import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {BlobReader,ZipReader} from '@zip.js/zip.js';
import {runFallbackWorker as worker} from './lib/zip-worker-harness.mjs';
const output=process.argv[2]?resolve(process.argv[2]):await mkdtemp('/private/tmp/archive-zip-security-aes-');
if(process.argv[2])await mkdir(output);
const hash=value=>createHash('sha256').update(value).digest('hex');
const payload=Uint8Array.from({length:1024*1024},(_,i)=>(i*73+(i>>>8)*19)&255);
const password='fixture-password';
const report={scope:'Actual application fallback worker, real zip.js and Node Web Streams; not browser download completion',cases:[]};
const record=async(id,fn)=>{const item={id,status:'FAIL'};report.cases.push(item);try{Object.assign(item,await fn());item.status='PASS';}catch(error){item.error=String(error);}await writeFile(join(output,'evidence.json'),JSON.stringify(report,null,2));};
let archive;
await record('actual-worker-aes-create',async()=>{const created=await worker(new File([payload],'payload.bin'),'create',{format:'zip',password,directories:['empty']});assert.equal(created.result.error,undefined);assert.equal(created.result.files.length,1);archive=new File([created.result.files[0].blob],'archive.zip');const bytes=new Uint8Array(await archive.arrayBuffer());await writeFile(join(output,'archive.zip'),bytes);return{bytes:bytes.length,sha256:hash(bytes)};});
if(archive){
 await record('encrypted-metadata-no-password',async()=>{const result=await worker(archive,'list');assert.equal(result.result.error,undefined);assert.deepEqual(Array.from(result.result.entries,e=>e.name).sort(),['empty/','payload.bin']);return{headerPreflight:true,plaintextAuthenticated:false};});
 await record('correct-password-full-hash',async()=>{const result=await worker(archive,'extract',{password});assert.equal(result.result.error,undefined);assert.equal(result.closed,true);assert.equal(result.bytes,payload.length);assert.equal(hash(Buffer.concat(result.chunks)),hash(payload));return{bytes:result.bytes,sha256:hash(payload)};});
 await record('wrong-password-no-completion',async()=>{const result=await worker(archive,'extract',{password:'wrong-fixture-password'});assert.match(result.result.error,/password|authentication|signature/i);assert.equal(result.closed,false);return{rejection:result.result.error,outputBytes:result.bytes};});
 await record('end-authentication-failure-no-completion',async()=>{const reader=new ZipReader(new BlobReader(archive));let entry;try{entry=(await reader.getEntries()).find(e=>e.filename==='payload.bin');}finally{await reader.close();}assert.equal(entry.encrypted,true);const bytes=Buffer.from(await archive.arrayBuffer());const start=entry.offset+30+bytes.readUInt16LE(entry.offset+26)+bytes.readUInt16LE(entry.offset+28);const tagLast=start+entry.compressedSize-1;assert.ok(tagLast>=start&&tagLast<bytes.length);bytes[tagLast]^=1;await writeFile(join(output,'bad-auth.zip'),bytes);const bad=new File([bytes],'bad-auth.zip');const listed=await worker(bad,'list');assert.equal(listed.result.error,undefined);const result=await worker(bad,'extract',{password});assert.match(result.result.error,/authentication|signature/i);assert.equal(result.closed,false);assert.equal(result.aborted,true);return{rejection:result.result.error,outputBytes:result.bytes,declaredBytes:payload.length,aborted:result.aborted};});
}
report.pass=report.cases.filter(c=>c.status==='PASS').length;report.fail=report.cases.length-report.pass;await writeFile(join(output,'evidence.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(report.fail)process.exitCode=1;
