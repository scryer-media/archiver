import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
import * as zip from '@zip.js/zip.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sourceCache=new Map();
async function source(path){if(!sourceCache.has(path))sourceCache.set(path,ts.transpileModule((await readFile(path,'utf8')).replaceAll('import.meta.url',JSON.stringify('https://local.test/worker.js')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText);return sourceCache.get(path);}
export async function runFallbackWorker(file,op,options={}){
 const sources=new Map();async function gather(path){if(sources.has(path))return;const compiled=await source(path);sources.set(path,compiled);for(const match of compiled.matchAll(/require\(["']([^"']+)["']\)/g)){if(match[1].startsWith('.'))await gather(resolve(dirname(path),match[1]+(match[1].endsWith('.ts')?'':'.ts')));}}await gather(resolve(root,'src/fallback.worker.ts'));
 const messages=[],chunks=[];let closed=false,aborted=false;const self={postMessage:message=>messages.push(message)};
 const sink=new WritableStream({write(chunk){chunks.push(chunk.slice())},close(){closed=true},abort(){aborted=true}});
 const context=vm.createContext({...(options.nativeStreams?{CompressionStream,DecompressionStream}:{}),File,Blob,WritableStream,ReadableStream,TransformStream,Uint8Array,Uint16Array,Uint32Array,DataView,TextEncoder,TextDecoder,Map,Set,Promise,Error,TypeError,RangeError,Number,BigInt,Math,JSON,Array,Object,DOMException,crypto:webcrypto,performance,console,setTimeout,clearTimeout,navigator:{storage:{getDirectory:async()=>{throw Error('No OPFS in Node worker regression')}}},self});
 const modules=new Map();function load(path){if(modules.has(path))return modules.get(path).exports;const module={exports:{}};modules.set(path,module);const require=name=>name==='@zip.js/zip.js'?zip:name.startsWith('.')?load(resolve(dirname(path),name+(name.endsWith('.ts')?'':'.ts'))):(()=>{throw Error('Unexpected worker dependency: '+name)})();vm.runInContext('(function(exports,require,module){'+sources.get(path)+'\n})',context,{filename:path})(module.exports,require,module);return module.exports;}
 load(resolve(root,'src/fallback.worker.ts'));await self.onmessage({data:{op,files:[file],storageId:'security-fixture',...options,...(op==='extract'&&options.captureDownload!==false?{downloadStream:sink}:{})}});
 const result=messages.findLast(message=>message.error||message.files||message.entries);assert.ok(result,'Worker returned no result: '+JSON.stringify(messages.slice(-2)));return{result,chunks,closed,aborted,bytes:chunks.reduce((n,chunk)=>n+chunk.byteLength,0)};
}
