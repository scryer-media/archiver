export interface InputReadMetrics { readCalls:number; backingReads:number; backingBytes:number; cacheHitBytes:number; peakCacheBytes:number }
const READ_WINDOW=4*1024*1024,MAX_CACHE=8*1024*1024;
// File objects are immutable snapshots. Keep only two completed read windows;
// decoder reads no longer require a separate browser Blob/FD lifecycle each time.
export function cachedInputReads(workerfs:any):{read:(stream:any,buffer:Uint8Array,offset:number,length:number,position:number)=>number;metrics:InputReadMetrics} {
 const metrics:InputReadMetrics={readCalls:0,backingReads:0,backingBytes:0,cacheHitBytes:0,peakCacheBytes:0};
 const windows:{node:any;start:number;bytes:Uint8Array}[]=[];
 return {metrics,read(stream,buffer,offset,length,position){
  metrics.readCalls++;
  const node=stream.node,size=node.size;
  if(![offset,length,position,size].every(value=>Number.isSafeInteger(value)&&value>=0)||offset+length>buffer.byteLength||!Number.isSafeInteger(offset+length))throw Error('Invalid archive input read range');
  if(position>=size||length===0)return 0;
  const count=Math.min(length,size-position);let copied=0;
  while(copied<count){
   const at=position+copied,start=Math.floor(at/READ_WINDOW)*READ_WINDOW;
   let index=windows.findIndex(window=>window.node===node&&window.start===start),hit=index>=0,window;
   if(hit){window=windows.splice(index,1)[0];}
   else{
    while(windows.length>=2)windows.shift();
    const end=Math.min(size,start+READ_WINDOW),chunk=node.contents.slice(start,end);
    const bytes=new Uint8Array(workerfs.reader.readAsArrayBuffer(chunk));
    metrics.backingReads++;metrics.backingBytes+=bytes.byteLength;
    if(bytes.byteLength!==end-start)throw Error('Archive input changed or returned an incomplete read');
    window={node,start,bytes};
   }
   windows.push(window!);while(windows.reduce((sum,item)=>sum+item.bytes.byteLength,0)>MAX_CACHE)windows.shift();
   metrics.peakCacheBytes=Math.max(metrics.peakCacheBytes,windows.reduce((sum,item)=>sum+item.bytes.byteLength,0));
   const within=at-start,amount=Math.min(count-copied,window!.bytes.byteLength-within);
   if(amount<=0)throw Error('Archive input window made no progress');
   buffer.set(window!.bytes.subarray(within,within+amount),offset+copied);if(hit)metrics.cacheHitBytes+=amount;copied+=amount;
  }
  return count;
 }};
}
// Mount inputs lazily without WORKERFS's prototype-bearing parent cache.
export function mountInputs(module:any,files:File[],names:string[]):InputReadMetrics {
  const fs=module.FS,workerfs=module.WORKERFS;
  fs.mkdir('/input');fs.mount(workerfs,{},'/input');
  const reads=cachedInputReads(workerfs);
  const root=fs.lookupPath('/input').node;
  root.contents=Object.create(null);
  const directoryMode=root.mode,fileMode=(directoryMode&0o7777)|0o100000;
  for(let index=0;index<files.length;index++){
    const parts=names[index].split('/'),name=parts.pop()!;let parent=root;
    for(const part of parts){
      let child=parent.contents[part];
      if(!child){child=workerfs.createNode(parent,part,directoryMode,0);child.contents=Object.create(null);}
      if(!fs.isDir(child.mode))throw new Error('Input file/directory path collision: '+names[index]);
      parent=child;
    }
    if(parent.contents[name])throw new Error('Input file/directory path collision: '+names[index]);
    const node=workerfs.createNode(parent,name,fileMode,0,files[index],new Date(files[index].lastModified));
    node.stream_ops={...node.stream_ops,read:reads.read};
  }
  return reads.metrics;
}
export function protectMemoryDirectories(module:any,node:any):void {
  if(!module.FS.isDir(node.mode))return;
  node.contents=Object.assign(Object.create(null),node.contents);
  const base=node.node_ops;
  node.node_ops={...base,mknod:(parent:any,name:string,mode:number,dev:number)=>{
    const child=base.mknod(parent,name,mode,dev);protectMemoryDirectories(module,child);return child;
  }};
}
