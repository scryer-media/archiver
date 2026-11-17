import { ArchiveEngine } from '../src/tool-engine';
import { ArchiveEngine as NativeEngine } from '../engine/client';
const results: {name:string;ok:boolean;detail?:string}[]=[];
const engines: {dispose():Promise<boolean>}[]=[];
const engine=()=>{const item=new ArchiveEngine();engines.push(item);return item;};
const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const rejects=async(fn:()=>Promise<unknown>,pattern:RegExp)=>{try{await fn();}catch(error){check(pattern.test(String(error)),String(error));return;}throw Error('Expected rejection');};
const report=(done=false)=>document.querySelector('#results')!.textContent=JSON.stringify({done,passed:results.filter(r=>r.ok).length,total:results.length,results},null,2);
const test=async(name:string,fn:()=>Promise<void|string>)=>{try{const detail=await fn();results.push({name,ok:true,...(detail?{detail}:{})});}catch(error){results.push({name,ok:false,detail:String(error)});}report();};
(window as any).verificationDispose=async()=> (await Promise.all(engines.map(e=>e.dispose()))).every(Boolean);
const nested=()=>{const file=new File(['folder bytes'],'leaf.txt');Object.defineProperty(file,'webkitRelativePath',{value:'root/leaf.txt'});return file;};
for(const format of ['zip','tar','tar.gz'])await test(format+' preserves structured-clone folder paths and empty directories',async()=>{
 const e=engine(),made=await e.create([nested()],{format,directories:['root','root/empty']});
 const archive=new File([made.files[0].blob],made.files[0].name);
 const extracted=await e.extract([archive]);
 check(extracted.files[0].name==='root/leaf.txt','Folder path lost: '+extracted.files[0].name);
 check(await extracted.files[0].blob.text()==='folder bytes','Bytes changed');
 check(extracted.directories?.includes('root/empty'),'Empty directory lost');
});
for(const format of ['zip','tar'])await test(format+' supports directory-only archive',async()=>{
 const e=engine(),made=await e.create([],{format,directories:['empty/sub']});
 const result=await e.extract([new File([made.files[0].blob],made.files[0].name)]);
 check(!result.files.length&&result.directories?.includes('empty/sub'),'Directory-only archive lost');
});
for(const format of ['zip','tar'])await test(format+' rejects creation duplicate files and file-parent collisions',async()=>{
 const e=engine();await rejects(()=>e.create([new File(['a'],'same'),new File(['b'],'same')],{format}),/Duplicate/);
 await rejects(()=>e.create([new File(['a'],'root'),nested()],{format}),/collision/);
});
// Minimal stored ZIP fixtures keep adversarial metadata independent of the engine under test.
const zip=async(entries:{name:string;mode?:number}[])=>{
 const local:BlobPart[]=[],central:BlobPart[]=[];let offset=0,centralBytes=0;
 for(const item of entries){
  const name=new TextEncoder().encode(item.name),header=new Uint8Array(30),record=new Uint8Array(46),a=new DataView(header.buffer),b=new DataView(record.buffer);
  a.setUint32(0,0x04034b50,true);a.setUint16(4,20,true);a.setUint16(6,0x800,true);a.setUint16(12,0x21,true);a.setUint32(14,0x8cdc1683,true);a.setUint32(18,1,true);a.setUint32(22,1,true);a.setUint16(26,name.length,true);
  b.setUint32(0,0x02014b50,true);b.setUint16(4,0x0314,true);b.setUint16(6,20,true);b.setUint16(8,0x800,true);b.setUint16(14,0x21,true);b.setUint32(16,0x8cdc1683,true);b.setUint32(20,1,true);b.setUint32(24,1,true);b.setUint16(28,name.length,true);b.setUint32(38,((item.mode??0o100644)<<16)>>>0,true);b.setUint32(42,offset,true);
  local.push(header,name,new Uint8Array([120]));central.push(record,name);offset+=header.length+name.length+1;centralBytes+=record.length+name.length;
 }
 const end=new Uint8Array(22),view=new DataView(end.buffer);view.setUint32(0,0x06054b50,true);view.setUint16(8,entries.length,true);view.setUint16(10,entries.length,true);view.setUint32(12,centralBytes,true);view.setUint32(16,offset,true);
 return new File([...local,...central,end],'unsafe.zip');
};
await test('ZIP rejects symlink and file-parent collision',async()=>{
 const e=engine();await rejects(async()=>e.extract([await zip([{name:'link',mode:0o120777}])]),/links/);
 await rejects(async()=>e.extract([await zip([{name:'root'},{name:'root/child'}])]),/collision/);
});
await test('explicit ZIP and TAR read routing',async()=>{for(const format of ['zip','tar']){const e=engine(),made=await e.create([new File(['test'],'test')],{format});const result=await e.extract([new File([made.files[0].blob],'unknown.bin')],undefined,format);check(await result.files[0].blob.text()==='test','Explicit '+format+' failed');}});
await test('one wrapper rejects overlap before asynchronous sniffing',async()=>{
 const e=engine(),first=e.list([new File(['bad'],'unknown.bin')]);
 await rejects(()=>e.create([new File(['x'],'x')],{format:'zip'}),/already running/);
 await first.catch(()=>{});
});
await test('constructor and postMessage failures terminate and release leases',async()=>{
 const original=window.Worker;let terminated=0;
 try{
  for(const kind of ['constructor','postMessage']){
   (window as any).Worker=class{constructor(){if(kind==='constructor')throw Error('injected constructor');}postMessage(){throw Error('injected postMessage');}terminate(){terminated++;}};
   for(const e of [engine(),new NativeEngine()]){engines.push(e);await rejects(()=>e.create([new File(['x'],'x')],{format:'zip'}),/injected/);check(await e.dispose(),'Cleanup failed');}
  }
  check(terminated===2,'Workers were not terminated: '+terminated);
 }finally{window.Worker=original;}
});
const storage=await navigator.storage.getDirectory(),destinationName='review-destination-'+crypto.randomUUID(),destination=await storage.getDirectoryHandle(destinationName,{create:true});
const destinationJobs:string[]=[];
const previousDispose=(window as any).verificationDispose;
(window as any).verificationDispose=async()=>{const clean=await previousDispose();await storage.removeEntry(destinationName,{recursive:true});return clean;};
const readSaved=async(directory:FileSystemDirectoryHandle,path:string)=>{const parts=path.split('/');for(const part of parts.slice(0,-1))directory=await directory.getDirectoryHandle(part);return (await directory.getFileHandle(parts.at(-1)!)).getFile();};
const sentinel=await destination.getFileHandle('root',{create:true}),sentinelWriter=await sentinel.createWritable();await sentinelWriter.write('existing original');await sentinelWriter.close();
for(const format of ['zip','tar','tar.gz','7z'])await test(format+' direct destination extraction commits exact files, nested and empty directories',async()=>{
 const e=engine(),made=await e.create([nested()],{format,directories:['root','root/empty']});
 const result=await e.extract([new File([made.files[0].blob],made.files[0].name)],undefined,undefined,destination);
 check(result.files.length===0&&result.savedFiles===1,'Expected one saved file: '+JSON.stringify(result));
 check(result.savedDirectory,'Missing saved directory');destinationJobs.push(result.savedDirectory!);
 const folder=await destination.getDirectoryHandle(result.savedDirectory!);
 check(await (await readSaved(folder,'root/leaf.txt')).text()==='folder bytes','Direct bytes mismatch');
 await (await folder.getDirectoryHandle('root')).getDirectoryHandle('empty');
 check(await (await sentinel.getFile()).text()==='existing original','Existing original changed');
});
await test('native input and output preserve prototype-like legal path names',async()=>{
 const before=Object.getOwnPropertyNames(Object.prototype).join();
 for(const name of ['__proto__','constructor','prototype','toString/leaf','__proto__/toString']){
  const file=new File(['prototype-safe bytes'],'leaf');Object.defineProperty(file,'webkitRelativePath',{value:name});
  const e=engine(),made=await e.create([file],{format:'7z'}),archive=new File([made.files[0].blob],'safe.7z');
  const result=await e.extract([archive]);check(result.files[0].name===name&&await result.files[0].blob.text()==='prototype-safe bytes','Legal path lost: '+name);
  const direct=await e.extract([archive],undefined,undefined,destination),folder=await destination.getDirectoryHandle(direct.savedDirectory!);
  check(await (await readSaved(folder,name)).text()==='prototype-safe bytes','Direct legal path lost: '+name);
 }
 check(Object.getOwnPropertyNames(Object.prototype).join()===before,'Object prototype was mutated');
});
await test('RAR direct extraction uses same streamed bytes as ordinary extraction',async()=>{
 const response=await fetch('/tests/fixtures/compatibility/rar5_multifile_lz.rar');check(response.ok,'Missing RAR fixture');
 const archive=new File([await response.blob()],'input.rar'),e=engine(),expected=await e.extract([archive]);
 const result=await e.extract([archive],undefined,undefined,destination);check(result.savedFiles===expected.files.length,'RAR saved count');
 const folder=await destination.getDirectoryHandle(result.savedDirectory!);
 for(const file of expected.files){const actual=await readSaved(folder,file.name);check(new Uint8Array(await actual.arrayBuffer()).join()===new Uint8Array(await file.blob.arrayBuffer()).join(),'RAR direct bytes mismatch '+file.name);}
});
await test('300 MiB direct native extraction stays bounded and matches every chunk',async()=>{
 const chunk=new Uint8Array(1024*1024);for(let i=0;i<chunk.length;i++)chunk[i]=(i*31+(i>>>8))&255;
 const input=new File(Array.from({length:300},()=>chunk),'large.bin'),e=engine();
 const made=await e.create([input],{format:'7z',codec:'copy'});
 let written=0;const direct=new ArchiveEngine(progress=>{written=Math.max(written,progress.writtenBytes||0);});engines.push(direct);
 const result=await direct.extract([new File([made.files[0].blob],'large.7z')],undefined,undefined,destination);
 const folder=await destination.getDirectoryHandle(result.savedDirectory!),output=await readSaved(folder,'large.bin');
 check(output.size===input.size&&written>=299*1024*1024,'Large size/progress mismatch');
 const expected=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',chunk))).join();
 for(let offset=0;offset<output.size;offset+=chunk.length){const digest=await crypto.subtle.digest('SHA-256',await output.slice(offset,offset+chunk.length).arrayBuffer());check(Array.from(new Uint8Array(digest)).join()===expected,'Large SHA256 chunk mismatch at '+offset);}
 check(result.metrics?.wasmMemoryBytes!==undefined&&result.metrics.wasmMemoryBytes<=128*1024*1024,'WASM heap exceeded bounded budget');
 return JSON.stringify({bytes:output.size,writtenBytes:written,wasmMemoryBytes:result.metrics?.wasmMemoryBytes});
});
await test('direct extraction failure rolls back only its owned job folder',async()=>{
 const before:string[]=[];for await(const [name]of(destination as any).entries())before.push(name);
 await rejects(()=>engine().extract([new File(['bad'],'bad.rar')],undefined,undefined,destination),/invalid|header|archive|corrupt|unexpected|rar/i);
 const after:string[]=[];for await(const [name]of(destination as any).entries())after.push(name);
 check(after.sort().join()===before.sort().join(),'Failed extraction leaked or deleted another job');
});
await test('direct native cancellation removes partial job and keeps originals',async()=>{
 let e:ArchiveEngine;let cancelled=false;
 e=new ArchiveEngine(progress=>{if(progress.writtenBytes&&!cancelled){cancelled=true;void e.dispose();}});engines.push(e);
 const made=await engine().create([new File([new Uint8Array(16*1024*1024)],'large.bin')],{format:'7z',codec:'copy'});
 const before:string[]=[];for await(const [name]of(destination as any).entries())before.push(name);
 await rejects(()=>e.extract([new File([made.files[0].blob],'large.7z')],undefined,undefined,destination),/cancel/i);
 check(cancelled,'No direct byte progress received');await e.dispose();
 const after:string[]=[];for await(const [name]of(destination as any).entries())after.push(name);
 check(after.sort().join()===before.sort().join(),'Cancellation leaked or deleted a job');
 check(await (await sentinel.getFile()).text()==='existing original','Cancellation changed original');
});
await test('direct RPC keeps 64-bit offsets, bounded batching, disk-write and close failures',async()=>{
 const worker=new Worker(new URL('./review-direct.worker.ts',import.meta.url),{type:'module'});
 try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Direct RPC test timeout')),30000);worker.onmessage=({data})=>{clearTimeout(timer);data.error?reject(Error(data.error)):resolve();};worker.onerror=e=>reject(Error(e.message));worker.postMessage({});});}finally{worker.terminate();}
});
await test('OPFS random access, hardlinks, sparse snapshots and fault injection',async()=>{
 const worker=new Worker(new URL('./review-opfs.worker.ts',import.meta.url),{type:'module'});
 try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('OPFS test timeout')),30000);worker.onmessage=({data})=>{clearTimeout(timer);data.error?reject(Error(data.error)):resolve();};worker.onerror=e=>reject(Error(e.message));worker.postMessage({});});}finally{worker.terminate();}
});
report(true);
