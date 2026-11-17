import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const repo=fileURLToPath(new URL('..',import.meta.url));
const fixtureRoot=resolve(repo,'tests/fixtures/tar-dot-paths');
const manifest=JSON.parse(await readFile(resolve(fixtureRoot,'manifest.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const wasm=await readFile(resolve(repo,'public/engine/archive_engine.wasm'));
const{default:createModule}=await import(pathToFileURL(resolve(repo,'public/engine/archive-engine.js')));
const module=await createModule({wasmBinary:wasm,print:()=>{},printErr:()=>{}}),fs=module.FS;
for(const path of ['/input','/out'])try{fs.mkdir(path);}catch{}
function clean(path){for(const name of fs.readdir(path)){if(name==='.'||name==='..')continue;const item=path+'/'+name;if(fs.isDir(fs.lstat(item).mode)){clean(item);fs.rmdir(item);}else fs.unlink(item);}}
function invoke(bytes,op,links='copy-safe'){
 clean('/input');clean('/out');fs.writeFile('/input/dot.tar',bytes);
 const pointer=module.ccall('engine_run','number',['string'],[JSON.stringify({op,format:'tar',paths:['/input/dot.tar'],links,maxOutput:1024*1024})]);
 try{return JSON.parse(module.UTF8ToString(pointer));}finally{module._engine_free(pointer);}
}
function outputs(){const found={};function walk(path,prefix){for(const name of fs.readdir(path)){if(name==='.'||name==='..')continue;const item=path+'/'+name,mode=fs.lstat(item).mode;assert.ok(!fs.isLink(mode));if(fs.isDir(mode)){found[prefix+name]={directory:true};walk(item,prefix+name+'/');}else{const data=fs.readFile(item);found[prefix+name]={bytes:data.length,sha256:hash(data)};}}}walk('/out','');return found;}
const report={scope:'Actual WASM TAR canonical paths, metadata and safe-link replay; system bsdtar PAX and Python GNU-format producers, not GNU CLI',wasmSHA256:hash(wasm),cases:[]};
for(const item of manifest.cases){
 const bytes=await readFile(resolve(fixtureRoot,item.archive));assert.equal(hash(bytes),item.sha256);
 const expected=Object.fromEntries(item.expected.map(entry=>[entry.name,entry.directory?{directory:true}:{bytes:entry.bytes,sha256:entry.sha256}]));
 for(const op of ['list','extract']){
  const result=invoke(bytes,op);assert.ok(!result.error,result.error);
  assert.deepEqual(result.entries.map(entry=>entry.name).sort(),item.expected.map(entry=>entry.name).sort());
  for(const entry of item.expected){const actual=result.entries.find(candidate=>candidate.name===entry.name);assert.equal(actual.isDirectory,entry.directory);assert.equal(actual.metadata.modifiedTime,entry.modifiedTime);}
  assert.deepEqual(outputs(),op==='list'?{}:expected);
  report.cases.push({id:item.archive+':'+op,status:'PASS'});
 }
 const rejected=invoke(bytes,'extract','reject');assert.match(rejected.error,/links/i);assert.deepEqual(outputs(),{});report.cases.push({id:item.archive+':default-links',status:'PASS'});
}
const encode=new TextEncoder();
function header(name,type='0',size=0,target=''){
 const bytes=new Uint8Array(512),put=(offset,text)=>bytes.set(encode.encode(text),offset);
 put(0,name);put(100,'0000644\0');put(108,'0000000\0');put(116,'0000000\0');put(124,size.toString(8).padStart(11,'0')+'\0');put(136,'00000000000\0');bytes.fill(32,148,156);put(156,type);put(157,target);put(257,'ustar\0');put(263,'00');put(148,bytes.reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ');return bytes;
}
const negatives=[
 ['root-regular',[header('.')]],
 ['root-symbolic',[header('./','2',0,'payload')]],
 ['root-directory-with-data',[header('./','5',3),encode.encode('abc'),new Uint8Array(509)]],
 ['canonical-duplicate',[header('./same'),header('same')]],
 ['canonical-file-ancestor',[header('./parent'),header('parent/child')]],
 ['escaping-link',[header('./copy','2',0,'../outside'),header('./payload')]],
];
for(const[id,parts]of negatives){const bytes=Buffer.concat([...parts,new Uint8Array(1024)].map(part=>Buffer.from(part)));for(const op of ['list','extract']){const result=invoke(bytes,op);assert.equal(typeof result.error,'string',id);assert.deepEqual(outputs(),{},id);report.cases.push({id:id+':'+op,status:'PASS',error:result.error});}}
report.status='PASS';report.pass=report.cases.length;
if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
