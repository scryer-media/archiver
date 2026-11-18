import {WriteBudget,ExpansionGate,outputLimit} from '../engine/output-budget';
import {browserStream,nativeStreamFormat,NativeStreamCodecError} from './native-stream';
import {preserveFileMetadata,timestamp} from './archive-metadata';
import {creationPlans} from '../engine/create-plan';
import type {CreateOptions,ExtractionOptions,ArchiveEntry,EntryMetadata} from '../engine/client';
import {destinationDirectory,destinationParent} from '../engine/destination';
import {ZipWriter,BlobReader,BlobWriter,configure} from '@zip.js/zip.js';
import {ZipStream} from '../engine/zip-stream';
import {openStrictZip,ZIP_STRICT_OPTIONS,exactZipOutput,validateZipPaths} from './zip-security';
import {selectEntries} from '../engine/selection';
configure({useWebWorkers:false});
const safe = (name: string) => {
  const path = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!path || path.startsWith('/') || /[\\\0:]/.test(path) || path.split('/').some(part => !part || part === '..' || part === '.')) throw Error('Unsafe archive path rejected: ' + name);
  return name;
};
function validateTree(entries: { name: string; isDirectory: boolean }[]): void {
  const paths = new Map<string, boolean>();
  for (const entry of entries) {
    safe(entry.name);
    const name = entry.name.replace(/\/$/, '');
    if (paths.has(name)) throw Error('Duplicate archive output path: ' + name);
    paths.set(name, entry.isDirectory);
  }
  for (const name of paths.keys()) {
    let slash = name.indexOf('/');
    while (slash !== -1) {
      if (paths.get(name.slice(0, slash)) === false) throw Error('Archive file/directory path collision: ' + name);
      slash = name.indexOf('/', slash + 1);
    }
  }
}
self.onmessage=async({data})=>{
 const {op,files,password,format,storageId,outputDirectory,downloadStream,creation,extraction,directories=[],names=files.map(file=>file.webkitRelativePath||file.name)}=data as {op:string;files:File[];password?:string;format?:string;storageId:string;creation?:CreateOptions;extraction?:ExtractionOptions;outputDirectory?:FileSystemDirectoryHandle;downloadStream?:WritableStream<Uint8Array>;directories?:string[];names?:string[]};
 let budget:WriteBudget|undefined;
 let directory:FileSystemDirectoryHandle|undefined;
 try{if(!outputDirectory&&!downloadStream)directory=await (await navigator.storage.getDirectory()).getDirectoryHandle(storageId,{create:true});}catch{}
 const memoryLimit=128*1024*1024;let sequence=0,buffered=0;
 const ensureCapacity=async(size:number)=>{if(outputDirectory||downloadStream)return;if(!directory&&size>memoryLimit)throw Error('This browser cannot stream output to local storage. The memory fallback is limited to 128 MB.');if(directory){const estimate=await navigator.storage.estimate();if(estimate.quota!==undefined&&size>estimate.quota-(estimate.usage||0))throw Error('Not enough browser storage for this operation.');}};
 let phase=op,message='Preparing archive operation',unit:'input'|'output'|undefined,totalBytes:number|undefined,totalFiles:number|undefined,processedBytes=0,outputBytes=0,filesProcessed=0,lastProgress=-Infinity;
 const emit=(force=false,commit=false)=>{
  if(!force&&performance.now()-lastProgress<250)return;lastProgress=performance.now();
  self.postMessage({progress:commit
   ? {phase:phase+'-commit',message:downloadStream?'Sending final bytes to browser download':'Committing output file',outputBytes,filesProcessed,totalFiles}
   : {phase,message,unit,processedBytes:unit?processedBytes:undefined,totalBytes:unit&&totalBytes!==undefined&&processedBytes<=totalBytes?totalBytes:undefined,outputBytes,filesProcessed,totalFiles}});
 };
 const begin=(nextPhase:string,nextMessage:string,nextUnit?:'input'|'output',total?:number,count?:number)=>{phase=nextPhase;message=nextMessage;unit=nextUnit;totalBytes=total;totalFiles=count;processedBytes=0;outputBytes=0;filesProcessed=0;emit(true);};
 const inputProgress=(bytes:number)=>{processedBytes=Math.max(processedBytes,bytes);emit();};
 const publish=(result:Record<string,unknown>)=>{if(downloadStream)result={...result,files:[],downloadSent:true,sentBytes:outputBytes};emit(true);self.postMessage({progress:{phase:'finalizing',message:downloadStream?'Sent bytes to browser download':'Preparing completed results',outputBytes,filesProcessed,totalFiles}});self.postMessage({...result,writeBudgetUsed:budget!.used});};
 let downloadUsed=false;
 // A ZIP download carries every extracted file through the one download stream.
 const zipWriter=downloadStream&&extraction?.zipDownload===true?downloadStream.getWriter():undefined;
 const zipOut=zipWriter?new ZipStream(bytes=>zipWriter.write(bytes)):undefined;
 const output = async (name?:string,modified?:number) => {
  if(zipOut){
   if(!name)throw Error('ZIP download entries need a name');
   if(modified!==undefined)zipOut.setTime(name,modified);
   await zipOut.begin(safe(name));
   const writer=new WritableStream<Uint8Array>({
    async write(chunk){
     try{budget!.charge(chunk.byteLength);for(let offset=0;offset<chunk.byteLength;offset+=1024*1024)await zipOut.write(chunk.subarray(offset,offset+1024*1024));outputBytes+=chunk.byteLength;if(unit==='output')processedBytes+=chunk.byteLength;emit();}
     catch(error){await zipWriter!.abort(error).catch(()=>{});throw error;}
    },
    async close(){await zipOut.end();if(unit==='output')filesProcessed++;emit();},
    async abort(reason){await zipWriter!.abort(reason).catch(()=>{});},
   });
   return {writer,finish:()=>new Blob()};
  }
  if(downloadStream&&downloadUsed)throw Error('Download requires exactly one output file');
  if(downloadStream)downloadUsed=true;
  const target=outputDirectory&&name?await destinationParent(outputDirectory,name):undefined;
  if(target){let existing=false;try{await target.directory.getFileHandle(target.name);existing=true;}catch(error){if((error as DOMException).name!=='NotFoundError')throw error;}if(existing)throw Error('Destination already contains an output file or filesystem path alias: '+name);}
  const handle = target ? await target.directory.getFileHandle(target.name,{create:true}) : directory ? await directory.getFileHandle(String(sequence++), { create: true }) : undefined;
  const memory = handle || downloadStream ? undefined : new BlobWriter();
  const sink = downloadStream || (handle ? await handle.createWritable() : memory!.writable);
  const downstream = sink.getWriter();
  let stopped=false;
  const stop=async(reason:unknown)=>{if(stopped)return;stopped=true;try{await downstream.abort(reason);}catch{}finally{try{downstream.releaseLock();}catch{}}};
  const writer = new WritableStream<Uint8Array>({
   async write(chunk) {
    try{
    budget!.charge(chunk.byteLength);
    if (!directory && !outputDirectory && !downloadStream && buffered + chunk.byteLength > memoryLimit) throw Error('Output exceeded the 128 MB memory limit.');
    for(let offset=0;offset<chunk.byteLength;offset+=1024*1024)await downstream.write(chunk.subarray(offset,offset+1024*1024));
    outputBytes+=chunk.byteLength;if(unit==='output')processedBytes+=chunk.byteLength;emit();
    if (!directory && !outputDirectory && !downloadStream) buffered += chunk.byteLength;
    }catch(error){await stop(error);throw error;}
   },
   async close(){const notice=setTimeout(()=>emit(true,true),250);try{await downstream.close();stopped=true;downstream.releaseLock();if(unit==='output')filesProcessed++;}catch(error){await stop(error);throw error;}finally{clearTimeout(notice);}emit();},
   abort: stop,
  });
  return { writer, finish: () => downloadStream ? new Blob() : handle ? handle.getFile() : memory!.getData() };
 };
 try{
 const limit=outputLimit(data.outputLimitBytes??creation?.outputLimitBytes??extraction?.outputLimitBytes),grant=data.writeBudgetGrant??limit;
 if(!Number.isSafeInteger(grant)||grant<0)throw Error('Invalid worker write-budget grant');
 budget=new WriteBudget(Math.min(limit,grant),true);if(data.expansion)budget.gate=new ExpansionGate(data.expansion);
 const progress=(nextMessage:string,_percent?:number)=>{message=nextMessage;emit();};
 progress(directory?'Streaming with local disk storage…':'Using bounded memory storage…');
 const transform=async(file:Blob,compress:boolean,streamFormat='gz',name?:string)=>{begin(compress?'compress-read':'decompress-read',compress?'Compressing':'Decompressing','input',file.size,1);const estimate=directory?await navigator.storage.estimate():undefined;const maximum=Math.min(budget!.remaining,outputDirectory||downloadStream?budget!.limit:directory?Math.max(0,(estimate?.quota??Number.MAX_SAFE_INTEGER)-(estimate?.usage||0)):memoryLimit);const target=await output(name);let bytes=0;const guard=new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){bytes+=chunk.length;if(!Number.isSafeInteger(bytes))throw Error('Stream output exceeds safe byte range');if(bytes>maximum){if(maximum===budget!.remaining)throw budget!.exceeded();throw Error('Stream output exceeds available storage or memory');}if(!directory&&!outputDirectory&&!downloadStream&&bytes>memoryLimit)throw Error('Expanded output exceeded the 128 MB memory limit.');controller.enqueue(chunk);}});await browserStream(file,streamFormat,compress?'compress':'decompress',inputProgress).pipeThrough(guard).pipeTo(target.writer);filesProcessed=1;emit(true,true);return target.finish();};

 if(op==='create'){
  if (!['zip','gz'].includes(format||'zip')&&!nativeStreamFormat(format||'','compress')) throw Error('Unsupported creation format: ' + format);
  validateTree([...names.map(name => ({name,isDirectory:false})),...directories.map(name => ({name,isDirectory:true}))]);
  if (!files.length && !directories.length) throw Error('Choose at least one file or directory');
  const inputSize=files.reduce((a,f)=>a+f.size,0);begin('create-read','Reading selected files','input',inputSize,files.length);await ensureCapacity(inputSize+(files.length+directories.length)*1024+1024);
  if(format==='gz'||nativeStreamFormat(format||'','compress')){if(directories.length)throw Error('GZIP cannot contain directories');if(files.length!==1)throw Error('GZIP takes one file. Choose TAR.GZ to package multiple files.');if(password)throw Error('GZIP does not support archive passwords.');publish({files:[{name:files[0].name+'.'+format,blob:await transform(files[0],true,format)}]});return;}
  {
   validateZipPaths([...names.map(name=>({filename:name,directory:false})),...directories.map(name=>({filename:name,directory:true}))]);
   const plans=creationPlans(names,{...creation,format:'zip',password});
   // Limited metadata: every entry gets the DOS epoch and no extended-timestamp field, so nothing records when the files were made.
   const stamp=creation?.limitedMetadata?{lastModDate:new Date(1980,0,1),extendedTimestamp:false}:{};
   const target=await output(),writer=new ZipWriter(target.writer,{password,encryptionStrength:3});for(const name of directories)await writer.add(name+'/',undefined,{directory:true,...stamp});for(let i=0;i<files.length;i++){const file=files[i];progress('Packing '+file.name);const before=processedBytes;await writer.add(safe(names[i]),new BlobReader(file),{password,encryptionStrength:3,lastModDate:timestamp(file.lastModified)!==undefined?new Date(file.lastModified):undefined,...stamp,compressionMethod:plans[i].codec==='copy'?0:8,level:plans[i].codec==='copy'?0:plans[i].level??6,onprogress:loaded=>inputProgress(before+loaded)});inputProgress(before+file.size);filesProcessed=i+1;emit();}emit(true,true);await writer.close();publish({files:[{name:'archive.zip',blob:await target.finish()}]});
  }return;
 }
 if(format&&nativeStreamFormat(format,'decompress')){if(files.length!==1)throw Error('Standalone streams require one input file');const name=safe(files[0].name.replace(/\.[^.]+$/,''))||'decoded.bin';selectEntries([{name,isDirectory:false,isLink:false}],extraction?.only);const blob=await transform(files[0],false,format,name);publish({files:outputDirectory?[]:[{name,blob}],savedFiles:outputDirectory?1:undefined});return;}
 if(files.length!==1)throw Error('Select a single ZIP archive.');const file:Blob=files[0];
 const zip=await openStrictZip(file,password,extraction);
 try{
  const {entries,totalBytes}=zip;
  const metadata:ArchiveEntry[]=entries.map(entry=>({name:entry.filename,size:entry.directory?0:zip.sources.get(entry.filename)!.uncompressedSize,isDirectory:entry.directory,isLink:!!zip.metadata.get(entry.filename)?.link,metadata:zip.metadata.get(entry.filename)}));
  if(op==='list'){publish({entries:metadata,metadata,files:[]});return;}
  // A selection writes only the named regular files; every entry above was still validated.
  const selection=extraction?.only===undefined?undefined:new Set(selectEntries(metadata,extraction.only).map(entry=>entry.name)),selected=(entry:{filename:string})=>!selection||selection.has(entry.filename);
  const written=entries.filter(entry=>!entry.directory&&selected(entry)),writtenBytes=selection?written.reduce((sum,entry)=>sum+zip.sources.get(entry.filename)!.uncompressedSize,0):totalBytes;
  begin('extract-output','Writing extracted ZIP members','output',writtenBytes,written.length);await ensureCapacity(writtenBytes);
  const totals={written:0,limit:writtenBytes},result:{name:string;blob:Blob;metadata?:EntryMetadata}[]=[];
  for(const entry of entries)if(entry.directory)await entry.getData!(exactZipOutput(new WritableStream<Uint8Array>(),0,totals),{...ZIP_STRICT_OPTIONS,password});
  if(outputDirectory&&!selection)for(const entry of entries)if(entry.directory){await destinationDirectory(outputDirectory,entry.filename.replace(/\/$/,''));}
  if(zipOut&&!selection)for(const entry of entries)if(entry.directory){const name=safe(entry.filename).replace(/\/$/,''),modified=zip.metadata.get(entry.filename)?.modifiedTime;if(modified!==undefined)zipOut.setTime(name,modified);await zipOut.directory(name);}
  // Unselected members are still decoded and checked against their headers, into a discard sink.
  const discarded={written:0,limit:Number.MAX_SAFE_INTEGER};
  for(const entry of entries){if(entry.directory)continue;if(!selected(entry)){const source=zip.sources.get(entry.filename)!;await source.getData!(exactZipOutput(new WritableStream<Uint8Array>(),source.uncompressedSize,discarded),{...ZIP_STRICT_OPTIONS,password});continue;}progress('Extracting '+entry.filename);const target=await output(entry.filename,zip.metadata.get(entry.filename)?.modifiedTime);const source=zip.sources.get(entry.filename)!;await source.getData!(exactZipOutput(target.writer,source.uncompressedSize,totals),{...ZIP_STRICT_OPTIONS,password});if(!outputDirectory&&!downloadStream)result.push({name:entry.filename,blob:preserveFileMetadata(await target.finish(),entry.filename,zip.metadata.get(entry.filename)),metadata:zip.metadata.get(entry.filename)});}
  if(totals.written!==writtenBytes)throw Error('ZIP aggregate output size mismatch');
  if(zipOut){await zipOut.finish();await zipWriter!.close();}
  publish({metadata,savedFiles:outputDirectory?written.length:undefined,directories:selection?[]:entries.filter(entry=>entry.directory).map(entry=>entry.filename.replace(/\/$/,'')),files:result});
 }finally{await zip.reader.close();}
 }catch(error){await zipWriter?.abort(error).catch(()=>{});self.postMessage({writeBudgetUsed:budget?.used??0,outputLimited:!budget?.gate?.stopped&&!!budget?.failure,expansionStopped:!!budget?.gate?.stopped,error:error instanceof Error?(error.message||error.name||'Archive operation failed'):(String(error)||'Archive operation failed'),nativeCodecError:error instanceof NativeStreamCodecError});}
};
