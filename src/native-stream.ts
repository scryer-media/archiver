import type {CreateOptions,ExtractionOptions} from '../engine/client';
export type StreamDirection='compress'|'decompress';
const formats:Record<string,string>={gz:'gzip',gzip:'gzip',deflate:'deflate-raw',zlib:'deflate',br:'brotli',brotli:'brotli',zstd:'zstd',zst:'zstd'};
export function nativeStreamFormat(format:string,direction:StreamDirection):string|undefined{
 const value=formats[format];if(!value)return;
 const Constructor=direction==='compress'?globalThis.CompressionStream:globalThis.DecompressionStream;
 if(typeof Constructor!=='function')return;
 try{new Constructor(value as CompressionFormat);return value;}catch{return;}
}
export function chooseNativeStream(format:string,direction:StreamDirection,options:CreateOptions|ExtractionOptions={},direct=false):boolean{
 const backend=options.streamBackend??'auto';if(!['auto','native','wasm'].includes(backend))throw Error('Unknown stream backend');
 if(backend==='wasm')return false;
 const creation=options as CreateOptions;
 const tuned=direction==='compress'&&(creation.level!==undefined||creation.dictionarySize!==undefined||!!creation.filter&&creation.filter!=='none'||creation.deltaDistance!==undefined||!!creation.fileOptions?.length);
 if(tuned){if(backend==='native')throw Error('Browser compression does not support explicit compression tuning; choose WASM');return false;}
 const supported=!!nativeStreamFormat(format,direction);
 if(backend==='native'&&!supported)throw Error('This browser does not support the selected native stream format');
 // Native decompression can reject valid multi-member streams. Automatic
 // retry is safe only when an existing private output stage owns all bytes.
 return supported&&(backend==='native'||direction==='compress'||!direct);
}
export class NativeStreamCodecError extends Error {readonly nativeCodecError=true;}
export function browserStream(file:Blob,format:string,direction:StreamDirection,onInput:(bytes:number)=>void):ReadableStream<Uint8Array>{
 const selected=nativeStreamFormat(format,direction);if(!selected)throw Error('Native stream format is unavailable');
 const Constructor=direction==='compress'?CompressionStream:DecompressionStream;
 const input=file.stream().getReader();let sourceFailed=false,processed=0;
 const source=new ReadableStream<Uint8Array<ArrayBuffer>>({async pull(controller){try{const chunk=await input.read();if(chunk.done){controller.close();input.releaseLock();}else{processed+=chunk.value.byteLength;onInput(processed);controller.enqueue(chunk.value);}}catch(error){sourceFailed=true;controller.error(error);}},async cancel(reason){try{await input.cancel(reason);}finally{input.releaseLock();}}},{highWaterMark:0});
 const reader=source.pipeThrough(new Constructor(selected as CompressionFormat)).getReader();
 return new ReadableStream<Uint8Array>({async pull(controller){try{const chunk=await reader.read();if(chunk.done){controller.close();reader.releaseLock();}else controller.enqueue(chunk.value);}catch(error){if(!sourceFailed&&direction==='decompress'&&error instanceof Error&&['TypeError','DataError'].includes(error.name))controller.error(new NativeStreamCodecError(error.message||'Browser decoder rejected compressed stream'));else controller.error(error);}},async cancel(reason){try{await reader.cancel(reason);}finally{reader.releaseLock();}}},{highWaterMark:0});
}
