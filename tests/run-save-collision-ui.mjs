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
 await call('Page.enable');await call('Page.addScriptToEvaluateOnNewDocument',{source:`window.mockResults={files:[]};window.Worker=class{postMessage(){setTimeout(()=>this.onmessage?.({data:window.mockResults}),0);}terminate(){}};`});
 await call('Network.enable');await call('Network.setBypassServiceWorker',{bypass:true});await call('Page.navigate',{url});await wait(`!!document.querySelector('#run')`);
 const cases=[
  {name:'NFC/NFD filenames',paths:['résumé.bin','re\u0301sume\u0301.bin']},
  {name:'case aliases',paths:['Case.bin','case.bin']},
  {name:'Greek sigma filesystem aliases',paths:['Σ.bin','ς.bin']},
  {name:'directory prefix aliases',paths:['Folder/a.bin','folder/b.bin']},
  {name:'file/directory aliases',paths:['Folder','folder/b.bin']},
  {name:'exact file ancestor',paths:['node','node/child.bin']},
  {name:'normal Unicode and empty folder',paths:['résumé/雪.bin'],dirs:['empty'],valid:true}
 ];
 for(const item of cases){
  await evaluate(`document.querySelector('[data-mode="create"]').click();const dt=new DataTransfer();dt.items.add(new File(['input'],'input.txt'));document.querySelector('#file-input').files=dt.files;document.querySelector('#file-input').dispatchEvent(new Event('change'));window.mockResults={files:${JSON.stringify(item.paths)}.map((name,index)=>({name,blob:new Blob(['payload-'+index])})),directories:${JSON.stringify(item.dirs||[])}};window.saveCounts={folderCreates:0,fileCreates:0,writerOpens:0,bytes:0};window.showDirectoryPicker=async()=>({getDirectoryHandle:async(name,options)=>{if(options?.create)window.saveCounts.folderCreates++;return await window.showDirectoryPicker();},getFileHandle:async(name,options)=>{if(!options?.create)throw new DOMException('Absent','NotFoundError');window.saveCounts.fileCreates++;return {createWritable:async()=>{window.saveCounts.writerOpens++;return new WritableStream({write(chunk){window.saveCounts.bytes+=chunk.byteLength}})}};}});document.querySelector('#run').click();`);
  await wait(`document.querySelector('#operation').hidden&&!document.querySelector('#save-all').hidden`);
  await evaluate(`document.querySelector('#save-all').click()`);
  await wait(`!document.querySelector('#save-all').disabled`);
  const actual=await evaluate(`({counts:window.saveCounts,notice:document.querySelector('#notice').textContent,error:document.querySelector('#notice').classList.contains('error')})`);
  if(item.valid){assert.equal(actual.counts.writerOpens,1);assert.equal(actual.counts.bytes,9);assert.match(actual.notice,/All files saved/);}
  else{assert.deepEqual(actual.counts,{folderCreates:0,fileCreates:0,writerOpens:0,bytes:0},item.name+' must reject before filesystem mutation');assert.doesNotMatch(actual.notice,/All files saved/);assert.match(actual.notice,/alias|collision|Duplicate/i);}
 }
 console.log('PASS: '+cases.length+' Save all component cases; NFC/NFD, case, Greek sigma and file/directory aliases reject with zero filesystem mutations; normal Unicode plus empty folder saves.');
}finally{ws?.close();await fetch(endpoint+'/json/close/'+target.id);}
