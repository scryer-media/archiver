import {askExpansion,expansionMessage,type ExpansionPause} from './expansion';
import {nativeStreamFormat} from './native-stream';
import {metadataDownload} from './archive-metadata';
import type {ArchiveEntry,ExtractionOptions} from '../engine/client';
import '@fontsource-variable/fira-code';
import './style.css';
import './dark.css';
import './workflows.css';
import {svg,fileIcon} from './icons';
import {canPickFolder,canCopy,canAddFolder,canDrop,tabCapacity} from './browser';
import {loadOnScroll,moreLine} from './scroll-more';
import { ArchiveEngine, zipDownloadName } from './tool-engine';
import {downloadZip} from './zip-download';
import { ProgressTracker, duration, type ProgressSample } from './progress';
import { chooseDelivery, intrinsicRawStream, LARGE_DELIVERY_BYTES, type DeliveryEntry } from './delivery';
import { streamDownloadCapability } from '../engine/download';
import {checkRecovery,hasParity,memoryBudget,repairedArchives} from './recovery';
import { destinationPathRegistry } from '../engine/destination';
import { generatePassword } from './password';
import {CreationSettings} from './create-settings';
import {ExtractionQueue} from './queue';
import {handOff} from './fly';
import {CreateQueue,archiveStem,type Delivery} from './create-queue';
import {groupArchives,recoveryName} from './archive-groups';
type Mode='extract'|'create';
let operationId=0;
let activeDirectOutput=false,activeStreamOutput=false;
let listedEntries:DeliveryEntry[]|undefined;
let latestMetadata:ArchiveEntry[]=[];
const streamBackend=():ExtractionOptions['streamBackend']=>mode==='create'&&!creationSettings.advanced?'auto':($('#stream-backend') as HTMLSelectElement).value as ExtractionOptions['streamBackend'];
// No fixed cap: an operation that expands far past its input pauses and asks instead (see askExpansion).
const writeBudget=()=>Number.MAX_SAFE_INTEGER;
const extractionOptions=():ExtractionOptions=>({outputLimitBytes:writeBudget(),streamBackend:streamBackend(),links:($('#archive-links') as HTMLSelectElement).value as ExtractionOptions['links']});
let streamCapability:{available:boolean;reason?:string}={available:false,reason:'Checking streamed-download support…'};
let saving=false;
function lockControls(locked:boolean){document.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement>('#selection button, #selection input, #selection select, [data-mode], #browse, #browse-folder, #queue-create, #save-all, #update-app, [data-download]').forEach(control=>control.disabled=locked);}
let repairedInputs:File[]=[];let recoveryChecked=false;
let directories:string[]=[], outputDirectories:string[]=[];
const archiveName=(name:string)=>/\.(7z(?:\.\d{3})?|zip|rar|r\d\d|exe|tar|gz|tgz|zst|zstd|br|xz|bz2|bzip2|lzma|lz4|deflate|zlib|zz)$/i.test(name);
const archiveInputs=()=>{const selected=repairedInputs.length?repairedInputs:files;const archives=selected.filter(file=>!/\.(par2|par3|rev)$/i.test(file.name));return repairedInputs.length?archives:archives.sort((a,b)=>Number(archiveName(b.name))-Number(archiveName(a.name))||a.name.localeCompare(b.name,undefined,{numeric:true}));};
let mode:Mode='extract', files:File[]=[],busy=false,selectedArchive=false, outputs:{name:string;blob:Blob}[]=[];
const tracker=new ProgressTracker();let progressTimer:ReturnType<typeof setInterval>|undefined;let lastAnnouncement=0,lastPhase='';
let expansionPause:ExpansionPause|undefined;
// Single files downloaded from an opened archive's contents. Their blobs live in this engine's storage, so it stays until the selection changes.
let entryEngine:ArchiveEngine|undefined;
const releaseEntryEngine=()=>{void entryEngine?.dispose();entryEngine=undefined;};
// One entry at a time: the entry engine runs a single extraction.
let entryChain=Promise.resolve();
function downloadEntry(button:HTMLButtonElement){
 const entry=listedEntries?.[Number(button.dataset.entry)] as ArchiveEntry|undefined;
 if(!entry||entry.isDirectory||entry.isLink||busy||saving||button.classList.contains('working'))return;
 button.classList.add('working');button.setAttribute('aria-busy','true');
 const inputs=archiveInputs(),password=($('#password') as HTMLInputElement).value||undefined,format=($('#input-format') as HTMLSelectElement).value||undefined,options={...extractionOptions(),only:[entry.name]};
 // A large file goes straight to Downloads, so it never has to fit in browser storage.
 const stream=streamCapability.available&&entry.size>=LARGE_DELIVERY_BYTES;
 entryChain=entryChain.then(async()=>{
  try{
   entryEngine??=Object.assign(new ArchiveEngine(()=>{}),{onExpansion:askExpansion(showExpansion)});
   const result=await entryEngine.extract(inputs,password,format,undefined,stream?'download':undefined,options);
   if(result.complete===false)throw new Error(result.message||'Incomplete');
   if(stream){if(!result.downloadSent)throw new Error('The download did not start.');notice(`${entry.name.split('/').pop()} is going to your browser’s Downloads.`);return;}
   const file=result.files.find(item=>item.name===entry.name);
   if(!file)throw new Error('The file was not in the extracted output.');
   save(file);
  }catch(error){notice(`Could not download ${entry.name}: ${error instanceof Error?error.message:String(error)}`,true);}
  finally{button.classList.remove('working');button.removeAttribute('aria-busy');}
 });
}
function showExpansion(pause:ExpansionPause|undefined){
 expansionPause=pause;$('#expansion').hidden=!pause;
 if(pause){$('#expansion-text').textContent=expansionMessage(pause,size);for(const id of ['#expansion-stop','#expansion-keep'])($(id) as HTMLButtonElement).disabled=false;$('#expansion-keep').focus();}
}
/** The on-screen engine; a pause for runaway expansion shows in the progress panel. */
const onScreenEngine=()=>{const created=new ArchiveEngine(updateProgress);created.onExpansion=askExpansion(showExpansion);return created;};
let engine=onScreenEngine();
function updateProgress(progress:ProgressSample){if(!busy)return;tracker.update(progress,performance.now());renderProgress();}
function startProgress(){activeStreamOutput=false;tracker.start(performance.now());lastAnnouncement=0;lastPhase='';renderProgress();if(progressTimer)clearInterval(progressTimer);progressTimer=setInterval(renderProgress,1000);}
function stopProgress(){if(progressTimer)clearInterval(progressTimer);progressTimer=undefined;}
function renderProgress(){
 const now=performance.now(),view=tracker.view(now),sample=view.sample,bar=$('#progress') as HTMLProgressElement;
 $('#phase').textContent=sample.message;
 if(view.percent===undefined){bar.removeAttribute('value');bar.setAttribute('aria-valuetext','Progress total unavailable for this phase');}else{bar.value=view.percent;bar.setAttribute('aria-valuetext',view.percent>=100?'Phase data processed; finishing operation':`${view.percent.toFixed(1)} percent of this phase`);}
 $('#progress-percent').textContent=view.percent===undefined?'Working…':view.percent>=100?'Data processed':`${view.percent.toFixed(1)}% of phase`;
 const bytes=sample.processedBytes,total=sample.totalBytes;
 $('#progress-bytes').textContent=bytes===undefined?'Waiting for measured data':`${size(bytes)}${total===undefined?'':` / ${size(total)}`} ${sample.unit==='output'?(activeStreamOutput?'sent to browser':'written'):'processed'}`;
 $('#progress-output').textContent=sample.outputBytes===undefined?'':`${size(sample.outputBytes)} ${activeStreamOutput?'sent to browser':'output written'}`;
 $('#progress-files').textContent=sample.filesProcessed===undefined?'':`${sample.filesProcessed}${sample.totalFiles===undefined?'':` / ${sample.totalFiles}`} files`;
 $('#progress-rate').textContent=view.rate===undefined?(view.stalled?'Waiting for progress':'Measuring…'):`${size(view.rate<1024?Math.round(view.rate):view.rate)}/s`;
 $('#progress-eta').textContent=view.etaSeconds!==undefined?`About ${duration(view.etaSeconds)}`:total===undefined?'No known total':bytes!==undefined&&bytes>=total?'Finishing…':view.stalled?'Waiting for progress':'Estimating…';
 $('#progress-elapsed').textContent=duration(view.elapsedSeconds);
 if(sample.phase!==lastPhase||now-lastAnnouncement>=5000){$('#progress-announcement').textContent=`${sample.message}. ${$('#progress-bytes').textContent}. ${view.etaSeconds===undefined?'':`Phase time remaining about ${duration(view.etaSeconds)}.`}`;lastAnnouncement=now;lastPhase=sample.phase;}
}

const $=(s:string)=>document.querySelector(s) as HTMLElement;
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const size=(n:number)=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:n<1073741824?`${(n/1048576).toFixed(1)} MB`:`${(n/1073741824).toFixed(2)} GB`;
document.querySelector('#app')!.innerHTML=`<header><a class="brand" href="/"><img src="/brand/logo.svg" alt="Archiver" width="211" height="30"></a><div class="header-right"><button id="update-app" class="secondary" hidden>${svg('refresh')} Update downloaded</button><button id="install" class="secondary" hidden>${svg('install')} Install app</button></div></header><main><h1 class="screen-reader-only">Archiver</h1><section class="workspace" aria-label="Archive tools"><nav class="tabs" aria-label="Choose a tool"><button data-mode="extract" aria-pressed="true" class="active">${svg('arrow')} Extract</button><button data-mode="create" aria-pressed="false">${svg('plus')} Create</button></nav><div class="tool-body"><div class="tool-heading screen-reader-only"><div><h2 id="tool-title">Extract archive</h2><p id="tool-description"></p></div></div><div id="dropzone" class="dropzone"><div class="drop-icon">${svg('box')}</div><h3 id="drop-title">Drop archives here</h3><p id="drop-description">ZIP, 7z, RAR, TAR and compressed streams</p><div class="open-buttons"><button class="primary" id="browse">Choose archives ${svg('plus')}</button><button class="secondary" id="browse-folder" hidden>${svg('folder')} Folder</button></div><p id="folder-note" class="local-note" hidden>Your browser may say “Upload”. Files stay on this device.</p></div><input id="file-input" type="file" multiple hidden><input id="folder-input" type="file" webkitdirectory multiple hidden><div id="selection" hidden><div class="selection-head"><div class="selection-title"><h3 id="selection-title">Your files</h3><div id="creation-mode" class="creation-mode" role="group" aria-label="Creation settings" hidden><button id="creation-simple" type="button" aria-pressed="true" class="active">Simple</button><button id="creation-advanced" type="button" aria-pressed="false">Advanced</button></div></div><button id="clear" class="quiet">${svg('close')} Clear selection</button></div><div id="file-list" class="file-list"></div><div id="file-settings" hidden></div><div class="context-buttons"><button id="add-files" class="quiet">${svg('plus')} Choose more files</button><button id="add-folder" class="quiet" hidden>${svg('folder')} Add folder</button></div><div class="options"><label id="format-label" hidden>Archive format<select id="format"><option value="zip">ZIP</option><option value="7z">7z</option><option value="tar">TAR</option><option value="tar.gz">TAR.GZ</option><optgroup label="Single-file compression streams"><option value="gz">GZIP</option><option value="zstd">Zstandard (.zst)</option><option value="br">Brotli (.br)</option><option value="xz">XZ (.xz)</option><option value="bz2">BZip2 (.bz2)</option><option value="lzma">LZMA (.lzma)</option><option value="lz4">LZ4 frame (.lz4)</option><option value="deflate">Raw Deflate</option><option value="zlib">Zlib</option></optgroup><optgroup label="TAR with compression"><option value="tar.zstd">TAR + Zstandard (.zst)</option><option value="tar.br">TAR + Brotli (.br)</option><option value="tar.xz">TAR + XZ (.xz)</option><option value="tar.bz2">TAR + BZip2 (.bz2)</option><option value="tar.lzma">TAR + LZMA (.lzma)</option><option value="tar.lz4">TAR + LZ4 frame (.lz4)</option><option value="tar.deflate">TAR + Raw Deflate</option><option value="tar.zlib">TAR + Zlib</option></optgroup><option value="par2">PAR2 recovery files</option></select></label><label id="effort-label" hidden>Compression<select id="effort"><option value="standard">Standard</option><option value="max">Max</option></select></label><label id="link-policy-label">Archive links<select id="archive-links"><option value="reject">Reject links</option><option value="copy-safe">Copy safe in-archive file targets</option></select></label><label id="input-format-label">Input format<select id="input-format"><option value="">Detect automatically</option><option value="br">Brotli stream</option><option value="deflate">Raw Deflate stream</option><option value="zlib">Zlib stream</option><option value="lzma">LZMA stream</option></select></label><div id="password-label" class="password-field"><label for="password" class="field-label">Password <small>optional</small></label><div class="password-row"><div class="password-input"><input id="password" type="password" placeholder="Password" autocomplete="off" spellcheck="false" autocapitalize="off" data-1p-ignore data-lpignore="true" data-bwignore data-protonpass-ignore="true" data-form-type="other"><span class="field-icons"><button id="copy-password" type="button" class="field-icon" aria-label="Copy password" title="Copy password" hidden>${svg('copy')}</button><button id="show-password" type="button" class="field-icon" aria-controls="password" aria-pressed="false" aria-label="Show password" title="Show password">${svg('eye')}</button></span></div><button id="generate-password" type="button" class="quiet" hidden>${svg('sparkle')} Generate</button></div><span id="password-announcement" class="screen-reader-only" role="status" aria-live="polite"></span></div></div><details id="seven-options" class="advanced-settings" hidden><summary>Archive options</summary><label id="header-option" class="check-setting" hidden><input id="encrypt-headers" type="checkbox" checked><span>Encrypt file names</span></label><label id="solid-option" class="solid-option" title="Groups consecutive files with matching settings into solid blocks." hidden><input id="solid" type="checkbox"><span>Group matching files (solid)</span></label><div class="advanced-options"><label>Compression<select id="codec"><option value="lzma2">LZMA2 · recommended</option><option value="lzma">LZMA</option><option value="ppmd">PPMd</option><option value="bzip2">BZip2</option><option value="zstd">Zstandard</option><option value="deflate">Deflate</option><option value="lz4">LZ4</option><option value="brotli">Brotli</option><option value="copy">Store · no compression</option></select></label><label>Content filter<select id="filter"><option value="none">None</option><option value="delta">Delta</option><option value="x86">x86 executable</option><option value="arm">ARM executable</option><option value="arm64">ARM64 executable</option><option value="thumb">ARM Thumb</option><option value="ia64">IA-64</option><option value="sparc">SPARC</option><option value="ppc">PowerPC</option><option value="riscv">RISC-V</option><option value="bcj2">BCJ2</option></select></label><label id="delta-label" hidden>Delta distance<input id="delta-distance" type="number" min="1" max="256" value="1"></label><label id="dictionary-option" class="dictionary-option" hidden>LZMA dictionary, at most<select id="dictionary"><option value="65536">64 KiB</option><option value="262144">256 KiB</option><option value="1048576">1 MiB</option><option value="2097152">2 MiB</option><option value="4194304">4 MiB</option><option value="8388608" selected>8 MiB · recommended</option></select><small>One size for the whole archive, so solid groups stay together. Less data uses a smaller dictionary automatically.</small></label><label>Add recovery files<select id="protection"><option value="">None</option><option value="par2">PAR2 protection</option></select></label></div></details><div id="parity-options" class="advanced-options parity-options" hidden><div class="settings-intro"><strong>Recovery settings</strong></div><label>Recovery data<select id="recovery-percent"><option value="5">5% · light protection</option><option value="10">10%</option><option value="20" selected>20% · recommended</option><option value="30">30%</option><option value="50">50%</option><option value="100">100%</option></select></label><label>Block size<select id="block-size"><option value="262144">256 KiB</option><option value="1048576" selected>1 MiB · recommended</option><option value="4194304">4 MiB</option><option value="16777216">16 MiB</option></select></label><label>Recovery blocks<input id="recovery-blocks" type="number" min="1" max="65535" placeholder="Use percentage above"></label><p id="par3-codec-label" class="parity-note" hidden>FFT recovery sidecars are created alongside the archive.</p></div><details id="advanced-recovery" class="advanced-recovery" hidden><summary>Advanced recovery settings <span>+</span></summary><div class="advanced-options"><label>Recovery volume layout<select id="volume-scheme"><option value="variable">Variable · recommended</option><option value="uniform">Uniform</option><option value="limited" data-par2>Limited (PAR2)</option><option value="size" data-par3>By size (PAR3)</option></select></label><label id="volume-count-label">Volume count<input id="volume-count" type="number" min="1" placeholder="Automatic"></label><label id="volume-blocks-label" hidden>Blocks per volume<input id="volume-blocks" type="number" min="1" placeholder="Automatic"></label><label id="volume-bytes-label" hidden>Volume size in MiB<input id="volume-bytes" type="number" min="1" placeholder="Automatic"></label><label>First recovery block<input id="first-recovery" type="number" min="0" value="0"></label><label id="dedup-label" hidden>Deduplication<select id="deduplication"><option value="none">None</option><option value="aligned">Aligned blocks</option><option value="sliding">Sliding blocks</option></select></label><label id="interleave-label" hidden>Extra FFT cohorts<input id="par3-interleave" type="number" min="0" value="0"></label><label id="capacity-label" hidden>FFT capacity, log₂<input id="par3-capacity" type="number" min="1" max="16" placeholder="Automatic"></label><label id="store-data-label" class="check-setting" hidden><input id="store-data" type="checkbox"><span>Include source-data packets</span></label></div></details><div class="action-row"><p id="action-hint">Ready when you are.</p><button id="add-queue" class="secondary" hidden>${svg('queue')} <span>Add to queue</span></button><button id="extract-folder" class="secondary" hidden>${svg('folder')} Extract to folder</button><button id="queue-create" class="secondary" hidden>${svg('queue')} Queue</button><button class="primary" id="run">Open archive ${svg('arrow')}</button></div></div><p id="delivery-hint" class="destination-hint" role="status"></p><p id="folder-hint" class="destination-hint" hidden></p><div id="operation" hidden><div class="progress-heading"><strong id="phase">Preparing your files…</strong><button id="cancel" class="danger">${svg('close')} Cancel</button></div><progress id="progress" aria-label="Operation progress" max="100"></progress><div class="progress-caption"><strong id="progress-percent">Working…</strong><span id="progress-files"></span></div><div class="progress-data"><span id="progress-bytes"></span><span id="progress-output"></span></div><dl class="progress-stats"><div><dt>Speed</dt><dd id="progress-rate">Measuring…</dd></div><div><dt>Phase ETA</dt><dd id="progress-eta">Not available yet</dd></div><div><dt>Elapsed</dt><dd id="progress-elapsed">0s</dd></div></dl><p class="progress-note"></p><div id="expansion" class="expansion" role="alert" hidden><p id="expansion-text"></p><div class="expansion-actions"><button id="expansion-stop" class="danger">${svg('stop')} Stop</button><button id="expansion-keep" class="primary">${svg('play')} Keep going</button></div></div><span id="progress-announcement" class="screen-reader-only" role="status" aria-live="polite"></span></div><div id="notice" role="status" hidden></div><div id="results" hidden><div class="selection-head"><h3 id="result-title">Archive contents</h3><button id="metadata-download" class="quiet" type="button" hidden>${svg('file')} Download metadata</button><button id="save-all" class="secondary" hidden>${svg('arrow')} Save all files</button></div><div id="result-list" class="file-list"></div></div></div></section><section id="create-queue" class="queue create-queue" aria-label="Archives being created" hidden></section><section id="queue" class="queue" aria-label="Extraction queue" hidden></section><input id="queue-input" type="file" multiple hidden></main><section class="privacy" aria-labelledby="privacy-title"><h2 id="privacy-title">Your files never leave your device.</h2><div class="privacy-grid"><div><span class="privacy-icon">${svg('chip')}</span><h3>Runs locally</h3><p>WebAssembly on your device.</p></div><div><span class="privacy-icon">${svg('no-upload')}</span><h3>No uploads</h3><p>No accounts. No telemetry.</p></div><div><span class="privacy-icon">${svg('lock')}</span><h3>Locked down</h3><p>No third-party requests.</p></div><div><span class="privacy-icon">${svg('offline')}</span><h3>Works offline</h3><p>Once installed.</p></div></div></section><footer><span>Powered by</span><a class="footer-brand" href="https://www.scryer.media" rel="noopener"><img src="/scryer-media.png" alt="" width="48" height="48">Scryer Media${svg('external')}</a></footer>`;
const streamOptions=document.createElement('details');streamOptions.id='stream-backend-options';streamOptions.className='advanced-settings';streamOptions.hidden=true;
streamOptions.innerHTML='<summary>Stream options</summary><div class="advanced-options"><label>Compression engine<select id="stream-backend"><option value="auto">Automatic</option><option value="native">Browser</option><option value="wasm">WASM</option></select></label></div>';
document.querySelector('.options')!.after(streamOptions);
const creationSettings=new CreationSettings($('#file-settings'),updateFormat,()=>busy||saving);
const queue=new ExtractionQueue($('#queue'),{isArchive:archiveName,svg,esc,size,canStart:()=>!busy&&!saving,notice,save:file=>save(file),streaming:()=>streamCapability.available,addArchives:()=>($('#queue-input') as HTMLInputElement).click()});
const createQueue=new CreateQueue($('#create-queue'),{svg,esc,size,save:file=>save(file)});
function queueAdd(source:File[]){const groups=groupArchives(source,archiveName);if(!groups.length){notice('No archives found in that selection.',true);return 0;}queue.add(groups,mode==='extract'?($('#password') as HTMLInputElement).value||undefined:undefined,mode==='extract'?($('#input-format') as HTMLSelectElement).value||undefined:undefined,extractionOptions());return groups.length;}
function updateFormat(){
 const format=($('#format') as HTMLSelectElement).value, native=mode==='create'&&format==='7z', protection=($('#protection') as HTMLSelectElement).value;
 $('#creation-mode').hidden=mode!=='create';$('#file-settings').hidden=mode!=='create';$('#file-list').hidden=mode==='create'&&creationSettings.advanced;const dictionary=$('#dictionary') as HTMLSelectElement;for(const option of dictionary.options)option.disabled=Number(option.value)>memoryBudget()/32;if(dictionary.selectedOptions[0]?.disabled)dictionary.value=[...dictionary.options].filter(option=>!option.disabled).pop()?.value??'65536';creationSettings.setContext(format,memoryBudget(),Number(dictionary.value));$('#effort-label').hidden=mode!=='create'||creationSettings.advanced||!hasEffort(format);($('#effort') as HTMLSelectElement).value=creationSettings.effort;
 $('#creation-simple').setAttribute('aria-pressed',String(!creationSettings.advanced));$('#creation-advanced').setAttribute('aria-pressed',String(creationSettings.advanced));$('#creation-simple').classList.toggle('active',!creationSettings.advanced);$('#creation-advanced').classList.toggle('active',creationSettings.advanced);
 $('#stream-backend-options').hidden=mode==='create'?(!creationSettings.advanced||!/(?:^|\.)(?:gz|zstd|br|xz|bz2|lzma|lz4|deflate|zlib)$/.test(format)):!intrinsicRawStream(archiveInputs().map(file=>file.name),($('#input-format') as HTMLSelectElement).value);
 const selectedStream=mode==='create'?(format.startsWith('tar.')?format.slice(4):format):(($('#input-format') as HTMLSelectElement).value||archiveInputs()[0]?.name.toLowerCase().match(/\.([^.]+)$/)?.[1]||'');
 const backendSelect=$('#stream-backend') as HTMLSelectElement,browserOption=backendSelect.querySelector<HTMLOptionElement>('[value="native"]')!;browserOption.disabled=!nativeStreamFormat(selectedStream,mode==='create'?'compress':'decompress');if(browserOption.disabled&&backendSelect.value==='native')backendSelect.value='auto';
 $('#header-option').hidden=!native||!creationSettings.advanced||!($('#password') as HTMLInputElement).value;
 const parity=mode==='create'&&(format==='par2'||format==='par3'||(native&&!!protection)), par3=parity&&(format==='par3'||protection==='par3');
 $('#extract-folder').hidden=mode!=='extract'||!(canPickFolder());
 const groups=selectedGroups();$('#add-queue').hidden=!groups.length;if(groups.length>1)$('#extract-folder').hidden=true;$('#add-queue span').textContent=groups.length>1?`Add ${groups.length} to queue`:'Add to queue';
 $('#folder-hint').hidden=mode!=='extract'||!files.length||canPickFolder();$('#folder-hint').textContent=canPickFolder()?'Extract to folder preserves all files and empty folders in a new destination subfolder.':'This browser can’t save into a folder, so an archive with several files downloads as one .zip.';
 updateDelivery();
 $('#solid-option').hidden=!native||!creationSettings.advanced;$('#dictionary-option').hidden=!native;$('#seven-options').hidden=!native;$('#parity-options').hidden=!parity;
 $('#par3-codec-label').hidden=!par3;$('#advanced-recovery').hidden=!parity;
 $('#add-files').innerHTML=mode==='create'?svg('plus')+' Add files':svg('file')+' Choose different files';$('#add-folder').hidden=mode!=='create'||!canAddFolder();
 $('#link-policy-label').hidden=mode!=='extract';$('#queue-create').hidden=mode!=='create';$('#metadata-download').hidden=!latestMetadata.length;
 ['codec','filter','delta-distance'].forEach(id=>$('#'+id).closest('label')!.hidden=true);
 $('#password-label').hidden=mode==='create'&&!['7z','zip'].includes(format);$('#generate-password').hidden=mode!=='create'||!['7z','zip'].includes(format);$('#copy-password').hidden=!canCopy()||mode!=='create'||!['7z','zip'].includes(format);$('#input-format-label').hidden=mode!=='extract';
 document.querySelectorAll<HTMLOptionElement>('[data-par2]').forEach(option=>option.disabled=par3);
 document.querySelectorAll<HTMLOptionElement>('[data-par3]').forEach(option=>option.disabled=!par3);
 const scheme=$('#volume-scheme') as HTMLSelectElement;if(scheme.selectedOptions[0]?.disabled)scheme.value='variable';
 $('#volume-count-label').hidden=par3;$('#volume-blocks-label').hidden=!par3||scheme.value!=='uniform';$('#volume-bytes-label').hidden=!par3||scheme.value!=='size';
 ['dedup-label','interleave-label','capacity-label','store-data-label'].forEach(id=>$('#'+id).hidden=!par3);
 if(mode==='create'&&files.length)$('#run').innerHTML=(format==='par2'||format==='par3'?'Create recovery files':'Create archive')+svg('box');
}
['format','protection','filter','volume-scheme','input-format'].forEach(id=>$('#'+id).addEventListener('change',updateFormat));
function selectedGroups(){return mode==='extract'&&files.length&&!selectedArchive?groupArchives(repairedInputs.length?repairedInputs:files,archiveName):[];}
function deliveryDecision(){return chooseDelivery({mode,choice:'auto',format:($('#format') as HTMLSelectElement).value,inputNames:mode==='create'?files.map(file=>file.webkitRelativePath||file.name):archiveInputs().map(file=>file.name),inputFormatHint:($('#input-format') as HTMLSelectElement).value||undefined,inputBytes:files.reduce((sum,file)=>sum+file.size,0),maxInputFileBytes:files.reduce((max,file)=>Math.max(max,file.size),0),inputCount:files.length,directoryCount:directories.length,entries:listedEntries,available:streamCapability.available,unavailableReason:streamCapability.reason,folderAccess:canPickFolder()});}
function updateDelivery(updateAction=true){const decision=deliveryDecision();$('#delivery-hint').textContent=decision.reason;$('#delivery-hint').hidden=!files.length||!decision.blocked&&!decision.stream;$('#delivery-hint').classList.toggle('delivery-warning',decision.blocked);if(!busy)($('#run') as HTMLButtonElement).disabled=(mode==='create'||selectedArchive||!decision.requiresInspection)&&decision.blocked;if(!updateAction)return;if(mode==='extract'&&selectedArchive)$('#run').innerHTML=(decision.blocked?'Choose another output':decision.zip?'Download as .zip':decision.stream?'Download file':'Extract all files')+svg('arrow');else if(mode==='extract'&&files.length){const hint=($('#input-format') as HTMLSelectElement).value,canOpen=!!hint||archiveInputs().some(file=>archiveName(file.name))||!files.some(file=>/\.(par2|par3|rev)$/i.test(file.name));$('#run').innerHTML=(decision.blocked&&!decision.requiresInspection?'Choose another output':decision.stream&&intrinsicRawStream(archiveInputs().map(file=>file.name),hint)?'Download stream':canOpen?'Open archive':'Verify files')+svg('arrow');}const count=selectedGroups().length;if(count>1){$('#run').innerHTML=`Extract ${count} archives`+svg('arrow');if(!busy)($('#run') as HTMLButtonElement).disabled=false;}}
/** The highest level each single-stream format accepts (Zstandard stops short of its memory-hungry ultra levels); LZ4 frames have none. */
const streamTop:Record<string,number>={gz:9,deflate:9,zlib:9,zstd:19,br:11,xz:9,bz2:9,lzma:9};
const streamOf=(format:string)=>format.startsWith('tar.')?format.slice(4):format;
const hasEffort=(format:string)=>['zip','7z'].includes(format)||streamOf(format) in streamTop;
function createOptions(){
 const format=($('#format') as HTMLSelectElement).value, protection=($('#protection') as HTMLSelectElement).value as 'par2'|'par3'|'';
 const number=(id:string)=>Number(($('#'+id) as HTMLInputElement).value)||undefined;
 return {format,directories,outputLimitBytes:writeBudget(),streamBackend:streamBackend(),fileOptions:mode==='create'?creationSettings.options():undefined,encryptHeaders:mode==='create'&&format==='7z'&&($('#password') as HTMLInputElement).value?(creationSettings.advanced?($('#encrypt-headers') as HTMLInputElement).checked:true):undefined,password:mode==='create'&&!['zip','7z'].includes(format)?undefined:($('#password') as HTMLInputElement).value||undefined,solid:creationSettings.advanced?($('#solid') as HTMLInputElement).checked:format==='7z'&&files.length>1,codec:mode==='create'?undefined:($('#codec') as HTMLSelectElement).value,filter:mode==='create'?undefined:($('#filter') as HTMLSelectElement).value,deltaDistance:undefined,protection:format==='7z'?(protection||undefined):undefined,blockSize:number('block-size'),recoveryPercent:number('recovery-percent'),recoveryBlocks:number('recovery-blocks'),par3Codec:'fft' as const,memoryLimit:memoryBudget(),volumeScheme:($('#volume-scheme') as HTMLSelectElement).value,volumeCount:number('volume-count'),volumeBlocks:number('volume-blocks'),volumeBytes:number('volume-bytes')===undefined?undefined:number('volume-bytes')!*1048576,firstRecovery:number('first-recovery')||0,deduplication:($('#deduplication') as HTMLSelectElement).value as 'none'|'aligned'|'sliding',storeData:($('#store-data') as HTMLInputElement).checked,par3Interleave:number('par3-interleave')||0,par3CapacityLog2:number('par3-capacity'),level:mode==='create'&&!creationSettings.advanced&&creationSettings.effort==='max'?streamTop[streamOf(format)]:undefined};
}
function notice(message:string,error=false){$('#notice').textContent=message;$('#notice').hidden=false;$('#notice').className=error?'error':'success';}
function setMode(next:Mode){if(busy||saving)return;releaseEntryEngine();engine.dispose();mode=next;creationSettings.reset();($('#solid') as HTMLInputElement).checked=true;($('#dictionary') as HTMLSelectElement).value='8388608';($('#encrypt-headers') as HTMLInputElement).checked=true;listedEntries=undefined;latestMetadata=[];($('#archive-links') as HTMLSelectElement).value='reject';files=[];directories=[];outputs=[];outputDirectories=[];repairedInputs=[];recoveryChecked=false;selectedArchive=false;$('#selection').hidden=true;$('#results').hidden=true;$('#notice').hidden=true;$('#dropzone').hidden=false; document.querySelectorAll('[data-mode]').forEach(b=>{b.classList.toggle('active',b.getAttribute('data-mode')===mode);b.setAttribute('aria-pressed',String(b.getAttribute('data-mode')===mode));});const copy={extract:['Extract archive','','Drop archives here','ZIP, 7z, RAR, TAR and compressed streams','Choose archives'],create:['Create archive','','Drop files or folders here','Anything you drop goes into the archive','Files'],verify:['A little peace of mind.','Check your files against PAR2 or PAR3 recovery data.','Drop files to verify','Include source files and matching recovery files','Choose files to verify'],repair:['Give your files another chance.','Add damaged files with PAR2, PAR3, RAR recovery records or REV volumes.','Drop files to repair','Include every available recovery volume','Choose repair files']}[mode];if(!canDrop())copy[2]=mode==='create'?'Choose files to archive':'Choose archives to extract';['tool-title','tool-description','drop-title','drop-description'].forEach((id,i)=>$('#'+id).textContent=copy[i]);$('#browse').innerHTML=mode==='create'?svg('file')+' Files':svg('plus')+' '+copy[4];$('#browse-folder').hidden=mode!=='create'||!canAddFolder();$('#folder-note').hidden=mode!=='create'||canPickFolder();$('#format-label').hidden=mode!=='create';$('#password-label').hidden=false;($('#password') as HTMLInputElement).value='';($('#password') as HTMLInputElement).type='password';$('#show-password').innerHTML=svg('eye');$('#show-password').setAttribute('aria-pressed','false');$('#show-password').setAttribute('aria-label','Show password');$('#password-announcement').textContent='';updateFormat();}
function renderRows(selector:string,count:number,row:(index:number)=>string,empty=''){
 const target=$(selector);target.innerHTML='';let shown=0;
 const more=()=>{target.querySelector('[data-more]')?.remove();const end=Math.min(count,shown+200);let html='';for(;shown<end;shown++)html+=row(shown);target.insertAdjacentHTML('beforeend',html);if(shown<count){const line=document.createElement('div');line.className='list-more';line.dataset.more='';line.textContent=moreLine(shown,count);target.append(line);loadOnScroll(line,more);}};
 if(count)more();else target.innerHTML=empty;
}
function accept(incoming:File[]){if(busy||saving||(!incoming.length&&!directories.length))return;releaseEntryEngine();listedEntries=undefined;latestMetadata=[];$('#metadata-download').hidden=true;repairedInputs=[];recoveryChecked=false;outputs=[];outputDirectories=[];($('#input-format') as HTMLSelectElement).value='';$('#save-all').hidden=true;files=mode==='create'?[...files,...incoming]:incoming;if(mode==='create')creationSettings.setFiles(files); selectedArchive=false; $('#dropzone').hidden=true;$('#selection').hidden=false;$('#results').hidden=true;$('#notice').hidden=true;renderRows('#file-list',files.length+directories.length,index=>{if(index>=files.length)return `<div class="file-row"><span class="file-symbol">${svg('folder')}</span><span class="file-name">${esc(directories[index-files.length])}</span><span class="file-size">Folder</span></div>`;const f=files[index];return `<div class="file-row">${recoveryName(f.name)?`<span class="file-symbol recovery" title="Recovery file">${svg('shield')}</span>`:`<span class="file-symbol">${svg(fileIcon(f.name))}</span>`}<span class="file-name">${esc(f.webkitRelativePath||f.name)}</span><span class="file-size">${size(f.size)}</span></div>`;});$('#selection-title').textContent=`${files.length} ${files.length===1?'file':'files'}${directories.length?` · ${directories.length} folders`:''} selected`;$('#run').innerHTML=(mode==='create'?'Create archive':files.some(file=>archiveName(file.name))||!files.some(file=>/\.(par2|par3|rev)$/i.test(file.name))?'Open archive':'Verify files')+svg(mode==='create'?'box':'arrow');$('#action-hint').textContent=`${size(files.reduce((a,f)=>a+f.size,0))} total`;updateFormat();}
function save(file:{name:string;blob:Blob}){const url=URL.createObjectURL(file.blob);const a=document.createElement('a');a.href=url;a.download=file.name.split('/').pop()||'archive';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function saveAll(){
  if(busy||saving||(!outputs.length&&!outputDirectories.length))return;
  const filesToSave=[...outputs], foldersToSave=[...outputDirectories];
  if(filesToSave.length===1&&!foldersToSave.length&&!/[\/]/.test(filesToSave[0].name)){save(filesToSave[0]);return;}
  if(!(canPickFolder())){
   // No folder access: everything goes out as one ZIP download.
   saving=true;lockControls(true);const name=zipDownloadName(archiveInputs());
   try{await downloadZip(name,filesToSave,foldersToSave,{streaming:streamCapability.available,save,progress:(done,total)=>notice(`Packing ${name}: ${done} of ${total} files…`)});notice(`${name} sent to your browser’s downloads.`);}
   catch(error){notice((error as Error).message,true);}finally{saving=false;lockControls(false);}
   return;
  }
  saving=true;lockControls(true);
  try{
   const directory=await (window as any).showDirectoryPicker({mode:'readwrite'});
   const partsFor=(name:string)=>{const parts=name.replaceAll('\\','/').split('/');if(!parts.length||parts.some(part=>!part||part==='..'||part==='.'||part.includes(':')))throw new Error('Unsafe output path rejected.');return parts;};
   const folder=async(parts:string[],create:boolean)=>{let target=directory;for(const part of parts)target=await target.getDirectoryHandle(part,{create});return target;};
   const paths=filesToSave.map(file=>({file,parts:partsFor(file.name)}));
   const folderPaths=foldersToSave.map(name=>partsFor(name.replace(/\/$/,'')));
   const register=destinationPathRegistry(),filePaths=new Set<string>();
   for(const {parts} of paths){const name=parts.join('/');if(filePaths.has(name))throw new Error('Duplicate output file path: '+name);filePaths.add(name);register(name);}
   for(const parts of folderPaths)register(parts.join('/'));
   for(const parts of [...paths.map(item=>item.parts),...folderPaths]){for(let end=1;end<parts.length;end++)if(filePaths.has(parts.slice(0,end).join('/')))throw new Error('Output file/directory path collision.');}
   for(const parts of folderPaths)if(filePaths.has(parts.join('/')))throw new Error('Output file/directory path collision.');
   // Check every destination before writing any output, so an existing file never causes a partial save.
   for(const {file,parts} of paths){try{const target=await folder(parts.slice(0,-1),false);await target.getFileHandle(parts.at(-1));throw new Error('A file named '+file.name+' already exists. Choose an empty destination folder; existing files will not be replaced.');}catch(error){if((error as Error).name!=='NotFoundError')throw error;}}
   for(const parts of folderPaths)await folder(parts,true);
   for(const {file,parts} of paths){const target=await folder(parts.slice(0,-1),true);try{await target.getFileHandle(parts.at(-1));throw new Error('Destination file or filesystem alias already exists: '+file.name);}catch(error){if((error as Error).name!=='NotFoundError')throw error;}const handle=await target.getFileHandle(parts.at(-1),{create:true});const writer=await handle.createWritable();await file.blob.stream().pipeTo(writer);}
   notice('All files saved to your selected folder.');
  }catch(error){if((error as Error).name!=='AbortError')notice((error as Error).message,true);}finally{saving=false;lockControls(false);}

}
/** Hands the Create screen's archive to the create queue and clears the screen for the next one. */
async function queueCreate(delivery:Delivery){
 const decision=deliveryDecision();if(decision.blocked){notice(decision.reason,true);return;}
 const label=$('#run').innerHTML;busy=true;lockControls(true);($('#run') as HTMLButtonElement).disabled=true;$('#run').textContent='Finishing file inspection…';
 try{await creationSettings.ready();}
 catch(error){notice(error instanceof Error?error.message:String(error),true);return;}
 finally{busy=false;lockControls(false);($('#run') as HTMLButtonElement).disabled=false;$('#run').innerHTML=label;}
 const format=($('#format') as HTMLSelectElement).value,stem=archiveStem([...files.map(file=>file.webkitRelativePath||file.name),...directories]);
 const rows=[...document.querySelectorAll('#file-list:not([hidden]) .file-row, #file-settings:not([hidden]) tbody tr')],input={stem,format,files:[...files],options:createOptions(),stream:decision.stream,delivery};
 const host=$('#create-queue'),wasHidden=host.hidden;let name='';
 // The form stays put, locked, until its files have landed in the queue.
 busy=true;lockControls(true);
 try{await handOff(rows,()=>{const added=createQueue.add(input);name=added.name;return ()=>createQueue.rowFor(added.id);},wasHidden?host:undefined);}
 finally{busy=false;lockControls(false);}
 setMode('create');notice(delivery==='hold'?`${name} is queued. Download it from the queue when it’s done.`:`Creating ${name}. It goes to your browser’s Downloads.`);$('#notice').classList.add('screen-reader-only');
}
/** An archive already opened on screen goes to the extraction queue, so it keeps running in its own engine beside creates and other tabs. */
async function queueExtract(toFolder:boolean){
 const delivery=deliveryDecision();if(!toFolder&&delivery.blocked){notice(delivery.reason,true);return;}
 let destination:FileSystemDirectoryHandle|undefined;
 if(toFolder)try{destination=await (window as any).showDirectoryPicker({mode:'readwrite'});}catch(error){if((error as Error).name!=='AbortError')notice((error as Error).message,true);return;}
 if(busy||saving)return;
 const groups=groupArchives(repairedInputs.length?repairedInputs:files,archiveName);if(!groups.length){notice('No archives found in that selection.',true);return;}
 const totalBytes=listedEntries?.reduce((sum,entry)=>sum+(entry.isDirectory?0:entry.size),0);
 queue.add(groups,($('#password') as HTMLInputElement).value||undefined,($('#input-format') as HTMLSelectElement).value||undefined,extractionOptions(),destination?{destination}:{delivery:{stream:delivery.stream,zip:!!delivery.zip,totalBytes}});
 void queue.start();setMode('extract');notice(`Extracting ${groups[0].name}${destination?` to ${destination.name}`:''}. Progress is in the queue below.`);$('#notice').classList.add('screen-reader-only');
}
async function run(action?:'verify'|'repair'|'rebuild'|'direct'|'queue'){
 if(busy||saving||(!files.length&&!(mode==='create'&&directories.length)))return;
 if(mode==='extract'&&!action&&selectedGroups().length>1){if(queueAdd(repairedInputs.length?repairedInputs:files)){void queue.start();setMode('extract');}return;}
 const invalid=[...document.querySelectorAll<HTMLInputElement>('#selection input[type=number]')].find(input=>!input.closest('[hidden]')&&!input.checkValidity());
 if(invalid){invalid.reportValidity();return;}
 if(mode==='create'&&($('#format') as HTMLSelectElement).value==='7z'&&($('#filter') as HTMLSelectElement).value==='bcj2'&&($('#password') as HTMLInputElement).value){notice('BCJ2 cannot be combined with password encryption. Choose another filter or remove the password.',true);return;}
 if(mode==='create'&&(!action||action==='queue')){await queueCreate(action==='queue'?'hold':'download');return;}
 if(mode==='extract'&&selectedArchive&&(!action||action==='direct')){await queueExtract(action==='direct');return;}
 busy=true;activeDirectOutput=action==='direct';lockControls(true);$('#results').hidden=true;$('#save-all').hidden=true;const current=++operationId;startProgress();$('#operation').hidden=false;$('#notice').hidden=true;($('#run') as HTMLButtonElement).disabled=true;$('#cancel').hidden=false;
 const password=($('#password') as HTMLInputElement).value||undefined;
 try{
  if(mode==='create')await creationSettings.ready();
  const destination=action==='direct'?await (window as any).showDirectoryPicker({mode:'readwrite'}):undefined;
  if(current!==operationId)return;
  const formatHint=($('#input-format') as HTMLSelectElement).value||undefined;const canOpen=!!formatHint||archiveInputs().some(file=>archiveName(file.name))||!files.some(file=>/\.(par2|par3|rev)$/i.test(file.name));
  // Recovery files in the selection: check the archive against them first, and repair it when the check finds damage.
  let recoveryNote='';
  if(mode==='extract'&&(!action||action==='direct')&&!selectedArchive&&canOpen&&!recoveryChecked&&hasParity(files)){
   const checked=await checkRecovery(engine,files,password,writeBudget(),archiveName);if(current!==operationId)return;
   recoveryChecked=true;if(checked?.repaired){repairedInputs=checked.files!;listedEntries=undefined;}
   recoveryNote=checked?.repaired?'Repaired with recovery data. ':checked?.checkFailed?`The recovery check could not run (${checked.checkFailed}), so the archive was opened without it. `:'Checked against recovery data. ';
  }
  const previewDelivery=deliveryDecision();if(!action&&previewDelivery.blocked&&!previewDelivery.requiresInspection)throw Error(previewDelivery.reason);
  if(mode==='extract'&&!action&&!selectedArchive&&canOpen&&!(previewDelivery.stream&&intrinsicRawStream(archiveInputs().map(file=>file.name),formatHint))){
   const result=await engine.list(archiveInputs(),password,formatHint,extractionOptions());if(current!==operationId)return;
   outputs=[];outputDirectories=[];$('#save-all').hidden=true;$('#results').hidden=false;$('#result-title').textContent='Archive contents';
   const entries=result.entries||[],entryLimit=streamCapability.available?Infinity:await tabCapacity(writeBudget());if(current!==operationId)return;const tooBig=entries.filter(entry=>!entry.isDirectory&&!entry.isLink&&entry.size>entryLimit).length;latestMetadata=result.metadata||entries;$('#metadata-download').hidden=!latestMetadata.length;listedEntries=entries;renderRows('#result-list',entries.length,index=>{const entry=entries[index];return `<div class="file-row"><span class="file-symbol">${svg(entry.isDirectory?'folder':fileIcon(entry.name))}</span><span class="file-name">${esc(entry.name)}</span><span class="file-size">${entry.isDirectory?'Folder':size(entry.size)}</span>${entry.isDirectory||entry.isLink?'':entry.size>entryLimit?`<span class="download-unavailable" title="Too large to download on its own in this browser" aria-label="${esc(entry.name)} is too large to download on its own in this browser">${svg('alert')}</span>`:`<button class="download" data-entry="${index}" aria-label="Download ${esc(entry.name)}" title="Download">${svg('arrow')}</button>`}</div>`;},'<p class="empty">This archive contains no entries.</p>');
   selectedArchive=true;updateDelivery();$('#result-title').textContent=`Contents · ${entries.length} ${entries.length===1?'entry':'entries'}`;notice(`${recoveryNote}Archive opened. ${entries.length} ${entries.length===1?'entry':'entries'}.${tooBig?` ${tooBig===1?'One file is':`${tooBig} files are`} larger than this browser can hold (${size(entryLimit)}), so ${tooBig===1?'it':'they'} can’t be downloaded on ${tooBig===1?'its':'their'} own.${canPickFolder()?' Extract to a folder to get '+(tooBig===1?'it':'them')+'.':''}`:''}`);if(!recoveryNote&&!tooBig)$('#notice').classList.add('screen-reader-only');return;
  }
  let operation=mode==='create'?'create':(action==='direct'?'extract':action)||(!canOpen?'verify':'extract');
  const delivery=deliveryDecision();if(!action&&(operation==='create'||operation==='extract')&&delivery.blocked)throw Error(delivery.reason);activeStreamOutput=!action&&(operation==='create'||operation==='extract')&&delivery.stream;
  $('#operation .progress-note').textContent=activeStreamOutput?'Check Downloads for final completion.':'';
  let result=operation==='create'?await engine.create(files,{...createOptions(),delivery:activeStreamOutput?'download':undefined}):operation==='verify'?await engine.verify(files,createOptions()):operation==='rebuild'?await engine.rebuildParity(files,createOptions()):operation==='repair'?await engine.repair(files,password,createOptions()):await engine.extract(archiveInputs(),password,formatHint,destination,activeStreamOutput?(delivery.zip?'zip':'download'):undefined,extractionOptions());
  if(current!==operationId)return;
  // Files with recovery data but no archive: repair them right away when the check finds damage.
  if(operation==='verify'&&!action&&result.complete===false&&hasParity(files)){$('#phase').textContent='Repairing your files…';result=await engine.repair(files,password,createOptions());operation='repair';if(current!==operationId)return;}
  latestMetadata=result.metadata||result.entries||[];$('#metadata-download').hidden=!latestMetadata.length;outputs=result.files;outputDirectories=result.directories||[];$('#results').hidden=false;$('#result-title').textContent=operation==='verify'?'Recovery verification':result.downloadSent?'Sent to your browser':'Output';
  renderRows('#result-list',outputDirectories.length+outputs.length,index=>{if(index<outputDirectories.length)return `<div class="file-row"><span class="file-symbol">${svg('folder')}</span><span class="file-name">${esc(outputDirectories[index])}</span><span class="file-size">Folder</span></div>`;const outputIndex=index-outputDirectories.length,file=outputs[outputIndex];return `<div class="file-row"><span class="file-symbol">${svg(fileIcon(file.name))}</span><span class="file-name">${esc(file.name)}</span><span class="file-size">${size(file.blob.size)}</span><button class="download" data-download="${outputIndex}" aria-label="Download ${esc(file.name)}">${svg('arrow')}</button></div>`;});
  if(result.downloadSent)$('#result-list').innerHTML=`<p class="empty">${esc(result.downloadName||'Download')} · ${result.sentBytes===undefined?'Transfer handed':size(result.sentBytes)+' sent'} to the browser. Check Downloads for completion.</p>`;
  $('#save-all').hidden=!!result.downloadSent||outputs.length===0&&outputDirectories.length===0;
  if(operation==='repair'){
   repairedInputs=repairedArchives(outputs,files,archiveName);listedEntries=undefined;recoveryChecked=true;selectedArchive=false;
   if(repairedInputs.length)$('#run').innerHTML='Open repaired archive'+svg('arrow');
  }
  const completionMessage=result.downloadSent?`Download sent to your browser. Check Downloads for ${result.downloadName||'your file'} and final completion.`:result.savedFiles!==undefined?`${result.savedFiles} files saved directly to ${result.savedDirectory||'your selected folder'}.`:result.message||(operation==='verify'?'Recovery verification complete.':`${outputs.length} ${outputs.length===1?'file':'files'} ready to save.`);
  notice(`${completionMessage} Elapsed: ${duration(tracker.view(performance.now()).elapsedSeconds)}.`,result.complete===false);if(!result.downloadSent&&result.savedFiles===undefined&&result.complete!==false&&!['verify','repair','rebuild'].includes(operation))$('#notice').classList.add('screen-reader-only');
 }catch(error){if(current===operationId&&(error as Error).name!=='AbortError')notice((error instanceof Error?error.message:String(error))+(activeStreamOutput?' A partial download may remain in the browser. Check Downloads before trying again.':''),true);}
 finally{if(current!==operationId)return;stopProgress();busy=false;activeDirectOutput=false;activeStreamOutput=false;lockControls(false);$('#operation').hidden=true;($('#run') as HTMLButtonElement).disabled=false;updateDelivery(false);}
}
async function acceptDropped(entries:FileSystemEntry[]){
 if(busy||saving)return;saving=true;lockControls(true);
 try{
  const incoming:File[]=[],found:string[]=[];
  const walk=async(entry:FileSystemEntry,path:string):Promise<void>=>{
   if(entry.isFile){const file=await new Promise<File>((resolve,reject)=>(entry as FileSystemFileEntry).file(resolve,reject));if(path.includes('/'))Object.defineProperty(file,'webkitRelativePath',{value:path});incoming.push(file);return;}
   found.push(path);const reader=(entry as FileSystemDirectoryEntry).createReader();
   for(;;){const batch=await new Promise<FileSystemEntry[]>((resolve,reject)=>reader.readEntries(resolve,reject));if(!batch.length)break;for(const child of batch)await walk(child,path+'/'+child.name);}
  };
  for(const entry of entries)await walk(entry,entry.name);
  directories.push(...found);saving=false;accept(incoming);
 }catch(error){notice((error as Error).message,true);}finally{saving=false;lockControls(false);}
}
async function chooseFolder(){
 if(busy||saving)return;
 if(!(canPickFolder())){($('#folder-input') as HTMLInputElement).click();return;}
 saving=true;lockControls(true);
 try{
  const root=await (window as any).showDirectoryPicker({mode:'read'}), incoming:File[]=[], found:string[]=[];
  const walk=async(handle:any,path:string)=>{found.push(path);for await(const child of handle.values()){const relative=path+'/'+child.name;if(child.kind==='directory')await walk(child,relative);else{const file=await child.getFile();Object.defineProperty(file,'webkitRelativePath',{value:relative});incoming.push(file);}}};
  await walk(root,root.name);directories.push(...found);saving=false;accept(incoming);
 }catch(error){if((error as Error).name!=='AbortError')notice((error as Error).message,true);}finally{saving=false;lockControls(false);}
}
$('#effort').onchange=e=>creationSettings.setEffort((e.target as HTMLSelectElement).value as 'standard'|'max');$('#expansion-keep').onclick=()=>expansionPause?.answer(true);$('#expansion-stop').onclick=()=>expansionPause?.answer(false);$('#creation-simple').onclick=()=>creationSettings.setAdvanced(false);$('#creation-advanced').onclick=()=>creationSettings.setAdvanced(true);$('#password').addEventListener('input',updateFormat);
$('#show-password').onclick=()=>{const input=$('#password') as HTMLInputElement;const show=input.type==='password';input.type=show?'text':'password';$('#show-password').innerHTML=svg(show?'eyeoff':'eye');$('#show-password').setAttribute('aria-pressed',String(show));$('#show-password').setAttribute('aria-label',show?'Hide password':'Show password');};
$('#copy-password').onclick=async()=>{const value=($('#password') as HTMLInputElement).value;if(!value||busy||saving)return;try{await navigator.clipboard.writeText(value);$('#password-announcement').textContent='Password copied';const copy=$('#copy-password');copy.innerHTML=svg('check');copy.classList.add('copied');setTimeout(()=>{copy.innerHTML=svg('copy');copy.classList.remove('copied');},1400);}catch{$('#password-announcement').textContent='Copy unavailable. Select the password to copy it.';}};
$('#generate-password').onclick=()=>{if(busy||saving||mode!=='create'||!['zip','7z'].includes(($('#format') as HTMLSelectElement).value))return;try{const input=$('#password') as HTMLInputElement;input.value=generatePassword();input.dispatchEvent(new Event('input',{bubbles:true}));$('#password-announcement').textContent='Password generated';}catch{$('#password-announcement').textContent='Password generation unavailable';}};
document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>setMode(b.getAttribute('data-mode') as Mode)));
$('#add-files').onclick=()=>($('#file-input') as HTMLInputElement).click();$('#add-folder').onclick=chooseFolder;
$('#browse').onclick=()=>($('#file-input') as HTMLInputElement).click();$('#browse-folder').onclick=chooseFolder;['file-input','folder-input'].forEach(id=>$('#'+id).addEventListener('change',e=>{accept(Array.from((e.target as HTMLInputElement).files||[]));(e.target as HTMLInputElement).value='';}));$('#clear').onclick=()=>{if(!busy)setMode(mode)};$('#run').onclick=()=>run();$('#queue-create').onclick=()=>run('queue');$('#extract-folder').onclick=()=>run('direct');$('#add-queue').onclick=()=>{if(!busy&&!saving&&queueAdd(repairedInputs.length?repairedInputs:files))setMode('extract');};$('#queue-input').addEventListener('change',e=>{const input=e.target as HTMLInputElement;queueAdd(Array.from(input.files||[]));input.value='';});window.addEventListener('beforeunload',e=>{if(queue.running)e.preventDefault();});$('#cancel').onclick=async()=>{creationSettings.cancelInspection();const directOutput=activeDirectOutput,streamOutput=activeStreamOutput;operationId++;tracker.update({phase:'cancel',message:'Cancelling and cleaning temporary files…'},performance.now());renderProgress();$('#cancel').hidden=true;expansionPause?.answer(false);const cleaned=await engine.dispose();engine=onScreenEngine();stopProgress();busy=false;activeDirectOutput=false;activeStreamOutput=false;lockControls(false);$('#operation').hidden=true;($('#run') as HTMLButtonElement).disabled=false;notice(streamOutput?'Stream stopped in the app. Your browser may retain a partial download. Check or cancel it in Downloads; originals are unchanged.':directOutput?'Operation stopped in the app. Your browser may still finish a pending disk write or final check. Original inputs are unchanged. Check the destination for partial output before starting again.':cleaned?'Operation cancelled. Temporary files removed; originals unchanged.':'Operation cancelled. Browser storage is still releasing temporary files; they will be retried on a later native operation.',!cleaned);};$('#result-list').onclick=e=>{const entry=(e.target as Element).closest<HTMLButtonElement>('[data-entry]');if(entry){downloadEntry(entry);return;}const button=(e.target as Element).closest('[data-download]');if(button&&!busy&&!saving){const file=outputs[Number(button.getAttribute('data-download'))];if(file)save(file);}};$('#save-all').onclick=saveAll;$('#dictionary').onchange=updateFormat;$('#archive-links').onchange=()=>{selectedArchive=false;listedEntries=undefined;updateDelivery();};$('#metadata-download').onclick=()=>{if(!busy&&!saving)try{save({name:'archive-metadata.json',blob:metadataDownload(latestMetadata)});}catch(error){notice(String(error),true);}};
['dragenter','dragover'].forEach(event=>$('#dropzone').addEventListener(event,e=>{e.preventDefault();$('#dropzone').classList.add('dragging')}));['dragleave','drop'].forEach(event=>$('#dropzone').addEventListener(event,e=>{e.preventDefault();$('#dropzone').classList.remove('dragging')}));
// A drop the page does not cancel makes the browser open the dropped item, leaving the app. Every drop on the page is taken here.
window.addEventListener('dragover',e=>{e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect=busy||saving?'none':'copy';});
window.addEventListener('drop',e=>{e.preventDefault();$('#dropzone').classList.remove('dragging');const transfer=e.dataTransfer;if(!transfer||busy||saving)return;
 // Entries must be taken during the drop event; a dropped folder walks without any browser dialog.
 const entries=mode==='create'?Array.from(transfer.items).map(item=>item.webkitGetAsEntry?.()).filter((entry):entry is FileSystemEntry=>!!entry):[];
 if(entries.some(entry=>entry.isDirectory))acceptDropped(entries);else accept(Array.from(transfer.files));});
let installPrompt:any;const showInstall=(visible:boolean)=>{$('#install').hidden=!visible;};
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;showInstall(true);});window.addEventListener('appinstalled',()=>{installPrompt=undefined;showInstall(false);});
const install=async()=>{const prompt=installPrompt;if(!prompt)return;installPrompt=undefined;showInstall(false);await prompt.prompt();};$('#install').onclick=install;$('#update-app').onclick=()=>{if(!busy&&!saving)notice('An update is downloaded. Save your results, close all app windows and tabs, then reopen the app to apply it. Active jobs keep their current version.');};
if('serviceWorker' in navigator&&import.meta.env.PROD)navigator.serviceWorker.register('/sw.js').then(registration=>{
 const showUpdate=()=>{if(registration.waiting&&navigator.serviceWorker.controller)$('#update-app').hidden=false;};showUpdate();
 registration.addEventListener('updatefound',()=>registration.installing?.addEventListener('statechange',showUpdate));
}).catch(()=>{});

if(!canDrop())$('#drop-title').textContent='Choose archives to extract';
void streamDownloadCapability().then(capability=>{streamCapability=capability;updateFormat();queue.refresh();}).catch(()=>{streamCapability={available:false,reason:'Streamed-download support could not be checked. Prepare files or use a folder.'};updateFormat();queue.refresh();});
