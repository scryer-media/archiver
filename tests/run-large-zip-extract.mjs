import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,join,basename} from 'node:path';
import {openBrowserSession} from './lib/browser-session.mjs';
const args=process.argv.slice(2),arg=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1]};
for(const key of ['--endpoint','--app-url','--archive','--expected','--output-root'])if(!arg(key))throw Error('Missing '+key);
const archive=resolve(arg('--archive')),output=resolve(arg('--output-root')),expected=JSON.parse(await readFile(arg('--expected'),'utf8'));
for(const item of expected){assert.ok(item.name&&!item.name.startsWith('/')&&!/[\\\0:]/.test(item.name)&&item.name.split('/').every(part=>part&&part!=='.'&&part!=='..'),'Unsafe oracle path');assert.ok(Number.isSafeInteger(item.bytes)&&item.bytes>=0&&/^[a-f0-9]{64}$/.test(item.sha256),'Invalid size/hash oracle');}
assert.equal(new Set(expected.map(item=>item.name)).size,expected.length,'Duplicate oracle path');
if(!args.includes('--execute')){console.log(JSON.stringify({status:'NOT_RUN',archive,output,expected,scope:'Actual app API direct-folder ZIP extraction with genuine folder permission and independent complete output SHA-256'},null,2));process.exit(0)}
if(!args.includes('--confirm-browser-idle'))throw Error('--confirm-browser-idle required');
await mkdir(output,{recursive:false});const marker=randomUUID();await writeFile(join(output,'destination-marker.txt'),marker);
const evidence={status:'RUNNING',archive,archiveBytes:(await stat(archive)).size,expected,scope:'Current application API through real browser workers; direct-folder output, no mock handles or hidden full-output Blob',startedAt:new Date().toISOString()};let reporting=Promise.resolve();const report=()=>{const text=JSON.stringify(evidence,null,2);reporting=reporting.then(()=>writeFile(join(output,'evidence.json'),text));return reporting;};await report();
async function hashFile(path,label){const hash=createHash('sha256');let bytes=0,last=0;for await(const chunk of createReadStream(path,{highWaterMark:1024*1024})){hash.update(chunk);bytes+=chunk.length;if(Date.now()-last>=5000){last=Date.now();console.log(JSON.stringify({stage:label,bytes}));}}return{bytes,sha256:hash.digest('hex')};}
let page,heartbeat;
try{
 evidence.inputBefore=await hashFile(archive,'hash-input');await report();page=await openBrowserSession(arg('--endpoint'),arg('--app-url'));
 await page.evaluate(`(async()=>{const {ArchiveEngine}=await import('/src/tool-engine.ts');window.largeZip={engine:new ArchiveEngine(progress=>window.largeZip.progress=progress),progress:null};document.body.insertAdjacentHTML('beforeend','<input id="large-zip-input" type="file" hidden>');return{initialized:true}})()`);
 const document=await page.call('DOM.getDocument'),input=await page.call('DOM.querySelector',{nodeId:document.result.root.nodeId,selector:'#large-zip-input'});await page.call('DOM.setFileInputFiles',{nodeId:input.result.nodeId,files:[archive]});
 const entries=await page.evaluate('(async()=>{largeZip.files=[...document.querySelector("#large-zip-input").files];const result=await largeZip.engine.list(largeZip.files,undefined,"zip");return result.entries})()');
 assert.equal(entries.length,expected.length);for(const item of expected){const entry=entries.find(entry=>entry.name===item.name);assert.ok(entry&&!entry.isDirectory&&entry.size===item.bytes,'Listed ZIP path or size mismatch');}
 evidence.preflight={allExpectedEntries:true,entries};evidence.pendingGrant={target:page.target.id,destination:output};await report();console.log('FOLDER_PICKER_READY '+JSON.stringify(evidence.pendingGrant));
 await page.evaluate(`(async()=>{const destination=await showDirectoryPicker({mode:'readwrite'});const markerFile=await(await destination.getFileHandle('destination-marker.txt')).getFile();if(await markerFile.text()!==${JSON.stringify(marker)})throw Error('Choose the exact test output directory');largeZip.destination=destination;return{granted:true,name:destination.name}})()`,180000);delete evidence.pendingGrant;
 const started=Date.now();let polling=false;heartbeat=setInterval(async()=>{if(polling)return;polling=true;try{const progress=await page.evaluate('largeZip.progress',10000);evidence.progress=progress;console.log(JSON.stringify({stage:'extract',progress}));await report()}catch{}finally{polling=false}},5000);
 const result=await page.evaluate('(async()=>{const result=await largeZip.engine.extract(largeZip.files,undefined,"zip",largeZip.destination);return{savedFiles:result.savedFiles,savedDirectory:result.savedDirectory,files:result.files.length}})()',600000);clearInterval(heartbeat);heartbeat=undefined;
 assert.equal(result.files,0);assert.equal(result.savedFiles,expected.length);assert.ok(result.savedDirectory?.startsWith('archive-extracted-'));evidence.extractSeconds=(Date.now()-started)/1000;evidence.result=result;await report();
 const root=join(output,result.savedDirectory),actual=[];async function walk(path,prefix=''){for(const entry of await readdir(path,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())await walk(join(path,entry.name),name+'/');else{assert.ok(entry.isFile(),'Unexpected nonregular output entry: '+name);actual.push(name)}}}await walk(root);assert.deepEqual(actual.sort(),expected.map(item=>item.name).sort());evidence.outputs=[];
 for(const item of expected){const result=await hashFile(join(root,item.name),'hash-output-'+basename(item.name));assert.equal(result.bytes,item.bytes);assert.equal(result.sha256,item.sha256);evidence.outputs.push({name:item.name,...result});await report();}
 evidence.inputAfter=await hashFile(archive,'rehash-input');assert.deepEqual(evidence.inputAfter,evidence.inputBefore);evidence.status='VERIFYING_TEARDOWN';await report();
}catch(error){evidence.status='FAIL';evidence.error=String(error);await report();throw error;}
finally{
 if(heartbeat)clearInterval(heartbeat);
 if(page){
  try{evidence.cleanupConfirmed=await page.evaluate('largeZip.engine.dispose()',30000);if(evidence.cleanupConfirmed!==true)throw Error('Owned engine cleanup did not confirm success');}
  catch(error){evidence.status='FAIL';evidence.cleanupError=String(error);process.exitCode=1;}
  try{await page.close();evidence.pageClosed=true;}
  catch(error){evidence.status='FAIL';evidence.pageCloseError=String(error);process.exitCode=1;}
 }
 if(evidence.status==='VERIFYING_TEARDOWN'&&evidence.cleanupConfirmed===true&&evidence.pageClosed===true)evidence.status='PASS';
 evidence.finishedAt=new Date().toISOString();await report();
 console.log(JSON.stringify({status:evidence.status,evidence:join(output,'evidence.json'),extractSeconds:evidence.extractSeconds,outputs:evidence.outputs}));
}
