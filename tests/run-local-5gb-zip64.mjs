import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,stat,readdir,copyFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {crc32} from 'node:zlib';
import {spawn} from 'node:child_process';
import {join,resolve,relative,basename} from 'node:path';
const [endpoint,appUrl,rootArg,outputArg]=process.argv.slice(2);
if(!endpoint||!appUrl||!rootArg||!outputArg)throw Error('Usage: run-local-5gb-zip64.mjs <dedicated-CDP> <isolated-app> <authorized-local-root> <fresh-zip64-run-directory> [--execute --confirm-browser-idle]');
const resume=process.argv.includes('--resume-created');
const root=resolve(rootArg),output=resolve(outputArg),source=join(root,'output/streamed-ui-run-1/payload.bin');
assert.equal(root,'/private/tmp/archive-5gb-test');assert.ok(output.startsWith(join(root,'zip64')+'/'),'Output must be in the authorized ZIP64 test namespace');
assert.equal(new URL(endpoint).origin,'http://127.0.0.1:9226');assert.equal(new URL(appUrl).origin,'http://127.0.0.1:4184');
const oracle=JSON.parse(await readFile(join(root,'test-5gb-manifest.json'),'utf8'));
const sourceEvidence=JSON.parse(await readFile(join(root,'output/streamed-ui-run-1/evidence.json'),'utf8'));
assert.equal(sourceEvidence.status,'PASS');assert.equal(sourceEvidence.payloadSha256,oracle.payload_sha256);assert.equal(oracle.expected_payload_bytes,5000000000);assert.equal((await stat(source)).size,oracle.expected_payload_bytes);
if(!process.argv.includes('--execute')){console.log(JSON.stringify({status:'NOT_RUN',resumeCreated:resume,source,sourceSha256:oracle.payload_sha256,output,steps:['Actual app two-input ZIP streamed creation','Browser download completion','Independent Python ZIP64 EOCD/offset/full CRC and SHA-256 checks','Independent 7zz metadata listing','Actual app direct-folder extraction with genuine marker-checked directory grant','Full output tree/size/SHA-256 verification'],requires:['--execute','--confirm-browser-idle','CUA grant of the printed extracted-base folder when requested']},null,2));process.exit(0);}
if(!process.argv.includes('--confirm-browser-idle'))throw Error('Root must confirm that the dedicated QA browser is idle');
if(!resume){await mkdir(join(root,'zip64'),{recursive:true});await mkdir(output,{recursive:false});}
const second=Buffer.from('A small second entry after a ZIP64 payload.\n'),secondPath=join(output,'second.txt'),extractBase=join(output,'extracted-base'),marker=resume?await readFile(join(output,'extracted-base/destination-marker.txt'),'utf8'):randomUUID();
const expected=[{name:'payload.bin',bytes:oracle.expected_payload_bytes,sha256:oracle.payload_sha256,crc32:oracle.payload_crc32},{name:'second.txt',bytes:second.length,sha256:createHash('sha256').update(second).digest('hex'),crc32:crc32(second).toString(16).padStart(8,'0')}];
let previous;
if(resume){
 previous=JSON.parse(await readFile(join(output,'evidence.json'),'utf8'));
 assert.equal(resolve(previous.archive),join(output,'archive.zip'));assert.equal((await stat(previous.archive)).size,previous.archiveBytes);
 assert.deepEqual(JSON.parse(await readFile(join(output,'expected.json'),'utf8')),expected);assert.deepEqual(await readFile(secondPath),second);
 assert.equal((await readdir(extractBase,{withFileTypes:true})).filter(entry=>entry.isDirectory()).length,0,'Resume requires an unused extraction destination');
 await copyFile(join(output,'evidence.json'),join(output,'evidence-before-resume-'+Date.now()+'.json'));
}else{await writeFile(secondPath,second);await mkdir(extractBase);await writeFile(join(extractBase,'destination-marker.txt'),marker);await writeFile(join(output,'expected.json'),JSON.stringify(expected,null,2)+'\n');}
const evidence=previous?{...previous,status:'RUNNING',resumedAt:new Date().toISOString(),priorFailure:previous.error}:{status:'RUNNING',startedAt:new Date().toISOString(),source,expected,output,downloadEvents:[],samples:[],scope:'Actual app UI invokes its normal engine API; no direct zip.js creation or forced ZIP64 option'};
delete evidence.error;
const report=()=>writeFile(join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');await report();
const children=new Set();let target,ws;const pending=new Map();let rpcId=0,download,unexpectedDownload;
function stopChildren(){for(const child of children){try{process.kill(-child.pid,'SIGTERM');}catch{}}}
process.once('SIGINT',()=>{stopChildren();process.exit(130)});process.once('SIGTERM',()=>{stopChildren();process.exit(143)});
async function command(program,args,timeout=480000){return new Promise((resolve,reject)=>{
 const child=spawn(program,[...args],{detached:true,stdio:['ignore','pipe','pipe']});children.add(child);let stdout='',stderr='';
 const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM')}catch{}reject(Error('Bounded independent verifier timeout'));},timeout);
 child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>2*1024*1024){try{process.kill(-child.pid,'SIGTERM')}catch{}reject(Error('Unexpected verifier output volume'));}});child.stderr.on('data',chunk=>{stderr+=chunk});
 child.on('error',error=>{clearTimeout(timer);children.delete(child);reject(error)});child.on('close',code=>{clearTimeout(timer);children.delete(child);code===0?resolve({stdout,stderr}):reject(Error(program+' failed '+code+': '+stderr+' '+stdout))});
 });}
const python=String.raw`import json,sys,struct,zipfile,hashlib,zlib,os
archive,oracle_path=sys.argv[1:]
expected=json.load(open(oracle_path));size=os.path.getsize(archive)
with open(archive,'rb') as f:
 f.seek(max(0,size-65557));tail=f.read();at=tail.rfind(b'PK\x05\x06');assert at>=0,'EOCD absent';eocd_offset=max(0,size-65557)+at
 signature,disk,cd_disk,disk_count,total_count,cd_size32,cd_offset32,comment=struct.unpack_from('<4s4H2LH',tail,at)
 assert eocd_offset+22+comment==size,'Invalid EOCD boundary'
 # Resolve legacy sentinels using APPNOTE 4.4.19-4.4.24, not as disk counts.
 legacy=(disk,cd_disk,disk_count,total_count,cd_size32,cd_offset32)
 f.seek(eocd_offset-20);locator=f.read(20);sig,record_disk,record_offset,disks=struct.unpack('<4sIQI',locator)
 assert sig==b'PK\x06\x07' and record_disk==0 and disks==1,'ZIP64 locator absent or split'
 f.seek(record_offset);record=f.read(56)
 sig,record_size,made,needed,disk,cd_disk,entries_disk,entries_total,cd_size,cd_offset=struct.unpack('<4sQHHIIQQQQ',record)
 assert sig==b'PK\x06\x06' and record_size>=44,'ZIP64 EOCD absent'
 assert entries_disk==entries_total==len(expected)==2 and disk==cd_disk==0,'Unexpected ZIP64 entry count or split archive'
 for old,actual,sentinel in zip(legacy,(disk,cd_disk,entries_disk,entries_total,cd_size,cd_offset),(0xffff,0xffff,0xffff,0xffff,0xffffffff,0xffffffff)):
  assert old==sentinel or old==actual,'Legacy and ZIP64 records disagree'
 assert record_offset>0xffffffff and cd_offset>0xffffffff,'Central directory does not cross 4 GiB'
 assert record_offset+12+record_size==eocd_offset-20,'ZIP64 record boundary mismatch'
with zipfile.ZipFile(archive) as z:
 infos=z.infolist();assert [i.filename for i in infos]==[e['name'] for e in expected],'Entry names/order mismatch'
 assert infos[1].header_offset>0xffffffff,'Second local header did not cross 4 GiB'
 results=[]
 for info,item in zip(infos,expected):
  assert not info.is_dir() and info.file_size==item['bytes'],'Output size/type mismatch'
  assert info.compress_type==zipfile.ZIP_DEFLATED,'App did not use default DEFLATE'
  assert not info.flag_bits&1,'Unexpected encryption'
  h=hashlib.sha256();crc=0;count=0
  with z.open(info) as data:
   while True:
    chunk=data.read(8*1024*1024)
    if not chunk:break
    count+=len(chunk);assert count<=item['bytes'],'Expanded output exceeded oracle';h.update(chunk);crc=zlib.crc32(chunk,crc)
  actual={'name':info.filename,'bytes':count,'sha256':h.hexdigest(),'crc32':format(crc,'08x'),'compressedBytes':info.compress_size,'headerOffset':info.header_offset,'extractVersion':info.extract_version}
  assert actual['bytes']==item['bytes'] and actual['sha256']==item['sha256'] and actual['crc32']==item['crc32'],'Full content hash/CRC mismatch'
  assert info.CRC==crc,'Central directory CRC mismatch';results.append(actual)
print(json.dumps({'zip64':True,'archiveBytes':size,'eocdOffset':eocd_offset,'zip64EocdOffset':record_offset,'centralDirectoryOffset':cd_offset,'centralDirectoryBytes':cd_size,'entries':results}))
`;
try{
 target=await(await fetch(endpoint+'/json/new?about:blank',{method:'PUT',signal:AbortSignal.timeout(15000)})).json();
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP connection timeout')),15000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('CDP failed'))},{once:true})});
 ws.onmessage=event=>{const data=JSON.parse(event.data);if(data.id){const item=pending.get(data.id);if(item){clearTimeout(item.timer);pending.delete(data.id);data.error?item.reject(Error(JSON.stringify(data.error))):item.resolve(data.result)}}if(data.method==='Browser.downloadWillBegin'){if(download)unexpectedDownload=Error('Unexpected extra download');else download={...data.params,state:'inProgress'};evidence.downloadEvents.push({kind:'begin',at:Date.now(),...data.params})}if(data.method==='Browser.downloadProgress'&&download?.guid===data.params.guid){download={...download,...data.params};if(data.params.state!=='inProgress')evidence.downloadEvents.push({kind:'state',at:Date.now(),...data.params})}};
 const call=(method,params={},timeout=30000)=>new Promise((resolve,reject)=>{const id=++rpcId,timer=setTimeout(()=>{pending.delete(id);reject(Error('Bounded CDP timeout: '+method))},timeout);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{const response=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true,replMode:true});if(response.exceptionDetails)throw Error(JSON.stringify(response.exceptionDetails));return response.result?.value};
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const wait=async(expression,timeout=30000)=>{const until=Date.now()+timeout;while(Date.now()<until){try{if(await evaluate(expression))return}catch(error){if(!/default execution context|context was destroyed/.test(String(error)))throw error}await pause(100)}throw Error('Condition timeout: '+expression)};
 const select=async(paths,mode)=>{await evaluate(`document.querySelector('#clear').click();document.querySelector('[data-mode="${mode}"]').click()`);const doc=await call('DOM.getDocument'),input=await call('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'#file-input'});await call('DOM.setFileInputFiles',{nodeId:input.nodeId,files:paths})};
 const set=async values=>evaluate(Object.entries(values).map(([key,value])=>`document.querySelector('#${key}').value=${JSON.stringify(value)};document.querySelector('#${key}').dispatchEvent(new Event('change'));`).join(''));
 const snapshot=()=>evaluate(`({active:!document.querySelector('#operation').hidden,phase:document.querySelector('#phase').textContent,bytes:document.querySelector('#progress-bytes').textContent,output:document.querySelector('#progress-output').textContent,notice:document.querySelector('#notice').textContent,error:document.querySelector('#notice').classList.contains('error')})`);
 async function operation(label,complete){const until=Date.now()+480000;let last=0;while(Date.now()<until){if(unexpectedDownload)throw unexpectedDownload;const state=await snapshot();if(!state.active&&state.error)throw Error(label+': '+state.notice);if(Date.now()-last>=5000){last=Date.now();const item={phase:label,at:last,download:download?{state:download.state,receivedBytes:download.receivedBytes}:undefined,...state};evidence.samples.push(item);console.log(JSON.stringify(item));await report()}if(await complete(state))return state;await pause(100)}throw Error(label+' exceeded eight-minute deadline');}
 await call('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:output,eventsEnabled:true});await call('Network.enable');await call('Network.setBypassServiceWorker',{bypass:true});await call('Page.navigate',{url:appUrl});await wait(`!!document.querySelector('#delivery')`);const currentEntry=await evaluate(`document.querySelector('script[type=module]').src`);evidence.creationEntryScript??=evidence.entryScript||currentEntry;evidence.entryScript=currentEntry;evidence.extractionEntryScript=currentEntry;console.log('ENTRY: '+evidence.entryScript);await call('Network.setBypassServiceWorker',{bypass:false});await wait(`navigator.serviceWorker.getRegistration('/__download/').then(value=>!!value?.active)`);
 await evaluate(`window.zip64Operations=[];const original=Worker.prototype.postMessage;Worker.prototype.postMessage=function(message,...rest){if(message?.op)window.zip64Operations.push({op:message.op,format:message.format||message.options?.format,stream:!!(message.downloadStream||message.options?.downloadBridge||message.options?.downloadStream),inputs:message.files?.map(file=>({name:file.name,size:file.size}))});return original.call(this,message,...rest)}`);
 let archive;
 if(!resume){
 await select([source,secondPath],'create');await set({format:'zip',delivery:'download',password:''});assert.equal(await evaluate(`document.querySelector('#run').disabled`),false);
 evidence.createStartedAt=Date.now();await evaluate(`document.querySelector('#run').click()`);
 const created=await operation('stream-create-zip64',state=>!state.active&&download?.state==='completed');assert.match(created.notice,/sent to your browser/i);assert.equal(download.suggestedFilename,'archive.zip');
 archive=resolve(download.filePath||join(output,'archive.zip'));assert.ok(archive.startsWith(output+'/'));assert.equal((await stat(archive)).size,download.receivedBytes);assert.ok(download.receivedBytes>2**32);evidence.archive=archive;evidence.archiveBytes=download.receivedBytes;evidence.createSeconds=(Date.now()-evidence.createStartedAt)/1000;evidence.operations=await evaluate('window.zip64Operations');assert.ok(evidence.operations.some(item=>item.op==='create'&&item.format==='zip'&&item.stream&&item.inputs?.length===2),'Creation bypassed the app streamed ZIP API');await report();
 }else{archive=resolve(evidence.archive);console.log('RESUME: preserving completed app-created archive '+archive);}
 const verifier=join(output,'verify-zip64.py');await writeFile(verifier,python);console.log('VERIFY: independent Python ZIP64 structure/full CRC/SHA256');const verified=await command('python3',[verifier,archive,join(output,'expected.json')]);await writeFile(join(output,'python-verification.log'),verified.stdout+verified.stderr);evidence.independent=JSON.parse(verified.stdout.trim());
 const listing=await command('7zz',['l','-slt','-bd','-bsp0',archive],30000);await writeFile(join(output,'7zz-list.txt'),listing.stdout+listing.stderr);assert.match(listing.stdout,/Type = zip/);await report();
 await select([archive],'extract');await set({delivery:'files',password:'', 'input-format':'zip'});await evaluate(`document.querySelector('#run').click()`);await wait(`document.querySelector('#operation').hidden&&!document.querySelector('#notice').hidden`,120000);assert.equal(await evaluate(`document.querySelector('#notice').classList.contains('error')`),false);assert.equal(await evaluate(`document.querySelectorAll('#result-list .file-row').length`),2);
 await evaluate(`const actualPicker=window.showDirectoryPicker.bind(window);window.showDirectoryPicker=async options=>{const handle=await actualPicker(options);const markerFile=await(await handle.getFileHandle('destination-marker.txt')).getFile();if(await markerFile.text()!==${JSON.stringify(marker)})throw Error('Select the exact authorized extracted-base directory');window.zip64Granted=true;return handle}`);
 evidence.extractStartedAt=Date.now();evidence.folderGrant={targetId:target.id,destination:extractBase};await report();console.log('FOLDER_PICKER_READY '+JSON.stringify(evidence.folderGrant));await evaluate(`document.querySelector('#extract-folder').click()`);
 const extracted=await operation('direct-folder-extract-zip64',state=>!state.active&&/2 files saved directly/i.test(state.notice));assert.equal(await evaluate('window.zip64Granted'),true);evidence.extractNotice=extracted.notice;evidence.extractSeconds=(Date.now()-evidence.extractStartedAt)/1000;
 const jobs=(await readdir(extractBase,{withFileTypes:true})).filter(entry=>entry.isDirectory());assert.equal(jobs.length,1);assert.match(jobs[0].name,/^archive-extracted-/);const extractedRoot=join(extractBase,jobs[0].name),names=await readdir(extractedRoot);assert.deepEqual(names.sort(),expected.map(item=>item.name).sort());evidence.extracted=[];
 for(const item of expected){const file=join(extractedRoot,item.name);assert.equal((await stat(file)).size,item.bytes);const hash=createHash('sha256');let bytes=0;for await(const chunk of createReadStream(file,{highWaterMark:1024*1024})){hash.update(chunk);bytes+=chunk.length;}const actual={name:item.name,bytes,sha256:hash.digest('hex')};assert.equal(actual.sha256,item.sha256);evidence.extracted.push(actual);}
 evidence.status='PASS';evidence.finishedAt=new Date().toISOString();await report();console.log(JSON.stringify({status:'PASS',output,archiveBytes:evidence.archiveBytes,zip64:evidence.independent,extracted:evidence.extracted,createSeconds:evidence.createSeconds,extractSeconds:evidence.extractSeconds},null,2));
}catch(error){evidence.status='FAIL';evidence.error=String(error);await report();throw error}finally{stopChildren();for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Runner closed'))}pending.clear();try{ws?.close()}catch{}if(target)await fetch(endpoint+'/json/close/'+target.id,{signal:AbortSignal.timeout(15000)}).catch(()=>{});}
