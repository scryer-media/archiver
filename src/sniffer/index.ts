import {SNIFF_LIMITS,unknownDetection,type Detection} from './model.ts';
export {recommendForFormat,SNIFF_LIMITS,type Detection,type Recommendation,type Filter} from './model.ts';
export interface SniffOptions {logicalNames?:string[];signal?:AbortSignal;onProgress?:(progress:{completed:number;total:number;bytesRead:number})=>void}
export async function sniffFiles(files:File[],options:SniffOptions={}):Promise<Detection[]> {
 if(options.signal?.aborted)throw new DOMException('Detection cancelled','AbortError');
 if(options.logicalNames&&options.logicalNames.length!==files.length)throw Error('Detection names must match files');
 const names=files.map((file,index)=>options.logicalNames?.[index]||file.webkitRelativePath||file.name);
 const order=files.map((_,index)=>index).sort((a,b)=>files[b].size-files[a].size||a-b);
 const results:Detection[]=new Array(files.length);let completed=0,bytesRead=0;
 if(!files.length)return [];
 let worker:Worker;
 try{worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});}catch{return names.map(name=>unknownDetection(name,'Detection worker unavailable; using general compression.','error'));}
 return new Promise((resolve,reject)=>{
  let ended=false,cursor=0,expectedStart=0,expectedCount=0,refining=false;
  const finish=(error?:unknown)=>{if(ended)return;ended=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);worker.terminate();if(error)reject(error);else resolve(results);};
  const fallback=(reason:string)=>{for(let index=0;index<files.length;index++)if(!results[index]||results[index].status==='unknown')results[index]={...unknownDetection(names[index],reason,'budget-exhausted'),bytesRead:results[index]?.bytesRead||0};finish();};
  const abort=()=>finish(new DOMException('Detection cancelled','AbortError'));
  const progress=()=>{try{options.onProgress?.({completed,total:files.length,bytesRead});}catch(error){finish(error);}};
  const next=()=>{if(cursor>=files.length){refining=true;worker.postMessage({finish:true});return;}expectedStart=cursor;cursor=Math.min(files.length,cursor+SNIFF_LIMITS.batchSize);expectedCount=cursor-expectedStart;const batch=order.slice(expectedStart,cursor);worker.postMessage({start:expectedStart,files:batch.map(index=>files[index]),names:batch.map(index=>names[index])});};
  const timer=setTimeout(()=>fallback('Detection time budget reached; using general compression.'),SNIFF_LIMITS.workerDeadlineMs);
  worker.onerror=()=>fallback('Detection worker unavailable; using general compression.');
  worker.onmessage=({data})=>{
   if(ended)return;
   if(data?.done&&refining){finish();return;}
   if(data?.updates&&refining){for(const update of data.updates){const at=order[update.at],detection=update.detection as Detection;if(at===undefined||detection?.name!==names[at]){fallback('Detection response unavailable; using general compression.');return;}bytesRead+=detection.bytesRead-(results[at]?.bytesRead||0);results[at]=detection;}progress();return;}
   if(refining||!Array.isArray(data?.results)||data.start!==expectedStart||data.results.length!==expectedCount){fallback('Detection response unavailable; using general compression.');return;}
   for(let index=0;index<data.results.length;index++){const detection=data.results[index] as Detection,at=order[data.start+index];if(!detection||detection.name!==names[at]){fallback('Detection response unavailable; using general compression.');return;}results[at]=detection;completed++;bytesRead+=detection.bytesRead;}
   progress();if(!ended)next();
  };
  options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted){abort();return;}next();
 });
}
