import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {openBrowserSession} from './lib/browser-session.mjs';
import {productionHeaders} from '../scripts/production-headers.mjs';
const args=process.argv.slice(2),get=(key,fallback)=>{const at=args.indexOf(key);return at<0?fallback:args[at+1];};
if(!args.includes('--execute')){console.log('NOT_RUN: --execute required; use an idle owned browser and fresh preview origin');process.exit();}
const url=get('--url','http://127.0.0.1:4199/'),endpoint=get('--endpoint','http://127.0.0.1:9230');
assert.ok(['127.0.0.1','localhost'].includes(new URL(url).hostname));
const output=await mkdtemp('/private/tmp/archive-production-csp-'),report={status:'FAIL',scope:'Actual production worker/CSP and offline browser checks; tiny local outputs only',url,endpoint,output,cases:[]};
let page;
const save=()=>writeFile(join(output,'evidence.json'),JSON.stringify(report,null,2));
async function productionWorkers(paths){
 const check=(condition,message)=>{if(!condition)throw Error(message);};
 const root=await navigator.storage.getDirectory(),owned=[],workers=[];
 const run=async(path,data)=>{
  const worker=new Worker(path,{type:'module'});workers.push(worker);
  return await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Production worker timeout')),30000);
   worker.onerror=event=>{clearTimeout(timer);reject(Error(event.message||'Production worker error'));};
   worker.onmessage=({data})=>{if(data.progress)return;clearTimeout(timer);data.error?reject(Error(data.error)):resolve(data);};
   worker.postMessage(data);
  });
 };
 const storage=()=>{const name='csp-'+crypto.randomUUID();owned.push(name);return name;};
 const bytes=Uint8Array.from({length:16384},(_,i)=>(i*17+i%251)&255),file=new File([bytes],'payload.bin',{lastModified:0});
 const hash=async blob=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('');
 try{
  const zip=await run(paths.zip,{op:'create',files:[file],storageId:storage(),format:'zip',password:'fixture-password',creation:{format:'zip',codec:'deflate',level:1}});
  const extracted=await run(paths.zip,{op:'extract',files:[new File([zip.files[0].blob],'fixture.zip')],storageId:storage(),password:'fixture-password'});
  check(extracted.files.length===1&&await hash(extracted.files[0].blob)===await hash(file),'Production ZIP exact bytes');
  const native=await run(paths.native,{op:'create',files:[file],temporaryDirectory:storage(),options:{format:'7z',codec:'lzma2'}});
  const directory=await root.getDirectoryHandle(storage(),{create:true});
  const direct=await run(paths.native,{op:'extract',files:[new File([native.files[0].blob],'fixture.7z')],options:{format:'7z',outputDirectory:directory}});
  check(direct.savedFiles===1&&await hash(await(await directory.getFileHandle('payload.bin')).getFile())===await hash(file),'Production native WASM/helper exact bytes');
  const png=new Uint8Array(32);png.set([137,80,78,71,13,10,26,10]);png.set([0,0,0,13,73,72,68,82],8);
  const sniff=await run(paths.sniff,{files:[new File([png],'image.bin')],names:['image.bin'],start:0});
  check(sniff.results?.[0]?.extension==='png','Production signature worker');
  return{zipBytes:zip.files[0].blob.size,nativeBytes:native.files[0].blob.size,payloadBytes:file.size,sha256:await hash(file),sniffer:sniff.results[0].extension,nativeHelper:true};
 }finally{
  for(const worker of workers)worker.terminate();
  for(const name of owned)await root.removeEntry(name,{recursive:true}).catch(error=>{if(error.name!=='NotFoundError')throw error;});
 }
}
async function streamDownload(){
 const registration=await navigator.serviceWorker.getRegistration('/__download/');if(!registration?.active)throw Error('Production download worker not installed');
 const token=crypto.randomUUID(),stream=new TransformStream(),channel=new MessageChannel(),frame=document.createElement('iframe');frame.hidden=true;
 let resolveStarted,rejectStarted;const started=new Promise((resolve,reject)=>{resolveStarted=resolve;rejectStarted=reject;});
 const registered=new Promise((resolve,reject)=>{channel.port1.onmessage=({data})=>{if(data.error){reject(Error(data.error));rejectStarted(Error(data.error));}else if(data.ready)resolve();else if(data.started)resolveStarted();};});
 const deadline=setTimeout(()=>rejectStarted(Error('Download start timeout')),15000);
 try{
  registration.active.postMessage({token,name:'csp-download.bin',size:65536,stream:stream.readable},[stream.readable,channel.port2]);await registered;
  frame.src='/__download/'+token;document.body.append(frame);await started;
  const writer=stream.writable.getWriter();await writer.write(new Uint8Array(65536).fill(91));await writer.close();window.cspDownloadFrame=frame;return{bytes:65536};
 }finally{clearTimeout(deadline);channel.port1.close();if(window.cspDownloadFrame!==frame)frame.remove();}
}
try{
 const files=await readdir('dist/assets'),paths={};
 for(const name of files.filter(name=>name.endsWith('.js'))){const text=await readFile('dist/assets/'+name,'utf8');if(name.startsWith('fallback.worker-'))paths.zip='/assets/'+name;else if(text.includes('archive-engine-'))paths.native='/assets/'+name;else if(text.includes('Detection byte or file budget'))paths.sniff='/assets/'+name;}
 assert.ok(paths.zip&&paths.native&&paths.sniff,'Expected actual production workers');report.paths=paths;
 const headers=productionHeaders();for(const path of ['/','/sw.js','/download-sw.js',...Object.values(paths)]){const response=await fetch(new URL(path,url));assert.equal(response.status,200);assert.equal(response.headers.get('content-security-policy'),headers['Content-Security-Policy']);}
 report.cases.push({id:'real-http-headers',status:'PASS'});
 page=await openBrowserSession(endpoint,url);await page.evaluate(`window.cspViolations=[];addEventListener('securitypolicyviolation',event=>cspViolations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));`);
 await page.evaluate('navigator.serviceWorker.ready.then(()=>true)',30000);if(!await page.evaluate('!!navigator.serviceWorker.controller')){await page.call('Page.reload');await page.wait('!!document.querySelector("#run")&&!!navigator.serviceWorker.controller');}
 await page.evaluate(`window.cspViolations=[];addEventListener('securitypolicyviolation',event=>cspViolations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));`);
 const online=await page.evaluate('('+productionWorkers.toString()+')('+JSON.stringify(paths)+')',120000);report.cases.push({id:'online-production-workers',status:'PASS',...online});
 assert.deepEqual(await page.evaluate('cspViolations'),[],'Unexpected application CSP violations');
 const denied=await page.evaluate(`(async()=>{const script=document.createElement('script');script.textContent='window.inlineProbeRan=true';document.body.append(script);let rejected=false;try{await fetch('https://blocked.invalid/csp-probe');}catch{rejected=true;}await new Promise(resolve=>setTimeout(resolve,100));return{inlineRan:!!window.inlineProbeRan,rejected,violations:cspViolations};})()`);
 assert.equal(denied.inlineRan,false);assert.equal(denied.rejected,true);assert.ok(denied.violations.some(v=>v.directive==='connect-src'));assert.ok(denied.violations.some(v=>v.directive==='script-src-elem'));report.cases.push({id:'inline-and-external-connect-denied',status:'PASS',...denied});
 await page.call('Browser.setDownloadBehavior',{behavior:'allowAndName',downloadPath:output,eventsEnabled:true});
 await page.evaluate('('+streamDownload.toString()+')()',30000);
 const end=Date.now()+30000;let complete;while(Date.now()<end){complete=page.events.find(event=>event.method==='Browser.downloadProgress'&&event.params.state==='completed');if(complete)break;await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(complete,'Browser download completion');await page.evaluate('window.cspDownloadFrame?.remove()');
 const data=await readFile(join(output,complete.params.guid));assert.equal(data.length,65536);assert.ok(data.every(byte=>byte===91));report.cases.push({id:'iframe-stream-download-completed',status:'PASS',bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
 await page.call('Network.setCacheDisabled',{cacheDisabled:true});await page.call('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
 await page.call('Page.reload');await page.wait('!!document.querySelector("#run")&&!!navigator.serviceWorker.controller');
 await page.evaluate(`window.cspViolations=[];addEventListener('securitypolicyviolation',event=>cspViolations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));`);
 const offline=await page.evaluate('('+productionWorkers.toString()+')('+JSON.stringify(paths)+')',120000);assert.deepEqual(await page.evaluate('cspViolations'),[]);report.cases.push({id:'offline-reload-fresh-production-workers',status:'PASS',...offline});
 const offlineDenied=await page.evaluate(`(async()=>{const s=document.createElement('script');s.textContent='window.offlineInlineProbe=true';document.body.append(s);await new Promise(resolve=>setTimeout(resolve,100));return{ran:!!window.offlineInlineProbe,violations:cspViolations};})()`);assert.equal(offlineDenied.ran,false);assert.ok(offlineDenied.violations.some(v=>v.directive==='script-src-elem'));report.cases.push({id:'offline-cached-html-retains-policy',status:'PASS',...offlineDenied});
 report.status='PASS';
}catch(error){report.error=String(error);if(page){report.downloadEvents=page.events.filter(event=>event.method.includes('download')||event.method==='Network.loadingFailed');report.cspViolations=await page.evaluate('window.cspViolations||[]',5000).catch(()=>[]);}}
finally{
 if(page){try{await page.call('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await page.call('Browser.setDownloadBehavior',{behavior:'default'});await page.close();report.pageClosed=true;}catch(error){report.status='FAIL';report.cleanupError=String(error);}}
 await save();console.log(JSON.stringify(report));if(report.status!=='PASS')process.exitCode=1;
}
