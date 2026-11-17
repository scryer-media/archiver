import * as outputBudget from '../engine/output-budget.ts';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {creationPlans} from '../engine/create-plan.ts';
let created=0,tickets=0,verified=0,repaired=0,listed=0;
class Native {async create(){created++;return{files:[]}}async verify(){verified++;return{files:[],complete:true}}async repair(){repaired++;return{files:[],complete:true}}async list(){listed++;return{files:[],entries:[]}}}
const exports={};const context={exports,File,Blob,Uint8Array,TextDecoder,TextEncoder,Map,Set,Error,Promise,console,require:name=>name.includes('output-budget')?outputBudget:name.includes('create-plan')?{creationPlans}:name.includes('native-stream')?{chooseNativeStream:()=>false}:name.includes('download')?{createDownload:async()=>{tickets++;throw Error('Unexpected download')}}:name.includes('client')?{ArchiveEngine:Native}:{}};
vm.runInNewContext(ts.transpileModule((await readFile(new URL('../src/tool-engine.ts',import.meta.url),'utf8')).replaceAll('import.meta.url',JSON.stringify('https://local.test/tool-engine.ts')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
for(const delivery of [undefined,'download'])for(const options of [{format:'par3'},{format:'7z',protection:'par3'},{format:'7z',protection:'par3-embedded'}])await assert.rejects(new exports.ArchiveEngine().create([],{...options,delivery}),/PAR3 creation is not available/);
assert.equal(created,0);assert.equal(tickets,0);
const file=new File(['existing set'],'recovery.par3');const engine=new exports.ArchiveEngine();await engine.verify([file]);await engine.repair([file]);await engine.list([file]);assert.deepEqual([verified,repaired,listed],[1,1,1]);
console.log('Creation policy passed: PAR3 creation and protection rejected before native/download work; existing-set list, verify and repair routing preserved');
