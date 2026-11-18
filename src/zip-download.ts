import {ZipStream} from '../engine/zip-stream';
import {createDownload} from '../engine/download';

export type PreparedFile={name:string;blob:Blob};

/**
 * Downloads files already prepared in this tab as one ZIP, for browsers that cannot write to a folder.
 * With streamed downloads it goes straight to Downloads; otherwise the ZIP is assembled from the
 * prepared files themselves (only its headers are new bytes) and saved as one file.
 */
export async function downloadZip(name:string,files:PreparedFile[],directories:string[],options:{streaming:boolean;save:(file:PreparedFile)=>void;progress?:(done:number,total:number)=>void}){
 const pack=async(zip:ZipStream,data?:{before:()=>void;after:(file:PreparedFile)=>void})=>{
  for(const directory of directories)await zip.directory(directory);
  for(const [index,file] of files.entries()){
   if(file.blob instanceof File)zip.setTime(file.name,file.blob.lastModified);
   await zip.begin(file.name);data?.before();
   const reader=file.blob.stream().getReader();
   for(;;){const {done,value}=await reader.read();if(done)break;await zip.write(value);}
   data?.after(file);
   options.progress?.(index+1,files.length);
  }
  await zip.finish();
 };
 if(options.streaming){
  const job=await createDownload(name);const writer=job.writable.getWriter();
  try{await pack(new ZipStream(bytes=>writer.write(bytes)));await writer.close();}
  catch(error){job.cancel();throw error;}
  finally{job.release();}
  return;
 }
 // The file data is read once for its CRC, then referenced by the ZIP Blob instead of copied.
 const parts:BlobPart[]=[];let headers=true;
 await pack(new ZipStream(async bytes=>{if(headers)parts.push(bytes.slice());}),{before:()=>{headers=false;},after:file=>{parts.push(file.blob);headers=true;}});
 options.save({name,blob:new Blob(parts,{type:'application/zip'})});
}
