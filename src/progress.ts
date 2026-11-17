export interface ProgressSample {
 phase:string; message:string; percent?:number; processedBytes?:number; totalBytes?:number;
 outputBytes?:number; writtenBytes?:number; filesProcessed?:number; totalFiles?:number; unit?:'input'|'output';
}
export interface ProgressView { sample:ProgressSample; percent?:number; rate?:number; etaSeconds?:number; elapsedSeconds:number; stalled:boolean }
const finite=(value:number|undefined)=>value!==undefined&&Number.isFinite(value)&&value>=0?value:undefined;
/** Rates and phase ETA derive exclusively from measured counters; clock ticks only update elapsed/staleness. */
export class ProgressTracker {
 private started=0;private updated=0;private points:{time:number;bytes:number}[]=[];
 private sample:ProgressSample={phase:'prepare',message:'Preparing your files…'};
 start(now:number){this.started=now;this.updated=now;this.points=[];this.sample={phase:'prepare',message:'Preparing your files…'};}
 update(next:ProgressSample,now:number){
  const bytes=finite(next.processedBytes), previous=finite(this.sample.processedBytes);
  if(next.phase!==this.sample.phase||next.unit!==this.sample.unit||(bytes!==undefined&&previous!==undefined&&bytes<previous)){this.points=[];this.updated=now;}
  if(bytes!==undefined){const last=this.points.at(-1);if(!last||bytes!==last.bytes){this.points.push({time:now,bytes});this.updated=now;}}
  this.points=this.points.filter(point=>now-point.time<=15000);
  this.sample={...next,processedBytes:bytes,totalBytes:finite(next.totalBytes),outputBytes:finite(next.outputBytes??next.writtenBytes)};
 }
 view(now:number):ProgressView{
  const sample=this.sample,total=sample.totalBytes,done=sample.processedBytes;
  const percent=total!==undefined&&total>0&&done!==undefined?Math.min(100,done/total*100):finite(sample.percent);
  const points=this.points.filter(point=>now-point.time<=15000),first=points[0],last=points.at(-1),stalled=now-this.updated>5000;
  let rate:number|undefined,etaSeconds:number|undefined;
  if(!stalled&&points.length>=3&&first&&last&&last.time-first.time>=1500){
   const measured=(last.bytes-first.bytes)/((last.time-first.time)/1000);
   if(measured>0){rate=measured;
    const intervals=points.slice(1).map((point,index)=>(point.bytes-points[index].bytes)/Math.max(.001,(point.time-points[index].time)/1000));
    const deviation=Math.sqrt(intervals.reduce((sum,value)=>sum+(value-measured)**2,0)/intervals.length)/measured;
    if(deviation<=.75&&total!==undefined&&done!==undefined&&total>done)etaSeconds=(total-done)/measured;
   }
  }
  return {sample,percent:percent===undefined?undefined:Math.min(100,percent),rate,etaSeconds,elapsedSeconds:Math.max(0,(now-this.started)/1000),stalled};
 }
}
export const duration=(seconds:number)=>{const value=Math.max(0,Math.round(seconds));if(value<60)return value+'s';if(value<3600)return Math.floor(value/60)+'m '+value%60+'s';return Math.floor(value/3600)+'h '+Math.floor(value%3600/60)+'m';};
