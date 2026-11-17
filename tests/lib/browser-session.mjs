// Bounded CDP sessions for repository browser harnesses; only created targets are closed.
export async function openBrowserSession(endpoint,url){
 const response=await fetch(endpoint+'/json/new?about:blank',{method:'PUT',signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Browser target creation failed');const target=await response.json();let socket;
 const close=async()=>{socket?.close();await fetch(endpoint+'/json/close/'+target.id,{signal:AbortSignal.timeout(15000)});};
 try{
  socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Browser connection timeout')),30000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Browser connection failed'))},{once:true});});
  let sequence=0;const pending=new Map(),events=[];
  const disconnected=()=>{for(const finish of [...pending.values()])finish({error:{message:'Browser connection closed'}})};socket.addEventListener('close',disconnected);socket.addEventListener('error',disconnected);
  socket.onmessage=({data})=>{const message=JSON.parse(data);if(message.id){pending.get(message.id)?.(message);pending.delete(message.id)}else{events.push(message);if(events.length>2000)events.shift();}};
  const call=(method,params={},timeout=30000)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Bounded browser RPC timeout: '+method))},timeout);const finish=message=>{clearTimeout(timer);pending.delete(id);message.error?reject(Error(JSON.stringify(message.error))):resolve(message)};pending.set(id,finish);if(socket.readyState!==WebSocket.OPEN){finish({error:{message:'Browser is disconnected'}});return;}try{socket.send(JSON.stringify({id,method,params}))}catch(error){finish({error:{message:String(error)}})}});
  const evaluate=async(expression,timeout=240000)=>{const message=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},timeout);if(message.result.exceptionDetails)throw Error(JSON.stringify(message.result.exceptionDetails));return message.result.result.value;};
  const wait=async(expression,timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(expression,Math.min(timeout,30000)))return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Browser state timeout: '+expression);};
  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');await call('Page.navigate',{url});await wait('!!document.querySelector("#run")');
  return{target,events,call,evaluate,wait,close};
 }catch(error){await close();throw error;}
}
