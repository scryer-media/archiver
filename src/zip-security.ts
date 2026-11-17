import {BlobReader,ZipReader,type Entry,type FileEntry} from '@zip.js/zip.js';
import {destinationPathRegistry} from '../engine/destination';
import type {EntryMetadata,ExtractionOptions} from '../engine/client';
import {resolveArchiveLinks,MAX_LINK_BYTES,timestamp} from './archive-metadata';

export type StrictZipEntry=Entry&Pick<FileEntry,'getData'>;
export const ZIP_LIMITS={metadataRead:64*1024*1024,metadataTotal:128*1024*1024,entries:250000} as const;
export const ZIP_STRICT_OPTIONS={strictness:'strict',checkLocalDirectory:true,checkLocalFilename:true,checkOverlappingEntry:true,checkCrc32:true,checkAuthenticationCode:true,checkSignature:true,maxAppendedDataSize:0} as const;

class BudgetedBlobReader extends BlobReader {
 private metadata=true;
 private metadataBytes=0;
 private file:Blob;
 constructor(file:Blob){super(file);this.file=file;}
 finishMetadata(){this.metadata=false;}
 async readUint8Array(index:number,length:number):Promise<Uint8Array>{
  if(!Number.isSafeInteger(index)||!Number.isSafeInteger(length)||index<0||length<0||!Number.isSafeInteger(index+length)||index+length>this.file.size)throw Error('ZIP metadata/data range is out of bounds');
  if(this.metadata){
   if(length>ZIP_LIMITS.metadataRead)throw Error('ZIP metadata read exceeds the 64 MiB limit');
   this.metadataBytes+=length;
   if(this.metadataBytes>ZIP_LIMITS.metadataTotal)throw Error('ZIP header reads exceed the 128 MiB metadata budget');
  }
  return super.readUint8Array(index,length);
 }
}

export function validateZipPaths(entries:{filename:string;directory:boolean}[]):void{
 if(entries.length>ZIP_LIMITS.entries)throw Error('ZIP entry count exceeds the 250000-entry metadata limit');
 const names=new Map<string,boolean>(),register=destinationPathRegistry();
 for(const entry of entries){
  const name=entry.filename.replace(/\/$/,'');
  if(!name||name.startsWith('/')||/[\\\0:]/.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/[\x00-\x1f]/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))throw Error('Unsafe ZIP archive path: '+entry.filename);
  if(names.has(name))throw Error('Duplicate ZIP output path: '+name);
  register(name);names.set(name,entry.directory);
 }
 for(const name of names.keys()){let slash=name.indexOf('/');while(slash!==-1){if(names.get(name.slice(0,slash))===false)throw Error('ZIP file/directory path collision: '+name);slash=name.indexOf('/',slash+1);}}
}

export async function openStrictZip(file:Blob,password?:string,options:ExtractionOptions={}){
 const input=new BudgetedBlobReader(file),reader=new ZipReader(input,{...ZIP_STRICT_OPTIONS,password});
 try{
  const entries:StrictZipEntry[]=[];let totalBytes=0;
  for await(const candidate of reader.getEntriesGenerator()){
   const entry=candidate as StrictZipEntry;
   if(typeof entry.getData!=='function')throw Error('ZIP entry does not expose header inspection');
   if(entries.length>=ZIP_LIMITS.entries)throw Error('ZIP entry count exceeds the 250000-entry metadata limit');
   const kind=(entry.externalFileAttributes>>>16)&0o170000;
   if((entry.symlink||kind===0o120000)&&options.links!=='copy-safe'||kind&&![0o100000,0o040000,0o120000].includes(kind))throw Error('ZIP links and special file types are not extracted');
   if((entry.symlink||kind===0o120000)&&entry.directory)throw Error('ZIP directory links are not materialized');
   if(!Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize<0||!Number.isSafeInteger(entry.compressedSize)||entry.compressedSize<0)throw Error('Invalid ZIP entry size');
   if(entry.directory&&entry.uncompressedSize!==0)throw Error('ZIP directory contains unexpected file data');
   totalBytes+=entry.uncompressedSize;if(!Number.isSafeInteger(totalBytes))throw Error('ZIP expanded size exceeds browser numeric precision');
   entries.push(entry);
  }
  validateZipPaths(entries);
  for(const entry of entries){
   // Header-only preflight does not decrypt or authenticate content. Supplying a
   // placeholder only permits encrypted metadata inspection without a password;
   // the real extraction still requires and authenticates the actual password.
   // The runtime supports an absent writer for this mode; its public type does not.
   await Reflect.apply(entry.getData,entry,[undefined,{...ZIP_STRICT_OPTIONS,password:password||'header-preflight-only',checkOverlappingEntryOnly:true}]);
  }
  let targetBytes=0;for(const entry of entries)if(entry.symlink||((entry.externalFileAttributes>>>16)&0o170000)===0o120000){if(entry.uncompressedSize>MAX_LINK_BYTES)throw Error('ZIP link target exceeds16KiB limit');targetBytes+=entry.uncompressedSize;if(targetBytes>4*1024*1024)throw Error('ZIP aggregate link target budget exceeds4MiB');}
  const actualTargets={written:0,limit:4*1024*1024},metadata=new Map<string,EntryMetadata>();
  for(const entry of entries){
   const value:EntryMetadata={};const dates=[['modifiedTime',entry.lastModDate],['createdTime',entry.creationDate],['accessedTime',entry.lastAccessDate]] as const;
   for(const [key,date]of dates){const number=timestamp(date?.getTime());if(number!==undefined)value[key]=number;}
   if(entry.unixMode!==undefined)value.unixMode=entry.unixMode;if(entry.msdosAttributesRaw!==undefined)value.windowsAttributes=entry.msdosAttributesRaw;
   if(entry.uid!==undefined)value.uid=entry.uid;if(entry.gid!==undefined)value.gid=entry.gid;
   if(entry.symlink||((entry.externalFileAttributes>>>16)&0o170000)===0o120000){
    if(entry.uncompressedSize>MAX_LINK_BYTES)throw Error('ZIP link target exceeds16KiB limit');
    const chunks:Uint8Array[]=[];const sink=new WritableStream<Uint8Array>({write(chunk){chunks.push(chunk.slice());}});
    await entry.getData!(exactZipOutput(sink,entry.uncompressedSize,actualTargets),{...ZIP_STRICT_OPTIONS,password});
    value.link={kind:'symbolic',target:new TextDecoder('utf-8',{fatal:true}).decode(await new Blob(chunks as Uint8Array<ArrayBuffer>[]).arrayBuffer())};
   }
   metadata.set(entry.filename,value);
  }
  const nodes=entries.map(entry=>({name:entry.filename.replace(/\/$/,''),isDirectory:entry.directory,isLink:!!metadata.get(entry.filename)?.link,metadata:metadata.get(entry.filename),entry}));
  const resolved=resolveArchiveLinks(nodes,options.links),sources=new Map(entries.filter(entry=>!entry.directory).map(entry=>[entry.filename,resolved.get(entry.filename.replace(/\/$/,''))!.entry]));
  totalBytes=0;for(const entry of entries)if(!entry.directory){totalBytes+=sources.get(entry.filename)!.uncompressedSize;if(!Number.isSafeInteger(totalBytes))throw Error('ZIP expanded size exceeds browser numeric precision');}
  input.finishMetadata();return{reader,entries,totalBytes,metadata,sources};
 }catch(error){await reader.close();throw error;}
}

export function exactZipOutput(target:WritableStream<Uint8Array>,expected:number,total:{written:number;limit:number}):WritableStream<Uint8Array>{
 const downstream=target.getWriter();let written=0,stopped=false;
 const stop=async(reason:unknown)=>{if(stopped)return;stopped=true;try{await downstream.abort(reason);}finally{downstream.releaseLock();}};
 return new WritableStream<Uint8Array>({
  async write(chunk){
   if(!Number.isSafeInteger(written+chunk.byteLength)||written+chunk.byteLength>expected||total.written+chunk.byteLength>total.limit){const error=Error('ZIP actual output exceeds its validated declared size');await stop(error);throw error;}
   try{await downstream.write(chunk);}catch(error){await stop(error).catch(()=>{});throw error;}written+=chunk.byteLength;total.written+=chunk.byteLength;
  },
  async close(){if(written!==expected){const error=Error('ZIP actual output size mismatch');await stop(error);throw error;}try{await downstream.close();}finally{stopped=true;downstream.releaseLock();}},
  abort:stop,
 });
}
