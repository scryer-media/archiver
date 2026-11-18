import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {ZipWriter,BlobWriter,TextReader,configure} from '@zip.js/zip.js';
import {runFallbackWorker} from './lib/zip-worker-harness.mjs';
configure({useWebWorkers:false});
// Selective extraction (`only`) writes just the named entries, with their normal bytes,
// and refuses a name that is missing, a directory or a link.
const repo=fileURLToPath(new URL('..',import.meta.url));
const wasm=await readFile(resolve(repo,'public/engine/archive_engine.wasm'));
const{default:createModule}=await import(pathToFileURL(resolve(repo,'public/engine/archive-engine.js')));
const module=await createModule({wasmBinary:wasm,print:()=>{},printErr:()=>{}}),fs=module.FS;
const run=request=>{const pointer=module.ccall('engine_run','number',['string'],[JSON.stringify(request)]);try{return JSON.parse(module.UTF8ToString(pointer));}finally{module._engine_free(pointer);}};
const clear=path=>{for(const name of fs.readdir(path)){if(name==='.'||name==='..')continue;const child=path+'/'+name;if(fs.isDir(fs.stat(child).mode)){clear(child);fs.rmdir(child);}else fs.unlink(child);}};
const outputs=(path='/out',prefix='')=>{const found={};for(const name of fs.readdir(path)){if(name==='.'||name==='..')continue;const child=path+'/'+name;if(fs.isDir(fs.stat(child).mode))found[prefix+name+'/']=null,Object.assign(found,outputs(child,prefix+name+'/'));else found[prefix+name]=Buffer.from(fs.readFile(child)).toString('latin1');}return found;};
const extract=(paths,extra={})=>{clear('/out');return run({op:'extract',paths,password:'',maxOutput:1<<30,...extra});};
const files={'a.txt':'alpha payload\n','b.txt':'bravo payload\n','sub/c.txt':'charlie payload\n'};
fs.mkdir('/input');fs.mkdir('/input/sub');fs.mkdir('/out');
for(const [name,text] of Object.entries(files))fs.writeFile('/input/'+name,text);
const sources=Object.keys(files).map(name=>'/input/'+name);
let pass=0;
function selective(id,paths,name,expected,{directory,missing='nope.txt',request={}}={}){
 const full=extract(paths,request);assert.equal(full.error,undefined,id+' full: '+full.error);
 const everything=outputs();
 const one=extract(paths,{...request,only:[name]});assert.equal(one.error,undefined,id+' only: '+one.error);
 assert.deepEqual(outputs(),{...(name.includes('/')?{[name.slice(0,name.lastIndexOf('/')+1)]:null}:{}),[name]:expected},id+' writes only the selected entry');
 assert.equal(everything[name],expected,id+' selected bytes match a full extraction');
 const unknown=extract(paths,{...request,only:[missing]});assert.match(unknown.error??'',/not in the archive/,id+' unknown name');assert.deepEqual(outputs(),{},id+' unknown name writes nothing');
 if(directory){const refused=extract(paths,{...request,only:[directory]});assert.match(refused.error??'',/is a directory/,id+' directory');assert.deepEqual(outputs(),{},id+' directory writes nothing');}
 pass++;
}
for(const solid of [true,false]){
 clear('/out');const created=run({op:'create',format:'7z',paths:sources,directories:['sub'],solid,password:'',maxOutput:1<<30});
 assert.equal(created.error,undefined,created.error);fs.rename('/out/archive.7z','/input/check.7z');
 selective(`7z-${solid?'solid':'plain'}`,['/input/check.7z'],'b.txt',files['b.txt'],{directory:'sub'});
 selective(`7z-${solid?'solid':'plain'}-nested`,['/input/check.7z'],'sub/c.txt',files['sub/c.txt']);
 fs.unlink('/input/check.7z');
}
{
 clear('/out');const created=run({op:'create',format:'tar',paths:sources,directories:['sub'],password:'',maxOutput:1<<30});
 assert.equal(created.error,undefined,created.error);fs.rename('/out/archive.tar','/input/check.tar');
 selective('tar',['/input/check.tar'],'a.txt',files['a.txt'],{directory:'sub',request:{format:'tar'}});
 selective('tar-nested',['/input/check.tar'],'sub/c.txt',files['sub/c.txt'],{request:{format:'tar'}});
 const listed=run({op:'list',format:'tar',paths:['/input/check.tar'],only:['a.txt']});assert.match(listed.error??'',/only to extraction/);
 fs.unlink('/input/check.tar');
}
{
 clear('/out');const created=run({op:'create',format:'gz',paths:['/input/a.txt'],password:'',maxOutput:1<<30});
 assert.equal(created.error,undefined,created.error);fs.rename('/out/a.txt.gz','/input/a.txt.gz');
 selective('gz-stream',['/input/a.txt.gz'],'a.txt',files['a.txt']);
 fs.unlink('/input/a.txt.gz');
}
for(const [fixture,name] of [['rar5_multifile_lz.rar','second.txt'],['rar4_lz_solid_mv.rar','lz_part2.bin']]){
 fs.writeFile('/input/'+fixture,await readFile(resolve(repo,'tests/fixtures/compatibility',fixture)));
 const full=extract(['/input/'+fixture]);assert.equal(full.error,undefined,full.error);
 selective('rar-'+fixture,['/input/'+fixture],name,outputs()[name]);
 fs.unlink('/input/'+fixture);
}
{
 const writer=new ZipWriter(new BlobWriter());await writer.add('sub/',undefined,{directory:true});
 for(const [name,text] of Object.entries(files))await writer.add(name,new TextReader(text));
 const zip=new File([await writer.close()],'check.zip');
 const full=await runFallbackWorker(zip,'extract',{captureDownload:false});assert.equal(full.result.error,undefined,full.result.error);assert.equal(full.result.files.length,3);
 const one=await runFallbackWorker(zip,'extract',{captureDownload:false,extraction:{only:['sub/c.txt']}});assert.equal(one.result.error,undefined,one.result.error);
 assert.deepEqual(Array.from(one.result.files,file=>file.name),['sub/c.txt']);assert.equal(await one.result.files[0].blob.text(),files['sub/c.txt']);assert.equal(one.result.directories.length,0);
 for(const [name,reason] of [['nope.txt',/not in the archive/],['sub/',/is a directory/]]){const refused=await runFallbackWorker(zip,'extract',{captureDownload:false,extraction:{only:[name]}});assert.match(refused.result.error??'',reason);}
 const download=await runFallbackWorker(zip,'extract',{extraction:{only:['b.txt']}});assert.equal(download.result.error,undefined,download.result.error);assert.equal(new TextDecoder().decode(Buffer.concat(download.chunks)),files['b.txt']);
 const linked=new ZipWriter(new BlobWriter());await linked.add('copy',new TextReader('payload'),{unixMode:0o120777,compressionMethod:0});await linked.add('payload',new TextReader('abc'));
 const link=await runFallbackWorker(new File([await linked.close()],'links.zip'),'extract',{captureDownload:false,extraction:{links:'copy-safe',only:['copy']}});assert.match(link.result.error??'',/is a link/);
 pass++;
}
console.log(JSON.stringify({pass,fail:0,scope:'Selective extraction of one entry from synthetic 7z, TAR, gzip and ZIP archives and RAR fixtures'}));
