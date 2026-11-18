import type {ExtractionOptions} from '../engine/client';
import {ArchiveEngine} from './tool-engine';
import {ProgressTracker,duration,type ProgressSample} from './progress';
import {recoveryName,type ArchiveGroup} from './archive-groups';

type JobState='queued'|'active'|'needs-folder'|'done'|'failed'|'cancelled';
type Output={name:string;blob:Blob};
interface Job extends ArchiveGroup {id:number;password?:string;format?:string;options:ExtractionOptions;state:JobState;detail?:string;outputs?:Output[];engine?:ArchiveEngine;open?:boolean;shown?:number;streamed?:boolean}
interface Helpers {svg:(name:string)=>string;esc:(text:string)=>string;size:(bytes:number)=>string;canStart:()=>boolean;notice:(message:string,error?:boolean)=>void;addArchives:()=>void;save:(file:Output)=>void;streaming:()=>boolean}
const folderAccess=()=>'showDirectoryPicker' in window;
const PAGE=200;

/** Extracts archive sets one after another. With a chosen folder everything goes there. Without one, an archive holding one file goes to Downloads, and one holding several waits for a folder (or, where the browser has no folder access, is kept in this tab for saving file by file). */
export class ExtractionQueue {
 private jobs:Job[]=[];private next=1;private engine?:ArchiveEngine;private active?:Job;private destination?:FileSystemDirectoryHandle;
 private tracker=new ProgressTracker();private timer?:ReturnType<typeof setInterval>;private started=0;private finishedAt=0;private stopping=false;private abortActive?:()=>void;
 constructor(private host:HTMLElement,private helpers:Helpers){host.addEventListener('click',event=>this.click(event));}
 get running(){return !!this.active||this.stopping;}
 add(groups:ArchiveGroup[],password:string|undefined,format:string|undefined,options:ExtractionOptions){
  for(const group of groups)this.jobs.push({...group,id:this.next++,password,format,options:{...options},state:'queued'});
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
  else if(action==='save'&&job?.outputs){if(job.outputs.length===1)this.helpers.save(job.outputs[0]);else{job.open=!job.open;job.shown=job.shown||PAGE;this.render();}}
  else if(action==='more'&&job){job.shown=(job.shown||PAGE)+PAGE;this.render();}
  else if(action==='file'&&job?.outputs){const file=job.outputs[Number(button.dataset.index)];if(file)this.helpers.save(file);}
 }
 private async chooseFolder(){
  try{this.destination=await (window as any).showDirectoryPicker({mode:'readwrite'});for(const job of this.jobs)if(job.state==='needs-folder'){job.state='queued';job.detail=undefined;}this.render();return true;}
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
   this.active=job;job.state='active';this.tracker.start(performance.now());this.render();
   try{
    const inputs=job.files.filter(file=>!recoveryName(file.name));
    // Dispose does not settle every native call, so cancellation also releases the loop directly.
    const cancelled=new Promise<never>((_resolve,reject)=>{this.abortActive=()=>reject(new Error('Cancelled'));});
    // Without a folder, an archive holding one file goes to Downloads; one holding several needs a folder first.
    const single=!this.destination&&(await Promise.race([engine.streamable(inputs,job.password,job.format,job.options),cancelled])).streamable;
    const stream=single&&this.helpers.streaming();
    if(!this.destination&&!single&&folderAccess()){job.state='needs-folder';job.detail='Holds several files. Choose a folder to extract it into.';}
    else{
    job.streamed=stream;
    const result=await Promise.race([engine.extract(inputs,job.password,job.format,this.destination,stream?'download':undefined,job.options),cancelled]);
    if(job.state==='active'){
     const count=result.savedFiles??result.files.length;
     job.state=result.complete===false?'failed':'done';
     job.detail=result.complete===false?(result.message||'Incomplete'):`${stream?'Sent to Downloads':`${count} ${count===1?'file':'files'}`} · ${duration(this.tracker.view(performance.now()).elapsedSeconds)}`;
     // In-tab results live in the engine's storage, so that engine stays alive until the job is cleared.
     if(!this.destination&&!stream&&job.state==='done'){job.outputs=result.files;job.engine=engine;if(single&&result.files.length===1){this.helpers.save(result.files[0]);job.detail=`Sent to Downloads · ${duration(this.tracker.view(performance.now()).elapsedSeconds)}`;}else job.detail+=' · this browser can’t save to a folder, so save them below';}
    }
    }
   }catch(error){if(job.state==='active'){job.state='failed';job.detail=error instanceof Error?error.message:String(error);}}
   finally{this.abortActive=undefined;if(this.engine===engine){this.engine=undefined;if(job.engine!==engine)void engine.dispose();}this.active=undefined;}
   this.render();
  }
  this.stopping=false;if(this.timer)clearInterval(this.timer);this.timer=undefined;this.finishedAt=performance.now();this.render();
 }
 private progress(engine:ArchiveEngine,update:ProgressSample){if(engine!==this.engine)return;this.tracker.update(update,performance.now());this.renderActive();}
 private async cancelActive(){
  const job=this.active,engine=this.engine;if(!job||!engine)return;
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
  if(shown<outputs.length)html+=`<li><button class="quiet" data-queue="more" data-job="${job.id}">Show ${Math.min(PAGE,outputs.length-shown)} more · ${outputs.length-shown} remaining</button></li>`;
  return html+'</ul>';
 }
 private row(job:Job){
  const {svg,esc}=this.helpers,name=esc(job.name);
  if(job.state==='active')return `<li class="queue-row active" data-row="${job.id}"><span class="file-symbol">${svg('box')}</span><div class="queue-main"><div class="queue-line"><span class="file-name">${name}</span><span class="queue-percent" data-field="percent"></span></div><progress max="100" aria-label="Progress for ${name}"></progress><div class="queue-line queue-stats"><span data-field="bytes"></span><span data-field="files"></span><span data-field="rate"></span><span data-field="eta"></span></div></div><button class="queue-x" data-queue="cancel" data-job="${job.id}" aria-label="Cancel ${name}">${svg('close')}</button></li>`;
  const symbol=job.state==='needs-folder'?`<span class="file-symbol muted">${svg('folder')}</span>`:job.state==='done'?`<span class="file-symbol ok">${svg('check')}</span>`:job.state==='failed'?`<span class="file-symbol failed">${svg('alert')}</span>`:job.state==='cancelled'?`<span class="file-symbol muted">${svg('close')}</span>`:`<span class="file-symbol">${svg('box')}</span>`;
  const detail=job.state==='queued'?this.meta(job):esc(job.detail||'');
  const action=job.state==='needs-folder'?`<button class="secondary" data-queue="folder" data-job="${job.id}">${svg('folder')} Choose folder</button>`:job.state==='queued'?`<button class="queue-x" data-queue="remove" data-job="${job.id}" aria-label="Remove ${name} from queue">${svg('close')}</button>`:job.outputs?.length?`<button class="quiet" data-queue="save" data-job="${job.id}" aria-expanded="${job.outputs.length>1?String(!!job.open):'false'}">${job.outputs.length===1?`Save ${svg('arrow')}`:job.open?'Hide files':'Show files'}</button>`:'';
  return `<li class="queue-row ${job.state}">${symbol}<div class="queue-main"><span class="file-name">${name}</span><span class="queue-detail">${detail}</span></div>${action}</li>${job.open&&job.outputs&&job.outputs.length>1?`<li class="queue-row-files">${this.files(job)}</li>`:''}`;
 }
 private render(){
  const {svg,esc,size}=this.helpers;
  this.host.hidden=!this.jobs.length;if(!this.jobs.length)return;
  const done=this.jobs.filter(job=>job.state==='done').length,counted=this.jobs.filter(job=>job.state!=='cancelled').length,queued=this.jobs.some(job=>job.state==='queued'),finished=this.jobs.some(job=>job.state==='done'||job.state==='failed'||job.state==='cancelled');
  const remaining=this.jobs.filter(job=>job.state==='queued'||job.state==='active'||job.state==='needs-folder').reduce((sum,job)=>sum+job.size,0);
  const start=!this.running&&queued?`<button class="primary" data-queue="start">${svg('arrow')} Start queue</button>`:'';
  const place=this.destination?`${svg('folder')} ${esc(this.destination.name)}${!this.running?' <button class="quiet" data-queue="folder">Change</button>':''}`:folderAccess()?`${svg('folder')} No folder chosen · single files go to Downloads <button class="quiet" data-queue="folder">Choose folder</button>`:`${svg('arrow')} Single files go to Downloads; others wait here to be saved`;
  this.host.innerHTML=`<div class="queue-head"><div><h2>Queue</h2><span class="queue-count">${done} of ${counted} done</span></div><div class="queue-actions">${this.running?'<button class="quiet" data-queue="cancel-all">Cancel all</button>':finished?'<button class="quiet" data-queue="clear">Clear finished</button>':''}<button class="quiet" data-queue="add">${svg('plus')} Add archives</button>${start}</div></div><ol class="queue-list">${this.jobs.map(job=>this.row(job)).join('')}</ol><div class="queue-foot"><span class="queue-folder">${place}</span><dl><div><dt>Remaining</dt><dd>${size(remaining)}</dd></div><div><dt>Elapsed</dt><dd data-field="elapsed">${this.started?duration(((this.finishedAt||performance.now())-this.started)/1000):'—'}</dd></div></dl></div>`;
  this.renderActive();
 }
 private renderActive(){
  if(this.started&&!this.finishedAt){const elapsed=this.host.querySelector('[data-field="elapsed"]');if(elapsed)elapsed.textContent=duration((performance.now()-this.started)/1000);}
  const job=this.active,row=job&&this.host.querySelector(`[data-row="${job.id}"]`);if(!row)return;
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
