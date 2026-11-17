import type {CreateOptions, FileCreateOptions} from './client';
const codecs7z = new Set(['copy','lzma','lzma2','ppmd','bzip2','zstd','deflate','lz4','brotli']);
const filters = new Set(['none','delta','x86','arm','arm64','thumb','ia64','sparc','ppc','riscv','bcj2']);
const levels:Record<string,readonly[number,number]>={lzma:[0,9],lzma2:[0,9],deflate:[0,9],ppmd:[0,9],bzip2:[1,9],zstd:[1,22],brotli:[0,11]};
const integer=(value:number,min:number,max:number)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
export function creationPlans(names:string[], options:CreateOptions):FileCreateOptions[]{
  const format=options.format||'zip', seven=format==='7z';
  if(options.fileOptions?.length&&!seven&&format!=='zip')throw Error('Per-file encoding options require ZIP or 7z');
  if(!seven&&format!=='zip')return [];
  if(options.encryptHeaders!==undefined&&(typeof options.encryptHeaders!=='boolean'||(!seven&&options.encryptHeaders)))throw Error('Header encryption is available only for 7z');
  if(options.encryptHeaders&&!options.password)throw Error('Header encryption requires an archive password');
  const budget=options.memoryLimit??256*1024*1024;
  if(!integer(budget,32*1024*1024,512*1024*1024))throw Error('Algorithm memory budget must be between 32 and 512 MiB');
  const selected=new Set(names), overrides=new Map<string,FileCreateOptions>();
  for(const value of options.fileOptions??[]){
    if(!value||typeof value.name!=='string'||!selected.has(value.name)||overrides.has(value.name))throw Error('Per-file options must name unique selected files');
    if(Object.keys(value).some(key=>!['name','codec','filter','level','dictionarySize','deltaDistance'].includes(key)))throw Error('Unknown per-file encoding option');
    overrides.set(value.name,{...value});
  }
  return names.map(name=>{
    const override=overrides.get(name), globalCodec=options.codec||(seven?'lzma2':'deflate');
    const codec=override?.codec??globalCodec, changed=codec!==globalCodec;
    const filter=override?.filter??options.filter??'none', filterChanged=filter!==(options.filter??'none');
    const plan:FileCreateOptions={name,codec,filter,level:override?.level??(changed?undefined:options.level),dictionarySize:override?.dictionarySize??(changed?undefined:options.dictionarySize),deltaDistance:override?.deltaDistance??(filterChanged||options.filter!=='delta'?undefined:options.deltaDistance)};
    if(!(seven?codecs7z.has(codec):['copy','deflate'].includes(codec)))throw Error('Unsupported creation codec: '+codec);
    if(!filters.has(filter)||(!seven&&filter!=='none'))throw Error('Unsupported creation filter: '+filter);
    if(filter==='bcj2'&&options.password)throw Error('BCJ2 cannot be combined with 7z password encryption');
    const range=levels[codec];
    if(plan.level!==undefined&&(!range||!integer(plan.level,range[0],range[1])))throw Error('Compression level is invalid or not applicable to this codec');
    if(plan.dictionarySize!==undefined&&(!seven||!['lzma','lzma2'].includes(codec)||!integer(plan.dictionarySize,65536,Math.min(8*1024*1024,Math.floor(budget/32)))))throw Error('Dictionary size is invalid or exceeds the selected memory budget');
    if(plan.deltaDistance!==undefined&&(filter!=='delta'||!integer(plan.deltaDistance,1,256)))throw Error('Delta distance requires the Delta filter and must be between 1 and 256');
    return plan;
  });
}
