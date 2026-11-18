import type {ExtractionOptions} from '../engine/client';
import {ArchiveEngine,zipDownloadName} from './tool-engine';
import {downloadZip} from './zip-download';
import {ProgressTracker,duration,type ProgressSample} from './progress';
import {recoveryName,archiveStem,type ArchiveGroup} from './archive-groups';
import {isOutputLimited} from '../engine/output-budget';
import {checkRecovery} from './recovery';
import {askExpansion,expansionMessage,type ExpansionPause} from './expansion';

type JobState='queued'|'active'|'needs-folder'|'done'|'failed'|'cancelled';
type Output={name:string;blob:Blob};
/** How an archive opened on screen goes out, as its Extract screen decided: streamed to Downloads, as one ZIP download, or kept in this tab. */
export interface JobDelivery {stream:boolean;zip:boolean;totalBytes?:number}
interface Job extends ArchiveGroup {destination?:FileSystemDirectoryHandle;delivery?:JobDelivery;id:number;password?:string;format?:string;options:ExtractionOptions;state:JobState;detail?:string;outputs?:Output[];directories?:string[];engine?:ArchiveEngine;open?:boolean;shown?:number;streamed?:boolean;saving?:string;pause?:ExpansionPause}
interface Helpers {isArchive:(name:string)=>boolean;svg:(name:string)=>string;esc:(text:string)=>string;size:(bytes:number)=>string;canStart:()=>boolean;notice:(message:string,error?:boolean)=>void;addArchives:()=>void;save:(file:Output)=>void;streaming:()=>boolean}
const folderAccess=()=>'showDirectoryPicker' in window;
const PAGE=200;
// Without disk-backed browser storage the engine falls back to a 128 MiB memory limit; stay under it so the queue's own budget trips first.
const MEMORY_CAPACITY=120*1024*1024;
/** How much a job may write while kept in this tab: most of the free browser storage, never more than the user's write budget. */
async function tabCapacity(budget:number){
 if(typeof navigator.storage?.getDirectory!=='function')return Math.min(budget,MEMORY_CAPACITY);
 const estimate=await navigator.storage.estimate().catch(()=>undefined);
 if(estimate?.quota===undefined)return budget;
 return Math.min(budget,Math.max(0,Math.floor((estimate.quota-(estimate.usage||0))*0.8)));
}
const safePath=(name:string)=>{const parts=name.split('/');if(!name||name.startsWith('/')||/[\\\0:]/.test(name)||parts.some(part=>!part||part==='.'||part==='..'))throw new Error('Unsafe output path: '+name);return parts;};

/** Extracts archive sets one after another. With a chosen folder everything goes there. Without one, an archive holding one file goes to Downloads. One holding several is kept in this tab when it fits, and one too large for the tab waits for a folder; where the browser cannot write to a folder it downloads as one ZIP instead. */
export class ExtractionQueue {
 private jobs:Job[]=[];private next=1;private engine?:ArchiveEngine;private active?:Job;private destination?:FileSystemDirectoryHandle;
 private tracker=new ProgressTracker();private timer?:ReturnType<typeof setInterval>;private started=0;private finishedAt=0;private stopping=false;private abortActive?:()=>void;
 constructor(private host:HTMLElement,private helpers:Helpers){host.addEventListener('click',event=>this.click(event));}
 get running(){return !!this.active||this.stopping;}
 add(groups:ArchiveGroup[],password:string|undefined,format:string|undefined,options:ExtractionOptions,place:{destination?:FileSystemDirectoryHandle;delivery?:JobDelivery}={}){
  for(const group of groups)this.jobs.push({...group,...place,id:this.next++,password,format,options:{...options},state:'queued'});
  this.render();
 }
 private find(id:number){return this.jobs.find(job=>job.id===id);}
 private click(event:Event){
  const button=(event.target as Element).closest<HTMLButtonElement>('button[data-queue]');if(!button||button.disabled)return;
  const action=button.dataset.queue,job=this.find(Number(button.dataset.job));
  if(action==='start')void this.start();
  else if(action==='add')this.helpers.addArchives();
  else if(action==='folder')void this.chooseFolder().then(chosen=>{if(chosen)this.resume();});
  else if(action==='cancel-all')void this.cancelAll();
  else if(action==='clear')this.clearFinished();
  else if(action==='remove'&&job?.state==='queued'){this.jobs=this.jobs.filter(item=>item!==job);this.render();}
  else if(action==='cancel'&&job&&job===this.active)void this.cancelActive();
  else if((action==='keep'||action==='stop')&&job?.pause)job.pause.answer(action==='keep');
  else if(action==='save'&&job?.outputs){if(job.outputs.length===1)this.helpers.save(job.outputs[0]);else{job.open=!job.open;job.shown=job.shown||PAGE;this.render();}}
  else if(action==='more'&&job){job.shown=(job.shown||PAGE)+PAGE;this.render();}
  else if(action==='save-all'&&job?.outputs&&!job.saving)void this.saveAll(job);
  else if(action==='file'&&job?.outputs){const file=job.outputs[Number(button.dataset.index)];if(file)this.helpers.save(file);}
 }
 private async chooseFolder(){
  try{this.destination=await (window as any).showDirectoryPicker({mode:'readwrite'});for(const job of this.jobs)if(job.state==='needs-folder'){job.state='queued';job.detail=undefined;job.destination=undefined;job.delivery=undefined;}this.render();return true;}
  catch(error){if((error as Error).name!=='AbortError')this.helpers.notice((error as Error).message,true);return false;}
 }
 private resume(){if(!this.running&&this.started&&this.jobs.some(job=>job.state==='queued'))void this.start();}
 async start(){
  if(this.running||!this.jobs.some(job=>job.state==='queued'))return;
  if(!this.helpers.canStart()){this.helpers.notice('Finish the current operation before starting the queue.',true);return;}
  this.started=performance.now();this.finishedAt=0;
  this.timer=setInterval(()=>this.renderActive(),1000);
  void this.loop();
 }
 private async loop(){
  for(let job=this.jobs.find(item=>item.state==='queued');job&&!this.stopping;job=this.jobs.find(item=>item.state==='queued')){
   const engine=this.engine=new ArchiveEngine(update=>this.progress(engine,update));
   engine.onExpansion=askExpansion(pause=>{job!.pause=pause;this.render();});
   this.active=job;job.state='active';this.tracker.start(performance.now());this.render();
   try{
    // Dispose does not settle every native call, so cancellation also releases the loop directly.
    const cancelled=new Promise<never>((_resolve,reject)=>{this.abortActive=()=>reject(new Error('Cancelled'));});
    // With recovery files in the set, check the archive against them first and repair it when the check finds damage.
    const recovery=await Promise.race([checkRecovery(engine,job.files,job.password,job.options.outputLimitBytes,this.helpers.isArchive),cancelled]);
    const inputs=recovery?.files??job.files.filter(file=>!recoveryName(file.name));
    const note=recovery?.repaired?' · repaired':recovery?.checkFailed?` · recovery check could not run (${recovery.checkFailed})`:recovery?' · checked':'';
    // Without a folder, an archive holding one file goes to Downloads. Anything else is kept in this tab, but only up to what the tab can hold.
    const destination=job.destination??this.destination,planned=destination?undefined:job.delivery;
    const inspected=destination||planned?undefined:await Promise.race([engine.inspect(inputs,job.password,job.format,job.options),cancelled]);
    const stream=planned?planned.stream&&!planned.zip:!!inspected?.streamable&&this.helpers.streaming();
    // A browser that cannot write to a folder takes several files as one ZIP download, at any size.
    const zip=planned?planned.zip?zipDownloadName(inputs):undefined:!destination&&!stream&&!folderAccess()&&this.helpers.streaming()?zipDownloadName(inputs):undefined;
    const budget=job.options.outputLimitBytes!,capacity=destination||stream||zip?budget:await tabCapacity(budget),tabLimited=capacity<budget;
    if(job.state==='active'&&tabLimited&&(capacity<=0||(inspected?.totalBytes??planned?.totalBytes)!==undefined&&(inspected?.totalBytes??planned!.totalBytes!)>capacity))this.needsFolder(job,`Expands to ${this.helpers.size(inspected?.totalBytes??planned?.totalBytes??0)}, more than this tab can hold (${this.helpers.size(capacity)}).`);
    else{
     job.streamed=stream;
     let result;
     try{result=await Promise.race([engine.extract(inputs,job.password,job.format,destination,stream?'download':zip?'zip':undefined,{...job.options,outputLimitBytes:capacity}),cancelled]);}
     catch(error){if(job.state==='active'&&tabLimited&&isOutputLimited(error)){this.needsFolder(job,`Ran past what this tab can hold (${this.helpers.size(capacity)}).`);result=undefined;}else throw error;}
     if(result&&job.state==='active'){
      const count=result.savedFiles??result.files.length,elapsed=duration(this.tracker.view(performance.now()).elapsedSeconds);
      job.state=result.complete===false?'failed':'done';
      job.detail=result.complete===false?(result.message||'Incomplete'):`${stream?'Sent to Downloads':zip&&result.downloadSent?`Sent to Downloads as ${result.downloadName||zip}`:`${count} ${count===1?'file':'files'}`}${note} · ${elapsed}`;
      // In-tab results live in the engine's storage, so that engine stays alive until the job is cleared.
      if(!destination&&!stream&&!result.downloadSent&&job.state==='done'){job.outputs=result.files;job.directories=result.directories;job.engine=engine;if(inspected?.streamable&&result.files.length===1){this.helpers.save(result.files[0]);job.detail=`Sent to Downloads${note} · ${elapsed}`;}}
     }
    }
   }catch(error){if(job.state==='active'){job.state='failed';job.detail=error instanceof Error?error.message:String(error);}}
   finally{this.abortActive=undefined;if(this.engine===engine){this.engine=undefined;if(job.engine!==engine)void engine.dispose();}this.active=undefined;}
   this.render();
  }
  this.stopping=false;if(this.timer)clearInterval(this.timer);this.timer=undefined;this.finishedAt=performance.now();this.render();
 }
 /** A job too large for this tab: with folder access it waits for a folder and then runs there; otherwise it fails with the reason. */
 private needsFolder(job:Job,reason:string){
  if(folderAccess()){job.state='needs-folder';job.detail=reason+' Choose a folder to extract it into.';}
  else{job.state='failed';job.detail=reason+' This browser can’t write to a folder, so open Archiver in one that can, such as Chrome or Edge.';}
 }
 /** Writes a finished in-tab job's files into a new subfolder of a folder the user picks; without folder access, downloads them one by one. */
 private async saveAll(job:Job){
  const outputs=job.outputs!;
  if(!folderAccess()){
   const name=zipDownloadName(job.files);
   try{await downloadZip(name,outputs,job.directories??[],{streaming:this.helpers.streaming(),save:this.helpers.save,progress:(done,total)=>{job.saving=`Packing ${done} of ${total}…`;this.render();}});job.detail=`Sent to Downloads as ${name}`;}
   catch(error){this.helpers.notice(`Downloading ${job.name} stopped: ${(error as Error).message}`,true);}
   job.saving=undefined;this.render();return;
  }
  let parent:FileSystemDirectoryHandle;
  try{parent=await (window as any).showDirectoryPicker({mode:'readwrite'});}catch(error){if((error as Error).name!=='AbortError')this.helpers.notice((error as Error).message,true);return;}
  try{
   const stem=archiveStem(job.name)||'archive';let name=stem;
   for(let attempt=2;;attempt++){try{await parent.getDirectoryHandle(name);name=`${stem} (${attempt})`;}catch(error){if((error as Error).name==='NotFoundError')break;throw error;}}
   const root=await parent.getDirectoryHandle(name,{create:true}),folders=new Map<string,FileSystemDirectoryHandle>([['',root]]);
   const folder=async(parts:string[])=>{let path='',handle=root;for(const part of parts){path+=(path?'/':'')+part;let next=folders.get(path);if(!next){next=await handle.getDirectoryHandle(part,{create:true});folders.set(path,next);}handle=next;}return handle;};
   for(const [index,file] of outputs.entries()){
    job.saving=`Saving ${index+1} of ${outputs.length}…`;this.render();
    const parts=safePath(file.name),handle=await (await folder(parts.slice(0,-1))).getFileHandle(parts.at(-1)!,{create:true});
    await file.blob.stream().pipeTo(await handle.createWritable());
   }
   job.saving=undefined;job.detail=`${outputs.length} files saved to ${parent.name}/${name}`;
  }catch(error){job.saving=undefined;this.helpers.notice(`Saving ${job.name} stopped: ${(error as Error).message}`,true);}
  this.render();
 }
 private progress(engine:ArchiveEngine,update:ProgressSample){if(engine!==this.engine)return;this.tracker.update(update,performance.now());this.renderActive();}
 private async cancelActive(){
  const job=this.active,engine=this.engine;if(!job||!engine)return;
  job.pause?.answer(false);
  job.state='cancelled';job.detail='Cancelled · partial output removed';this.engine=undefined;this.abortActive?.();this.render();
  if(!await engine.dispose())job.detail='Cancelled · browser is still releasing temporary files';
  this.render();
 }
 private async cancelAll(){
  for(const job of this.jobs)if(job.state==='queued'||job.state==='needs-folder'){job.state='cancelled';job.detail='Cancelled';}
  if(this.active){this.stopping=true;await this.cancelActive();}
  this.render();
 }
 private clearFinished(){
  for(const job of this.jobs)if(job.engine&&job.state!=='queued'&&job.state!=='active'){void job.engine.dispose();job.engine=undefined;job.outputs=undefined;}
  this.jobs=this.jobs.filter(job=>job.state==='queued'||job.state==='active'||job.state==='needs-folder');this.render();
 }
 private meta(job:Job){const {size}=this.helpers;const parts=[size(job.size)];if(job.volumes>1)parts.push(`${job.volumes} parts`);if(job.recovery)parts.push(`${job.recovery} recovery`);return parts.join(' · ');}
 private files(job:Job){
  const {svg,esc,size}=this.helpers,outputs=job.outputs!,shown=Math.min(outputs.length,job.shown||PAGE);let html='<ul class="queue-files">';
  for(let index=0;index<shown;index++){const file=outputs[index];html+=`<li><span class="file-name">${esc(file.name)}</span><span class="file-size">${size(file.blob.size)}</span><button class="download" data-queue="file" data-job="${job.id}" data-index="${index}" aria-label="Download ${esc(file.name)}">${svg('arrow')}</button></li>`;}
  if(shown<outputs.length)html+=`<li><button class="quiet" data-queue="more" data-job="${job.id}">${svg('down')} Show ${Math.min(PAGE,outputs.length-shown)} more · ${outputs.length-shown} remaining</button></li>`;
  return html+'</ul>';
 }
 private row(job:Job){
  const {svg,esc}=this.helpers,name=esc(job.name);
  if(job.state==='active'&&job.pause)return `<li class="queue-row active paused" data-row="${job.id}"><span class="file-symbol warn">${svg('alert')}</span><div class="queue-main"><span class="file-name">${name}</span><span class="queue-detail" role="alert">${esc(expansionMessage(job.pause,this.helpers.size))}</span></div><div class="queue-pause-actions"><button class="danger" data-queue="stop" data-job="${job.id}">${svg('stop')} Stop</button><button class="primary" data-queue="keep" data-job="${job.id}">${svg('play')} Keep going</button></div></li>`;
  if(job.state==='active')return `<li class="queue-row active" data-row="${job.id}"><span class="file-symbol">${svg('box')}</span><div class="queue-main"><div class="queue-line"><span class="file-name">${name}</span><span class="queue-percent" data-field="percent"></span></div><progress max="100" aria-label="Progress for ${name}"></progress><div class="queue-line queue-stats"><span data-field="bytes"></span><span data-field="files"></span><span data-field="rate"></span><span data-field="eta"></span></div></div><button class="queue-x" data-queue="cancel" data-job="${job.id}" aria-label="Cancel ${name}">${svg('close')}</button></li>`;
  const symbol=job.state==='needs-folder'?`<span class="file-symbol muted">${svg('folder')}</span>`:job.state==='done'?`<span class="file-symbol ok">${svg('check')}</span>`:job.state==='failed'?`<span class="file-symbol failed">${svg('alert')}</span>`:job.state==='cancelled'?`<span class="file-symbol muted">${svg('close')}</span>`:`<span class="file-symbol">${svg('box')}</span>`;
  const detail=job.state==='queued'?this.meta(job):esc(job.saving||job.detail||'');
  const action=job.state==='needs-folder'?`<button class="secondary" data-queue="folder" data-job="${job.id}">${svg('folder')} Choose folder &amp; retry</button>`:job.state==='queued'?`<button class="queue-x" data-queue="remove" data-job="${job.id}" aria-label="Remove ${name} from queue">${svg('close')}</button>`:job.outputs?.length?`${job.outputs.length>1?`<button class="secondary" data-queue="save-all" data-job="${job.id}"${job.saving?' disabled':''} aria-label="${folderAccess()?'Save all files to a folder':'Download all files as one ZIP'}">${svg(folderAccess()?'folder':'arrow')} ${folderAccess()?'Save all<span class="queue-wide"> to folder</span>':'Download<span class="queue-wide"> all as</span> .zip'}</button>`:''}<button class="secondary" data-queue="save" data-job="${job.id}" aria-expanded="${job.outputs.length>1?String(!!job.open):'false'}">${job.outputs.length===1?`${svg('arrow')} Save`:job.open?`${svg('up')} Hide files`:`${svg('down')} Show files`}</button>`:'';
  return `<li class="queue-row ${job.state}">${symbol}<div class="queue-main"><span class="file-name">${name}</span><span class="queue-detail">${detail}</span></div>${action}</li>${job.open&&job.outputs&&job.outputs.length>1?`<li class="queue-row-files">${this.files(job)}</li>`:''}`;
 }
 private render(){
  const {svg,esc,size}=this.helpers;
  this.host.hidden=!this.jobs.length;if(!this.jobs.length)return;
  const done=this.jobs.filter(job=>job.state==='done').length,counted=this.jobs.filter(job=>job.state!=='cancelled').length,queued=this.jobs.some(job=>job.state==='queued'),finished=this.jobs.some(job=>job.state==='done'||job.state==='failed'||job.state==='cancelled');
  const remaining=this.jobs.filter(job=>job.state==='queued'||job.state==='active'||job.state==='needs-folder').reduce((sum,job)=>sum+job.size,0);
  const start=!this.running&&queued?`<button class="primary" data-queue="start">${svg('play')} Start queue</button>`:'';
  const place=this.destination?`${svg('folder')} ${esc(this.destination.name)}${!this.running?` <button class="quiet" data-queue="folder">${svg('folder')} Change</button>`:''}`:folderAccess()?`${svg('folder')} No folder chosen · single files go to Downloads, others wait here to be saved <button class="quiet" data-queue="folder">${svg('folder')} Choose folder</button>`:this.helpers.streaming()?`${svg('arrow')} Everything goes to Downloads; archives with several files arrive as one .zip`:`${svg('arrow')} Finished archives wait here; save each as one .zip`;
  this.host.innerHTML=`<div class="queue-head"><div><h2>Extracting</h2><span class="queue-count">${done} of ${counted} done</span></div><div class="queue-actions">${this.running?`<button class="danger" data-queue="cancel-all">${svg('close')} Cancel all</button>`:finished?`<button class="quiet" data-queue="clear">${svg('trash')} Clear finished</button>`:''}<button class="quiet" data-queue="add">${svg('plus')} Add archives</button>${start}</div></div><ol class="queue-list">${this.jobs.map(job=>this.row(job)).join('')}</ol><div class="queue-foot"><span class="queue-folder">${place}</span><dl><div><dt>Remaining</dt><dd>${size(remaining)}</dd></div><div><dt>Elapsed</dt><dd data-field="elapsed">${this.started?duration(((this.finishedAt||performance.now())-this.started)/1000):'—'}</dd></div></dl></div>`;
  this.renderActive();
 }
 private renderActive(){
  if(this.started&&!this.finishedAt){const elapsed=this.host.querySelector('[data-field="elapsed"]');if(elapsed)elapsed.textContent=duration((performance.now()-this.started)/1000);}
  const job=this.active,row=job&&this.host.querySelector(`[data-row="${job.id}"]`);if(!row||job.pause)return;
  const {size}=this.helpers,view=this.tracker.view(performance.now()),sample=view.sample,bar=row.querySelector('progress')!;
  const set=(field:string,text:string)=>{const target=row.querySelector(`[data-field="${field}"]`);if(target)target.textContent=text;};
  if(view.percent===undefined)bar.removeAttribute('value');else bar.value=view.percent;
  set('percent',view.percent===undefined?sample.message:`${view.percent.toFixed(0)}%`);
  set('bytes',sample.processedBytes===undefined?'':`${size(sample.processedBytes)}${sample.totalBytes===undefined?'':` / ${size(sample.totalBytes)}`}`);
  set('files',sample.filesProcessed===undefined?'':`${sample.filesProcessed}${sample.totalFiles===undefined?'':` / ${sample.totalFiles}`} files`);
  set('rate',view.rate===undefined?'':`${size(view.rate<1024?Math.round(view.rate):view.rate)}/s`);
  set('eta',view.etaSeconds===undefined?'':`${duration(view.etaSeconds)} left`);
 }
}
