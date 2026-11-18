import type { EngineProgress } from './client';
// Unique covered byte ranges: seeks do not count skipped bytes, and rereads
// do not inflate the amount of input processed.
export class ByteRanges {
  private ranges:[number,number][]=[];
  bytes=0;
  add(start:number,length:number):number {
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(length)||start<0||length<=0||!Number.isSafeInteger(start+length))return 0;
    let end=start+length,low=0,high=this.ranges.length;
    while(low<high){const middle=(low+high)>>>1;if(this.ranges[middle][1]<start)low=middle+1;else high=middle;}
    const first=low;let removed=0;
    while(low<this.ranges.length&&this.ranges[low][0]<=end){const range=this.ranges[low];start=Math.min(start,range[0]);end=Math.max(end,range[1]);removed+=range[1]-range[0];low++;}
    this.ranges.splice(first,low-first,[start,end]);
    const added=end-start-removed;this.bytes+=added;return added;
  }
}
export function installIoProgress(module:any,op:string,files:File[],names:string[],send:(progress:EngineProgress)=>void,direct:boolean,totals?:{totalBytes:number;totalFiles:number}) {
  if(direct)return {finish:()=>{}};
  const fs=module.FS,read=fs.read.bind(fs),write=fs.write.bind(fs),close=fs.close.bind(fs);
  let completedInputs=0;
  const sizes=new Map(names.map((name,index)=>['/input/'+name,files[index].size]));
  const inputs=new Map<string,ByteRanges>(),outputs=new Map<string,ByteRanges>(),closed=new Set<string>();
  const totalInput=files.reduce((sum,file)=>sum+file.size,0);
  let inputBytes=0,outputBytes=0,last=-Infinity,lastPhase='',outputStarted=false;
  const report=(force=false)=>{
    if(direct)return;
    const extracting=op==='extract'&&outputStarted;
    const inputComplete=inputBytes>=totalInput;
    const phase=extracting?'extract-output':inputComplete?op+'-processing':op+'-read';
    if(!force&&phase===lastPhase&&performance.now()-last<250)return;
    last=performance.now();lastPhase=phase;
    if(extracting)send({phase,message:'Writing extracted bytes to browser storage',processedBytes:outputBytes,totalBytes:totals&&outputBytes<=totals.totalBytes?totals.totalBytes:undefined,unit:'output',outputBytes,filesProcessed:closed.size,totalFiles:totals?.totalFiles});
    else if(inputComplete)send({phase,message:op==='create'?'Finishing the archive':'Processing archive data',outputBytes});
    else send({phase,message:op==='create'?'Compressing':op==='extract'?'Reading the archive':'Reading files',processedBytes:inputBytes,totalBytes:op==='create'?totalInput:undefined,unit:'input',outputBytes,filesProcessed:completedInputs,totalFiles:op==='create'?files.length:undefined});
  };
  const outputPath=(stream:any)=>{const path=stream.path as string;return path?.startsWith('/out/')&&!path.startsWith('/out/.work/')&&path!=='/out/.work'?path:undefined;};
  fs.read=(stream:any,buffer:any,offset:number,length:number,position?:number,...rest:any[])=>{
    const start=position??stream.position,result=read(stream,buffer,offset,length,position,...rest),path=stream.path;
    if(sizes.has(path)&&result>0){let ranges=inputs.get(path);if(!ranges){ranges=new ByteRanges();inputs.set(path,ranges);}const size=sizes.get(path)!,done=ranges.bytes===size;inputBytes+=ranges.add(start,Math.min(result,Math.max(0,size-start)));if(!done&&ranges.bytes===size)completedInputs++;report();}
    return result;
  };
  fs.write=(stream:any,buffer:any,offset:number,length:number,position?:number,...rest:any[])=>{
    const start=position??stream.position,path=outputPath(stream);
    if(path&&op==='extract')outputStarted=true;
    const result=write(stream,buffer,offset,length,position,...rest);
    if(path&&result>0){let ranges=outputs.get(path);if(!ranges){ranges=new ByteRanges();outputs.set(path,ranges);}outputBytes+=ranges.add(start,result);report();}
    return result;
  };
  fs.close=(stream:any)=>{const path=outputPath(stream),result=close(stream);if(path){closed.add(path);report();}return result;};
  report(true);
  return {finish:()=>{report(true);send({phase:'finalizing',message:'Preparing completed results',outputBytes,filesProcessed:closed.size,totalFiles:totals?.totalFiles});}};
}
