// Model-free native interruption probe. The executor's context hook blocks
// before provider access; the actual OpenCode subagent and stop command run.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeArtifact } from "./artifact.mjs";

const root = await mkdtemp(join(tmpdir(), "fusion-native-stop-"));
const repo = resolve(import.meta.dirname, "../..");
let packageRoot = repo;
if (process.env.FUSION_OPENCODE_TARBALL) {
 await cp(process.env.FUSION_OPENCODE_TARBALL, join(root, "fusion-opencode.tgz"));
 await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "fusion-opencode": "file:./fusion-opencode.tgz" } }));
 assert.equal(spawnSync("bun", ["install"], { cwd: root, encoding: "utf8" }).status, 0, "Dedicated package consumer must install");
 packageRoot = join(root, "node_modules/fusion-opencode");
}
await mkdir(join(root, "driver"));
await mkdir(join(root, "home"));
await writeFile(join(root, "opencode.json"), JSON.stringify({ plugins: [packageRoot, "./driver"] }));
await writeFile(join(root, "driver/index.ts"), `
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export default {id:'fusion-native-stop-probe',async setup(ctx){
 const out=async(name,value)=>writeFile(join(ctx.location.directory,name),JSON.stringify(value));
 const appendLine=async(line)=>{try{const {appendFile}=await import('node:fs/promises');await appendFile(join(ctx.location.directory,'bus.jsonl'),String(line)+'\\n');}catch{}};
 try {
  const busIterator=ctx.event?.subscribe?.(undefined)?.[Symbol.asyncIterator]?.();
  if(busIterator) void (async()=>{for(;;){const next=await busIterator.next();if(next.done)break;await appendLine(JSON.stringify(next.value));}})().catch(()=>{});
 } catch {}
 await ctx.session.hook('context',async e=>{if(e.agent==='fusion-executor'){await out('child-context.json',{sessionID:e.sessionID});await new Promise(r=>setTimeout(r,15000));throw Error('PROBE_STOP_BEFORE_MODEL');}if(e.agent==='fusion-scout'){await out('scout-context.json',{sessionID:e.sessionID});await new Promise(r=>setTimeout(r,15000));throw Error('PROBE_STOP_BEFORE_MODEL');}});
 await ctx.command.transform(ed=>ed.add({name:'stop-probe-status',description:'Inspect the Fusion stop probe',execute:async args=>{
  const tools=await ctx.tool.list();const context={sessionID:args.sessionID,agent:'fusion',messageID:'msg_probe',id:'call_probe_status',signal:new AbortController().signal,progress:async()=>{}};
  try{await out('status.json',JSON.parse((await tools.find(t=>t.id==='fusion_status').execute({},context)).content));}catch(error){await out('error.json',{error:String(error?.stack??error)});}
 }}));
 await ctx.command.transform(ed=>ed.add({name:'start-stop-probe',description:'Start a model-free executor probe',execute:async args=>{
  try {
   const tools=await ctx.tool.list();
   const context={sessionID:args.sessionID,agent:'fusion',messageID:'msg_probe',id:'call_probe',signal:new AbortController().signal,progress:async value=>out('progress.json',value)};
   await tools.find(t=>t.id==='fusion_start').execute({task:'Model-free interruption probe'},context);
   void tools.find(t=>t.id==='fusion_delegate').execute({action:'execute',title:'Stop probe',details:{brief:'Wait for the stop probe.'}},context).then(value=>out('result.json',value),error=>out('result.json',{error:String(error?.stack??error)}));
  }catch(error){await out('error.json',{error:String(error?.stack??error)});}
 }}));
 await ctx.command.transform(ed=>ed.add({name:'start-scout-stop-probe',description:'Start a model-free scout stop probe',execute:async args=>{
  try{
   const tools=await ctx.tool.list();
   const context={sessionID:args.sessionID,agent:'fusion',messageID:'msg_probe_scout',id:'call_probe_scout',signal:new AbortController().signal,progress:async value=>out('scout-progress.json',value)};
   await tools.find(t=>t.id==='fusion_start').execute({task:'Model-free scout stop probe'},context);
   void tools.find(t=>t.id==='fusion_scout').execute({questions:['Where is the stop marker?']},context).then(value=>out('scout-result.json',value),error=>out('scout-result.json',{error:String(error?.stack??error)}));
  }catch(error){await out('error.json',{error:String(error?.stack??error)});}
 }}));
 await ctx.command.transform(ed=>ed.add({name:'scout-refusal-probe',description:'Check the stopped run refuses scout work',execute:async args=>{
  try{
   const tools=await ctx.tool.list();
   const context={sessionID:args.sessionID,agent:'fusion',messageID:'msg_probe_scout2',id:'call_probe_scout_refusal',signal:new AbortController().signal,progress:async()=>{}};
   const response=await tools.find(t=>t.id==='fusion_scout').execute({questions:['more?']},context);
   await out('scout-refusal.json',{refused:/was stopped/i.test(String(response.content)),content:String(response.content).slice(0,200)});
  }catch(error){await out('scout-refusal.json',{refused:/was stopped/i.test(String(error)),content:String(error).slice(0,200)});}
 }}));
 await ctx.command.transform(ed=>ed.add({name:'release-scout-run',description:'Reset the Fusion run to release the workspace',execute:async args=>{
  try{
   const tools=await ctx.tool.list();
   const context={sessionID:args.sessionID,agent:'fusion',messageID:'msg_probe_reset',id:'call_probe_reset',signal:new AbortController().signal,progress:async()=>{}};
   const response=await tools.find(t=>t.id==='fusion_reset').execute({},context);
   await out('scout-release.json',{content:String(response?.content??'') .slice(0,400)});
  }catch(error){await out('scout-release.json',{error:String(error?.stack??error).slice(0,400)});}
 }}));
}};`);
const env = Object.fromEntries(["PATH", "SHELL", "TMPDIR", "LANG"].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
env.HOME = join(root, "home");
env.FUSION_OWNERSHIP_DIR = join(root, "ownership");
for (const key of ["DATA", "CONFIG", "CACHE", "STATE"]) env[`XDG_${key}_HOME`] = join(root, key);
const server = spawn(process.env.FUSION_OPENCODE_BIN || "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
for (const stream of [server.stdout, server.stderr]) stream.on("data", (chunk) => { log += chunk; });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = async (name) => { try { return JSON.parse(await readFile(join(root, name), "utf8")); } catch { return undefined; } };
const result = { ok: false, modelFree: true, installedPackage: packageRoot !== repo };
try {
 let url, password;
 for (let i = 0; i < 300; i++) { url = log.match(/server listening on (http:\/\/\S+)/)?.[1]; password = log.match(/server password (\S+)/)?.[1]; if (url && password) break; await delay(100); }
 assert.ok(url && password, "OpenCode server did not start");
 const headers = { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64"), "content-type": "application/json" };
 const api = async (path, body) => { let response; for (let i = 0; i < 100; i++) { response = await fetch(url + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); if (body || response.status !== 503) break; await response.arrayBuffer(); await delay(100); } const value = await response.json().catch(() => null); assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`); return value; };
 await api("/api/agent");
 // Scout phase first: it does not claim the workspace, so a separate
 // session can run a blocked fusion-scout child and stop it with the same
 // user command path. The run scope covers the scout with a per-worker
 // record confirmed by the child's terminal event.
 const scoutParent = await api("/api/session", {});
 const scoutSessionID = scoutParent.id ?? scoutParent.data?.id;
 await api(`/api/session/${scoutSessionID}/command`, { name: "start-scout-stop-probe", text: "" });
 let scoutContext;
 for (let i = 0; i < 150; i++) { scoutContext = await read("scout-context.json"); if (scoutContext) break; const error = await read("error.json") ?? await read("scout-result.json"); if (error?.error) throw Error(error.error); await delay(100); }
 assert.ok(scoutContext?.sessionID, "Real scout did not reach its model-free context hook");
 result.scoutChildSessionID = scoutContext.sessionID;
 await api(`/api/session/${scoutSessionID}/command`, { name: "fusion-stop", text: "Native scout stop probe" });
 for (let i = 0; i < 100; i++) {
  const scoutChild = await api(`/api/session/${scoutContext.sessionID}`);
  result.scoutChildOutcome = scoutChild.outcome ?? scoutChild.data?.outcome;
  if (result.scoutChildOutcome === "interrupted") break;
  await delay(100);
 }
 assert.equal(result.scoutChildOutcome, "interrupted", "Owned scout child did not report interruption");
 await api(`/api/session/${scoutSessionID}/command`, { name: "scout-refusal-probe", text: "" });
 for (let i = 0; i < 100; i++) { result.scoutRefusal = await read("scout-refusal.json"); if (result.scoutRefusal) break; await delay(100); }
 assert.equal(result.scoutRefusal?.refused, true, "The stopped run must refuse further scout work");
 // The scout child's context hook blocks ~15s before the terminal event
 // fires; wait bounded well past it.
 for (let i = 0; i < 400; i++) {
  await api(`/api/session/${scoutSessionID}/command`, { name: "stop-probe-status", text: "" });
  const status = await read("status.json");
  result.scoutStopState = status?.stop?.scouts?.[0]?.state;
  result.scoutStopTerminal = status?.stop?.scouts?.[0]?.terminal;
  if (result.scoutStopState === "confirmed") break;
  await delay(100);
 }
 assert.equal(result.scoutStopState, "confirmed", "Fusion did not confirm the scout record from the child's terminal event");
 assert.equal(result.scoutStopTerminal, "cancelled");
 // Release the scout-only run so the executor phase can claim the workspace.
 await api(`/api/session/${scoutSessionID}/command`, { name: "release-scout-run", text: "" });
 for (let i = 0; i < 60; i++) { result.scoutRelease = await read("scout-release.json"); if (result.scoutRelease) break; await delay(100); }
 if (result.scoutRelease?.error) throw Error(`scout release failed: ${result.scoutRelease.error}`);
 assert.ok(/released|Reset|reset/i.test(result.scoutRelease?.content ?? ""), "Scout-only run release did not report success");
 await delay(500);
 const parent = await api("/api/session", {});
 const sessionID = parent.id ?? parent.data?.id;
 await api(`/api/session/${sessionID}/command`, { name: "start-stop-probe", text: "" });
 let context;
 for (let i = 0; i < 150; i++) { context = await read("child-context.json"); if (context) break; const error = await read("error.json") ?? await read("result.json"); if (error?.error) throw Error(error.error); await delay(100); }
 assert.ok(context?.sessionID, "Real executor did not reach its model-free context hook");
 result.childSessionID = context.sessionID;
 await api(`/api/session/${sessionID}/command`, { name: "fusion-stop", text: "Native stop probe" });
 for (let i = 0; i < 100; i++) {
  const child = await api(`/api/session/${context.sessionID}`);
  result.childOutcome = child.outcome ?? child.data?.outcome;
  if (result.childOutcome === "interrupted") break;
  await delay(100);
 }
 assert.equal(result.childOutcome, "interrupted", "Owned child did not report interruption");
 for (let i = 0; i < 60; i++) {
  await api(`/api/session/${sessionID}/command`, { name: "stop-probe-status", text: "" });
  const status = await read("status.json");
  result.stopState = status?.stop?.state;
  result.stopTerminal = status?.stop?.terminal;
  result.retainedPending = !!status?.pending;
  if (result.stopState === "confirmed") break;
  await delay(100);
 }
 assert.equal(result.stopState, "confirmed", "Fusion did not report terminal evidence for the interrupted child");
 assert.equal(result.stopTerminal, "cancelled");
 assert.equal(result.retainedPending, true, "Interrupted work must remain available for reconciliation");
 result.ok = true;
} catch (error) { result.error = String(error); result.logTail = log.replace(/server password \S+/g, "server password [redacted]").slice(-1500); process.exitCode = 1; }
finally { server.kill("SIGKILL"); try { result.busTail = (await readFile(join(root, "bus.jsonl"), "utf8")).split("\n").filter(Boolean).slice(-30); } catch {} ; await writeArtifact("opencode-stop-native", result); await rm(root, { recursive: true, force: true }); }
console.log(JSON.stringify(result));
