import type {CreateOptions} from '../engine/client';
import {ArchiveEngine} from './tool-engine';
import {ProgressTracker,duration,type ProgressSample} from './progress';

type JobState='queued'|'active'|'done'|'failed'|'cancelled';
type Output={name:string;blob:Blob};
/** One archive to create, captured from the Create screen when it was added. */
/** `download` sends the archive to Downloads as it is made (or the moment it is done); `hold` keeps it until the user downloads it from the job. */
export type Delivery='download'|'hold';
export interface CreateJobInput {stem:string;format:string;files:File[];options:CreateOptions;stream:boolean;delivery:Delivery}
interface Job extends CreateJobInput {id:number;name:string;size:number;state:JobState;detail?:string;outputs?:Output[];engine?:ArchiveEngine;downloaded?:boolean}
interface Helpers {svg:(name:string)=>string;esc:(text:string)=>string;size:(bytes:number)=>string;save:(file:Output)=>void}

/** The archive's name: the one folder everything sits in, the lone file's name, or "archive". */
export function archiveStem(paths:string[]){
 const roots=new Set(paths.map(path=>path.includes('/')?path.slice(0,path.indexOf('/')):''));
 if(roots.size===1&&!roots.has(''))return [...roots][0];
 if(paths.length===1&&!paths[0].includes('/'))return paths[0].replace(/\.[^.]+$/,'')||paths[0];
 return 'archive';
}
/** The engine names its output archive.*; recovery files and volumes follow the archive, so they take the same stem. */
const renamed=(file:Output,stem:string)=>file.name.startsWith('archive.')?{...file,name:stem+file.name.slice('archive'.length)}:file;

/** Creates archives one after another, so the Create screen is free for the next one. An archive to download now runs next; a queued one waits its turn and is kept until downloaded. */
export class CreateQueue {
 private jobs:Job[]=[];private next=1;private active?:Job;private engine?:ArchiveEngine;private tracker=new ProgressTracker();private timer?:ReturnType<typeof setInterval>;private abortActive?:()=>void;
 constructor(private host:HTMLElement,private helpers:Helpers){host.addEventListener('click',event=>this.click(event));}
 get running(){return !!this.active;}
 add(input:CreateJobInput){
  const name=['zip','7z','tar'].includes(input.format)||input.format.startsWith('tar.')?`${input.stem}.${input.format}`:input.format==='par2'?`${input.stem} recovery files`:`${input.files[0]?.name}.${input.format}`;
  const job:Job={...input,id:this.next++,name,size:input.files.reduce((sum,file)=>sum+file.size,0),state:'queued'};
  // Download now goes ahead of anything only queued.
  const waiting=input.delivery==='download'?this.jobs.findIndex(item=>item.state==='queued'&&item.delivery==='hold'):-1;
  if(waiting<0)this.jobs.push(job);else this.jobs.splice(waiting,0,job);
  this.render();if(!this.active)void this.loop();
  return {name,id:job.id};
 }
 private async loop(){
  this.timer=setInterval(()=>this.renderActive(),1000);
  for(let job=this.jobs.find(item=>item.state==='queued');job;job=this.jobs.find(item=>item.state==='queued')){
   const engine=this.engine=new ArchiveEngine(update=>this.progress(engine,update));
   this.active=job;job.state='active';this.tracker.start(performance.now());this.render();
   try{
    const cancelled=new Promise<never>((_resolve,reject)=>{this.abortActive=()=>reject(new Error('Cancelled'));});
    const result=await Promise.race([engine.create(job.files,{...job.options,stem:job.stem,delivery:job.stream&&job.delivery==='download'?'download':undefined}),cancelled]);
    if(job.state==='active'){
     const elapsed=duration(this.tracker.view(performance.now()).elapsedSeconds);
     if(result.complete===false){job.state='failed';job.detail=result.message||'Incomplete';}
     else if(result.downloadSent){job.state='done';job.detail=`Sent to Downloads as ${result.downloadName||job.name} · ${elapsed}`;}
     else{
      // Prepared output lives in this engine's storage, so the engine stays until the job is cleared and the files can be saved again.
      job.state='done';job.outputs=result.files.map(file=>renamed(file,job!.stem));job.engine=engine;
      const total=this.helpers.size(job.outputs.reduce((sum,file)=>sum+file.blob.size,0)),count=job.outputs.length===1?'':`${job.outputs.length} files · `;
      if(job.delivery==='download'){this.download(job);job.detail=`Sent to Downloads · ${count}${total} · ${elapsed}`;}
      else job.detail=`Ready · ${count}${total} · ${elapsed}`;
     }
    }
   }catch(error){if(job.state==='active'){job.state='failed';job.detail=error instanceof Error?error.message:String(error);}}
   finally{this.abortActive=undefined;if(this.engine===engine)this.engine=undefined;if(job.engine!==engine)void engine.dispose();this.active=undefined;}
   this.render();
  }
  if(this.timer)clearInterval(this.timer);this.timer=undefined;
 }
 /** The row showing a job, for the hand-off animation from the Create screen. */
 rowFor(id:number){return this.host.querySelector(`[data-row="${id}"]`);}
 private find(id:number){return this.jobs.find(job=>job.id===id);}
 private click(event:Event){
  const button=(event.target as Element).closest<HTMLButtonElement>('button[data-create]');if(!button||button.disabled)return;
  const action=button.dataset.create,job=this.find(Number(button.dataset.job));
  if(action==='remove'&&job?.state==='queued'){this.jobs=this.jobs.filter(item=>item!==job);this.render();}
  else if(action==='cancel'&&job&&job===this.active)void this.cancelActive();
  else if(action==='save'&&job?.outputs){this.download(job);this.render();}
  else if(action==='cancel-all')void this.cancelAll();
  else if(action==='clear')this.clearFinished();
 }
 private download(job:Job){for(const file of job.outputs!)this.helpers.save(file);job.downloaded=true;}
 private async cancelActive(){
  const job=this.active,engine=this.engine;if(!job||!engine)return;
  job.state='cancelled';job.detail='Cancelled · partial output removed';this.engine=undefined;this.abortActive?.();this.render();
  if(!await engine.dispose())job.detail='Cancelled · browser is still releasing temporary files';
  this.render();
 }
 private async cancelAll(){
  for(const job of this.jobs)if(job.state==='queued'){job.state='cancelled';job.detail='Cancelled';}
  await this.cancelActive();this.render();
 }
 private clearFinished(){
  for(const job of this.jobs)if(job.engine&&job.state!=='queued'&&job.state!=='active'){void job.engine.dispose();job.engine=undefined;job.outputs=undefined;}
  this.jobs=this.jobs.filter(job=>job.state==='queued'||job.state==='active');this.render();
 }
 private progress(engine:ArchiveEngine,update:ProgressSample){if(engine!==this.engine)return;this.tracker.update(update,performance.now());this.renderActive();}
 private row(job:Job){
  const {svg,esc,size}=this.helpers,name=esc(job.name);
  if(job.state==='active')return `<li class="queue-row active" data-row="${job.id}"><span class="file-symbol">${svg('box')}</span><div class="queue-main"><div class="queue-line"><span class="file-name">${name}</span><span class="queue-percent" data-field="percent"></span></div><progress max="100" aria-label="Progress for ${name}"></progress><span class="queue-phase" data-field="phase"></span><div class="queue-line queue-stats"><span data-field="bytes"></span><span data-field="files"></span><span data-field="rate"></span><span data-field="eta"></span><span data-field="elapsed"></span></div></div><button class="queue-x" data-create="cancel" data-job="${job.id}" aria-label="Cancel ${name}">${svg('close')}</button></li>`;
  const symbol=job.state==='done'?`<span class="file-symbol ok">${svg('check')}</span>`:job.state==='failed'?`<span class="file-symbol failed">${svg('alert')}</span>`:job.state==='cancelled'?`<span class="file-symbol muted">${svg('close')}</span>`:`<span class="file-symbol">${svg('box')}</span>`;
  const detail=job.state==='queued'?`Waiting · ${job.files.length} ${job.files.length===1?'file':'files'} · ${size(job.size)}`:esc(job.detail||'');
  const action=job.state==='queued'?`<button class="queue-x" data-create="remove" data-job="${job.id}" aria-label="Remove ${name} from queue">${svg('close')}</button>`:job.outputs?.length?job.downloaded?`<button class="quiet" data-create="save" data-job="${job.id}">Download again ${svg('arrow')}</button>`:`<button class="primary" data-create="save" data-job="${job.id}">${svg('arrow')} Download</button>`:'';
  return `<li class="queue-row ${job.state}" data-row="${job.id}">${symbol}<div class="queue-main"><span class="file-name">${name}</span><span class="queue-detail">${detail}</span></div>${action}</li>`;
 }
 private render(){
  this.host.hidden=!this.jobs.length;if(this.host.hidden)return;
  const done=this.jobs.filter(job=>job.state==='done').length,counted=this.jobs.filter(job=>job.state!=='cancelled').length,finished=this.jobs.some(job=>!['queued','active'].includes(job.state));
  this.host.innerHTML=`<div class="queue-head"><div><h2>Creating</h2><span class="queue-count">${done} of ${counted} done</span></div><div class="queue-actions">${finished?'<button class="quiet" data-create="clear">Clear finished</button>':''}${this.active?'<button class="quiet" data-create="cancel-all">Cancel all</button>':''}</div></div><ol class="queue-list">${this.jobs.map(job=>this.row(job)).join('')}</ol>`;
  this.renderActive();
 }
 private renderActive(){
  const job=this.active,row=job&&this.host.querySelector(`[data-row="${job.id}"]`);if(!row)return;
  const {size}=this.helpers,view=this.tracker.view(performance.now()),sample=view.sample,bar=row.querySelector('progress')!;
  const set=(field:string,text:string)=>{const target=row.querySelector(`[data-field="${field}"]`);if(target)target.textContent=text;};
  if(view.percent===undefined)bar.removeAttribute('value');else bar.value=view.percent;
  set('percent',view.percent===undefined?'Working…':`${view.percent.toFixed(0)}%`);set('phase',sample.message);set('elapsed',`${duration(view.elapsedSeconds)} elapsed`);
  set('bytes',sample.processedBytes===undefined?'':`${size(sample.processedBytes)}${sample.totalBytes===undefined?'':` / ${size(sample.totalBytes)}`}`);
  set('files',sample.filesProcessed===undefined?'':`${sample.filesProcessed}${sample.totalFiles===undefined?'':` / ${sample.totalFiles}`} files`);
  set('rate',view.rate===undefined?'':`${size(view.rate<1024?Math.round(view.rate):view.rate)}/s`);
  set('eta',view.etaSeconds===undefined?'':`${duration(view.etaSeconds)} left`);
 }
}
