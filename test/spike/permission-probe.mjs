// C3 permission-semantics probe: boot 2.3.0 with the plugin + shipped Markdown
// agents (both .opencode/agent and .opencode/agents layouts) and dump each
// Fusion agent's observed fields next to the plugin's centralized definition.
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..", "..");
const root = await mkdtemp(join(tmpdir(), "fusion-perm-probe-"));
const children = [];
try {
  for (const layout of ["agent", "agents"]) {
    const project = join(root, `project-${layout}`);
    await mkdir(join(project, ".opencode/plugins"), { recursive: true });
    await mkdir(join(project, ".opencode", layout), { recursive: true });
    await cp(join(repo, "src"), join(project, ".opencode/fusion"), { recursive: true });
    await cp(join(repo, "examples/opencode/agents"), join(project, ".opencode", layout), { recursive: true });
    await writeFile(join(project, ".opencode/plugins/fusion.ts"), 'export { default } from "../fusion/opencode/index.ts";\n');
    const env = Object.fromEntries(["PATH", "SHELL", "TMPDIR", "LANG"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
    env.HOME = join(root, `home-${layout}`);
    for (const [key, folder] of Object.entries({ XDG_DATA_HOME: "data", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state" })) env[key] = join(root, `${folder}-${layout}`);
    env.FUSION_OWNERSHIP_DIR = join(root, `ownership-${layout}`);
    const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let log = "";
    for (const s of [child.stdout, child.stderr]) s.on("data", (c) => { log += c; });
    let url, password;
    for (let i = 0; i < 300 && !(url && password); i++) {
      url = log.match(/server listening on (http:\/\/\S+)/)?.[1];
      password = log.match(/server password (\S+)/)?.[1];
      if (!(url && password)) await new Promise((r) => setTimeout(r, 100));
    }
    if (!url || !password) throw new Error(`server did not start (${layout}): ${log.slice(-500)}`);
    const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
    const get = async (path) => (await fetch(url + path, { headers: auth, signal: AbortSignal.timeout(15000) })).json().catch(() => null);
    let agents = [];
    for (let i = 0; i < 120; i++) {
      agents = (await get("/api/agent")) ?? [];
      const list = Array.isArray(agents) ? agents : agents.data ?? [];
      if (list.some((a) => a?.id === "fusion")) { await new Promise((r) => setTimeout(r, 1500)); agents = (await get("/api/agent")) ?? []; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    const list = Array.isArray(agents) ? agents : agents.data ?? [];
    const { FUSION_AGENTS } = await import(`${repo}/src/opencode/agents.ts`);
    console.log(`\n===== layout .opencode/${layout} =====`);
    for (const def of FUSION_AGENTS) {
      const observed = list.find((a) => a?.id === def.id);
      console.log(`--- ${def.id} ---`);
      console.log("observed.mode:", observed?.mode, "| defined:", def.mode);
      console.log("observed.description match:", observed?.description === def.description);
      console.log("observed.system match:", observed?.system === def.system);
      console.log("observed.permissions:", JSON.stringify(observed?.permissions));
      console.log("defined.permissions:", JSON.stringify(def.permissions));
    }
  }
} finally {
  for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
  await new Promise((r) => setTimeout(r, 400));
  await rm(root, { recursive: true, force: true });
}
