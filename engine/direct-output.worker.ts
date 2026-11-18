import { destinationParent, destinationDirectory, destinationPathRegistry } from './destination';
import { ZipStream } from './zip-stream';
let root: FileSystemDirectoryHandle;
let download:WritableStreamDefaultWriter<Uint8Array>|undefined,downloadPath:string|undefined,downloadPosition=0,downloadClosed=false;
// Set when a download packs every extracted file into one ZIP instead of carrying a single file.
let zip:ZipStream|undefined;
let state: Int32Array, payload: Uint8Array, progress: MessagePort | undefined;
const writers = new Map<string, FileSystemWritableFileStream>();
const registerPath=destinationPathRegistry();
let written = 0, lastProgress = 0, filesProcessed=0;
let totals:{totalBytes:number;totalFiles:number}|undefined;
const completed=new Set<string>();
const report=(finalizing=false,force=false)=>{
  if(!force&&performance.now()-lastProgress<250)return;
  lastProgress=performance.now();
  progress?.postMessage(finalizing
    ? {phase:'finalizing',message:'Committing file to selected folder',outputBytes:written,writtenBytes:written,filesProcessed,totalFiles:totals?.totalFiles}
    : {phase:'extract-output',message:download?'Sending bytes to browser download':'Writing extracted bytes to selected folder',processedBytes:written,totalBytes:totals&&written<=totals.totalBytes?totals.totalBytes:undefined,unit:'output',outputBytes:written,writtenBytes:written,filesProcessed,totalFiles:totals?.totalFiles});
};
const open = async (path: string) => {
  let writer = writers.get(path);
  if (!writer) {
    const {directory,name} = await destinationParent(root,path);
    try {
      await directory.getFileHandle(name);
      throw new Error('Extraction destination already exists: '+path);
    } catch(error) {
      if((error as Error).name!=='NotFoundError')throw error;
    }
    const handle = await directory.getFileHandle(name,{create:true});
    writer = await handle.createWritable({keepExistingData:true}); writers.set(path,writer);
  }
  return writer;
};
const commit=async(path:string,writer:FileSystemWritableFileStream)=>{
  const notice=setTimeout(()=>report(true,true),250);
  try{await writer.close();writers.delete(path);if(!completed.has(path)){completed.add(path);filesProcessed++;}}
  finally{clearTimeout(notice);}
  report();
};
const handleMessage = async ({data}:MessageEvent) => {
  if (data.init) {
    download=data.download?.getWriter();if(download&&data.zip){const sink=download;zip=new ZipStream(bytes=>sink.write(bytes));}root=data.directory;state=new Int32Array(data.shared,0,4);payload=new Uint8Array(data.shared,16);progress=data.progress;totals=data.totals;report(false,true);
    if(data.commandPort)data.commandPort.onmessage=handleMessage;
    self.postMessage({ready:true});return;
  }
  // Slot 2 proves the helper is alive while native disk operations are pending.
  const heartbeat=setInterval(()=>{Atomics.add(state,2,1);Atomics.notify(state,0);},1000);
  try {
    const {op,path,position,length}=data;
    if(op==='totals'){totals={totalBytes:position,totalFiles:length};report(false,true);Atomics.store(state,1,0);return;}
    if(path)registerPath(path);
    if(zip){
      // Files arrive one after another and are written front to back; anything else cannot be streamed.
      if(op==='mkdir')await zip.directory(path);
      else if(op==='time')zip.setTime(path,position);
      else if(op==='open'){if(downloadClosed)throw new Error('ZIP download is already finished');if(zip.current!==path){if(zip.has(path))throw new Error('ZIP download output must be sequential');await zip.begin(path);filesProcessed=zip.fileCount-1;}}
      else if(op==='write'){if(downloadClosed||path!==zip.current||position!==zip.currentSize||length<0||length>payload.length)throw new Error('ZIP download output must be sequential');await zip.write(payload.slice(0,length));written+=length;report();}
      else if(op==='truncate'){if(path===zip.current?length!==zip.currentSize:length!==0||zip.has(path))throw new Error('ZIP download output cannot be truncated');}
      else if(op==='close'){ /* An entry ends when the next one starts or the download finishes. */ }
      else if(op==='finish'){await zip.finish();await download!.close();downloadClosed=true;filesProcessed=zip.fileCount;report(false,true);}
      else throw new Error('ZIP download output cannot perform this file operation');
      Atomics.store(state,1,0);return;
    }
    if(download){
      if(op==='mkdir'){ /* Parent paths are flattened to the selected download name. */ }
      else if(op==='open'){if(downloadClosed||downloadPath&&downloadPath!==path)throw new Error('Download requires exactly one output file');downloadPath=path;}
      else if(op==='write'){if(downloadClosed||path!==downloadPath||position!==downloadPosition||length<0||length>payload.length)throw new Error('Download output must be sequential');await download.write(payload.slice(0,length));downloadPosition+=length;written+=length;report();}
      else if(op==='truncate'){if(length!==downloadPosition)throw new Error('Download output cannot be truncated');}
      else if(op==='close'){ /* Commit only after the native operation reports success. */ }
      else if(op==='finish'){if(!downloadPath)throw new Error('Download produced no output file');await download.close();downloadClosed=true;filesProcessed=1;report(false,true);}
      else throw new Error('Download output cannot perform this file operation');
      Atomics.store(state,1,0);return;
    }
    if(op==='mkdir') await destinationDirectory(root,path);
    else if(op==='open') await open(path);
    else if(op==='write') {
      const writer=await open(path);await writer.seek(position);await writer.write(payload.slice(0,length));written+=length;
      report();
    }
    else if(op==='truncate') await (await open(path)).truncate(length);
    else if(op==='close') {const writer=writers.get(path);if(writer){await commit(path,writer);}}
    else if(op==='unlink') {const writer=writers.get(path);if(writer){await writer.abort();writers.delete(path);}const {directory,name}=await destinationParent(root,path);await directory.removeEntry(name);}
    else if(op==='finish') {report(true,true);for(const [path,writer] of writers)await commit(path,writer);writers.clear();report(false,true);report(true,true);}
    else throw new Error('Unsupported direct output operation');
    Atomics.store(state,1,0);
  } catch(error) {
    const bytes=new TextEncoder().encode((error as Error).message || String(error));payload.set(bytes.subarray(0,payload.length));Atomics.store(state,1,Math.min(bytes.length,payload.length));
  } finally {clearInterval(heartbeat);Atomics.store(state,0,1);Atomics.notify(state,0);}
};

self.onmessage=handleMessage;
