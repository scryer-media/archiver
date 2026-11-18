import type {EngineResult} from '../engine/client';
import type {ArchiveEngine} from './tool-engine';

const MIB=1024*1024;
export const hasParity=(files:File[])=>files.some(file=>/\.(par2|par3)$/i.test(file.name));

/** Recovery memory picked from the device: more on devices that report plenty of memory, 256 MiB when the browser does not say. */
export function memoryBudget(){
 const gib=(navigator as Navigator&{deviceMemory?:number}).deviceMemory;
 if(typeof gib!=='number')return 256*MIB;
 return gib>=8?512*MIB:gib>=4?256*MIB:128*MIB;
}

/** Archive inputs after a repair: repaired archive files replace their originals, untouched originals stay. */
export function repairedArchives(outputs:EngineResult['files'],files:File[],isArchive:(name:string)=>boolean){
 const candidates=new Map<string,File>();
 for(const file of outputs)if(isArchive(file.name)){const name=file.name.split('/').pop()!;candidates.set(name,new File([file.blob],name));}
 for(const file of files)if(isArchive(file.name)&&!candidates.has(file.name))candidates.set(file.name,file);
 const repaired=[...candidates.values()];
 if(repaired.some(file=>/\.(rar|r\d\d)$/i.test(file.name)))repaired.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
 return repaired;
}

/**
 * Checks a selection against its PAR2/PAR3 recovery files before extraction and repairs it when the check finds damage.
 * Returns the archive files to extract, or undefined when the selection has no recovery files.
 * A check that cannot run is reported in `checkFailed` and extraction goes ahead with the originals; a repair that fails stops the job.
 * The repaired files live in the engine's storage, so extract them with the same engine.
 */
export async function checkRecovery(engine:ArchiveEngine,files:File[],password:string|undefined,outputLimitBytes:number|undefined,isArchive:(name:string)=>boolean):Promise<{repaired:boolean;files?:File[];checkFailed?:string}|undefined>{
 if(!hasParity(files))return undefined;
 const options={memoryLimit:memoryBudget(),outputLimitBytes};
 let verified;
 try{verified=await engine.verify(files,options);}catch(error){return {repaired:false,checkFailed:error instanceof Error?error.message:String(error)};}
 if(verified.complete!==false)return {repaired:false};
 const repaired=await engine.repair(files,password,options);
 return {repaired:true,files:repairedArchives(repaired.files,files,isArchive)};
}
