let installed:Promise<ServiceWorker>|undefined;
async function downloadWorker():Promise<ServiceWorker>{
  if(installed){const previous=await installed;if(previous.state==='activated')return previous;installed=undefined;}
  installed??=(async()=>{
  const registration = await navigator.serviceWorker.register('/download-sw.js', { scope: '/__download/' });
  return registration.active ?? await new Promise<ServiceWorker>((resolve, reject) => {
    const candidate=registration.installing??registration.waiting;
    if(candidate?.state==='activated'){resolve(candidate);return;}
    if(!candidate){reject(new Error('Download worker is unavailable'));return;}
    const timer=setTimeout(()=>reject(new Error('Download worker did not activate')),30000);
    candidate.addEventListener('statechange',()=>{if(candidate.state==='activated'){clearTimeout(timer);resolve(candidate);}else if(candidate.state==='redundant'){clearTimeout(timer);reject(new Error('Download worker installation failed'));}});
  });
  })().catch(error=>{installed=undefined;throw error;});
  return installed;
}
export async function streamDownloadCapability():Promise<{available:boolean;reason?:string}>{
  if(typeof window==='undefined'||!isSecureContext||!('serviceWorker' in navigator)||typeof TransformStream==='undefined')return {available:false,reason:'Streamed downloads require service workers in a secure context'};
  const channel=new MessageChannel();
  try{const stream=new TransformStream();channel.port1.postMessage(stream.readable,[stream.readable]);await downloadWorker();return {available:true};}
  catch(error){return {available:false,reason:'Download worker unavailable; connect once to install it. '+String(error)};}
  finally{channel.port1.close();channel.port2.close();}
}
export interface DownloadJob { writable: WritableStream<Uint8Array>; name: string; cancel(reason?: string): void; release(): void }
export async function createDownload(name: string, size?: number): Promise<DownloadJob> {
  const capability=await streamDownloadCapability();if(!capability.available)throw new Error(capability.reason);
  name=name.split(/[\\/]/).pop()?.replace(/[\x00-\x1f\x7f]/g,'').slice(0,240)||'download.bin';
  const worker=await downloadWorker();
  const token=crypto.randomUUID(), stream=new TransformStream<Uint8Array,Uint8Array>(undefined,{highWaterMark:1,size:chunk=>chunk.byteLength},{highWaterMark:0});
  const channel=new MessageChannel();
  const frame=document.createElement('iframe');frame.hidden=true;
  const cancel=(reason='Download cancelled')=>{worker.postMessage({cancel:token,reason});frame.remove();};
  const unload=()=>cancel('The producing page closed');
  try {
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Download worker did not register the stream')),30000);
      channel.port1.onmessage=({data})=>{clearTimeout(timer);data.error?reject(new Error(data.error)):resolve();};
      try{worker.postMessage({token,name,size,stream:stream.readable},[stream.readable,channel.port2]);}catch(error){clearTimeout(timer);reject(error);}
    });
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Browser did not start the download')),30000);
      channel.port1.onmessage=({data})=>{if(data.started||data.error){clearTimeout(timer);data.error?reject(new Error(data.error)):resolve();}};
      frame.src='/__download/'+token;document.body.append(frame);
    });
    addEventListener('pagehide',unload,{once:true});
    return {writable:stream.writable,name,cancel,release(){removeEventListener('pagehide',unload);frame.remove();}};
  } catch(error){cancel();throw error;} finally {channel.port1.close();}
}
