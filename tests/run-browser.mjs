const endpoint=process.argv[2]||"http://127.0.0.1:9223";
const url=process.argv[3]||"http://127.0.0.1:4173/tests/browser.html";
const target=await(await fetch(endpoint+"/json/new?"+encodeURIComponent(url),{method:"PUT"})).json();
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve=>ws.addEventListener("open",resolve,{once:true}));
let id=0;const pending=new Map();
ws.addEventListener("message",event=>{const data=JSON.parse(event.data);if(data.id){pending.get(data.id)?.(data);pending.delete(data.id);}});
const call=(method,params={})=>new Promise(resolve=>{pending.set(++id,resolve);ws.send(JSON.stringify({id,method,params}));});
let result;
try{for(let i=0;i<120;i++){await new Promise(resolve=>setTimeout(resolve,500));const response=await call("Runtime.evaluate",{expression:"document.querySelector(\"#results\")?.textContent",returnByValue:true});try{const value=JSON.parse(response.result?.result?.value);if(value.done){result=value;break;}}catch{}}
if(!result)throw Error("Browser worker suite timed out");console.log(JSON.stringify(result,null,2));process.exitCode=result.passed===result.total?0:1;
if(result&&process.env.VERIFY_EXPORT_DIR){const {mkdir,writeFile}=await import("node:fs/promises");const {join,basename}=await import("node:path");await mkdir(process.env.VERIFY_EXPORT_DIR,{recursive:true});const exported=await call("Runtime.evaluate",{expression:"Promise.all((window.verificationArtifacts||[]).map(async f=>({name:f.name,bytes:Array.from(new Uint8Array(await f.blob.arrayBuffer()))})))",awaitPromise:true,returnByValue:true});if(exported.result?.exceptionDetails)throw Error("Artifact export failed: "+exported.result.result.description);for(const item of exported.result?.result?.value||[])await writeFile(join(process.env.VERIFY_EXPORT_DIR,basename(item.name)),new Uint8Array(item.bytes));}
}finally{try{const cleanup=await call("Runtime.evaluate",{expression:"window.verificationDispose?.()",awaitPromise:true,returnByValue:true});if(cleanup.result?.result?.value===false){console.error("Verification storage cleanup failed");process.exitCode=1;}}finally{ws.close();await fetch(endpoint+"/json/close/"+target.id);}}
