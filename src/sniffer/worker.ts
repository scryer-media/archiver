import {detectSample} from './detect.ts';
import {SNIFF_LIMITS,unknownDetection,type Detection} from './model.ts';
let inspected=0,totalBytes=0;
const pending:{at:number;file:File;name:string;bytes:Uint8Array;detection:Detection}[]=[];
self.onmessage=async({data})=>{
 if(data.finish){
  let updates:{at:number;detection:Detection}[]=[];
  for(const sample of pending){
   let detection=sample.detection;
   const target=Math.min(sample.file.size,SNIFF_LIMITS.bytesPerFile,sample.bytes.length+SNIFF_LIMITS.totalBytes-totalBytes);
   if(target>sample.bytes.length){totalBytes+=target-sample.bytes.length;try{const tail=new Uint8Array(await sample.file.slice(sample.bytes.length,target).arrayBuffer());const bytes=new Uint8Array(sample.bytes.length+tail.length);bytes.set(sample.bytes);bytes.set(tail,sample.bytes.length);detection=await detectSample(bytes,sample.file.size,sample.name);}catch{detection={...unknownDetection(sample.name,'Header refinement unavailable; using general compression.','error'),bytesRead:sample.bytes.length};}}
   else detection={...unknownDetection(sample.name,'The refinement byte budget was reached; using general compression.','budget-exhausted'),bytesRead:sample.bytes.length};
   updates.push({at:sample.at,detection});if(updates.length===SNIFF_LIMITS.batchSize){self.postMessage({updates});updates=[];}
  }
  if(updates.length)self.postMessage({updates});pending.length=0;self.postMessage({done:true});return;
 }
 const results:Detection[]=[];
 for(let index=0;index<data.files.length;index++){
  const file=data.files[index] as File,name=data.names[index] as string;
  if(inspected>=SNIFF_LIMITS.maxInspectedFiles||totalBytes>=SNIFF_LIMITS.totalBytes){results.push(unknownDetection(name,'Detection byte or file budget reached; using general compression.','budget-exhausted'));continue;}
  inspected++;const length=Math.min(file.size,SNIFF_LIMITS.initialBytes,SNIFF_LIMITS.totalBytes-totalBytes);
  totalBytes+=length;try{const bytes=new Uint8Array(await file.slice(0,length).arrayBuffer());const detection=await detectSample(bytes,file.size,name);results.push(detection);if(file.size>bytes.length&&(detection.kind==='unknown'||/incomplete|bounded sample/.test(detection.reason)))pending.push({at:data.start+index,file,name,bytes,detection});}
  catch{results.push(unknownDetection(name,'The bounded sample could not be inspected; using general compression.','error'));}
 }
 self.postMessage({start:data.start,results});
};
