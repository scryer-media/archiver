import { DirectOutput } from '../engine/direct-output';
const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
self.onmessage=async()=>{try{
 const url=new URL('/engine/archive-engine.js',location.origin).href,{default:createModule}=await import(/* @vite-ignore */ url);
 const module=await createModule({locateFile:(name:string)=>'/engine/'+name,print:()=>{},printErr:()=>{}}),fs=module.FS;
 const original=self.Worker,commands:any[]=[];let fail='',hold=false;
 (self as any).Worker=class{
  onmessage?: (event:any)=>void;onerror?: (event:any)=>void;state?:Int32Array;payload?:Uint8Array;
  postMessage(data:any){if(data.init){this.state=new Int32Array(data.shared,0,4);this.payload=new Uint8Array(data.shared,16);queueMicrotask(()=>this.onmessage?.({data:{ready:true}}));return;}
   commands.push({...data,bytes:data.op==='write'?this.payload!.slice(0,data.length):undefined});
   if(hold)return;
   if(data.op===fail){const bytes=new TextEncoder().encode('injected disk '+fail+' failure');this.payload!.set(bytes);Atomics.store(this.state!,1,bytes.length);}else Atomics.store(this.state!,1,0);
   Atomics.store(this.state!,0,1);Atomics.notify(this.state!,0);
  }
  terminate(){}
 };
 try{
  const direct=await DirectOutput.create(module,{} as FileSystemDirectoryHandle);fs.mkdir('/direct');direct.mount('/direct');
  const stream=fs.open('/direct/large','w'),offset=2**32+17;
  fs.write(stream,new Uint8Array([4,5,6]),0,3,offset);check(!commands.some(command=>command.op==='write'),'Small writes bypass batching');fs.close(stream);direct.finish();
  const write=commands.find(command=>command.op==='write');check(write.position===offset&&write.bytes.join()==='4,5,6','Direct RPC truncated64bit offset or bytes');
  const next=fs.open('/direct/batched','w');for(let index=0;index<256;index++)fs.write(next,new Uint8Array(8192),0,8192,index*8192);fs.close(next);
  const batches=commands.filter(command=>command.op==='write'&&command.path==='batched');check(batches.length===2&&batches.every(command=>command.length===1024*1024),'Direct buffer is not bounded/coalesced');direct.close();
  const error=await DirectOutput.create(module,{} as FileSystemDirectoryHandle);fs.mkdir('/failed');error.mount('/failed');const failed=fs.open('/failed/data','w');fail='write';let rejected=false,writeError='';try{fs.write(failed,new Uint8Array(1024*1024),0,1024*1024,0);}catch(reason){writeError=String(reason);rejected=/injected disk write/.test(writeError);}check(rejected,'Disk write error not propagated synchronously: '+writeError+' commands='+JSON.stringify(commands.map(command=>({op:command.op,length:command.length,path:command.path}))));error.close();
  fail='';const closing=await DirectOutput.create(module,{} as FileSystemDirectoryHandle);fs.mkdir('/closing');closing.mount('/closing');const closeStream=fs.open('/closing/data','w');fs.write(closeStream,new Uint8Array([1]),0,1,0);fail='close';rejected=false;try{fs.close(closeStream);}catch(reason){rejected=/injected disk close/.test(String(reason));}check(rejected,'Disk close commit failure ignored');rejected=false;try{closing.finish();}catch{rejected=true;}check(rejected,'Finish accepted a failed writer');closing.close();
  fail='';let clock=0,waits=0;
  const nowDescriptor=Object.getOwnPropertyDescriptor(performance,'now'),originalWait=Atomics.wait;
  let onWait:(state:Int32Array,timeout:number)=>string=()=>{throw Error('Unexpected wait');};
  Object.defineProperty(performance,'now',{configurable:true,value:()=>clock});
  (Atomics as any).wait=(state:Int32Array,_index:number,_expected:number,timeout:number)=>{waits++;return onWait(state,timeout);};
  hold=true;
  const probe=async(script:(state:Int32Array,timeout:number)=>string,op='open')=>{
    clock=0;waits=0;onWait=script;const output=await DirectOutput.create(module,{} as FileSystemDirectoryHandle);
    try{(output as any).call(op,'timing');return '';}catch(error){return String(error);}finally{output.close();}
  };
  try{
    let message=await probe(state=>{clock+=60000;if(waits<4)Atomics.add(state,2,1);else Atomics.store(state,0,1);return 'ok';},'close');
    check(!message&&waits===4&&clock===240000,'Live heartbeat returned before completion or hit the old absolute timeout');
    message=await probe((_state,timeout)=>{clock+=timeout;return 'timed-out';});
    check(/stopped responding/.test(message)&&clock===120000,'Dead helper did not hit the inactivity deadline');
    message=await probe(()=>{clock+=60000;return 'ok';});
    check(/stopped responding/.test(message)&&waits===2&&clock===120000,'Spurious notifications extended the inactivity deadline');
    message=await probe(state=>{clock+=60000;Atomics.add(state,2,1);return 'ok';});
    check(/time limit/.test(message)&&clock===600000,'Alive helper with a stuck operation escaped its finite deadline');
    message=await probe((state,timeout)=>{clock+=timeout;Atomics.store(state,0,1);return 'timed-out';},'close');
    check(!message&&waits===1,'Completion racing the inactivity deadline was rejected');
    hold=false;clock=0;waits=0;const immediate=await DirectOutput.create(module,{} as FileSystemDirectoryHandle);
    (immediate as any).call('open','immediate');immediate.close();check(waits===0,'An immediate acknowledgement still waited');
  }finally{
    hold=false;(Atomics as any).wait=originalWait;
    if(nowDescriptor)Object.defineProperty(performance,'now',nowDescriptor);else delete (performance as any).now;
  }
 }finally{self.Worker=original;}
 if(new URL(self.location.href).searchParams.has('slowClose')){
  const helperUrl=new URL('/engine/direct-output.worker.ts',location.origin).href;
  const wrapper=URL.createObjectURL(new Blob([`import ${JSON.stringify(helperUrl)};const nativeClose=FileSystemWritableFileStream.prototype.close;let calls=0;FileSystemWritableFileStream.prototype.close=async function(){const call=++calls;await new Promise(resolve=>setTimeout(resolve,call===1?125000:1100));await nativeClose.call(this);if(call===2)throw Error('injected delayed close failure');};`],{type:'text/javascript'}));
  (self as any).Worker=class extends original{constructor(_url:string|URL,options?:WorkerOptions){super(wrapper,options);}};
  const root=await navigator.storage.getDirectory(),name='direct-heartbeat-'+crypto.randomUUID(),directory=await root.getDirectoryHandle(name,{create:true});
  let output:DirectOutput|undefined;
  try{
    output=await DirectOutput.create(module,directory);fs.mkdir('/slow');output.mount('/slow');
    const stream=fs.open('/slow/bytes','w');fs.write(stream,new Uint8Array([1,2,3]),0,3,0);
    self.postMessage({progress:'Waiting for a real helper close delayed beyond 120 seconds'});
    const started=performance.now();fs.close(stream);const elapsed=performance.now()-started;
    check(elapsed>=125000,'Real delayed close returned prematurely');
    const state=(output as any).state as Int32Array,heartbeat=Atomics.load(state,2);
    check(heartbeat>0,'The real helper never emitted a heartbeat');
    await new Promise(resolve=>setTimeout(resolve,1200));check(Atomics.load(state,2)===heartbeat,'Helper heartbeat continued after success');
    const bytes=new Uint8Array(await (await (await directory.getFileHandle('bytes')).getFile()).arrayBuffer());
    check(bytes.join()==='1,2,3','Delayed close changed output bytes');
    const failing=fs.open('/slow/failure','w');fs.write(failing,new Uint8Array([4]),0,1,0);
    let rejected=false;try{fs.close(failing);}catch(error){rejected=/injected delayed close failure/.test(String(error));}
    check(rejected,'Real helper delayed error payload was lost');
    const afterFailure=Atomics.load(state,2);await new Promise(resolve=>setTimeout(resolve,1200));
    check(Atomics.load(state,2)===afterFailure,'Helper heartbeat continued after failure');
    self.postMessage({progress:'Real delayed close and heartbeat cleanup passed',elapsed});
  }finally{output?.close();self.Worker=original;URL.revokeObjectURL(wrapper);await root.removeEntry(name,{recursive:true});}
 }
 self.postMessage({ok:true});
 }catch(error){self.postMessage({error:String(error)+' '+(error as Error).stack});}};
