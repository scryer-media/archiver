import {ZipWriter,BlobWriter,TextReader,configure} from '@zip.js/zip.js';
import assert from 'node:assert/strict';
import {runFallbackWorker} from './lib/zip-worker-harness.mjs';
configure({useWebWorkers:false});
let pass=0;
async function bad(id,file,options={}){for(const op of ['list','extract']){const result=await runFallbackWorker(file,op,options);assert.ok(result.result.error,id);assert.equal(result.bytes,0,id);assert.equal(result.closed,false,id);}pass++;}
const opt={extraction:{links:'copy-safe'}};
async function zipLink(target,{directory=false,special=false}={}){const writer=new ZipWriter(new BlobWriter());await writer.add('copy',new TextReader(target),{unixMode:0o120777,compressionMethod:0});await writer.add(directory?'payload/':'payload',directory?undefined:new TextReader('abc'),{directory,unixMode:special?0o020644:undefined});return new File([await writer.close()],'links.zip');}
for(const target of ['/payload','C:/payload','//server/share','\\payload','../payload','payload\0hidden','payload:stream','missing','a'.repeat(16385)])await bad('zip-target-'+target.slice(0,30),await zipLink(target),opt);
await bad('zip-directory-target',await zipLink('payload',{directory:true}),opt);
await bad('zip-special-target',await zipLink('payload',{special:true}),opt);
const validZip=await zipLink('payload');await bad('zip-default-links',validZip);
const zipOutput=await runFallbackWorker(validZip,'extract',{...opt,captureDownload:false});assert.ok(!zipOutput.result.error);assert.equal(zipOutput.result.files.length,2);for(const file of zipOutput.result.files)assert.equal(await file.blob.text(),'abc');pass++;
const corrupt=new Uint8Array(await validZip.arrayBuffer());const payloadAt=30+new DataView(corrupt.buffer).getUint16(26,true)+new DataView(corrupt.buffer).getUint16(28,true);corrupt[payloadAt]^=1;await bad('zip-corrupt-link-CRC',new File([corrupt],'corrupt.zip'),opt);
const bombWriter=new ZipWriter(new BlobWriter());for(let i=0;i<257;i++)await bombWriter.add('link-'+i,new TextReader('x'.repeat(16384)),{unixMode:0o120777});const bomb=new File([await bombWriter.close()],'link-budget.zip');const bombResult=await runFallbackWorker(bomb,'list',opt);assert.match(bombResult.result.error,/aggregate link target budget/);pass++;

async function regularZip(nested=false){const writer=new ZipWriter(new BlobWriter());if(nested)await writer.add('folder/',undefined,{directory:true});await writer.add(nested?'folder/payload':'payload',new TextReader('abc'));return new File([await writer.close()],'regular.zip');}
let existingWrites=0,existingCreates=0;const existingDirectory={async getFileHandle(_name,options){if(options?.create)existingCreates++;return{async createWritable(){existingWrites++;return new WritableStream();}};}};
const existingResult=await runFallbackWorker(await regularZip(),'extract',{captureDownload:false,outputDirectory:existingDirectory});assert.match(existingResult.result.error,/already contains/);assert.equal(existingWrites,0);assert.equal(existingCreates,0);pass++;
let existingDirectoryCreates=0;const directoryAlias={async getDirectoryHandle(_name,options){if(options?.create)existingDirectoryCreates++;return directoryAlias;},async getFileHandle(){throw Error('Must not access members of unexpected existing directory');}};
const dirAliasResult=await runFallbackWorker(await regularZip(true),'extract',{captureDownload:false,outputDirectory:directoryAlias});assert.match(dirAliasResult.result.error,/Unexpected existing destination directory/);assert.equal(existingDirectoryCreates,0);pass++;
console.log(JSON.stringify({pass,fail:0,scope:'Actual ZIP worker safe-link/security and shared destination refusal regressions'}));
