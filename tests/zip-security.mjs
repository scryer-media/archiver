import {runFallbackWorker as worker} from './lib/zip-worker-harness.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
const fixtureRoot=process.argv[2]||'/private/tmp/archive-zip-migration/security',reportPath=process.argv[3];
const manifest=JSON.parse(await readFile(join(fixtureRoot,'manifest.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={scope:'Actual application fallback worker with real zip.js, Node Web Streams and monitored output; browser integration is separate',cases:[]};
for(const spec of manifest.cases){const item={id:spec.id,status:'FAIL'};report.cases.push(item);try{
 const bytes=await readFile(join(fixtureRoot,spec.archive));assert.equal(bytes.length,spec.bytes);assert.equal(hash(bytes),spec.sha256);const file=new File([bytes],spec.archive);
 const listed=await worker(file,'list');item.listRejected=!!listed.result.error;
 const extracted=await worker(file,'extract');item.outputBytes=extracted.bytes;item.closed=extracted.closed;item.aborted=extracted.aborted;
 if(spec.expectation==='accept'){assert.equal(listed.result.error,undefined);assert.equal(extracted.result.error,undefined);assert.equal(extracted.closed,true);const output=new Uint8Array(await new Blob(extracted.chunks).arrayBuffer());assert.equal(output.length,manifest.payload.bytes);assert.equal(hash(output),manifest.payload.sha256);item.allPayloadBytesAndHash=true;}
 else{assert.ok(extracted.result.error,'Unsafe/corrupt fixture was accepted');assert.match(extracted.result.error,/unsafe filename|ambiguous|archive|zip|path|link|special|duplicate|invalid|size|signature|CRC|checksum|overlap|directory|entry|format|metadata|precision/i);assert.doesNotMatch(extracted.result.error,/worker failed|cannot read|not a function|fetch failed|module|ReferenceError|Unsupported TAR or GZIP/i);item.rejection=extracted.result.error;if(spec.id!=='body-corruption'){assert.equal(listed.result.error!==undefined,true,'Metadata preflight did not reject fixture');assert.equal(extracted.bytes,0,'Rejected header/path fixture wrote output');assert.equal(extracted.closed,false);}}
 item.status='PASS';}catch(error){item.error=String(error);}if(reportPath){await mkdir(dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2));}}
report.pass=report.cases.filter(item=>item.status==='PASS').length;report.fail=report.cases.length-report.pass;console.log(JSON.stringify(report,null,2));if(report.fail)process.exitCode=1;
