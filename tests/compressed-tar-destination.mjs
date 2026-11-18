import * as outputBudget from '../engine/output-budget.ts';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import ts from '@typescript/typescript6';
const {default:createModule}=await import(new URL('../public/engine/archive-engine.js',import.meta.url));
const module=await createModule({wasmBinary:await readFile(new URL('../public/engine/archive_engine.wasm',import.meta.url)),print(){},printErr(){}}),fs=module.FS;
for(const path of ['/input','/out'])try{fs.mkdir(path);}catch{}
const clean=path=>{for(const name of fs.readdir(path)){if(name==='.'||name==='..')continue;const child=path+'/'+name;if(fs.isDir(fs.lstat(child).mode)){clean(child);fs.rmdir(child);}else fs.unlink(child);}};
const invoke=request=>{const pointer=module.ccall('engine_run','number',['string'],[JSON.stringify(request)]);try{return JSON.parse(module.UTF8ToString(pointer));}finally{module._engine_free(pointer);}};
const compile=async path=>ts.transpileModule((await readFile(new URL(path,import.meta.url),'utf8')).replaceAll('import.meta.url',JSON.stringify('https://local.test/module.js')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const context=vm.createContext({File,Blob,Uint8Array,TextEncoder,TextDecoder,ReadableStream,WritableStream,TransformStream,DOMException,crypto:webcrypto,performance,navigator:{storage:{}},setTimeout,clearTimeout,URL,console});
const load=(source,require)=>{const exports={};vm.runInContext('(function(exports,require){'+source+'\n})',context)(exports,require);return exports;};
const destination=load(await compile('../engine/destination.ts'),()=>{throw Error('Unexpected destination import');}),storage=load(await compile('../engine/storage.ts'),()=>{throw Error('Unexpected storage import');});
const {ArchiveEngine}=load(await compile('../src/tool-engine.ts'),name=>name.includes('output-budget')?outputBudget:name.includes('client')?{ArchiveEngine:class{}}:name.includes('destination')?destination:name.includes('storage')?storage:{});
const notFound=()=>new DOMException('Absent','NotFoundError');let memberWrites=0;
class Directory{
 constructor(path=''){this.path=path;this.children=new Map();}
 async getDirectoryHandle(name,options){let value=this.children.get(name);if(!value){if(!options?.create)throw notFound();value=new Directory(this.path+'/'+name);this.children.set(name,value);}if(!(value instanceof Directory))throw new DOMException('Not directory','TypeMismatchError');return value;}
 async getFileHandle(name,options){let value=this.children.get(name);if(!value){if(!options?.create)throw notFound();value={kind:'file',name,blob:new Blob(),getFile:async()=>new File([value.blob],name),createWritable:async()=>{if(!this.path.includes('/.archive-stream-'))memberWrites++;const chunks=[];return new WritableStream({write(chunk){chunks.push(chunk.slice());},close(){value.blob=new Blob(chunks);}});}};this.children.set(name,value);}if(value instanceof Directory)throw new DOMException('Not file','TypeMismatchError');return value;}
 async removeEntry(name){if(!this.children.delete(name))throw notFound();}
 async *entries(){yield*this.children;}
 async *values(){for(const[name,value]of this.children)yield value instanceof Directory?{kind:'directory',name}:value;}
}
function header(name,size=0,type='0',target=''){const b=new Uint8Array(512),enc=new TextEncoder(),put=(at,text)=>b.set(enc.encode(text),at);put(0,name);put(100,'0000644\0');put(108,'0000000\0');put(116,'0000000\0');put(124,size.toString(8).padStart(11,'0')+'\0');put(136,'00000000000\0');put(148,'        ');put(156,type);put(157,target);put(257,'ustar\0');put(263,'00');put(148,b.reduce((a,n)=>a+n,0).toString(8).padStart(6,'0')+'\0 ');return b;}
async function fixture(target='payload'){return new File([gzipSync(Buffer.from(await new Blob([header('payload',3),new TextEncoder().encode('abc'),new Uint8Array(509),header('copy',0,'2',target),new Uint8Array(1024)]).arrayBuffer()))],'fixture.tar.gz');}
function engine(root,{cancel=false}={}){
 const app=new ArchiveEngine();let decodedToChosen=false,rejectNative,started;
 const ready=new Promise(resolve=>started=resolve);
 app.listInternal=async()=>{throw Error('Private OPFS predecode must not run for a selected destination');};
 app.native={extract:async(files,_password,format,dir,_stream,options={})=>{
  assert.ok(dir,'Decompression and member extraction must receive the selected handles');
  if(format!=='tar'){decodedToChosen=true;const file=await dir.getFileHandle('archive.tar',{create:true}),writer=(await file.createWritable()).getWriter();await writer.write(gunzipSync(Buffer.from(await files[0].arrayBuffer())));await writer.close();started();if(cancel)await new Promise((_resolve,reject)=>rejectNative=reject);return{files:[],savedFiles:1};}
  assert.equal(options.links,'copy-safe');clean('/input');clean('/out');fs.writeFile('/input/archive.tar',new Uint8Array(await files[0].arrayBuffer()));const result=invoke({op:'extract',format:'tar',paths:['/input/archive.tar'],links:options.links,maxOutput:8*1024*1024});if(result.error){assert.deepEqual(fs.readdir('/out').filter(n=>n!=='.'&&n!=='..'),[],'Unsafe graph must not publish native outputs');throw Error(result.error);}
  let saved=0;const publish=async(path,prefix)=>{for(const name of fs.readdir(path)){if(name==='.'||name==='..')continue;const child=path+'/'+name,relative=prefix+name;if(fs.isDir(fs.lstat(child).mode)){await destination.destinationDirectory(dir,relative);await publish(child,relative+'/');}else{const target=await destination.destinationParent(dir,relative),handle=await target.directory.getFileHandle(target.name,{create:true}),writer=(await handle.createWritable()).getWriter();await writer.write(fs.readFile(child));await writer.close();saved++;}}};await publish('/out','');return{files:[],savedFiles:saved,metadata:result.entries};
 },dispose:async()=>{rejectNative?.(Error('Cancelled'));return true;}};
 app.fallback=async()=>{throw Error('Custom TAR worker must not be used');};
 return{app,ready,decoded:()=>decodedToChosen};
}
const root=new Directory(),positive=engine(root);const result=await positive.app.extract([await fixture()],undefined,undefined,root,undefined,{links:'copy-safe'});assert.ok(positive.decoded());assert.equal(result.savedFiles,2);const job=await root.getDirectoryHandle(result.savedDirectory);assert.deepEqual([...job.children.keys()].sort(),['copy','payload']);for(const file of job.children.values())assert.equal(await file.blob.text(),'abc');assert.equal(await positive.app.dispose(),true);
memberWrites=0;const invalidRoot=new Directory(),invalid=engine(invalidRoot);await assert.rejects(invalid.app.extract([await fixture('../outside')],undefined,undefined,invalidRoot,undefined,{links:'copy-safe'}),/escapes/);assert.equal(memberWrites,0,'Unsafe graph must not open any member writer');assert.equal(invalidRoot.children.size,0,'Failed job and decompressed scratch must be removed');await invalid.app.dispose();
const cancelRoot=new Directory(),cancelled=engine(cancelRoot,{cancel:true});const operation=cancelled.app.extract([await fixture()],undefined,undefined,cancelRoot,undefined,{links:'copy-safe'});await cancelled.ready;assert.equal(await cancelled.app.dispose(),true);await assert.rejects(operation);assert.equal(cancelRoot.children.size,0);
console.log(JSON.stringify({pass:3,fail:0,scope:'Actual public orchestration and native TAR C ABI with mock chosen-directory publication; outer GZIP decode uses Node shim, not native codec proof',privateOPFSUnavailable:true,chosenScratchUsed:true,exactMemberBytes:true,unsafeGraphZeroMemberWrites:true,failureAndCancelCleanup:true}));
