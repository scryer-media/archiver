import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const repo=resolve(process.env.ARCHIVE_REPO||'.');
const root=process.env.NATIVE_FIXTURE_ROOT||'/private/tmp/archive-completeness-battery';
const securityRoot=process.env.NATIVE_SECURITY_FIXTURE_ROOT||root+'/native-security-final';
const reportRoot=process.env.NATIVE_REPORT_ROOT||root+'/native-security-result-'+Date.now();
await mkdir(reportRoot,{recursive:false});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={scope:'Actual application Emscripten WASM engine_run API and virtual filesystem; no host filesystem links or metadata mutation',status:'RUNNING',cases:[],runtime:{}};
const save=()=>writeFile(reportRoot+'/evidence.json',JSON.stringify(report,null,2)+'\n');
try{
 const js=await readFile(repo+'/public/engine/archive-engine.js'),wasm=await readFile(repo+'/public/engine/archive_engine.wasm');report.runtime={jsSHA256:digest(js),wasmSHA256:digest(wasm)};
 const {default:createModule}=await import(pathToFileURL(repo+'/public/engine/archive-engine.js'));
 const module=await createModule({wasmBinary:wasm,print:()=>{},printErr:()=>{}}),fs=module.FS;
 const clean=path=>{for(const name of fs.readdir(path)){if(name==='.'||name==='..')continue;const child=path+'/'+name;if(fs.isDir(fs.lstat(child).mode)){clean(child);fs.rmdir(child);}else fs.unlink(child);}};
 for(const dir of ['/input','/out']){try{fs.mkdir(dir);}catch{clean(dir);}}
 const outputs=()=>{const result={};const walk=(path,prefix)=>{for(const name of fs.readdir(path)){if(name==='.'||name==='..')continue;const child=path+'/'+name,logical=prefix+name,mode=fs.lstat(child).mode;assert.ok(!fs.isLink(mode),'Native output must not be a link');if(fs.isDir(mode)){result[logical]={directory:true};walk(child,logical+'/');}else{assert.ok(fs.isFile(mode),'Native output must be a regular file');const bytes=fs.readFile(child);result[logical]={bytes:bytes.length,sha256:digest(bytes)};}}};walk('/out','');return result;};
 const invoke=request=>{const ptr=module.ccall('engine_run','number',['string'],[JSON.stringify(request)]);try{return JSON.parse(module.UTF8ToString(ptr));}finally{module._engine_free(ptr);}};
 async function check(id,path,policy,expected,errorPattern,maxOutput=32*1024*1024,metadata,maxReadRatio){
  const result={id,policy,status:'FAIL'};report.cases.push(result);
  try{clean('/input');clean('/out');const bytes=await readFile(path);result.archiveSHA256=digest(bytes);const input='/input/archive'+(path.endsWith('.rar')?'.rar':'.7z');fs.writeFile(input,bytes);let inputBytesRead=0;const originalRead=fs.read;fs.read=function(stream,...args){const count=originalRead.call(this,stream,...args);if(stream.path===input)inputBytesRead+=count;return count;};let response;try{response=invoke({op:'extract',paths:[input],links:policy,maxOutput});}finally{fs.read=originalRead;}result.inputBytesRead=inputBytesRead;if(maxReadRatio){assert.ok(inputBytesRead>0);assert.ok(inputBytesRead<bytes.length*maxReadRatio,'Cached aliases reread input excessively');}result.response=response;result.outputs=outputs();
   if(errorPattern){assert.equal(typeof response.error,'string');assert.match(response.error,errorPattern);assert.deepEqual(result.outputs,{},'Rejected archive wrote output before preflight');}
   else{assert.ok(!response.error,response.error);const want=Object.fromEntries(expected.map(entry=>[entry.name,entry.directory?{directory:true}:{bytes:entry.bytes,sha256:entry.sha256}]));assert.deepEqual(result.outputs,want);for(const[name,fields]of Object.entries(metadata||{})){const entry=response.entries.find(entry=>entry.name===name);assert.ok(entry);for(const[key,value]of Object.entries(fields))assert.deepEqual(entry.metadata[key],value);}}
   result.status='PASS';
  }catch(error){result.error=String(error);}await save();
 }
 const manifest=JSON.parse(await readFile(root+'/native/manifest.json','utf8'));
 for(const item of manifest.cases){const path=root+'/native/'+item.archive;const archiveBytes=await readFile(path);assert.equal(archiveBytes.length,item.archiveBytes);assert.equal(digest(archiveBytes),item.archiveSHA256);
  if(item.listMetadata){const record={id:item.id+'-list',status:'FAIL'};report.cases.push(record);try{clean('/input');clean('/out');fs.writeFile('/input/archive.rar',archiveBytes);const response=invoke({op:'list',paths:['/input/archive.rar']});assert.ok(!response.error,response.error);const entry=response.entries.find(entry=>entry.name===item.listMetadata.name);assert.equal(entry.isLink,true);assert.equal(entry.metadata.link.kind,item.listMetadata.kind);assert.equal(!!entry.metadata.link.targetIsDirectory,item.listMetadata.targetIsDirectory);assert.deepEqual(outputs(),{});record.response=entry;record.status='PASS';}catch(error){record.error=String(error);}await save();}
  await check(item.id+'-default',path,'reject',undefined,new RegExp(item.defaultRejectPattern||'Archive links are not extracted'));
  await check(item.id+'-copy',path,'copy-safe',item.expected,item.negative?new RegExp(item.rejectPattern||'checksum|crc','i'):undefined,undefined,item.metadata);
 }
 const failures={absolute:/Unsafe archive link target/,escape:/escapes/,drive:/Unsafe archive link target/,unc:/Unsafe archive link target/,backslash:/Unsafe archive link target/,nul:/Unsafe archive link target/,cycle:/cycle/,missing:/target is missing/,directory:/directory links/,special:/special files/, 'case-ancestor':/canonical path aliases|file is used as a directory/,'nfc-alias':/canonical path aliases/,'sigma-alias':/canonical path aliases/,'sigma-ancestor':/canonical path aliases|file is used as a directory/,oversized:/16 KiB/};
 for(const[name,pattern]of Object.entries(failures))await check('7z-'+name,securityRoot+'/'+name+'.7z','copy-safe',undefined,pattern);
 const oracle=digest(Buffer.from('oracle'));
 for(const[name,names]of [['forward-chain',['first','second','data']],['unicode',['copie','résumé']]])await check('7z-'+name,securityRoot+'/'+name+'.7z','copy-safe',names.map(name=>({name,bytes:6,sha256:oracle})));
 await check('7z-expanded-copy-quota',root+'/native/7z-link-metadata.7z','copy-safe',undefined,/output limit/,11);
 await check('7z-regular-quota-before-corrupt-link',root+'/native/7z-link-bad-crc.7z','copy-safe',undefined,/regular members exceed output limit/,5);
 const many=Array.from({length:1001},(_,index)=>({name:'alias-'+index,bytes:6,sha256:oracle}));many.push({name:'data',bytes:6,sha256:oracle});
 await check('7z-many-cached-aliases',securityRoot+'/many-cached-aliases.7z','copy-safe',many,undefined,undefined,undefined,10);
 await check('7z-uncached-metadata-budget',securityRoot+'/many-uncached-budget.7z','copy-safe',undefined,/metadata work budget/,128*1024*1024);
 const largeHash=digest(Buffer.alloc(65537,97));await check('7z-uncached-replay',securityRoot+'/uncached-replay.7z','copy-safe',['data','link'].map(name=>({name,bytes:65537,sha256:largeHash})));
 report.status=report.cases.every(item=>item.status==='PASS')?'PASS':'FAIL';
}catch(error){report.status='FAIL';report.error=String(error);}
await save();console.log(JSON.stringify({status:report.status,cases:report.cases.length,failed:report.cases.filter(item=>item.status!=='PASS').map(item=>({id:item.id,error:item.error})),evidence:reportRoot+'/evidence.json',error:report.error}));
if(report.status!=='PASS')process.exitCode=1;
