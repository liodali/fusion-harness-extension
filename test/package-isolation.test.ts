import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

// M7.1: the two harness entrypoints are explicit published surfaces, and the
// import graphs behind them are isolated. All paths below are repo-relative
// POSIX paths of source files, not absolute filesystem paths. This is a
// static source-graph test: the graph is read from every file's import
// declarations (including dynamic `import(...)` specifiers) — nothing is
// executed.
//
// Import kinds matter for the package rule (C1): a type-only import is erased
// before any host loads the file, so the OpenCode closure may carry type-only
// imports of the officially supported plugin package (`@opencode/plugin`,
// docs/opencode-contract-matrix.md) without importing an SDK at runtime.
// Every other bare specifier — including type-only ones — is still a
// violation, and any runtime import is one regardless of the package.
//
// The boundary rules are exercised in two directions: they must be satisfied
// by the real entry closures (no violations), and they must DETECT
// violations — mutation-style fixtures under test/isolation-fixtures
// deliberately cross each boundary and are asserted to be flagged, so the
// rules cannot pass vacuously (a wrong path prefix would fail the fixture
// assertions).

const root = resolve(import.meta.dir, "..");
/** The official OpenCode plugin package: the one bare specifier the OpenCode
 * closure may import, and only as types (erased at load time). */
const OFFICIAL_PLUGIN_PACKAGE = "@opencode/plugin";

const toRepoPath = (file: string) => relative(root, file).replaceAll("\\", "/");

type Graph = {
	closure: Set<string>;
	bare: Set<string>;
	/** Bare specifiers imported only as types (erased by the loader). */
	typeOnlyBare: Set<string>;
	violations: string[];
};

/** True when an import declaration is erased before the module loads:
 * `import type {...}`, or every binding is `type`-only with no default or
 * namespace clause. */
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
	const clause = node.importClause;
	if (!clause) return false; // bare `import "x"` is a runtime side-effect import
	if (clause.isTypeOnly) return true;
	if (clause.name) return false;
	if (!clause.namedBindings) return false;
	if (ts.isNamespaceImport(clause.namedBindings)) return false;
	return clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly);
}

function importSpecifiers(file: string): { specifier: string; typeOnly: boolean }[] {
	const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const found: { specifier: string; typeOnly: boolean }[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			found.push({ specifier: node.moduleSpecifier.text, typeOnly: isTypeOnlyImport(node) });
		} else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
			found.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly === true });
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
			found.push({ specifier: node.arguments[0].text, typeOnly: false });
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function walk(entry: string): Graph {
	const graph: Graph = { closure: new Set(), bare: new Set(), typeOnlyBare: new Set(), violations: [] };
	const pending = [resolve(root, entry)];
	while (pending.length > 0) {
		const file = pending.pop()!;
		const repoPath = toRepoPath(file);
		if (graph.closure.has(repoPath)) continue;
		graph.closure.add(repoPath);
		for (const { specifier, typeOnly } of importSpecifiers(file)) {
			if (specifier.startsWith("node:")) continue;
			if (!specifier.startsWith(".")) {
				graph.bare.add(specifier);
				if (typeOnly) graph.typeOnlyBare.add(specifier);
				continue;
			}
			if (!specifier.endsWith(".ts")) graph.violations.push(`${repoPath}: local import "${specifier}" must use an explicit .ts specifier`);
			const target = resolve(dirname(file), specifier);
			if (!existsSync(target)) {
				graph.violations.push(`${repoPath}: local import "${specifier}" does not resolve to a file`);
				continue;
			}
			pending.push(target);
		}
	}
	return graph;
}

// Boundary rules. The OpenCode side must not reach the Pi adapter, Pi
// Durable, or the Pi extension entrypoint, and must have no bare package
// imports at all (only node builtins) — so an OpenCode-only install cannot
// import any Pi SDK. The Pi side must not reach the OpenCode adapter.
const openCodeBoundaryViolations = (graph: Graph): string[] => {
	const piFiles = [...graph.closure].filter((path) => path.startsWith("src/pi/") || path === "src/index.ts");
	// Runtime imports are always violations. Type-only imports are erased at
	// load time; the official plugin package is the only bare specifier the
	// OpenCode closure may carry that way (its server/TUI declarations).
	const packages = [...graph.bare].filter((name) => name !== OFFICIAL_PLUGIN_PACKAGE || !graph.typeOnlyBare.has(name));
	return [
		...piFiles.map((path) => `OpenCode closure reaches Pi source ${path}`),
		...packages.map((name) => `OpenCode closure imports package ${name}`),
	];
};

const piBoundaryViolations = (graph: Graph): string[] => {
	return [...graph.closure].filter((path) => path.startsWith("src/opencode/")).map((path) => `Pi closure reaches OpenCode source ${path}`);
};

const piEntry = walk("src/index.ts");
const opencodeEntry = walk("src/opencode/index.ts");

test("published entrypoints pi and opencode exist and stay on their own side of the graph", () => {
	const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
		exports: Record<string, string>;
	};
	expect(pkg.exports["."]).toBe("./src/index.ts");
	expect(pkg.exports["./pi"]).toBe("./src/index.ts");
	expect(pkg.exports["./opencode"]).toBe("./src/opencode/index.ts");
	expect(pkg.exports["./server"]).toBe(pkg.exports["./opencode"]);
	for (const [key, target] of Object.entries(pkg.exports)) {
		if (key === "./package.json") continue;
		expect(existsSync(resolve(root, target))).toBe(true);
	}
	// Same entrypoint, imported two ways: the alias and the Pi default export
	// must agree, so the Pi install path keeps working unchanged.
	expect(pkg.exports["."]).toBe(pkg.exports["./pi"]);
});

test("the OpenCode entry closure never imports the Pi adapter, Pi Durable, or the Pi extension entry", () => {
	const violations = openCodeBoundaryViolations(opencodeEntry).filter((v) => v.startsWith("OpenCode closure reaches"));
	expect(violations).toEqual([]);
});

test("the OpenCode entry closure has no runtime package imports and only type-imports the official plugin package", () => {
	const violations = openCodeBoundaryViolations(opencodeEntry).filter((v) => v.startsWith("OpenCode closure imports"));
	expect(violations).toEqual([]);
	// The one allowed bare specifier must actually be the official plugin
	// package, imported as types only — a runtime import fails the rule above.
	expect([...opencodeEntry.bare].every((name) => name === OFFICIAL_PLUGIN_PACKAGE && opencodeEntry.typeOnlyBare.has(name))).toBe(true);
});

test("the Pi entry closure never imports the OpenCode adapter", () => {
	expect(piBoundaryViolations(piEntry)).toEqual([]);
});

test("every local import in both entry closures resolves through the exact-.ts convention", () => {
	expect(piEntry.violations).toEqual([]);
	expect(opencodeEntry.violations).toEqual([]);
});

test("isolation rules detect a fixture whose import graph crosses into Pi sources", () => {
	const fixture = walk("test/isolation-fixtures/crosses-opencode-boundary.ts");
	const violations = openCodeBoundaryViolations(fixture);
	// Reaching src/pi/** must be flagged — the fixture imports the Pi worker
	// runtime and the Pi extension entrypoint cover set.
	const reaches = violations.filter((v) => v.startsWith("OpenCode closure reaches Pi source src/pi/"));
	expect(reaches.length).toBeGreaterThan(0);
	// Bare package imports must be flagged — the fixture imports an SDK.
	expect(violations.some((v) => v.startsWith("OpenCode closure imports package @earendil-works/"))).toBe(true);
});

test("isolation rules detect a fixture that returns a bare package import as a violation", () => {
	const fixture = walk("test/isolation-fixtures/imports-bare-package.ts");
	const violations = openCodeBoundaryViolations(fixture);
	expect(violations.some((v) => v.startsWith("OpenCode closure imports package typebox"))).toBe(true);
});

test("isolation rules detect a closure that reaches opencode sources from the Pi side", () => {
	const fixture = walk("test/isolation-fixtures/crosses-pi-boundary.ts");
	const violations = piBoundaryViolations(fixture);
	expect(violations.some((v) => v.startsWith("Pi closure reaches OpenCode source src/opencode/"))).toBe(true);
});

test("Pi SDK peers optional and development versions satisfy the declared peer ranges", () => {
	const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
		peerDependencies: Record<string, string>;
		peerDependenciesMeta: Record<string, { optional?: boolean }>;
		overrides: Record<string, string>;
		devDependencies: Record<string, string>;
	};
	const piSdks = Object.keys(pkg.peerDependencies).filter((name) => name.startsWith("@earendil-works/") || name === "typebox");
	expect(piSdks.length).toBeGreaterThan(0);
	for (const name of piSdks) {
		expect({ sdk: name, meta: pkg.peerDependenciesMeta[name] }).toEqual({ sdk: name, meta: { optional: true } });
	}
	// The codemode compatibility window: pi-coding-agent's declared range
	// admits 1.x releases that dropped exports Pi consumers rely on, so the
	// constraint is a capped 1.0.x window (superset of the dev-exact pin),
	// and the dev-side override must stay inside that window.
	expect(pkg.peerDependencies["@earendil-works/pi-codemode"]).toBe("~1.0.3");
	expect(pkg.overrides["@earendil-works/pi-codemode"]).toBe("1.0.3");
	// Every peer with a pinned development version must satisfy its own
	// declared peer range — the repository must not test a combination
	// outside the published contract.
	for (const [name, range] of Object.entries(pkg.peerDependencies)) {
		const devPin = pkg.devDependencies[name];
		if (devPin === undefined) continue;
		expect({ dep: name, devPin, range, satisfies: devSatisfies(devPin, range) }).toEqual({ dep: name, devPin, range, satisfies: true });
	}
});

function devSatisfies(version: string, range: string): boolean {
	const compare = (a: string, b: string) => {
		const pa = a.split(".").map(Number);
		const pb = b.split(".").map(Number);
		for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
			const difference = (pa[i] ?? 0) - (pb[i] ?? 0);
			if (difference !== 0) return Math.sign(difference);
		}
		return 0;
	};
	if (range.startsWith("^")) {
		const base = range.slice(1);
		const major = Number(base.split(".")[0]);
		return compare(version, base) >= 0 && compare(version, `${major + 1}.0.0`) < 0;
	}
	if (range.startsWith("~")) {
		const [major, minor] = range.slice(1).split(".").map(Number);
		return compare(version, `${major}.${minor}.0`) >= 0 && compare(version, `${major}.${minor + 1}.0`) < 0;
	}
	return compare(version, range) === 0;
}
