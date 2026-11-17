import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const repo=process.env.ARCHIVE_REPO;if(!repo)throw Error('ARCHIVE_REPO required');
const appURL=process.env.APP_URL||'http://127.0.0.1:4185',root=process.env.NATIVE_FIXTURE_ROOT||'/private/tmp/archive-completeness-battery';
if(!process.argv.includes('--execute')){console.log(JSON.stringify({status:'NOT_RUN',scope:'Actual Chromium application API with small synthetic File inputs and private browser output; full hashes/metadata, not UI/folder-picker proof',appURL,root}));process.exit();}
if(!process.argv.includes('--confirm-browser-idle'))throw Error('Browser idle confirmation required');
const {openBrowserSession}=await import(pathToFileURL(repo+'/tests/lib/browser-session.mjs'));
const manifest=JSON.parse(await readFile(root+'/native/manifest.json','utf8')),directory=root+'/native-browser-'+Date.now();await mkdir(directory);
const hash=data=>createHash('sha256').update(data).digest('hex'),report={scope:'Actual Chromium application API, synthetic small archive File, real native worker/WASM and OPFS results; no host symlink creation; not a folder-picker/UI test',status:'RUNNING',cases:[],appURL,runtime:{}};
const save=()=>writeFile(directory+'/evidence.json',JSON.stringify(report,null,2)+'\n');let page;
try{
 for(const[name,file]of Object.entries({js:'archive-engine.js',wasm:'archive_engine.wasm'})){const expected=hash(await readFile(repo+'/public/engine/'+file));const response=await fetch(appURL+'/engine/'+file);assert.ok(response.ok);assert.equal(hash(Buffer.from(await response.arrayBuffer())),expected);report.runtime[name]=expected;}
 page=await openBrowserSession(process.env.BROWSER_ENDPOINT||'http://127.0.0.1:9226',appURL);
 for(const item of manifest.cases){const bytes=await readFile(root+'/native/'+item.archive);assert.equal(bytes.length,item.archiveBytes);assert.equal(hash(bytes),item.archiveSHA256);
  for(const policy of ['reject','copy-safe']){const result={id:item.id,policy,status:'FAIL'};report.cases.push(result);
   try{const value=await page.evaluate(`(async()=>{const input=${JSON.stringify({name:item.archive,base64:bytes.toString('base64'),policy})};const{ArchiveEngine}=await import('/src/tool-engine.ts');const engine=new ArchiveEngine();let result;try{const data=Uint8Array.from(atob(input.base64),letter=>letter.charCodeAt(0)),file=new File([data],input.name);const output=await engine.extract([file],undefined,undefined,undefined,undefined,{links:input.policy});const files=[];for(const item of output.files){const bytes=await item.blob.arrayBuffer();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');files.push({name:item.name,bytes:bytes.byteLength,sha256:hash});}result={completed:true,files,directories:output.directories||[],metadata:output.metadata||output.entries};}catch(error){result={completed:true,error:String(error),rejected:true};}finally{const cleaned=await engine.dispose();if(!cleaned)throw Error('Native operation cleanup failed');}return result;})()`,60000);assert.equal(value?.completed,true);result.actual=value;
    const pattern=policy==='reject'?new RegExp(item.defaultRejectPattern||'Archive links are not extracted'):item.negative?new RegExp(item.rejectPattern||'checksum|crc','i'):undefined;
    if(pattern){assert.equal(typeof value.error,'string');assert.match(value.error,pattern);assert.equal(value.rejected,true);}
    else{assert.ok(!value.error,value.error);const expectedFiles=item.expected.filter(entry=>!entry.directory).sort((a,b)=>a.name.localeCompare(b.name));assert.deepEqual(value.files.sort((a,b)=>a.name.localeCompare(b.name)),expectedFiles);assert.deepEqual([...value.directories].sort(),item.expected.filter(entry=>entry.directory).map(entry=>entry.name).sort());for(const[name,fields]of Object.entries(item.metadata||{})){const entry=value.metadata?.find(entry=>entry.name===name);assert.ok(entry,'Missing metadata '+name);for(const[key,expected]of Object.entries(fields))assert.deepEqual(entry.metadata[key],expected);}}
    result.status='PASS';
   }catch(error){result.error=String(error);if(/timeout|disconnected|connection closed|target.*closed|execution context|navigated/i.test(result.error)){await save();throw error;}}await save();console.log(JSON.stringify({id:result.id,policy,status:result.status,error:result.error}));
  }
 }
 report.status=report.cases.length===manifest.cases.length*2&&report.cases.every(item=>item.status==='PASS')?'PASS':'FAIL';
}catch(error){report.status='FAIL';report.error=String(error);}
finally{if(page){try{await page.close();report.ownedPageClosed=true;}catch(error){report.status='FAIL';report.closeError=String(error);}}await save();}
console.log(JSON.stringify({status:report.status,evidence:directory+'/evidence.json',cases:report.cases.length,error:report.error}));if(report.status!=='PASS')process.exitCode=1;
