import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from '@typescript/typescript6';
const handlers={};
const sandbox={ReadableStream,Response,URL,TextEncoder,TextDecoder,Map,Error,Number,String,encodeURIComponent,setTimeout:()=>1,clearTimeout(){},self:{location:{origin:'https://local.test'},addEventListener:(name,callback)=>handlers[name]=callback}};
vm.runInNewContext(await readFile(new URL('../public/download-sw.js',import.meta.url),'utf8'),sandbox);
const owner={id:'page-a',url:'https://local.test/'};
let sequence=0;
const handoffs=[];
function register(name='file.bin',size){
 const token='00000000-0000-4000-8000-'+String(++sequence).padStart(12,'0');
 const stream=new TransformStream(undefined,{highWaterMark:1,size:chunk=>chunk.byteLength},{highWaterMark:0});let reply;
 handlers.message({source:owner,waitUntil:promise=>{assert.equal(typeof promise.then,'function');handoffs.push(promise);},data:{token,name,size,stream:stream.readable},ports:[{postMessage:value=>reply=value,close(){}}]});
 assert.equal(reply.ready,true);return {token,writer:stream.writable.getWriter()};
}
async function fetchJob(token){let response;handlers.fetch({waitUntil:()=>assert.fail('Body lifetime must not use a five-minute ExtendableEvent'),request:new Request('https://local.test/__download/'+token),respondWith:value=>response=value});return response;}
{
 const job=register("../folder/a'b\r\n.bin",3);let accepted=false;
 const write=job.writer.write(new Uint8Array([1,2,3])).then(()=>accepted=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(accepted,false,'producer must wait for response consumption');
 const response=await fetchJob(job.token);await handoffs.at(-1);assert.equal(accepted,false,'registration handoff settles before body consumption');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('content-length'),'3');assert.equal(response.headers.get('content-disposition'),"attachment; filename*=UTF-8''a%27b.bin");
 const consuming=response.arrayBuffer();await write;await job.writer.close();assert.deepEqual([...new Uint8Array(await consuming)],[1,2,3]);
 assert.equal((await fetchJob(job.token)).status,404,'ticket is single-use');
}
{
 const job=register();const response=await fetchJob(job.token);const consuming=response.arrayBuffer();
 handlers.message({source:{id:'other',url:owner.url},data:{cancel:job.token},ports:[]});
 await job.writer.write(new Uint8Array([7]));
 handlers.message({source:owner,data:{cancel:job.token},ports:[]});
 await assert.rejects(consuming);await assert.rejects(job.writer.write(new Uint8Array([8])));
}
{
 const job=register();const response=await fetchJob(job.token);const consuming=response.arrayBuffer();
 await job.writer.write(new Uint8Array([1]));await job.writer.abort(new Error('codec integrity failed'));await assert.rejects(consuming,/codec integrity failed/);
}
{
 let reply;handlers.message({source:{id:'remote',url:'https://remote.test/'},data:{token:'bad'},ports:[{postMessage:value=>reply=value,close(){}}]});assert.equal(reply,undefined,'cross-origin registration ignored');
}
const helper={self:{postMessage(){}},performance,Int32Array,Uint8Array,Atomics,TextEncoder,TextDecoder,Map,Set,Error,Number,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},destinationPathRegistry:()=>()=>{},destinationParent:()=>{throw Error('disk path used by download');}};
const code=ts.transpileModule((await readFile(new URL('../engine/direct-output.worker.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
vm.runInNewContext(code,helper);
const shared=new SharedArrayBuffer(16+1024*1024),state=new Int32Array(shared,0,4),payload=new Uint8Array(shared,16);let closed=false,received=0;
await helper.self.onmessage({data:{init:true,shared,download:new WritableStream({write(chunk){received+=chunk.length;},close(){closed=true;}})}});
async function operation(op,path='',position=0,length=0){Atomics.store(state,0,0);await helper.self.onmessage({data:{op,path,position,length}});assert.equal(Atomics.load(state,0),1);return Atomics.load(state,1);}
assert.equal(await operation('open','nested/file.bin'),0);payload.fill(1,0,3);assert.equal(await operation('write','nested/file.bin',0,3),0);assert.equal(received,3);
assert.ok(await operation('write','nested/file.bin',2,1)>0,'backward write must fail');assert.ok(await operation('open','other.bin')>0,'second output must fail');
assert.equal(await operation('close','nested/file.bin'),0);assert.equal(closed,false,'member close must not complete before codec success');
assert.equal(await operation('finish'),0);assert.equal(closed,true);assert.ok(await operation('write','nested/file.bin',3,1)>0,'writes after finish fail');
console.log('Download contracts passed: backpressure, bytes, filenames, ticket reuse, ownership, cancellation, codec errors, sequential native sink and success ordering');
