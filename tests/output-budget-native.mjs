import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import createModule from '../public/engine/archive-engine.js';
import {WriteBudget,installWriteBudget} from '../engine/output-budget.ts';
// Requires the repository's built public native runtime; no filesystem outputs.
const module=await createModule({wasmBinary:await readFile(new URL('../public/engine/archive_engine.wasm',import.meta.url)),print:()=>{},printErr:()=>{}});
module.FS.mkdir('/out');
const budget=new WriteBudget(4);installWriteBudget(module,budget);
const stream=module.FS.open('/out/test','w+');
try{
 module.FS.ftruncate(stream.fd,4);assert.equal(budget.used,4);assert.equal(module.FS.stat('/out/test').size,4);
 assert.throws(()=>module.FS.ftruncate(stream.fd,5),/Write budget/);assert.equal(module.FS.stat('/out/test').size,4);
 assert.throws(()=>module.FS.mmap(stream,4,0,3,1),/Writable output/);
}finally{module.FS.close(stream);}
console.log('PASS: actual Emscripten descriptor truncate charges once, refuses before mutation, and denies writable output mmap');
