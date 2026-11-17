import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
async function load(name){const exports={};vm.runInNewContext(ts.transpileModule(await readFile(new URL('../engine/'+name,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,Uint8Array,Blob,Map,WeakMap,Set,Number,Math,Error,Promise});return exports;}
const {publicationPolicy}=await load('publication.ts'),{DiskVolume}=await load('opfs.ts');
const PAGE=512*1024;
async function verifySnapshot(names,allowed,backup){
 const nodes=new Map(),disks=new Map(),backing=new Uint8Array(names.length*PAGE),expected=new Map();
 names.forEach((name,index)=>{const node={mode:0o100644},bytes=Uint8Array.of(index+1,index+2,index+3);nodes.set('/out/'+name,node);backing.set(bytes,index*PAGE);expected.set(name,bytes);disks.set(node,{size:3,get pages(){if(name===backup)throw Error('Damaged backup was snapshotted');return new Map([[0,index*PAGE]]);}});});
 const fs={readdir:()=>['.','..',...names],lookupPath:path=>({node:nodes.get(path)}),isDir:mode=>(mode&0o170000)===0o040000};
 const volume=Object.create(DiskVolume.prototype);volume.module={FS:fs};volume.files=disks;let closed=false;volume.close=()=>closed=true;volume.file={getFile:async()=>new Blob([backing])};
 const policy=publicationPolicy(allowed),outputs=await volume.outputs('/out',policy.files);
 assert.equal(closed,true,'snapshot must release its sync access handle');assert.deepEqual(Array.from(outputs,file=>file.name),allowed);
 for(const file of outputs)assert.deepEqual(new Uint8Array(await file.blob.arrayBuffer()),expected.get(file.name));
}
await verifySnapshot(['large.bin','large.bin.1','small.bin'],['large.bin','small.bin'],'large.bin.1');
await verifySnapshot(['good.bin','good.bin.1','good.bin.2','keep.bak'],['good.bin','good.bin.1','keep.bak'],'good.bin.2');
assert.deepEqual([...publicationPolicy(['nested/file.bin']).directories],['nested']);
assert.equal(publicationPolicy(undefined).files,undefined,'ordinary operations retain their existing publication contract');
for(const names of [['same','same'],['../outside'],['.work/private'],['a\\b'],['/absolute'],'invalid'])assert.throws(()=>publicationPolicy(names));
console.log('Repair publication passed: real OPFS snapshot excludes damaged backup before reading pages, preserves verified .1/.bak targets, validates paths and closes access handle');
