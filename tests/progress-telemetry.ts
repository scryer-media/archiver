import { ByteRanges,installIoProgress } from '../engine/io-progress';
import { ArchiveEngine } from '../src/tool-engine';
import type { EngineProgress } from '../engine/client';
const results:{name:string;ok:boolean;detail?:string}[]=[];
const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
const report=(done=false)=>document.querySelector('#results')!.textContent=JSON.stringify({done,passed:results.filter(result=>result.ok).length,total:results.length,results},null,2);
const test=async(name:string,fn:()=>Promise<void>|void)=>{try{await fn();results.push({name,ok:true});}catch(error){results.push({name,ok:false,detail:String(error)});}report();};
const engines:ArchiveEngine[]=[];
const engine=(events:EngineProgress[])=>{const e=new ArchiveEngine(progress=>events.push(progress));engines.push(e);return e;};
const finalization=(events:EngineProgress[])=>{const final=events.filter(event=>/commit|finaliz/.test(event.phase));check(final.length,'No finalization phase');for(const event of final)check(event.totalBytes===undefined&&event.processedBytes===undefined&&event.percent===undefined,'Finalization advertised a denominator');};
(window as any).verificationDispose=async()=> (await Promise.all(engines.map(e=>e.dispose()))).every(Boolean);
await test('unique ranges exclude skipped footer bytes and repeated reads',()=>{
 const ranges=new ByteRanges();check(ranges.add(900,100)===100&&ranges.bytes===100,'Footer seek counted skipped data');
 check(ranges.add(900,100)===0,'Reread counted twice');check(ranges.add(0,100)===100&&ranges.bytes===200,'Disjoint prefix coverage');
 check(ranges.add(50,900)===800&&ranges.bytes===1000,'Overlapping range union incorrect');
 const huge=new ByteRanges();check(huge.add(2**32+17,100)===100&&huge.bytes===100,'64-bit range truncated');
});
const fake=(op:string)=>{
 const events:EngineProgress[]=[];let time=0;const original=performance.now.bind(performance);Object.defineProperty(performance,'now',{configurable:true,value:()=>time+=300});
 let rejectWrite=false,rejectClose=false;
 const fs:any={read:(_stream:any,_buffer:any,_offset:number,length:number)=>length,write:(_stream:any,_buffer:any,_offset:number,length:number)=>{if(rejectWrite)throw Error('injected write');return Math.floor(length/2);},close:()=>{if(rejectClose)throw Error('injected close');}};
 const tracker=installIoProgress({FS:fs},op,[new File([new Uint8Array(1000)],'a'),new File([new Uint8Array(2000)],'unused.par2')],['a','unused.par2'],event=>events.push(event),false,{totalBytes:100,totalFiles:1});
 return {events,fs,tracker,writeError:()=>rejectWrite=true,closeError:()=>rejectClose=true,restore:()=>Object.defineProperty(performance,'now',{configurable:true,value:original})};
};
for(const op of ['list','verify','repair'])await test(op+' input counters never claim all selected bytes are a known task total',()=>{
 const item=fake(op);try{const stream={path:'/input/a',position:0};item.fs.read(stream,null,0,100,900);item.fs.read(stream,null,0,100,900);const last=item.events.at(-1)!;check(last.processedBytes===100,'Footer/reread count inflated');check(last.totalBytes===undefined,'Unproven native denominator');}finally{item.restore();}
});
await test('creation tracks all source input bytes as its known read phase',()=>{
 const item=fake('create');try{item.fs.read({path:'/input/a',position:0},null,0,100,900);const last=item.events.at(-1)!;check(last.totalBytes===3000&&last.processedBytes===100&&last.unit==='input','Create denominator incorrect');item.tracker.finish();finalization(item.events);}finally{item.restore();}
});
await test('native partial writes count returned bytes; failed writes/closes do not advance counts',()=>{
 const item=fake('extract');try{const stream={path:'/out/a',position:0};item.fs.write(stream,null,0,100,0);check(item.events.at(-1)!.processedBytes===50,'Partial write overstated');item.writeError();try{item.fs.write(stream,null,0,100,50);}catch{}item.closeError();try{item.fs.close(stream);}catch{}item.tracker.finish();const final=item.events.at(-1)!;check(final.outputBytes===50&&final.filesProcessed===0,'Failure advanced telemetry');finalization(item.events);}finally{item.restore();}
});
const payload=new File([new Uint8Array(8*1024*1024)],'data.bin');
for(const format of ['zip','tar','tar.gz','7z','tar.zstd'])await test(format+' creation reports measured input and separates finalization',async()=>{
 const events:EngineProgress[]=[],e=engine(events);const result=await e.create([payload],{format});check(result.files.length,'No archive');
 const reads=events.filter(event=>event.unit==='input'&&event.totalBytes===payload.size);check(reads.length,'No known source-byte phase');
 check(events.some(event=>(event.outputBytes||0)>0),'No measured output bytes');finalization(events);
 if(format==='tar.zstd')check(events.some(event=>event.phase.startsWith('pack-tar:'))&&events.some(event=>event.phase.startsWith('compress-tar:')),'TAR stages shared rate counters');
 const extracts:EngineProgress[]=[],extractor=engine(extracts);await extractor.extract([new File([result.files[0].blob],result.files[0].name)]);
 if(format==='zip'||format==='7z'){check(extracts.some(event=>event.unit==='output'&&event.totalBytes===payload.size),'Extraction did not use expanded member size');check(extracts.some(event=>event.outputBytes===payload.size),'Final output byte count incorrect');}
 finalization(extracts);
});
const storage=await navigator.storage.getDirectory(),destinationName='progress-test-'+crypto.randomUUID(),destination=await storage.getDirectoryHandle(destinationName,{create:true});
const oldDispose=(window as any).verificationDispose;(window as any).verificationDispose=async()=>{const clean=await oldDispose();await storage.removeEntry(destinationName,{recursive:true});return clean;};
for(const format of ['zip','tar','7z'])await test(format+' direct extraction reports expanded totals and committed file count',async()=>{
 const source=engine([]),made=await source.create([payload],{format}),events:EngineProgress[]=[],e=engine(events);
 const result=await e.extract([new File([made.files[0].blob],made.files[0].name)],undefined,undefined,destination);
 check(result.savedFiles===1,'Direct result count');check(events.some(event=>event.unit==='output'&&event.totalBytes===payload.size),'Missing direct expanded total');
 check(events.some(event=>event.outputBytes===payload.size&&event.filesProcessed===1),'No committed file count/final bytes');finalization(events);
});
for(const fixture of ['rar5_multifile_lz.rar','rar4_lz_solid_mv.rar'])await test(fixture+' direct metadata totals use expanded members and solid file counts',async()=>{
 const response=await fetch('/tests/fixtures/compatibility/'+fixture);check(response.ok,'Missing RAR fixture');
 const archive=new File([await response.blob()],fixture),source=engine([]),listed=await source.list([archive]);
 const entries=listed.entries!.filter(entry=>!entry.isDirectory),total=entries.reduce((sum,entry)=>sum+entry.size,0),events:EngineProgress[]=[],e=engine(events);
 const result=await e.extract([archive],undefined,undefined,destination);check(result.savedFiles===entries.length,'RAR file count');
 check(events.some(event=>event.unit==='output'&&event.totalBytes===total&&event.totalFiles===entries.length),'RAR expanded denominator missing');
 check(events.some(event=>event.outputBytes===total&&event.filesProcessed===entries.length),'RAR committed output count');finalization(events);
});
await test('standalone stream direct output keeps expanded total unknown without a redundant decode',async()=>{
 const made=await engine([]).create([payload],{format:'gz'}),events:EngineProgress[]=[],e=engine(events);
 const result=await e.extract([new File([made.files[0].blob],made.files[0].name)],undefined,undefined,destination);
 check(result.savedFiles===1,'Stream result');const output=events.filter(event=>event.phase==='extract-output');check(output.length&&output.every(event=>event.totalBytes===undefined),'Stream guessed its expanded total');
 check(events.some(event=>event.outputBytes===payload.size),'Stream actual output counter');finalization(events);
});
await test('native synchronous I/O reports are throttled rather than one event per block',()=>{
 const events:EngineProgress[]=[],fs:any={read:(_s:any,_b:any,_o:number,length:number)=>length,write:(_s:any,_b:any,_o:number,length:number)=>length,close:()=>{}};
 const tracker=installIoProgress({FS:fs},'create',[new File([new Uint8Array(20000)],'a')],['a'],event=>events.push(event),false);
 const stream={path:'/input/a',position:0};for(let index=0;index<1000;index++)fs.read(stream,null,0,10,index*10);tracker.finish();
 check(events.length<10,'Per-block event flood: '+events.length);check(events.at(-1)!.phase==='finalizing','No terminal phase');
});
await test('direct heartbeat, acknowledgement, timeout and disk error contracts remain valid',async()=>{
 const worker=new Worker(new URL('./review-direct.worker.ts',import.meta.url),{type:'module'});
 try{await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Direct helper contract timeout')),30000);worker.onmessage=({data})=>{clearTimeout(timeout);data.error?reject(Error(data.error)):resolve();};worker.onerror=event=>reject(Error(event.message));worker.postMessage({});});}finally{worker.terminate();}
});
report(true);
