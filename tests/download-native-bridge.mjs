import * as outputBudget from '../engine/output-budget.ts';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {Worker as Thread,MessageChannel} from 'node:worker_threads';
import ts from '@typescript/typescript6';
const compile=source=>ts.transpileModule(source.replaceAll('import.meta.url',JSON.stringify('file:///workspace/engine/client.ts')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const helperCode=compile((await readFile(new URL('../engine/direct-output.worker.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,''));
const directCode=compile(await readFile(new URL('../engine/direct-output.ts',import.meta.url),'utf8'));
const threadCode=`const {parentPort,workerData}=require('node:worker_threads');
 global.self={postMessage:data=>parentPort.postMessage(data),crossOriginIsolated:true};
 global.destinationPathRegistry=()=>()=>{};
 global.destinationParent=()=>{throw Error('Unexpected disk path');};
 global.Worker=class{constructor(){throw Error('Native thread created a child stream helper');}};
 if(workerData.helper){eval(workerData.helperCode);parentPort.on('message',data=>workerData.delay?setTimeout(()=>self.onmessage({data}),200):self.onmessage({data}));}
 else{const exports={};eval(workerData.directCode);parentPort.on('message',data=>{try{
 if(data.options.downloadStream)throw Error('Writable stream was relayed through native thread');
 const bridge=data.options.downloadBridge,output=exports.DirectOutput.downloadBridge({},bridge);
 output.call('open','payload.bin');new Uint8Array(bridge.shared,16).set([1,2,3]);
 output.call('write','payload.bin',0,3);output.call('close','payload.bin');output.finish();output.close();
 parentPort.postMessage({writeBudgetUsed:3,files:[],downloadSent:true,sentBytes:3});
 }catch(error){parentPort.postMessage({writeBudgetUsed:0,error:String(error)});}});}`;
const instances=[],terminations=[];let delayHelpers=false,shortTimeout=false,removals=0;
class Worker {
 constructor(url){this.helper=String(url).includes('direct-output.worker');this.thread=new Thread(threadCode,{eval:true,workerData:{helper:this.helper,delay:delayHelpers,helperCode,directCode}});this.thread.on('message',data=>this.onmessage?.({data}));this.thread.on('error',error=>this.onerror?.({message:error.message}));instances.push(this);}
 postMessage(data,transfer){this.posted=true;this.thread.postMessage(data,transfer);}
 terminate(){if(!this.terminated){this.terminated=true;terminations.push(this.thread.terminate());}}
}
const exports={};
vm.runInNewContext(compile(await readFile(new URL('../engine/client.ts',import.meta.url),'utf8')),{exports,require:name=>name.includes('output-budget')?outputBudget:({cleanAbandonedStorage:async()=>{},acquireStorageLease:async()=>({name:'lease',release(){}}),removeStorage:async()=>{removals++;return true;}}),Worker,MessageChannel,WritableStream,SharedArrayBuffer,crossOriginIsolated:true,URL,Promise,Error,setTimeout:(callback,ms)=>setTimeout(callback,shortTimeout&&ms===30000?20:ms),clearTimeout});
const Engine=exports.ArchiveEngine;
{
 const engine=new Engine(),stream=new TransformStream(undefined,{highWaterMark:1},{highWaterMark:0});
 const bytes=new Response(stream.readable).arrayBuffer();
 const result=await engine.create([],{format:'zstd',downloadStream:stream.writable});
 assert.equal(result.downloadSent,true);assert.deepEqual([...new Uint8Array(await bytes)],[1,2,3]);await engine.dispose();
}
{
 const engine=new Engine();await assert.rejects(engine.create([],{downloadStream:new WritableStream({write(){throw Error('consumer rejected bytes');}})}),/consumer rejected bytes/);await engine.dispose();
}
{
 const engine=new Engine();await assert.rejects(engine.create([],{downloadStream:new WritableStream({close(){throw Error('consumer close failed');}})}),/consumer close failed/);await engine.dispose();
}
{
 const prior=instances.length,before=removals,engine=new Engine();
 let controller,releaseWrite,startedWrite,finishedAbort,abortReason;
 const gate=new Promise(resolve=>releaseWrite=resolve),started=new Promise(resolve=>startedWrite=resolve),aborted=new Promise(resolve=>finishedAbort=resolve);
 const stream=new WritableStream({start(value){controller=value;},async write(){startedWrite();await gate;},abort(reason){abortReason=reason;finishedAbort();}});
 const failure=assert.rejects(engine.create([],{downloadStream:stream}),/cancelled/);
 await started;
 await engine.dispose();await failure;
 assert.equal(controller.signal.aborted,true,'cancellation must request downstream abort while a write is blocked');
 assert.ok(instances.slice(prior).every(worker=>worker.terminated),'cancellation must terminate native and helper immediately');
 assert.equal(removals-before,1,'cancelled operation must clean storage exactly once');
 releaseWrite();await aborted;assert.match(String(abortReason),/stopped|cancelled/);
}
{
 delayHelpers=true;const engine=new Engine(),prior=instances.length;
 const failure=assert.rejects(engine.create([],{downloadStream:new WritableStream()}),/cancelled/);
 while(!instances.slice(prior).some(worker=>worker.helper&&worker.posted))await new Promise(resolve=>setTimeout(resolve,1));
 await engine.dispose();await failure;delayHelpers=false;
}
{
 delayHelpers=true;shortTimeout=true;const engine=new Engine(),before=removals;
 await assert.rejects(engine.create([],{downloadStream:new WritableStream()}),/did not initialize/);await engine.dispose();
 await new Promise(resolve=>setTimeout(resolve,1));assert.equal(removals-before,1,'initialization timeout must remove storage exactly once');delayHelpers=false;shortTimeout=false;
}
assert.ok(instances.every(worker=>worker.terminated),'every main-owned helper/native worker must be terminated');await Promise.all(terminations);
console.log('Native download bridge passed: real transferable stream bypasses blocked native thread; strict RPC acknowledgements, consumer error and cancellation terminate both workers');
