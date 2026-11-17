import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {openBrowserSession} from './lib/browser-session.mjs';
const args=process.argv.slice(2),get=(key,fallback)=>{const at=args.indexOf(key);return at<0?fallback:args[at+1];};
if(!args.includes('--execute')){console.log('NOT_RUN: --execute required; actual tiny source-browser/API checks, no large fixtures');process.exit();}
const output=await mkdtemp('/private/tmp/archive-output-budget-browser-'),endpoint=get('--endpoint','http://127.0.0.1:9230'),url=get('--url','http://127.0.0.1:4185/');
assert.ok(['127.0.0.1','localhost'].includes(new URL(url).hostname));
let page;const report={status:'FAIL',scope:'Actual browser source API, real native/ZIP/browser codec workers and runtime FS; not a production CSP or large-archive proof',url,endpoint,output};
async function checks(selected){
 const {ArchiveEngine}=await import('/src/tool-engine.ts');
 const {ArchiveEngine:NativeEngine}=await import('/engine/client.ts');
 const {WriteBudget,installWriteBudget}=await import('/engine/output-budget.ts');
 const verify=(value,message)=>{if(!value)throw Error(message);},delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const root=await navigator.storage.getDirectory(),records=[],live=new Set(),storage=new Set(),engines=new Set(),owned=[],cases=[];
 const OriginalWorker=window.Worker;let phase='setup';
 window.Worker=class extends OriginalWorker{
  constructor(...args){super(...args);live.add(this);this.addEventListener('message',({data})=>{if(data.progress||typeof data.writeBudgetUsed!=='number')return;records.push({phase,event:'terminal',used:data.writeBudgetUsed,limit:data.writeBudgetLimit,error:data.error||null,files:data.files?.length||0});});}
  postMessage(data,...rest){if(data.op){const options=data.options||data;records.push({phase,event:'request',op:data.op,format:options.format,grant:options.writeBudgetGrant,limit:options.outputLimitBytes});const name=data.storageId||data.temporaryDirectory;if(name)storage.add(name);}return super.postMessage(data,...rest);}
  terminate(){live.delete(this);return super.terminate();}
 };
 const hash=async blob=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('');
 const bytes=Uint8Array.from({length:16384},(_,i)=>(i*73+(i>>>8)*19)&255),file=new File([bytes],'payload.bin',{lastModified:0});
 const engine=(native=false)=>{const value=native?new NativeEngine():new ArchiveEngine();engines.add(value);return value;};
 const sink=()=>{const state={chunks:[],bytes:0,closed:false,aborted:false};state.writer=new WritableStream({write(bytes){state.chunks.push(new Uint8Array(bytes));state.bytes+=bytes.length;},close(){state.closed=true;},abort(reason){state.aborted=true;state.reason=String(reason);}});return state;};
 const waitSink=async(state,field)=>{const end=Date.now()+1000;while(!state[field]&&Date.now()<end)await delay(10);verify(state[field],'Sink did not '+field);};
 const rejected=async(action,pattern=/write budget/i)=>{try{await action();}catch(error){verify(pattern.test(String(error)),'Expected write-budget error, got '+error);return String(error);}throw Error('Over-budget operation unexpectedly succeeded');};
 const counters=(start,limit)=>{const terminal=records.slice(start).filter(r=>r.event==='terminal');verify(terminal.length>0,'No actual worker terminal evidence');for(const r of terminal)verify(Number.isSafeInteger(r.used)&&r.used>=0&&r.used<=limit,'Invalid actual write counter');return terminal;};
 async function test(id,action){if(selected.length&&!selected.includes(id))return;phase=id;const start=records.length;let item={id,status:'FAIL'};try{Object.assign(item,await action());item.status='PASS';}catch(error){item.error=String(error);}finally{for(const value of engines){try{verify(await value.dispose(),'Engine cleanup returned false');}catch(error){item.status='FAIL';item.cleanupError=String(error);}}engines.clear();for(const name of storage){try{await root.getDirectoryHandle(name);item.status='FAIL';item.cleanupError='Owned private stage remains';}catch(error){if(error.name!=='NotFoundError'){item.status='FAIL';item.cleanupError=String(error);}}}storage.clear();if(live.size){item.status='FAIL';item.liveWorkers=live.size;for(const worker of [...live])worker.terminate();}item.workerEvidence=records.slice(start);cases.push(item);}return item;}
 try{
  await test('invalid-budget-before-worker',async()=>{const start=records.length;for(const limit of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]){let failed=false;try{await engine().create([file],{format:'zip',outputLimitBytes:limit});}catch(error){failed=/whole number|write budget/i.test(String(error));}verify(failed,'Invalid budget accepted');}verify(records.length===start,'Invalid budget started a worker');return{values:6};});
  await test('default-budget-is-20-gib',async()=>{const result=await engine().create([file],{format:'zip',codec:'copy'});verify(result.writeBudgetLimit===20*1024**3,'Wrong default budget');verify(result.writeBudgetUsed>0,'Missing actual usage');return{used:result.writeBudgetUsed,limit:result.writeBudgetLimit};});
  for(const [id,options]of [['zip',{format:'zip',codec:'copy'}],['native7z',{format:'7z',codec:'copy'}],['browser-gzip',{format:'gz',streamBackend:'native'}]]){
   await test(id+'-prepared-exact-and-under',async()=>{
    const first=await engine().create([file],{...options,outputLimitBytes:1024*1024});verify(first.files.length===1,'Missing created file');const used=first.writeBudgetUsed;verify(Number.isSafeInteger(used)&&used>1,'No measured writes');
    const exact=await engine().create([file],{...options,outputLimitBytes:used});verify(exact.writeBudgetUsed===used&&exact.writeBudgetLimit===used,'Exact boundary counter mismatch');verify(await hash(exact.files[0].blob)===await hash(first.files[0].blob),'Exact boundary changed archive bytes');
    const start=records.length,error=await rejected(()=>engine().create([file],{...options,outputLimitBytes:used-1}));const evidence=counters(start,used-1);verify(evidence.some(r=>r.error&&/write budget/i.test(r.error)),'Refusal did not come from actual worker writes');return{used,outputBytes:first.files[0].blob.size,error};
   });
  }
  for(const [id,options]of [['zip',{format:'zip',codec:'copy'}],['browser-gzip',{format:'gz',streamBackend:'native'}]])await test(id+'-stream-abort-and-exact',async()=>{
   const initial=sink(),result=await engine().create([file],{...options,downloadStream:initial.writer,outputLimitBytes:1024*1024});await waitSink(initial,'closed');verify(initial.bytes>0&&result.writeBudgetUsed===initial.bytes,'Stream actual-byte accounting');
   const exact=sink(),r=await engine().create([file],{...options,downloadStream:exact.writer,outputLimitBytes:initial.bytes});await waitSink(exact,'closed');verify(exact.bytes===initial.bytes&&r.writeBudgetUsed===initial.bytes,'Exact stream boundary');
   const small=sink(),error=await rejected(()=>engine().create([file],{...options,downloadStream:small.writer,outputLimitBytes:512}));await waitSink(small,'aborted');verify(!small.closed&&small.bytes<=512,'Refused stream completed or exceeded limit');return{limit:512,written:small.bytes,aborted:small.aborted,error};
  });
  const expanded=new File([new Uint8Array(16384).fill(65)],'expanded.bin'),raw=new File([await new Response(expanded.stream().pipeThrough(new CompressionStream('deflate-raw'))).blob()],'expanded.deflate');
  await test('browser-unknown-size-expansion',async()=>{const start=records.length,error=await rejected(()=>engine().extract([raw],undefined,'deflate',undefined,undefined,{streamBackend:'native',outputLimitBytes:512}));const terminal=counters(start,512);verify(terminal.some(r=>r.used===0&&/write budget/i.test(r.error||'')),'Oversized first chunk was not refused before storage write');return{packedBytes:raw.size,expandedBytes:expanded.size,error};});
  await test('native-unknown-size-stream-expansion',async()=>{
   const small=sink(),start=records.length,error=await rejected(()=>engine(true).extract([raw],undefined,'deflate',undefined,small.writer,{outputLimitBytes:512}),/write budget|Decoded stream exceeds the output quota/i);await waitSink(small,'aborted');verify(!small.closed&&small.bytes===0,'Native oversized first chunk reached sink');counters(start,512);
   const exact=sink(),r=await engine(true).extract([raw],undefined,'deflate',undefined,exact.writer,{outputLimitBytes:expanded.size});await waitSink(exact,'closed');verify(exact.bytes===expanded.size&&r.writeBudgetUsed===expanded.size,'Exact native expansion boundary');verify(await hash(new Blob(exact.chunks))===await hash(expanded),'Native expansion exact hash');return{error,expandedBytes:expanded.size,aborted:true};
  });
  let compressedTar;
  await test('compressed-tar-create-shared-stage-budget',async()=>{
   const options={format:'tar.gz',streamBackend:'native'},base=await engine().create([file],{...options,outputLimitBytes:1024*1024});compressedTar=new File([await base.files[0].blob.arrayBuffer()],'archive.tar.gz');const used=base.writeBudgetUsed;verify(used>compressedTar.size,'TAR stage writes not counted');
   const exact=await engine().create([file],{...options,outputLimitBytes:used});verify(exact.writeBudgetUsed===used,'Exact aggregate create boundary');
   const start=records.length,error=await rejected(()=>engine().create([file],{...options,outputLimitBytes:used-1}));const request=records.slice(start).filter(r=>r.event==='request'),term=counters(start,used-1);verify(request.length>=2&&request.at(-1).grant<used-1,'Stages did not share remaining grant');verify(term.reduce((n,r)=>n+r.used,0)<=used-1,'Aggregate actual writes exceeded allowance');return{used,packedBytes:compressedTar.size,error};
  });
  await test('compressed-tar-extract-shared-stage-budget',async()=>{
   verify(compressedTar,'Creation fixture unavailable');const base=await engine().extract([compressedTar],undefined,undefined,undefined,undefined,{outputLimitBytes:1024*1024});verify(base.files.length===1&&await hash(base.files[0].blob)===await hash(file),'Full TAR payload');const used=base.writeBudgetUsed;verify(used>file.size,'Expanded TAR stage not counted');
   const exact=await engine().extract([compressedTar],undefined,undefined,undefined,undefined,{outputLimitBytes:used});verify(exact.writeBudgetUsed===used,'Exact aggregate extraction boundary');
   const start=records.length,error=await rejected(()=>engine().extract([compressedTar],undefined,undefined,undefined,undefined,{outputLimitBytes:used-1}));verify(records.slice(start).filter(r=>r.event==='request').length>=2,'No multiple real stages');counters(start,used-1);return{used,payloadBytes:file.size,error};
  });
  await test('compressed-tar-destination-failure-cleans-owned-job',async()=>{
   verify(compressedTar,'Creation fixture unavailable');const name='budget-destination-'+crypto.randomUUID();owned.push(name);const destination=await root.getDirectoryHandle(name,{create:true});
   const stageBytes=(await new Response(compressedTar.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()).byteLength,limit=stageBytes+512,start=records.length;const error=await rejected(()=>engine().extract([compressedTar],undefined,undefined,destination,undefined,{outputLimitBytes:limit}),/write budget|output quota/i);const requests=records.slice(start).filter(r=>r.event==='request'),terminal=counters(start,limit);verify(requests.length>=2&&requests.at(-1).format==='tar'&&requests.at(-1).grant===512,'Direct stage2 did not receive shared remaining allowance');verify(terminal[0].used===stageBytes,'Intermediate stage was not actually written');const entries=[];for await(const entry of destination.values())entries.push(entry.name);verify(entries.length===0,'Failed direct job was not removed');return{error,stageBytes,limit,remainingEntries:entries};
  });
  await test('actual-runtime-ftruncate-and-writable-mmap',async()=>{
   const {default:createModule}=await import('/engine/archive-engine.js');const module=await createModule({locateFile:name=>'/engine/'+name,print(){},printErr(){}}),fs=module.FS;fs.mkdir('/out');const budget=new WriteBudget(32);installWriteBudget(module,budget);const stream=fs.open('/out/fixture','w+');
   try{fs.ftruncate(stream.fd,32);verify(fs.stat('/out/fixture').size===32&&budget.used===32,'Real ftruncate exact boundary');let rejectedGrowth=false;try{fs.ftruncate(stream.fd,33);}catch(error){rejectedGrowth=/write budget/i.test(String(error));}verify(rejectedGrowth&&fs.stat('/out/fixture').size===32&&budget.used===32,'Real ftruncate bypassed budget');
    let mapped=false;try{fs.mmap(stream,4096,0,3,1);}catch(error){mapped=/mmap|mapping|writ/i.test(String(error));}verify(mapped,'Writable native mmap was not refused');
   }finally{fs.close(stream);fs.unlink('/out/fixture');}return{used:budget.used,limit:budget.limit,actualRuntime:true};
  });
 }finally{for(const value of engines)await value.dispose();for(const worker of [...live])worker.terminate();window.Worker=OriginalWorker;for(const name of owned)await root.removeEntry(name,{recursive:true});}
 for(const id of selected)verify(cases.some(item=>item.id===id),'Unknown or unavailable selected case: '+id);return{cases,pass:cases.filter(c=>c.status==='PASS').length,fail:cases.filter(c=>c.status!=='PASS').length};
}
try{page=await openBrowserSession(endpoint,url);Object.assign(report,await page.evaluate('('+checks.toString()+')('+JSON.stringify(get('--cases','').split(',').filter(Boolean))+')',240000));report.status=report.fail===0?'PASS':'FAIL';}
catch(error){report.error=String(error);}
finally{try{await page?.close();report.pageClosed=true;}catch(error){report.status='FAIL';report.cleanupError=String(error);}await writeFile(join(output,'evidence.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(report.status!=='PASS')process.exitCode=1;}
