import assert from 'node:assert/strict';
// Component state regression: mocked worker replies do not validate archive codecs.
const endpoint=process.argv[2],url=process.argv[3];
if(!endpoint||!url)throw Error('Provide CDP endpoint and app URL');
const target=await(await fetch(endpoint+'/json/new?about:blank',{method:'PUT'})).json();
let ws;
try{
 ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP connection timeout')),10000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});ws.addEventListener('error',reject,{once:true});});
 let id=0;const pending=new Map();ws.onmessage=({data})=>{const reply=JSON.parse(data);if(reply.id){pending.get(reply.id)?.(reply);pending.delete(reply.id);}};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout: '+method))},15000);pending.set(n,result=>{clearTimeout(timer);result.error?reject(Error(JSON.stringify(result.error))):resolve(result)});ws.send(JSON.stringify({id:n,method,params}));});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,replMode:true});if(r.result.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));return r.result.result.value;};
 const wait=async expression=>{for(let n=0;n<100;n++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw Error('UI timeout: '+expression);};
 await call('Page.enable');await call('Page.addScriptToEvaluateOnNewDocument',{source:`window.mockOps=[];window.Worker=class{postMessage(request){window.mockOps.push(request.op);const result=request.op==='repair'?{files:[{name:'input.rar',blob:new Blob(['repaired'])}],complete:true}: {files:[],entries:[{name:'a.txt',size:1,isDirectory:false},{name:'b.txt',size:1,isDirectory:false}]};setTimeout(()=>this.onmessage?.({data:result}),0);}terminate(){}};`});
 await call('Network.enable');await call('Network.setBypassServiceWorker',{bypass:true});await call('Page.navigate',{url});await wait(`!!document.querySelector('#run')`);
 await evaluate(`const dt=new DataTransfer();dt.items.add(new File(['archive'],'input.rar'));document.querySelector('#file-input').files=dt.files;document.querySelector('#file-input').dispatchEvent(new Event('change'));document.querySelector('#delivery').value='download';document.querySelector('#delivery').dispatchEvent(new Event('change'));document.querySelector('#run').click();`);
 await wait(`document.querySelector('#operation').hidden&&window.mockOps.includes('list')`);
 assert.equal(await evaluate(`document.querySelector('#run').disabled`),true,'Multi-file streamed extraction must stay blocked after unlock');
 await evaluate(`document.querySelector('#repair-recovery').click()`);await wait(`document.querySelector('#operation').hidden&&window.mockOps.includes('repair')`);
 assert.equal(await evaluate(`document.querySelector('#run').disabled`),false,'Repaired archive must be inspectable despite previous multi-file list');
 assert.match(await evaluate(`document.querySelector('#run').textContent`),/Open repaired archive/);
 await evaluate(`document.querySelector('#run').click()`);await wait(`document.querySelector('#operation').hidden&&window.mockOps.filter(x=>x==='list').length===2`);
 assert.equal(await evaluate(`document.querySelector('#run').disabled`),true,'Fresh repaired listing must enforce its own many-file restriction');
 console.log('PASS: multi-file stream blocked; repair clears stale listing and preserves Open repaired archive; fresh listing reapplies restriction.');
}finally{ws?.close();await fetch(endpoint+'/json/close/'+target.id);}
