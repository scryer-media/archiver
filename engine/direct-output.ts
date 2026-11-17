const CAPACITY=1024*1024;
// Individual commit bounds cover the 100 GB validation target, not arbitrary sizes or a whole job.
const INACTIVITY_TIMEOUT=120000,OPERATION_TIMEOUT=10*60*1000,COMMIT_TIMEOUT=6*60*60*1000;
export class DirectOutput {
  private shared:SharedArrayBuffer;
  private state:Int32Array;
  private payload:Uint8Array;
  private worker:Worker|MessagePort;
  private failure?: Error;
  count=0;
  writtenBytes=0;
  private pending?: {path:string;position:number;length:number};
  private constructor(private module:any,bridge?:{shared:SharedArrayBuffer;port:MessagePort}) {
    this.shared=bridge?.shared??new SharedArrayBuffer(16+CAPACITY);
    this.state=new Int32Array(this.shared,0,4);this.payload=new Uint8Array(this.shared,16);
    this.worker=bridge?.port??new Worker(new URL('./direct-output.worker.ts',import.meta.url),{type:'module'});
  }
  static async create(module:any,directory:FileSystemDirectoryHandle,progress?:MessagePort,totals?:{totalBytes:number;totalFiles:number}):Promise<DirectOutput>{
    if(!self.crossOriginIsolated || typeof SharedArrayBuffer==='undefined')throw new Error('Direct native extraction requires cross-origin isolation headers. Use a configured local server or the ordinary extraction workflow.');
    const output=new DirectOutput(module);
    try{await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Direct output worker did not initialize')),30000);
      output.worker.onmessage=({data})=>{if(data.ready){clearTimeout(timer);resolve();}};
      (output.worker as Worker).onerror=event=>{clearTimeout(timer);reject(new Error(event.message||'Direct output worker failed'));};
      output.worker.postMessage({init:true,directory,shared:output.shared,progress,totals},progress?[progress]:[]);
    });return output;}catch(error){output.close();throw error;}
  }
  static downloadBridge(module:any,bridge:{shared:SharedArrayBuffer;port:MessagePort},totals?:{totalBytes:number;totalFiles:number}):DirectOutput{
    const output=new DirectOutput(module,bridge);
    if(totals)output.call('totals','',totals.totalBytes,totals.totalFiles);
    return output;
  }
  private flush():void{
    const pending=this.pending;this.pending=undefined;
    if(pending)this.call('write',pending.path,pending.position,pending.length);
  }
  private call(op:string,path='',position=0,length=0):void{
    if(op!=='write')this.flush();
    if(this.failure)throw this.failure;
    Atomics.store(this.state,0,0);Atomics.store(this.state,1,0);
    const started=performance.now(),limit=op==='close'||op==='finish'?COMMIT_TIMEOUT:OPERATION_TIMEOUT;
    let heartbeat=Atomics.load(this.state,2),lastActivity=started;
    this.worker.postMessage({op,path,position,length});
    for(;;){
      const acknowledgement=Atomics.load(this.state,0);
      if(acknowledgement===1)break;
      if(acknowledgement!==0){this.failure=new Error('Direct disk output returned an invalid acknowledgement');break;}
      const now=performance.now(),currentHeartbeat=Atomics.load(this.state,2);
      if(currentHeartbeat!==heartbeat){heartbeat=currentHeartbeat;lastActivity=now;}
      const remaining=Math.min(INACTIVITY_TIMEOUT-(now-lastActivity),limit-(now-started));
      if(remaining<=0){
        if(Atomics.load(this.state,0)===1)break;
        this.failure=new Error(now-started>=limit?'Direct disk output exceeded its time limit before completion':'Direct disk output stopped responding before completion');
        break;
      }
      Atomics.wait(this.state,0,0,remaining);
    }
    const errorBytes=Atomics.load(this.state,1);
    if(errorBytes)this.failure=new Error('Could not write extraction destination: '+new TextDecoder().decode(this.payload.slice(0,errorBytes)));
    if(this.failure)throw this.failure;
  }
  mount(path:string):void{
    const fs=this.module.FS,memory=fs.lookupPath('/').node.mount.type;
    const decorate=(node:any):any=>{
      const base=node.node_ops;
      const relative=(node:any):string=>fs.getPath(node).slice(path.length+1);
      if(fs.isDir(node.mode)){node.contents=Object.assign(Object.create(null),node.contents);node.node_ops={...base,
        mknod:(parent:any,name:string,mode:number,dev:number)=>{
          const child=decorate(base.mknod(parent,name,mode,dev));
          if(fs.isDir(mode)){if(relative(child)!=='.work')this.call('mkdir',relative(child));}
          else if(!fs.isFile(mode))throw new fs.ErrnoError(63);else this.count++;
          return child;
        },
        rename:()=>{throw new fs.ErrnoError(63);},
        symlink:()=>{throw new fs.ErrnoError(63);},
        unlink:(parent:any,name:string)=>{this.call('unlink',relative(fs.lookupNode(parent,name)));base.unlink(parent,name);},
      };}
      else if(fs.isFile(node.mode)){
        let size=0;
        node.node_ops={...base,getattr:(n:any)=>({...base.getattr(n),size,blocks:Math.ceil(size/512)}),setattr:(n:any,attrs:any)=>{
          if(attrs.size!==undefined){this.call('truncate',relative(n),0,attrs.size);size=attrs.size;}
          const metadata={...attrs};delete metadata.size;base.setattr(n,metadata);
        }};
        node.stream_ops={...node.stream_ops,
          open:()=>this.call('open',relative(node)),close:()=>this.call('close',relative(node)),
          read:()=>{throw new fs.ErrnoError(63);},
          write:(_stream:any,buffer:Uint8Array,offset:number,length:number,position:number)=>{
            if(!Number.isSafeInteger(position+length)||position<0)throw new Error('Invalid direct disk offset');
            for(let done=0;done<length;){
              const name=relative(node);
              if(this.pending&&(this.pending.path!==name||this.pending.position+this.pending.length!==position+done))this.flush();
              this.pending??={path:name,position:position+done,length:0};
              const count=Math.min(CAPACITY-this.pending.length,length-done);
              this.payload.set(buffer.subarray(offset+done,offset+done+count),this.pending.length);
              this.pending.length+=count;done+=count;
              if(this.pending.length===CAPACITY)this.flush();
            }
            this.writtenBytes+=length;size=Math.max(size,position+length);return length;
          },
          llseek:(stream:any,offset:number,whence:number)=>{const value=offset+(whence===1?stream.position:whence===2?size:0);if(!Number.isSafeInteger(value)||value<0)throw new fs.ErrnoError(28);return value;},
          mmap:()=>{throw new fs.ErrnoError(43);},
          allocate:()=>{throw new fs.ErrnoError(63);},
        };
      }
      return node;
    };
    fs.mount({mount:(mount:any)=>decorate(memory.mount(mount))},{},path);
  }
  finish():void{this.call('finish');}
  close():void{if('terminate' in this.worker)this.worker.terminate();else this.worker.close();}
}
