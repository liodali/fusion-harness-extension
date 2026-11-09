// Opt-in real-model integration: real Durable storage, worker, bash tool,
// Fusion stop registration, and recovery. Supervisor controls are fixture-driven.
import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import {cp,mkdir,mkdtemp,readFile,readdir,rm,writeFile,access} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeArtifact} from './artifact.mjs';
if(process.env.FUSION_PI_STOP_LIVE!=='1') throw Error('Opt in with FUSION_PI_STOP_LIVE=1; this fixture consumes model tokens.');
const spec=process.env.FUSION_PI_STOP_MODEL;
if(!spec)throw Error('Set FUSION_PI_STOP_MODEL to a configured provider/model.');
const [provider,...ids]=spec.split('/');const modelId=ids.join('/');
const root=await mkdtemp(join(tmpdir(),'fusion-durable-stop-live-'));
const agentDir=join(root,'agent'),project=join(root,'project');
await mkdir(agentDir);await mkdir(project);
const result={ok:false,model:spec,realDurable:true,supervisor:'fixture-driven',backendBinding:'shared real backend instance'};
let source,sourceHandle,fixture,turn;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(operation,ms,label){let timer;try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`Timed out: ${label}`)),ms);})]);}finally{clearTimeout(timer);}}
async function exists(path){try{await access(path);return true;}catch{return false;}}
try{
 for(const name of ['auth.json','models-store.json'])await cp(join(homedir(),'.pi/agent',name),join(agentDir,name));
 try{await cp(join(homedir(),'.pi/agent/models.json'),join(agentDir,'models.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
 process.env.PI_CODING_AGENT_DIR=agentDir;process.env.FUSION_OWNERSHIP_DIR=join(root,'ownership');
 const catalog=JSON.parse(await readFile(join(agentDir,'models-store.json'),'utf8'));
 const entry=catalog[provider]?.models.find(m=>m.id===modelId);assert.ok(entry,'Configured executor model must exist');const model={...entry,provider};
 const {createDurableExecutorBackend}=await import('../../src/pi/durable/backend.ts');
 // Pi owns one Durable harness. Bind the fixture and restored supervisor to
 // the same real backend; two concurrent harness schedulers are not a Pi lifecycle.
 source=await createDurableExecutorBackend();
 mock.module(new URL('../../src/pi/durable/backend.ts',import.meta.url).pathname,()=>({createDurableExecutorBackend:async()=>source}));
 const {default:register}=await import('../../src/index.ts');
 const {writeRun,readRun,runsDir}=await import('../../src/runs.ts');
 const {openWorkspaceRegistry,canonicalWorkspace}=await import('../../src/workspace/ownership.ts');
 const canonical=await canonicalWorkspace(project);
 function host(){
  const tools=new Map(),commands=new Map(),hooks=new Map(),notices=[];let active=[];
  register({registerTool:t=>tools.set(t.name,t),registerCommand:(n,c)=>commands.set(n,c),on:(n,h)=>hooks.set(n,h),getActiveTools:()=>active,setActiveTools:v=>{active=v;},setModel:async()=>true,setThinkingLevel:()=>{},sendUserMessage:()=>{},exec:async()=>({code:1,stdout:''})});
  const ctx={cwd:project,sessionManager:{getSessionId:()=> 'durable-stop-supervisor'},hasUI:true,mode:'rpc',scopedModels:[],modelRegistry:{find:(p,id)=>p===provider&&id===modelId?model:undefined,getAvailable:()=>[model]},waitForIdle:async()=>{},ui:{notify:m=>notices.push(m),input:async()=>'',select:async(_title,options)=>options[0],confirm:async()=>true,setWidget:()=>{}}};
  return {tools,commands,hooks,notices,ctx,call:(name,input={})=>tools.get(name).execute('stop-live-call',input,undefined,undefined,ctx)};
 }
 sourceHandle=await source.createExecutor({cwd:project,model,thinking:'off'});
 const requestId='durable-stop-original';let started;
 const observed=new Promise(r=>{started=r;});
 const startedAt=Date.now();
 turn=sourceHandle.prompt('Implement this cancellation integration-test fixture in the isolated disposable workspace: run the bash command `sleep 20; printf completed > completion-marker.txt`. The delay gives the external test driver time to request cancellation, and the marker detects a command that incorrectly survives. This is the complete requested task; no other implementation is needed. If the command finishes, return a short completion report.',{requestId,onEvent:e=>{if(e.type==='tool_start'&&e.toolName==='bash')started();}});
 // Consume rejection immediately while awaiting a tool event.
 const completion=turn.then(value=>({value}),error=>({error:String(error)}));
 await bounded(Promise.race([observed,completion.then(v=>{throw Error('Executor ended before bash started: '+(v.value?.errorMessage??v.value?.stopReason??v.error));})]),90000,'observed executor bash');
 const toolStartedAt=Date.now();result.toolObserved=true;
 // Recovery injection: the original worker is real and running; only the
 // supervisor observation is represented as interrupted, with exact identity.
 const run={runId:'live-durable-stop',cwd:project,task:'Stop the running Durable executor',originalTask:'Stop the running Durable executor',brief:'Wait then write the test marker',backend:'durable',conversationId:Number(sourceHandle.resumeRef()),pending:{action:'execute',requestId},executor:{provider,modelId,label:spec,thinking:'off'},status:'interrupted',revisions:0,results:{},updatedAt:new Date().toISOString()};
 await writeRun(runsDir(agentDir),run);
 fixture=host();await fixture.commands.get('fusion-resume').handler('',fixture.ctx);
 assert.ok(fixture.notices.some(n=>n.includes('Resumed interrupted Fusion run')), 'Fusion must attach the exact pending conversation');
 const stopped=await bounded(fixture.call('fusion_stop',{reason:'Live integration test stop'}),12000,'registered fusion_stop');
 result.abortDelivery=stopped.details.abort;assert.equal(stopped.details.stopped,true);assert.equal(result.abortDelivery,'delivered');
 const settled=await bounded(completion,20000,'original worker termination');
 result.originalTurn=settled.value?.stopReason??'rejected';result.usage=settled.value?.usage;
 assert.equal(await exists(join(project,'completion-marker.txt')),false);
 const saved=await readRun(runsDir(agentDir),run.runId);assert.ok(saved.stopped);assert.equal(saved.pending.requestId,requestId);
 const owned=await(await openWorkspaceRegistry()).inspect(canonical);assert.ok(owned.manifest.adapterData.legacyPi.stopped);result.sharedStopSaved=true;
 await fixture.hooks.get('session_shutdown')();fixture=undefined;source=await createDurableExecutorBackend();sourceHandle=undefined;
 fixture=host();await fixture.commands.get('fusion-resume').handler('',fixture.ctx);
 assert.ok(fixture.notices.some(n=>n.includes('Resumed interrupted Fusion run')),'Restart must recover pending work');
 const refused=await fixture.call('fusion_delegate',{action:'revise',brief:'Do more work'});assert.match(refused.content[0].text,/was stopped/);result.restartGuard=true;
 const recovered=await bounded(fixture.call('fusion_delegate',{action:'resume',brief:'resume'}),20000,'exact result reconciliation');
 const recoveredRun=await readRun(runsDir(agentDir),run.runId);assert.equal(recoveredRun.pending,undefined,'Real terminal proof must settle pending intent');assert.ok(recoveredRun.stopped);result.recovered=true;
 const stillRefused=await fixture.call('fusion_delegate',{action:'revise',brief:'Do more work'});assert.match(stillRefused.content[0].text,/was stopped/);
 await fixture.commands.get('fusion-clean').handler('',fixture.ctx);assert.equal(await(await openWorkspaceRegistry()).inspect(canonical),undefined);result.cleaned=true;
 // Observe past the original command's intended write time to detect a
 // shell that outlived interruption, without another model request.
 const remaining=toolStartedAt+22000-Date.now();if(remaining>0)await delay(remaining);
 result.noLateWrite=!await exists(join(project,'completion-marker.txt'));assert.equal(result.noLateWrite,true);
 result.elapsedMs=Date.now()-startedAt;result.ok=true;
}catch(error){result.error=String(error?.message??error);process.exitCode=1;}
finally{
 try{if(sourceHandle)await bounded(sourceHandle.abort(),3000,'cleanup abort');}catch{}
 try{if(fixture)await bounded(fixture.hooks.get('session_shutdown')(),3000,'cleanup session');}catch{}
 try{if(source)await bounded(source.dispose(),3000,'cleanup backend');}catch{}
 await writeArtifact('pi-durable-stop-live',result);
 await rm(root,{recursive:true,force:true});
}
console.log(JSON.stringify(result));

// A failed SDK shutdown must not leave the opt-in fixture running forever.
process.exit(process.exitCode??0);
