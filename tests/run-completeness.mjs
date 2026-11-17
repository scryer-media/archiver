import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {openBrowserSession} from './lib/browser-session.mjs';
const args=process.argv.slice(2),get=(key,fallback)=>{const at=args.indexOf(key);return at<0?fallback:args[at+1];};
if(!args.includes('--execute')){console.log('NOT_RUN: --execute required');process.exit();}
const out=resolve(get('--output-dir','/private/tmp/archive-completeness-browser'));await mkdir(out);let page;
async function browserChecks(){
 const{ArchiveEngine}=await import('/src/tool-engine.ts');
 const transformed=await(await fetch('/src/zip-security.ts')).text(),dependency=transformed.match(/from\s*[\"']([^\"']*(?:zip__js|zip\.js)[^\"']*)/);if(!dependency)throw Error('Vite ZIP dependency URL missing');const{ZipWriter,BlobWriter,TextReader}=await import(dependency[1]);
 const engine=new ArchiveEngine(),check=(v,m)=>{if(!v)throw Error(m);},results=[];
 const test=async(id,fn)=>{try{await fn();results.push({id,status:'PASS'});}catch(e){results.push({id,status:'FAIL',error:String(e)});}finally{await engine.dispose();}};
 const bytes=new TextEncoder(),record=(k,v)=>{const payload=k+'='+v+'\n';let n=bytes.encode(payload).length+2;while(n!==String(n).length+1+bytes.encode(payload).length)n=String(n).length+1+bytes.encode(payload).length;return n+' '+payload;};
 const header=(name,size,type='0',target='')=>{const b=new Uint8Array(512),put=(at,text)=>b.set(bytes.encode(text),at);put(0,name);put(100,'0000644\0');put(108,'0000000\0');put(116,'0000000\0');put(124,size.toString(8).padStart(11,'0')+'\0');put(136,'00000000000\0');put(257,'ustar\0');put(263,'00');b[156]=type.charCodeAt(0);b.set(bytes.encode(target),157);b.fill(32,148,156);b.set(bytes.encode(b.reduce((a,n)=>a+n,0).toString(8).padStart(6,'0')+'\0 '),148);return b;};
 const pax=bytes.encode(record('GNU.sparse.size','10')+record('GNU.sparse.map','2,2,8,1')),sparse=new File([header('PaxHeaders/item',pax.length,'x'),pax,new Uint8Array((512-pax.length%512)%512),header('sparse',3),bytes.encode('ABC'),new Uint8Array(509),new Uint8Array(1024)],'sparse.tar');
 await test('sparse-prepared',async()=>{const r=await engine.extract([sparse]);check(r.files.length===1&&await r.files[0].blob.text()==='\0\0AB\0\0\0\0C\0','Sparse exactdata');check(r.metadata[0].metadata.sparse.logicalSize===10,'Sparse metadata');});
 await test('sparse-direct-folder',async()=>{const root=await navigator.storage.getDirectory(),name='completeness-'+crypto.randomUUID(),dir=await root.getDirectoryHandle(name,{create:true});try{const r=await engine.extract([sparse],undefined,undefined,dir);check(r.files.length===0&&r.savedFiles===1,'Direct contract');const job=await dir.getDirectoryHandle(r.savedDirectory),file=await(await job.getFileHandle('sparse')).getFile();check(await file.text()==='\0\0AB\0\0\0\0C\0','Disk sparse');}finally{await root.removeEntry(name,{recursive:true});}});
 const linked=new File([header('copy',0,'2','payload'),header('payload',3),bytes.encode('abc'),new Uint8Array(509),new Uint8Array(1024)],'linked.tar');
 await test('tar-default-reject',async()=>{let rejected=false;try{await engine.extract([linked]);}catch(e){rejected=/links/.test(String(e));}check(rejected,'Default rejects');});
 await test('tar-opt-in-copy',async()=>{const r=await engine.extract([linked],undefined,undefined,undefined,undefined,{links:'copy-safe'});check(r.files.length===2,'Both materialized');for(const f of r.files)check(await f.blob.text()==='abc','Linkedbytes');check(r.metadata.find(e=>e.name==='copy').metadata.link.target==='payload','Targetmetadata');});
 const writer=new ZipWriter(new BlobWriter());await writer.add('payload',new TextReader('zip fixture'));await writer.add('copy',new TextReader('payload'),{unixMode:0o120777});const linkedZip=new File([await writer.close()],'linked.zip');
 await test('zip-default-reject',async()=>{let rejected=false;try{await engine.list([linkedZip]);}catch(e){rejected=/links/.test(String(e));}check(rejected,'DefaultZIPrejects');});
 await test('zip-opt-in-copy',async()=>{const r=await engine.extract([linkedZip],undefined,undefined,undefined,undefined,{links:'copy-safe'});check(r.files.length===2,'BothZIPoutputs');for(const f of r.files)check(await f.blob.text()==='zip fixture','ZIPlinkbytes');});
 await test('native-prepared-modification-times',async()=>{
  const expected=[['before.bin','-0.001',-1],['epoch.bin','0',0],['pax.bin','1700000000.125',1700000000125]],parts=[header('./',0,'5')];
  for(const[name,time]of expected){const body=bytes.encode(record('mtime',time));parts.push(header('PaxHeaders/item',body.length,'x'),body,new Uint8Array((512-body.length%512)%512),header('./'+name,1),bytes.encode('!'),new Uint8Array(511));}
  parts.push(new Uint8Array(1024));const result=await engine.extract([new File(parts,'times.tar')]);check(result.files.length===3,'Exact native time output count');
  for(const[name,,modified]of expected){const output=result.files.find(file=>file.name===name);check(output?.blob instanceof File,'Prepared native output is a File');check(output.blob.lastModified===modified,'Prepared File modification time preserved');check(output.metadata.modifiedTime===modified,'Descriptive modification time preserved');check(await output.blob.text()==='!','Exact native time payload');}
 });
 await test('ui-explicit-policy',async()=>{check(document.querySelector('#archive-links').value==='reject','UIdefault');check(document.querySelector('#metadata-download').hidden,'Noauto metadata');});
 return{scope:'Real browser workers; tiny OPFS direct output readback only',cases:results,pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length};
}
try{page=await openBrowserSession(get('--endpoint','http://127.0.0.1:9226'),get('--app-url','http://127.0.0.1:4185/'));const evidence=await page.evaluate('('+browserChecks.toString()+')()',180000);await writeFile(join(out,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));assert.equal(evidence.fail,0);}finally{await page?.close();}
