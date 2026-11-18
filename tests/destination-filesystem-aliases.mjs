import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,stat,rm,open} from 'node:fs/promises';
import {join} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as destination from '../engine/destination.ts';
import * as zipStream from '../engine/zip-stream.ts';
const root=await mkdtemp('/private/tmp/archive-destination-aliases-');let writerOpened=0,createdDirectories=0;
function directory(path){return{
 async getDirectoryHandle(name,options={}){const child=join(path,name);try{const value=await stat(child);if(!value.isDirectory())throw new DOMException('Not a directory','TypeMismatchError');}catch(error){if(error.code!=='ENOENT')throw error;if(!options.create)throw new DOMException('Missing','NotFoundError');await mkdir(child);createdDirectories++;}return directory(child);},
 async getFileHandle(name,options={}){const file=join(path,name);try{const value=await stat(file);if(!value.isFile())throw new DOMException('Not a file','TypeMismatchError');}catch(error){if(error.code!=='ENOENT')throw error;if(!options.create)throw new DOMException('Missing','NotFoundError');const handle=await open(file,'a');await handle.close();}return{async createWritable(){writerOpened++;return{async close(){},async abort(){}};}};}
};}
try{
 for(const [a,b] of [['Σ','ς'],['parent/Σ/a','parent/ς/b'],['ß','SS'],['é','e\u0301']]){const register=destination.destinationPathRegistry();register(a);assert.throws(()=>register(b),/aliases/);}
 await writeFile(join(root,'Σ'),'original');assert.equal(await readFile(join(root,'ς'),'utf8'),'original','This actual-host regression requires case-insensitive APFS');
 const rootHandle=directory(root);await mkdir(join(root,'DirΣ'));const before=createdDirectories;await assert.rejects(destination.destinationParent(rootHandle,'Dirς/child'),/existing/);assert.equal(createdDirectories,before);
 const made=await destination.destinationDirectory(rootHandle,'owned/sub');assert.equal(await destination.destinationDirectory(rootHandle,'owned/sub'),made);assert.equal((await destination.destinationParent(rootHandle,'owned/sub/a')).directory,made);
 const shared=new SharedArrayBuffer(16+1024*1024),state=new Int32Array(shared,0,4),self={postMessage(){}};
 const source=ts.transpileModule(await readFile('engine/direct-output.worker.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const context=vm.createContext({exports:{},require:name=>{if(name==='./zip-stream')return zipStream;assert.equal(name,'./destination');return destination;},self,Int32Array,Uint8Array,Atomics,SharedArrayBuffer,Map,Set,Error,TextEncoder,performance,setInterval,clearInterval,setTimeout,clearTimeout});vm.runInContext(source,context);
 await self.onmessage({data:{init:true,directory:rootHandle,shared}});await self.onmessage({data:{op:'open',path:'ς'}});assert.ok(Atomics.load(state,1)>0);assert.equal(writerOpened,0);assert.equal(await readFile(join(root,'Σ'),'utf8'),'original');
 console.log('Actual APFS aliases: shared registry, unknown-directory refusal, exact-owned reuse and native helper existing-file refusal passed; no original bytes changed');
}finally{await rm(root,{recursive:true,force:true});}
