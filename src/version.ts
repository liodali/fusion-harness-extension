/**
 * Identity of the package a Fusion entrypoint was loaded from. Both hosts
 * report "Fusion <version>" in the doctor, so the version must come from the
 * actual installed manifest — never a compiled-in constant that can drift
 * from the published package. Node builtins only: both the Pi extension and
 * the OpenCode plugin load this module.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageIdentity {
	name: string;
	version: string;
	/** The manifest the identity came from (display only). */
	manifest: string;
}

const cache = new Map<string, PackageIdentity | undefined>();

/** Walk upward from a module URL to the nearest package.json carrying a name
 * and a version. Undefined (cached per starting directory) when no manifest
 * can be read — callers must report the version as unobservable instead of
 * guessing. Only positive hits are cached: an intermediate directory without
 * a manifest must not terminate a later walk from a deeper start. */
export async function loadedPackageIdentity(moduleUrl: string): Promise<PackageIdentity | undefined> {
	let current: string | undefined;
	try { current = dirname(fileURLToPath(moduleUrl)); } catch { return undefined; }
	const start = current;
	const cached = cache.get(start);
	if (cached) return cached;
	const seen = new Set<string>();
	for (;;) {
		if (seen.has(current)) break;
		seen.add(current);
		const manifest = join(current, "package.json");
		try {
			await stat(manifest);
			const parsed = JSON.parse(await readFile(manifest, "utf8")) as { name?: unknown; version?: unknown };
			if (typeof parsed.name === "string" && parsed.name.trim() && typeof parsed.version === "string" && parsed.version.trim()) {
				const identity: PackageIdentity = { name: parsed.name.trim(), version: parsed.version.trim(), manifest };
				cache.set(start, identity);
				return identity;
			}
		} catch {
			// No readable manifest at this level; keep walking.
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	cache.set(start, undefined);
	return undefined;
}
