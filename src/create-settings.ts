import {sniffFiles,recommendForFormat,type Detection} from './sniffer';
import {unknownDetection} from './sniffer/model';
import type {FileCreateOptions} from '../engine/client';
type Format = 'zip'|'7z';
const codecs=['lzma2','lzma','ppmd','bzip2','zstd','deflate','lz4','brotli','copy'];
const filters=['none','delta','x86','arm','arm64','thumb','ia64','sparc','ppc','riscv','bcj2'];
const codecLabels:Record<string,string>={lzma2:'LZMA2',lzma:'LZMA',ppmd:'PPMd',bzip2:'BZip2',zstd:'Zstandard',deflate:'Deflate',lz4:'LZ4',brotli:'Brotli',copy:'Store'};
const filterLabels:Record<string,string>={none:'None',delta:'Delta',x86:'x86',arm:'ARM',arm64:'ARM64',thumb:'ARM Thumb',ia64:'IA-64',sparc:'SPARC',ppc:'PowerPC',riscv:'RISC-V',bcj2:'BCJ2'};
const levels:Record<string,[number,number,number]>={lzma2:[0,9,3],lzma:[0,9,3],ppmd:[0,9,6],bzip2:[1,9,5],zstd:[1,22,3],deflate:[0,9,6],brotli:[0,11,5]};
export class CreationSettings {
 advanced=false;
 private files:File[]=[];
 private detections:Detection[]=[];
 private overrides=new Map<string,FileCreateOptions>();
 private generation=0;
 private page=0;
 private query='';
 private inspecting=false;
 private completed=0;
 private skipped=false;
 private pending:Promise<void>=Promise.resolve();
 private abort?:AbortController;
 private format='zip';
 private memory=256*1024*1024;
 constructor(private host:HTMLElement,private changed:()=>void,private locked:()=>boolean){}
 private dictionary=8*1024*1024;
 /** `dictionary` is the archive-wide LZMA dictionary ceiling; every LZMA and LZMA2 file uses it, so solid groups are not split by it. */
 setContext(format:string,memory:number,dictionary=8*1024*1024){this.format=format;this.memory=memory;this.dictionary=dictionary;this.render();}
 setAdvanced(value:boolean){this.advanced=value;this.render();this.changed();}
 setFiles(files:File[]){
  this.abort?.abort();this.abort=new AbortController();const generation=++this.generation;
  this.files=[...files];this.detections=[];this.page=0;this.query='';this.inspecting=files.length>0;this.completed=0;this.skipped=false;const names=new Set(files.map(file=>file.webkitRelativePath||file.name));
  for(const name of this.overrides.keys())if(!names.has(name.slice(name.indexOf(':')+1)))this.overrides.delete(name);
  this.render();
  this.pending=sniffFiles(files,{logicalNames:files.map(file=>file.webkitRelativePath||file.name),signal:this.abort.signal,onProgress:progress=>{if(generation!==this.generation)return;this.completed=progress.completed;const status=this.host.querySelector('.inspection-status');if(status)status.textContent=this.status();}}).then(detections=>{if(generation!==this.generation)return;this.detections=detections;this.inspecting=false;this.render();}).catch(error=>{if(generation===this.generation&&(error as Error).name!=='AbortError')throw error;});
  // Retain rejection for ready(), without an unhandled rejection while the user edits.
  void this.pending.catch(()=>{});
 }
 private status(){return this.inspecting?'Inspecting files · '+this.completed+' / '+this.files.length:this.skipped?'Inspection skipped · using general defaults':'File settings';}
 cancelInspection(){if(!this.inspecting)return;this.abort?.abort();this.detections=this.files.map(file=>unknownDetection(file.webkitRelativePath||file.name,'Inspection skipped; using general defaults.'));this.inspecting=false;this.skipped=true;this.pending=Promise.resolve();this.render();}
 ready(){return this.pending;}
 reset(){this.abort?.abort();this.generation++;this.files=[];this.detections=[];this.inspecting=false;this.skipped=false;this.overrides.clear();this.advanced=false;this.pending=Promise.resolve();this.render();}
 private recommendation(index:number):FileCreateOptions{
  const name=this.files[index].webkitRelativePath||this.files[index].name;
  const detection=this.detections[index];
  const base=detection?recommendForFormat(detection,this.format as Format):{name,codec:this.format==='zip'?'deflate':'lzma2',level:3};
  return this.normalize({...base,name});
 }
 private normalize(plan:FileCreateOptions):FileCreateOptions{
  const result:FileCreateOptions={name:plan.name,codec:plan.codec};const bounds=levels[plan.codec||''];
  if(bounds)result.level=plan.level??bounds[2];
  if(this.format==='7z'){
   result.filter=plan.codec==='copy'?'none':plan.filter||'none';
   if(plan.codec==='lzma'||plan.codec==='lzma2')result.dictionarySize=Math.min(this.dictionary,this.memory/32,8*1024*1024);
   if(result.filter==='delta')result.deltaDistance=plan.deltaDistance||1;
  }
  return result;
 }
 options():FileCreateOptions[]|undefined{
  if(!['zip','7z'].includes(this.format))return undefined;
  return this.files.map((_file,index)=>this.effective(index));
 }
 private effective(index:number){const auto=this.recommendation(index),file=this.files[index];return this.normalize(this.advanced?{...auto,...this.overrides.get(this.format+':'+(file.webkitRelativePath||file.name))}:auto);}
 private render(){
  this.host.replaceChildren();
  if(this.inspecting||this.skipped||this.advanced){const row=document.createElement('div');row.className='inspection-row';const state=document.createElement('p');state.className='inspection-status';state.setAttribute('role','status');state.textContent=this.status();row.append(state);if(this.inspecting){const cancel=document.createElement('button');cancel.type='button';cancel.className='quiet';cancel.textContent='Skip inspection';cancel.disabled=this.locked();cancel.onclick=()=>this.cancelInspection();row.append(cancel);}this.host.append(row);}
  if(!this.advanced)return;
  const search=document.createElement('input');search.type='search';search.placeholder='Find a file';search.setAttribute('aria-label','Find a file');search.value=this.query;search.className='file-settings-search';search.oninput=()=>{this.query=search.value;this.page=0;const cursor=search.selectionStart;this.render();const next=this.host.querySelector<HTMLInputElement>('.file-settings-search');next?.focus();if(cursor!==null)next?.setSelectionRange(cursor,cursor);};this.host.append(search);
  const indices=this.files.map((_file,index)=>index).filter(index=>(this.files[index].webkitRelativePath||this.files[index].name).toLocaleLowerCase().includes(this.query.toLocaleLowerCase()));
  this.page=Math.min(this.page,Math.max(0,Math.ceil(indices.length/50)-1));
  const start=this.page*50,visible=indices.slice(start,start+50);
  const count=document.createElement('p');count.className='inspection-status';count.textContent=indices.length?(start+1)+'–'+(start+visible.length)+' of '+indices.length+' files':'No matching files';this.host.append(count);
  if(!['zip','7z'].includes(this.format)){const note=document.createElement('p');note.className='inspection-status';note.textContent='Compression applies to the entire archive or stream.';this.host.append(note);}
  else{
   const seven=this.format==='7z',table=document.createElement('table'),head=document.createElement('tr'),body=document.createElement('tbody');
   for(const label of ['File','Compression','Level',...(seven?['Filter']:[])]){const cell=document.createElement('th');cell.scope='col';cell.textContent=label;head.append(cell);}
   const unused=()=>{const cell=document.createElement('td');cell.className='not-applicable';cell.textContent='—';cell.title='Not used by this compression';return cell;};
   visible.forEach(index=>{
    const file=this.files[index],plan=this.effective(index),label=file.webkitRelativePath||file.name,row=document.createElement('tr');
    const commit=(patch:Partial<FileCreateOptions>)=>{this.overrides.set(this.format+':'+plan.name,this.normalize({...plan,...patch}));this.render();};
    const select=(setting:string,choices:(string|number)[],text:(value:string)=>string,value:string|number,apply:(value:string)=>void)=>{const input=document.createElement('select');input.setAttribute('aria-label',setting+' for '+label);for(const choice of choices){const option=document.createElement('option');option.value=String(choice);option.textContent=text(String(choice));input.append(option);}input.value=String(value);input.addEventListener('change',()=>apply(input.value));return input;};
    const cell=(...inputs:HTMLElement[])=>{const td=document.createElement('td');td.append(...inputs);return td;};
    const name=document.createElement('th'),path=document.createElement('span'),type=document.createElement('small');name.scope='row';path.textContent=label;type.textContent=this.detections[index]?.label||'Detecting…';type.title=this.detections[index]?.reason||'';name.append(path,type);row.append(name);
    row.append(cell(select('Compression',this.format==='zip'?['deflate','copy']:codecs,codec=>codecLabels[codec]||codec,plan.codec||'lzma2',codec=>commit({codec,level:undefined}))));
    const bounds=levels[plan.codec||''];
    row.append(bounds?cell(select('Level',Array.from({length:bounds[1]-bounds[0]+1},(_,at)=>bounds[0]+at),level=>level,plan.level??bounds[2],level=>commit({level:Number(level)}))):unused());
    if(seven){
     if(plan.codec==='copy')row.append(unused());
     else{
      const inputs=[select('Filter',filters,filter=>filterLabels[filter]||filter,plan.filter||'none',filter=>commit({filter,deltaDistance:undefined}))];
      if(plan.filter==='delta')inputs.push(select('Delta distance',Array.from({length:256},(_,at)=>at+1),distance=>'Distance '+distance,plan.deltaDistance||1,distance=>commit({deltaDistance:Number(distance)})));
      row.append(cell(...inputs));
     }
    }
    body.append(row);
   });
   const thead=document.createElement('thead');thead.append(head);table.append(thead,body);
   const wrap=document.createElement('div');wrap.className='file-settings-table';wrap.append(table);this.host.append(wrap);
  }
  if(indices.length>50){const navigation=document.createElement('div');navigation.className='file-settings-navigation';for(const [label,delta] of [['Previous',-1],['Next',1]] as const){const button=document.createElement('button');button.type='button';button.className='quiet';button.textContent=label;button.disabled=this.locked()||(delta<0?this.page===0:start+50>=indices.length);button.onclick=()=>{this.page+=delta;this.render();};navigation.append(button);}this.host.append(navigation);}
  if(this.locked())this.host.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(input=>input.disabled=true);
 }
}
