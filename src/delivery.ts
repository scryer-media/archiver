export type DeliveryChoice='auto'|'download'|'files';
export interface DeliveryEntry {name:string;size:number;isDirectory:boolean}
export interface DeliveryContext {mode:'extract'|'create';choice:DeliveryChoice;format:string;inputNames:string[];inputFormatHint?:string;inputBytes:number;maxInputFileBytes?:number;inputCount:number;directoryCount:number;entries?:DeliveryEntry[];available:boolean;unavailableReason?:string;/** False when the browser cannot write to a folder; undefined is treated as true. */folderAccess?:boolean}
export interface DeliveryDecision {stream:boolean;blocked:boolean;reason:string;eligible:boolean;requiresInspection?:boolean;/** Stream every extracted file as one ZIP download. */zip?:boolean}
export const LARGE_DELIVERY_BYTES=128*1024*1024;
const nativeStreams=new Set(['gz','gzip','bz2','bzip2','xz','lzma','zstd','zst','br','brotli','lz4','deflate','zlib']);
export const compressedTar=(name:string)=>/(?:\.tar\.(?:gz|bz2|bzip2|xz|lzma|zst|zstd|br|lz4|deflate|zlib)|\.tgz)$/i.test(name);
export const intrinsicRawStream=(names:string[],hint?:string)=>names.length===1&&!compressedTar(names[0])&&(!!hint&&nativeStreams.has(hint)||/\.(?:gz|bz2|bzip2|xz|lzma|zst|zstd|br|lz4|deflate|zlib)$/i.test(names[0]));
/** Delivery policy never replaces an explicitly requested stream with staged output. */
export function chooseDelivery(context:DeliveryContext):DeliveryDecision{
 const result=(eligible:boolean,reason:string,large=false):DeliveryDecision=>{
  const requested=context.choice==='download'||context.choice==='auto'&&large;
  if(!eligible)return {stream:false,blocked:context.choice==='download',eligible:false,reason};
  if(!context.available)return {stream:false,blocked:context.choice==='download',eligible:true,reason:context.unavailableReason||'Streamed downloads are unavailable in this browser.'};
  return {stream:requested,blocked:false,eligible:true,reason:requested?'Transfers directly to your browser’s Downloads. Completion on disk is shown by the browser.':'Prepare files in browser storage, then choose where to save them.'};
 };
 if(context.mode==='create'&&(context.format==='tar'||context.format.startsWith('tar.'))&&(!Number.isSafeInteger(context.maxInputFileBytes??0)||(context.maxInputFileBytes??0)<0))return {stream:false,blocked:true,eligible:false,reason:'This file size is not supported by this browser.'};
 if(context.choice==='files')return {stream:false,blocked:false,eligible:true,reason:'Prepare files in browser storage, then choose where to save them.'};
 if(context.mode==='create'){
  if(context.format.startsWith('tar.')&&nativeStreams.has(context.format.slice(4))){const decision=result(true,'',context.inputBytes>=LARGE_DELIVERY_BYTES);return {...decision,reason:decision.reason+' Temporary TAR storage is required.'};}
  if(!['zip','tar',...nativeStreams].includes(context.format))return result(false,'This format needs seekable output or creates multiple recovery files. Prepare files to save, or choose a stream-compatible format.');
  if(nativeStreams.has(context.format)&&(context.inputCount!==1||context.directoryCount>0))return result(false,'A standalone compression stream takes exactly one file and no folders.');
  return result(true,'',context.inputBytes>=LARGE_DELIVERY_BYTES);
 }
 // Several files, or folders, go out as one ZIP: when asked for a download, and by default where the browser cannot write to a folder.
 const wantsZip=context.choice==='download'||context.choice==='auto'&&context.folderAccess===false;
 const zip=():DeliveryDecision=>context.available?{stream:true,zip:true,blocked:false,eligible:true,reason:'Downloads as one .zip that keeps every file and folder.'}:{stream:false,blocked:context.choice==='download',eligible:true,reason:context.unavailableReason||'Streamed downloads are unavailable in this browser.'};
 if(context.inputNames.some(compressedTar))return wantsZip?zip():result(false,'Compressed TAR extraction needs an intermediate TAR file. Use Extract to folder or prepare files to save.');
 if(!context.entries){if(intrinsicRawStream(context.inputNames,context.inputFormatHint))return result(true,'',context.inputBytes>=LARGE_DELIVERY_BYTES);return {...result(false,'Open the archive first to check whether it contains one regular file.'),requiresInspection:true};}
 const files=context.entries.filter(entry=>!entry.isDirectory);
 if(files.length!==1||context.entries.some(entry=>entry.isDirectory))return wantsZip?zip():result(false,'Streamed download extracts one regular file. Use Extract to folder or prepare files for an archive with multiple files.');
 return result(true,'',files[0].size>=LARGE_DELIVERY_BYTES);
}
