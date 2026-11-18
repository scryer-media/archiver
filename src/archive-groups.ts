export const recoveryName=(name:string)=>/\.(par2|par3|rev)$/i.test(name);
const volumeOrder=(a:File,b:File)=>a.name.localeCompare(b.name,undefined,{numeric:true});

/** Archive set stem: volume, split and recovery suffixes removed, so every part of one set shares it. */
export function archiveStem(name:string){
 let stem=name.toLowerCase();
 if(recoveryName(stem)){stem=stem.replace(/\.(par2|par3|rev)$/,'').replace(/\.vol\d+[+-]\d+$/,'').replace(/\.part\d+$/,'');}
 return stem
  .replace(/\.part\d+\.(rar|exe)$/,'')
  .replace(/\.(7z|zip|tar)\.\d{3}$/,'')
  .replace(/\.(rar|r\d\d|\d{3}|zip|z\d\d|7z|tar|tgz|tar\.[a-z0-9]+|gz|zst|zstd|br|xz|bz2|bzip2|lzma|lz4|deflate|zlib|zz|exe)$/,'');
}

export interface ArchiveGroup {name:string;files:File[];volumes:number;recovery:number;size:number}
/** One group per archive set; recovery files join the set they protect and never form a job on their own. */
export function groupArchives(files:File[],isArchive:(name:string)=>boolean):ArchiveGroup[]{
 const sets=new Map<string,File[]>();
 for(const file of files){const key=archiveStem(file.name);const set=sets.get(key);if(set)set.push(file);else sets.set(key,[file]);}
 const groups:ArchiveGroup[]=[];
 for(const set of sets.values()){
  const data=set.filter(file=>!recoveryName(file.name)).sort((a,b)=>Number(isArchive(b.name))-Number(isArchive(a.name))||volumeOrder(a,b));
  if(!data.length)continue;
  const recovery=set.length-data.length;
  groups.push({name:data[0].name,files:[...data,...set.filter(file=>recoveryName(file.name))],volumes:data.length,recovery,size:set.reduce((sum,file)=>sum+file.size,0)});
 }
 return groups.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
}
