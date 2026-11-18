import * as outputBudget from '../engine/output-budget.ts';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from '@typescript/typescript6';
import {creationPlans} from '../engine/create-plan.ts';
import {selectEntries} from '../engine/selection.ts';
let tickets=0,listed=0,entries=[];
class Native { async list(){listed++;return {files:[],entries};}async extract(){return {files:[],sentBytes:3};}async create(){return {files:[],sentBytes:3};}async dispose(){return true;} }
const exports={};
const context={exports,File,Blob,Uint8Array,TextDecoder,TextEncoder,Map,Set,Error,Promise,console,require:name=>name.includes('output-budget')?outputBudget:name.includes('selection')?{selectEntries}:name.includes('create-plan')?{creationPlans}:name.includes('native-stream')?{chooseNativeStream:()=>false}:name.includes('download')?{createDownload:async name=>{tickets++;return {name,writable:new WritableStream(),cancel(){},release(){}};}}:name.includes('client')?{ArchiveEngine:Native}:{} };
vm.runInNewContext(ts.transpileModule((await readFile(new URL('../src/tool-engine.ts',import.meta.url),'utf8')).replaceAll('import.meta.url',JSON.stringify('https://local.test/tool-engine.ts')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
const Engine=exports.ArchiveEngine;
const file=(name,size=3)=>({name,size,webkitRelativePath:'',slice:()=>new Blob([new Uint8Array([0x52,0x61,0x72,0x21])])});
for(const [files,options] of [
 [[file('x')],{format:'7z'}],[[file('x')],{format:'par2'}],[[file('x')],{format:'tar.zstd',password:'p'}],
 [[file('x',Number.MAX_SAFE_INTEGER+1)],{format:'tar'}],[[file('../x')],{format:'zip'}],
 [[file('x'),file('x')],{format:'zip'}],[[file('x'),file('x/y')],{format:'zip'}],
 [[file('x')],{format:'tar',password:'p'}],[[file('x'),file('y')],{format:'zstd'}],[[file('x')],{format:'zstd',password:'p'}],
 ]){await assert.rejects(new Engine().create(files,{...options,delivery:'download'}));assert.equal(tickets,0,'invalid create opened download ticket');}
for(const value of [[],[{name:'a',size:1,isDirectory:false,isLink:false},{name:'b',size:1,isDirectory:false,isLink:false}],[{name:'link',size:1,isDirectory:false,isLink:true}],[{name:'../bad',size:1,isDirectory:false,isLink:false}],[{name:'old-runtime',size:1,isDirectory:false}]]){
 entries=value;await assert.rejects(new Engine().extract([file('archive.rar')],undefined,undefined,undefined,'download'));assert.equal(tickets,0,'invalid extraction opened download ticket');
}
entries=[{name:'a',size:1,isDirectory:false,isLink:false},{name:'b',size:1,isDirectory:false,isLink:false},{name:'dir',size:0,isDirectory:true,isLink:false}];
for(const only of [['missing'],['dir']]){await assert.rejects(new Engine().extract([file('archive.rar')],undefined,undefined,undefined,'download',{only}));assert.equal(tickets,0,'invalid selection opened download ticket');}
assert.equal((await new Engine().extract([file('archive.rar')],undefined,undefined,undefined,'download',{only:['b']})).downloadSent,true);assert.equal(tickets,1);tickets=0;
entries=[{name:'nested/good.bin',size:3,isDirectory:false,isLink:false}];assert.equal((await new Engine().extract([file('archive.rar')],undefined,undefined,undefined,'download')).downloadSent,true);assert.equal(tickets,1);
const before=listed;assert.equal((await new Engine().extract([file('huge.zstd')],undefined,undefined,undefined,'download')).downloadSent,true);assert.equal(listed,before,'raw stream performed full decoding metadata pass');
assert.equal((await new Engine().create([file('good.bin')],{format:'zstd',delivery:'download'})).downloadSent,true);
for(const files of [[file('large.bin',8**11)],[file('x'.repeat(101))]])assert.equal((await new Engine().create(files,{format:'tar',delivery:'download'})).downloadSent,true,'PAX-capable TAR must not retain obsolete USTAR limits');
console.log('Download preflight passed: format/seek, safe-integer sizes and PAX paths, password, tree collisions, one regular safe member, old runtime fail-closed, raw stream single pass');
