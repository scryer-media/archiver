import {fileTypeFromBuffer} from 'file-type';
import {executableHeader} from './architecture.ts';
import {SNIFF_LIMITS,unknownDetection,type Detection} from './model.ts';
const at=(bytes:Uint8Array,text:string,offset=0)=>[...text].every((char,index)=>bytes[offset+index]===char.charCodeAt(0));
function container(bytes:Uint8Array):{extension:string;mime:string;label:string}|undefined {
 const signatures:[number[],string,string,string][]=[[[0x50,0x4b,3,4],'zip','application/zip','ZIP'],[[0x50,0x4b,5,6],'zip','application/zip','ZIP'],[[0x50,0x4b,7,8],'zip','application/zip','ZIP'],[[0x1f,0x8b],'gz','application/gzip','GZIP'],[[0x37,0x7a,0xbc,0xaf,0x27,0x1c],'7z','application/x-7z-compressed','7z'],[[0x52,0x61,0x72,0x21,0x1a,0x07],'rar','application/x-rar-compressed','RAR'],[[0xfd,0x37,0x7a,0x58,0x5a,0],'xz','application/x-xz','XZ'],[[0x42,0x5a,0x68],'bz2','application/x-bzip2','BZip2'],[[0x28,0xb5,0x2f,0xfd],'zst','application/zstd','Zstandard'],[[4,0x22,0x4d,0x18],'lz4','application/x-lz4','LZ4']];
 for(const[magic,extension,mime,label]of signatures)if(bytes.length>=magic.length&&magic.every((value,index)=>bytes[index]===value))return{extension,mime,label};
}
function rawAudio(bytes:Uint8Array):boolean {
 if(bytes.length<12||!at(bytes,'RIFF')||!at(bytes,'WAVE',8))return false;
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);let pos=12;
 for(let chunks=0;chunks<64&&pos+8<=bytes.length;chunks++){
  const size=view.getUint32(pos+4,true);if(at(bytes,'fmt ',pos)&&size>=16&&pos+24<=bytes.length){const format=view.getUint16(pos+8,true),channels=view.getUint16(pos+10,true),bits=view.getUint16(pos+22,true);return[1,3].includes(format)&&channels>0&&channels<=32&&bits>0&&bits<=64&&bits%8===0&&view.getUint16(pos+20,true)===channels*(bits/8);}
  if(size>bytes.length-pos-8)break;pos+=8+size+(size%2);
 }
 return false;
}
function textSample(bytes:Uint8Array,complete:boolean):boolean {
 try{let encoding='utf-8',start=0;if(bytes[0]===0xff&&bytes[1]===0xfe){encoding='utf-16le';start=2;}else if(bytes[0]===0xfe&&bytes[1]===0xff){encoding='utf-16be';start=2;}const text=new TextDecoder(encoding,{fatal:true}).decode(bytes.subarray(start),{stream:!complete});if(!text.length)return false;return !/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text);}catch{return false;}
}
export async function detectSample(bytes:Uint8Array,fileSize:number,name:string):Promise<Detection> {
 if(bytes.length>SNIFF_LIMITS.bytesPerFile)throw Error('Sample exceeds detection limit');
 const base={name,bytesRead:bytes.length,status:'detected' as const,confidence:'high' as const};
 if(fileSize===0)return{...base,label:'Empty file',kind:'empty',reason:'There is no payload to compress.'};
 // Stop at container magic: do not inflate GZIP or scan ZIP entries just to recommend a setting.
 const packed=container(bytes);if(packed)return{...base,...packed,kind:'compressed-archive',reason:'Archive or compressed-stream signature; contents were not decoded.'};
 const executable=executableHeader(bytes,fileSize);if(executable)return{...base,label:executable.label,kind:'executable',architecture:executable.architecture,suggestedFilter:executable.filter,reason:executable.reason};
 if(rawAudio(bytes))return{...base,label:'WAV · raw PCM/float',mime:'audio/wav',extension:'wav',kind:'raw-audio',reason:'The WAV format chunk identifies uncompressed samples.'};
 if(bytes.length>=54&&at(bytes,'BM')){const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.length);if(view.getUint32(14,true)>=40&&[0,3,6].includes(view.getUint32(30,true)))return{...base,label:'BMP · raw pixels',mime:'image/bmp',extension:'bmp',kind:'raw-image',reason:'The bitmap header identifies uncompressed pixel data.'};}
 let type:Awaited<ReturnType<typeof fileTypeFromBuffer>>;
 try{type=await fileTypeFromBuffer(bytes,{
  maxBufferSize:SNIFF_LIMITS.bytesPerFile,
  // file-type can re-enter after metadata (for example ID3). Stop nested container probes too.
  customDetectors:[{id:'container-signature-only',async detect(tokenizer){
   const prefix=new Uint8Array(8);
   const count=await tokenizer.peekBuffer(prefix,{position:tokenizer.position,length:prefix.length,mayBeLess:true});
   const packed=container(prefix.subarray(0,count));
   return packed?{ext:packed.extension,mime:packed.mime}:undefined;
  }}],
 });}catch{/* A truncated or bounded sample is an unknown type, not an archive failure. */}
 if(type){
  const compressedImages=new Set(['jpg','png','apng','gif','webp','avif','heic','heif','jxl','jxr','jls','jp2','j2c','jpm','jpx']);
  const compressedAudio=new Set(['mp3','mp2','mp1','aac','m4a','m4b','ogg','oga','opus','flac','ape','wv','ac3','amr','spx']);
  if(compressedImages.has(type.ext)||compressedAudio.has(type.ext)||['woff','woff2'].includes(type.ext))return{...base,mime:type.mime,extension:type.ext,label:type.ext.toUpperCase(),kind:'compressed-media',reason:'Recognized compressed media or font format.'};
  if(type.mime.startsWith('video/')&&!['avi','mxf'].includes(type.ext))return{...base,mime:type.mime,extension:type.ext,label:type.ext.toUpperCase()+' video',kind:'compressed-media',confidence:'medium',reason:'Video container is usually already compressed; raw codecs can differ.'};
  return{...base,mime:type.mime,extension:type.ext,label:type.ext.toUpperCase(),kind:'unknown',confidence:'medium',reason:'Format identified, but its compressibility is not established by this header.'};
 }
 if(textSample(bytes,fileSize<=bytes.length))return{...base,label:'Text',kind:'text',confidence:'medium',reason:'The sample is valid text without binary control bytes.'};
 return{...unknownDetection(name),bytesRead:bytes.length};
}
