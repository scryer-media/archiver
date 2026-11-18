import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
// A solid 7z holds a reader for every file at once. More files than the runtime can
// keep open (4096) must still archive, because each file is opened only while it is read.
const repo=fileURLToPath(new URL('..',import.meta.url));
const wasm=await readFile(resolve(repo,'public/engine/archive_engine.wasm'));
const{default:createModule}=await import(pathToFileURL(resolve(repo,'public/engine/archive-engine.js')));
const module=await createModule({wasmBinary:wasm,print:()=>{},printErr:()=>{}}),fs=module.FS;
const run=request=>{const pointer=module.ccall('engine_run','number',['string'],[JSON.stringify(request)]);try{return JSON.parse(module.UTF8ToString(pointer));}finally{module._engine_free(pointer);}};
const COUNT=6000;
fs.mkdir('/input');fs.mkdir('/input/tree');fs.mkdir('/out');
const paths=[];
for(let i=0;i<COUNT;i++){const path=`/input/tree/f${i}.txt`;fs.writeFile(path,`file ${i}\n`);paths.push(path);}
for(const solid of [true,false]){
 for(const name of fs.readdir('/out'))if(name!=='.'&&name!=='..')fs.unlink('/out/'+name);
 const created=run({op:'create',format:'7z',paths,solid,password:'',maxOutput:1<<30});
 assert.equal(created.error,undefined,`${solid?'solid':'non-solid'} create: ${created.error}`);
 fs.rename('/out/archive.7z','/input/check.7z');
 const listed=run({op:'list',paths:['/input/check.7z'],password:'',maxOutput:Number.MAX_SAFE_INTEGER});
 assert.equal(listed.error,undefined,listed.error);
 const files=listed.entries.filter(entry=>!entry.isDirectory);
 assert.equal(files.length,COUNT,'every file is in the archive');
 assert.equal(files.find(entry=>entry.name==='tree/f5999.txt')?.size,'file 5999\n'.length);
 fs.unlink('/input/check.7z');
}
console.log(JSON.stringify({status:'PASS',scope:`${COUNT}-file solid and non-solid 7z creation past the open-file limit`}));
