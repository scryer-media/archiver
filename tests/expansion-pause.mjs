import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {WriteBudget,answerExpansion,expansionCheckpoint,EXPANSION_FLOOR,EXPANSION_RATIO,EXPANSION_STEP,EXPANSION_STOPPED} from '../engine/output-budget.ts';
// A job whose output grows past its question point pauses inside the worker until the page answers:
// keep going moves the next question EXPANSION_STEP times further out, stop fails the write.
assert.equal(expansionCheckpoint(1024),EXPANSION_FLOOR,'small inputs get the floor');
assert.equal(expansionCheckpoint(EXPANSION_FLOOR),EXPANSION_FLOOR*EXPANSION_RATIO,'large inputs get the ratio');
const source=`
import {parentPort,workerData} from 'node:worker_threads';
globalThis.self={postMessage:message=>parentPort.postMessage(message)};
const {WriteBudget,ExpansionGate}=await import(workerData.module);
const budget=new WriteBudget(1e9,true);budget.gate=new ExpansionGate(workerData.channel);
const written=[];
try{for(const bytes of [60,60,1000,5000])budget.charge(bytes),written.push(budget.used);parentPort.postMessage({done:written});}
catch(error){parentPort.postMessage({done:written,error:error.message,stopped:!!budget.gate.stopped});}
`;
const budget=new WriteBudget(1e9);budget.checkpoint=100;
const answers=[true,false],asked=[];budget.ask=async written=>{asked.push(written);return answers.shift();};
const channel={shared:new SharedArrayBuffer(16),allowance:100};
const worker=new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`),{workerData:{module:new URL('../engine/output-budget.ts',import.meta.url).href,channel}});
const result=await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error('worker did not finish')),20_000);
 worker.on('message',message=>{if(message.expansion)void answerExpansion(budget,channel,message.expansion.written,()=>true);else{clearTimeout(timer);resolve(message);}});
 worker.on('error',reject);
});
await worker.terminate();
// 60 fits; 120 passes 100 and asks (keep going → next question at 120×STEP); 1120 fits; 6120 asks again and stops.
assert.deepEqual(asked,[120,6120]);
assert.equal(budget.checkpoint,120*EXPANSION_STEP);
assert.deepEqual(result.done,[60,120,1120]);
assert.equal(result.error,EXPANSION_STOPPED);assert.equal(result.stopped,true);
console.log(JSON.stringify({status:'PASS',scope:'worker pauses past the expansion checkpoint; keep going raises it, stop fails the write'}));
