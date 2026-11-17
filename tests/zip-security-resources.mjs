import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import * as zip from '@zip.js/zip.js';
zip.configure({useWebWorkers:false});
const compile=async name=>ts.transpileModule(await readFile(new URL(name,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const destination={},metadata={},exports={};
const context=vm.createContext({Blob,File,Uint8Array,DataView,Map,Set,Error,Promise,Number,Math,Reflect,WritableStream,TextEncoder,TextDecoder,console});
function evaluate(source,out,require){vm.runInContext('(function(exports,require){'+source+'\n})',context)(out,require)}
evaluate(await compile('../engine/destination.ts'),destination,()=>{throw Error('Unexpected destination dependency')});
evaluate(await compile('../src/archive-metadata.ts'),metadata,()=>destination);
evaluate(await compile('../src/zip-security.ts'),exports,name=>name==='@zip.js/zip.js'?zip:name.includes('destination')?destination:name.includes('archive-metadata')?metadata:(()=>{throw Error(name)})());
const {openStrictZip,exactZipOutput,ZIP_LIMITS}=exports;
let largestAllocation=0;
class VirtualMetadataBlob extends Blob {
 get size(){return 128*1024*1024+22}
 slice(start=0,end=this.size){
  const length=end-start;largestAllocation=Math.max(largestAllocation,length);assert.ok(length<=1024*1024,'Parser attempted a large allocation before metadata guard');const data=new Uint8Array(length),record=new Uint8Array(22),view=new DataView(record.buffer);view.setUint32(0,0x06054b50,true);view.setUint16(8,1,true);view.setUint16(10,1,true);view.setUint32(12,ZIP_LIMITS.metadataRead+1,true);view.setUint32(16,0,true);const position=this.size-22-start;for(let index=0;index<22;index++)if(position+index>=0&&position+index<length)data[position+index]=record[index];return new Blob([data]);
 }
}
await assert.rejects(openStrictZip(new VirtualMetadataBlob()),/metadata read exceeds the 64 MiB limit/);assert.ok(largestAllocation<1024*1024);
async function sinkCase(expected,parts,{closeError=false,writeError=false}={}){
 let bytes=0,aborted=false,closed=false;const sink=new WritableStream({write(chunk){if(writeError)throw Error('downstream disk failure');bytes+=chunk.byteLength},close(){if(closeError)throw Error('downstream commit failure');closed=true},abort(){aborted=true}});const target=exactZipOutput(sink,expected,{written:0,limit:expected}).getWriter();return{target,state:()=>({bytes,aborted,closed})};
}
let test=await sinkCase(3);await test.target.write(new Uint8Array(3));await test.target.close();assert.deepEqual(test.state(),{bytes:3,aborted:false,closed:true});
test=await sinkCase(3);await assert.rejects(test.target.write(new Uint8Array(4)),/exceeds/);assert.deepEqual(test.state(),{bytes:0,aborted:true,closed:false});
test=await sinkCase(3);await test.target.write(new Uint8Array(2));await assert.rejects(test.target.close(),/size mismatch/);assert.deepEqual(test.state(),{bytes:2,aborted:true,closed:false});
test=await sinkCase(1,[],{writeError:true});await assert.rejects(test.target.write(new Uint8Array(1)),/disk failure/);assert.equal(test.state().closed,false);
test=await sinkCase(1,[],{closeError:true});await test.target.write(new Uint8Array(1));await assert.rejects(test.target.close(),/commit failure/);assert.equal(test.state().closed,false);
console.log('ZIP resource contracts passed: virtual oversized central directory rejected before allocation, exact/overrun/short writes, disk-write and close-commit failures');
