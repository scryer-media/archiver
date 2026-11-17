// This worker owns only its download route; it never claims the application.
const pending=new Map(), active=new Map();
self.addEventListener('message',event=>{
  if(!event.source||new URL(event.source.url).origin!==self.location.origin)return;
  const data=event.data,port=event.ports[0];
  if(data?.cancel){
    const job=pending.get(data.cancel)||active.get(data.cancel);
    if(job?.owner===event.source.id){job.cancel(new Error('Download cancelled'));pending.delete(data.cancel);active.delete(data.cancel);}
    return;
  }
  if(!/^[a-f0-9-]{36}$/.test(data?.token)||!(data.stream instanceof ReadableStream)||pending.has(data.token)||active.has(data.token)||pending.size+active.size>=16){port?.postMessage({error:'Invalid download registration'});return;}
  const name=String(data.name).split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g,'').slice(0,240)||'download.bin';
  const reader=data.stream.getReader();let controller,settle;
  // Only the bounded registration handoff extends this message event.
  // Chromium keeps a streaming Response alive separately; waiting for body EOF
  // here would hit its five-minute ExtendableEvent execution limit.
  const handoff=new Promise(resolve=>settle=resolve);
  const job={port,settle,owner:event.source.id,reader,name,size:Number.isSafeInteger(data.size)&&data.size>=0?data.size:undefined,cancel(reason){settle();clearTimeout(job.timer);controller?.error(reason);void reader.cancel(reason).catch(()=>{});}};
  job.timer=setTimeout(()=>{pending.delete(data.token);job.cancel(new Error('Download was not started'));},60000);
  job.body=new ReadableStream({start(value){controller=value;},async pull(value){try{const chunk=await reader.read();if(chunk.done){active.delete(data.token);settle();value.close();}else value.enqueue(chunk.value);}catch(error){active.delete(data.token);settle();value.error(error);}},cancel(reason){active.delete(data.token);job.cancel(reason);}},{highWaterMark:0});
  event.waitUntil(handoff);
  pending.set(data.token,job);port?.postMessage({ready:true});
});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(url.origin!==self.location.origin||!url.pathname.startsWith('/__download/'))return;
  const token=url.pathname.slice('/__download/'.length),job=pending.get(token);
  if(event.request.method!=='GET'||!job){event.respondWith(new Response('Download unavailable',{status:404,headers:{'Cache-Control':'no-store'}}));return;}
  pending.delete(token);clearTimeout(job.timer);job.settle();active.set(token,job);job.port?.postMessage({started:true});job.port?.close();
  const headers={'Content-Type':'application/octet-stream','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(new TextDecoder().decode(new TextEncoder().encode(job.name))).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase()),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  if(job.size!==undefined)headers['Content-Length']=String(job.size);
  // The response body owns its browser streaming lifetime, not waitUntil.
  event.respondWith(new Response(job.body,{headers}));
});
