import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Pi persists and authoritatively restores the stop marker in the shared manifest", async () => {
	const root = await mkdtemp(join(tmpdir(), "fusion-pi-stop-shared-"));
	try {
		const child = Bun.spawn([process.execPath, "test", resolve(import.meta.dir, "integration/pi-stop-shared-recovery-probe.mjs")],
			{ stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, FUSION_PI_TEST_DIR: root, PI_CODING_AGENT_DIR: root } });
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" });
	} finally { await rm(root, { recursive: true, force: true }); }
}, 60000);
