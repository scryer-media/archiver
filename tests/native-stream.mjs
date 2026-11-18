import * as outputBudget from '../engine/output-budget.ts';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync,inflateSync} from 'node:zlib';
import vm from 'node:vm';
import ts from '@typescript/typescript6';
const code=ts.transpileModule(await readFile(new URL('../src/native-stream.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const planCode=ts.transpileModule(await readFile(new URL('../engine/create-plan.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;const plans=await import('data:text/javascript;base64,'+Buffer.from(planCode).toString('base64'));
const native=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
assert.equal(native.nativeStreamFormat('gz','compress'),'gzip');assert.equal(native.nativeStreamFormat('zlib','decompress'),'deflate');
assert.equal(native.chooseNativeStream('gz','compress',{}),true,'Simple defaults must use browser compression');
assert.equal(native.chooseNativeStream('gz','compress',{level:6}),false);assert.equal(native.chooseNativeStream('gz','compress',{streamBackend:'wasm'}),false);
assert.throws(()=>native.chooseNativeStream('gz','compress',{streamBackend:'native',level:6}),/tuning/);
assert.throws(()=>native.chooseNativeStream('xz','compress',{streamBackend:'native'}),/does not support/);
assert.equal(native.chooseNativeStream('gz','decompress',{},true),false,'Automatic direct writes must remain WASM');assert.equal(native.chooseNativeStream('gz','decompress',{},false),true);assert.equal(native.chooseNativeStream('gz','decompress',{streamBackend:'native'},true),true);
const input=new Blob([new Uint8Array(1024*1024).fill(71)]);let seen=0;
for(const [format,decode]of [['gz',gunzipSync],['zlib',inflateSync]]){const bytes=new Uint8Array(await new Response(native.browserStream(input,format,'compress',n=>seen=n)).arrayBuffer());assert.deepEqual(decode(bytes),Buffer.from(await input.arrayBuffer()));assert.equal(seen,input.size);}
const original=globalThis.DecompressionStream;
try{
 globalThis.DecompressionStream=class{constructor(){return new TransformStream({transform(){throw new TypeError('codec rejected data')}})}};
 await assert.rejects(new Response(native.browserStream(new Blob(['bad']),'gz','decompress',()=>{})).arrayBuffer(),e=>e.nativeCodecError===true);
 const broken={stream:()=>new ReadableStream({pull(c){c.error(new TypeError('source failed'));}})};
 await assert.rejects(new Response(native.browserStream(broken,'gz','decompress',()=>{})).arrayBuffer(),e=>e.message==='source failed'&&!e.nativeCodecError);
}finally{globalThis.DecompressionStream=original;}
let cancelled=false;const pending={stream:()=>new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}})};const reader=native.browserStream(pending,'gz','compress',()=>{}).getReader();await reader.cancel();await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,true);
const source=ts.transpileModule((await readFile(new URL('../src/tool-engine.ts',import.meta.url),'utf8')).replaceAll('import.meta.url',JSON.stringify('https://local.test/module.js')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const context=vm.createContext({CompressionStream,DecompressionStream,File,Blob,Uint8Array,Error,Promise,Map,Set,URL,Worker:class{terminate(){}postMessage(){Promise.resolve().then(()=>this.onerror({message:''}));}}});const exports={};vm.runInContext('(function(exports,require){'+source+'})',context) (exports,name=>name.includes('output-budget')?outputBudget:name.includes('native-stream')?native:name.includes('create-plan')?plans:name.includes('client')?{ArchiveEngine:class{}}:name.includes('storage')?{acquireStorageLease:async()=>({name:'fixture',release(){}}),removeStorage:async()=>true}:{});
function app(){const value=new exports.ArchiveEngine(),calls=[];value.native={create:async()=>{calls.push('wasm-create');return{files:[]}},extract:async()=>{calls.push('wasm-extract');return{files:[]}}};value.fallback=async(op,files,password,format)=>{calls.push('browser-'+op+':'+format);return{files:[]}};return{value,calls};}
const file=new File(['payload'],'payload.bin');
{const {value,calls}=app();await value.createInternal([file],{format:'gz'});assert.deepEqual(calls,['browser-create:gz']);}
{const {value,calls}=app();await value.createInternal([file],{format:'gz',level:6});assert.deepEqual(calls,['wasm-create']);}
{const {value,calls}=app();await value.extractInternal([new File(['x'],'input.gz')],undefined,undefined,{},undefined,{});assert.deepEqual(calls,['wasm-extract']);}
{const {value,calls}=app();value.fallback=async()=>{calls.push('browser-failed');value.pendingCleanup.push(Promise.resolve(true));throw Object.assign(Error('codec'),{nativeCodecError:true});};await value.extractInternal([new File(['x'],'input.gz')]);assert.deepEqual(calls,['browser-failed','wasm-extract']);}
for(const failure of [Error('QuotaExceededError'),Object.assign(Error('codec'),{nativeCodecError:true})]){const {value,calls}=app();value.fallback=async()=>{calls.push('browser-failed');throw failure;};await assert.rejects(value.extractInternal([new File(['x'],'input.gz')],undefined,undefined,undefined,undefined,{streamBackend:'native'}));assert.deepEqual(calls,['browser-failed']);}
{const {value,calls}=app();value.fallback=async()=>{value.pendingCleanup.push(Promise.resolve(false));throw Object.assign(Error('codec'),{nativeCodecError:true});};await assert.rejects(value.extractInternal([new File(['x'],'input.gz')]),/remove failed/);assert.deepEqual(calls,[]);}
{const {value,calls}=app();value.fallback=async()=>{value.cancellationEpoch++;throw Object.assign(Error('codec'),{nativeCodecError:true});};await assert.rejects(value.extractInternal([new File(['x'],'input.gz')]),/cancelled/);assert.deepEqual(calls,[]);}
{const {value,calls}=app();value.fallback=async()=>{calls.push('browser-failed');throw Error('QuotaExceededError');};await assert.rejects(value.extractInternal([new File(['x'],'input.gz')]),/Quota/);assert.deepEqual(calls,['browser-failed']);}
{const {value,calls}=app();await assert.rejects(value.create([file],{format:'gz',outputDirectory:{}}),/selected output folder/);assert.deepEqual(calls,[]);}
{const value=new exports.ArchiveEngine();await assert.rejects(value.fallback('create',[file]),/Archive worker failed/);}
{const {value}=app();let delivered;value.deliver=async(name,action)=>{delivered=name;return action(new WritableStream());};value.createInternal=async()=>({files:[]});const large=new File([], 'é'.repeat(200)+'.bin');Object.defineProperty(large,'size',{value:9*1024**3});await value.create([large],{format:'tar',delivery:'download'});assert.equal(delivered,'archive.tar','PAX creation preflight must permit large files and long UTF8 names');const unsafe=new File([], 'unsafe-size');Object.defineProperty(unsafe,'size',{value:Number.MAX_SAFE_INTEGER+1});await assert.rejects(value.create([unsafe],{format:'tar',delivery:'download'}),/not supported/);}
const {runFallbackWorker}=await import('./lib/zip-worker-harness.mjs');
for(const format of ['gz','zlib','deflate']){
 const made=await runFallbackWorker(new File(['native worker content'],'source.txt'),'create',{format,nativeStreams:true});assert.equal(made.result.error,undefined);assert.ok(made.result.files[0].blob.size>0);
 const decoded=await runFallbackWorker(new File([made.result.files[0].blob],'source.'+format),'extract',{format,nativeStreams:true});assert.equal(decoded.result.error,undefined);assert.equal(decoded.closed,true);assert.equal(Buffer.concat(decoded.chunks.map(Buffer.from)).toString(),'native worker content');
 if(format==='gz'){const bytes=new Uint8Array(await made.result.files[0].blob.arrayBuffer());bytes[bytes.length-8]^=1;const bad=await runFallbackWorker(new File([bytes],'bad.gz'),'extract',{format,nativeStreams:true});assert.ok(bad.result.error);assert.equal(bad.closed,false,'CRC failure must withhold downstream EOF');assert.equal(bad.aborted,true);}
}
const failingDirectory={async getFileHandle(_name,options){if(!options?.create)throw new DOMException('Missing','NotFoundError');return{async createWritable(){throw new Error('');}};}};
const failedOutput=await runFallbackWorker(new File(['x'],'input.gz'),'extract',{format:'gz',nativeStreams:true,captureDownload:false,outputDirectory:failingDirectory});assert.equal(failedOutput.result.error,'Error','An empty platform message must still publish a terminal failure');assert.equal(failedOutput.result.nativeCodecError,false,'Destination failures must not become codec retries');
const primitiveDirectory={async getFileHandle(_name,options){if(!options?.create)throw new DOMException('Missing','NotFoundError');return{async createWritable(){throw '';}};}};
const primitiveFailure=await runFallbackWorker(new File(['x'],'input.gz'),'extract',{format:'gz',nativeStreams:true,captureDownload:false,outputDirectory:primitiveDirectory});assert.equal(primitiveFailure.result.error,'Archive operation failed');assert.equal(primitiveFailure.result.nativeCodecError,false);
console.log('Native stream tests passed: real gzip/zlib bytes, direction detection, tuning, direct-output policy, source/codec separation, cancellation and transactional retry guards');
