import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {creationPlans} from '../engine/create-plan.ts';
import {runFallbackWorker} from './lib/zip-worker-harness.mjs';
import {ZipReader,BlobReader,BlobWriter} from '@zip.js/zip.js';
const files=[new File(['already-compressed-fixture'],'media.bin'),new File(['text content '.repeat(100)],'text.txt')];
const names=files.map(file=>file.name);
const options={format:'zip',fileOptions:[{name:names[0],codec:'copy'},{name:names[1],codec:'deflate',level:9}]};
const plans=creationPlans(names,options);assert.deepEqual(plans.map(p=>p.codec),['copy','deflate']);
assert.notEqual(plans[0],options.fileOptions[0]);
for(const invalid of [
 {fileOptions:[{name:'missing',codec:'copy'}]},
 {fileOptions:[{name:names[0]},{name:names[0]}]},
 {fileOptions:[{name:names[0],codec:'copy',level:5}]},
 {fileOptions:[{name:names[0],codec:'deflate',dictionarySize:65536}]},
 {encryptHeaders:true,password:'fixture-password'},
 {fileOptions:[{name:names[0],filter:'x86'}]},
]) assert.throws(()=>creationPlans(names,{...invalid,format:'zip'}));
assert.throws(()=>creationPlans(names,{format:'7z',password:'fixture-password',fileOptions:[{name:names[0],filter:'bcj2'}]}));
assert.throws(()=>creationPlans(names,{format:'7z',memoryLimit:32*1024*1024,dictionarySize:8*1024*1024}));
for(const filter of ['none','x86','arm','arm64','thumb','ia64','sparc','ppc','riscv','bcj2'])assert.equal(creationPlans(names,{format:'7z',filter,deltaDistance:16})[0].deltaDistance,undefined);
assert.equal(creationPlans(names,{format:'7z',filter:'x86',deltaDistance:16,fileOptions:[{name:names[0],filter:'delta'}]})[0].deltaDistance,undefined);
assert.equal(creationPlans(names,{format:'7z',filter:'delta',deltaDistance:16})[0].deltaDistance,16);
assert.equal(creationPlans(names,{format:'7z',deltaDistance:16,fileOptions:[{name:names[0],filter:'delta',deltaDistance:256}]})[0].deltaDistance,256);
assert.throws(()=>creationPlans(names,{format:'7z',filter:'delta',deltaDistance:257}));
assert.throws(()=>creationPlans(names,{format:'7z',filter:'x86',fileOptions:[{name:names[0],deltaDistance:1}]}));
const changed=creationPlans(names,{format:'7z',codec:'lzma2',level:5,dictionarySize:65536,filter:'delta',deltaDistance:4,fileOptions:[{name:names[0],codec:'copy',filter:'none'}]});
assert.equal(changed[0].level,undefined);assert.equal(changed[0].dictionarySize,undefined);assert.equal(changed[0].deltaDistance,undefined);
for(const password of [undefined,'fixture-password']){
 const created=await runFallbackWorker(files[0],'create',{files,names,format:'zip',password,creation:options});
 assert.equal(created.result.error,undefined);assert.equal(created.result.files.length,1);
 const archive=created.result.files[0].blob,reader=new ZipReader(new BlobReader(archive),{password});
 try{
  const entries=await reader.getEntries();assert.deepEqual(entries.map(e=>e.filename),names);
  assert.deepEqual(entries.map(e=>e.compressionMethod),[0,8]);
  assert.deepEqual(entries.map(e=>e.encrypted),[!!password,!!password]);
  for(let index=0;index<entries.length;index++)assert.equal(await (await entries[index].getData(new BlobWriter())).text(),await files[index].text());
 }finally{await reader.close();}
 if(!password){const root=await mkdtemp('/private/tmp/archive-file-options-');const path=join(root,'mixed.zip');await writeFile(path,Buffer.from(await archive.arrayBuffer()));execFileSync('python3',['-c',`import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
 assert [(x.filename,x.compress_type) for x in z.infolist()]==[('media.bin',0),('text.txt',8)]
 assert z.read('media.bin')==b'already-compressed-fixture'
 assert z.read('text.txt')==b'text content '*100`,path]);}
}
const invalid=await runFallbackWorker(files[0],'create',{files,names,format:'zip',creation:{fileOptions:[{name:'not-selected',codec:'copy'}]}});
assert.match(invalid.result.error,/selected/);assert.equal(invalid.closed,false);assert.equal(invalid.bytes,0);
console.log('Per-file plans, ZIP Store/Deflate, AES policy, independent Python decoding and invalid-plan refusals passed');
