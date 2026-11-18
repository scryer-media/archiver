export function offlineWorkerSource(cache, assets) {
 return String.raw`
const CACHE=${JSON.stringify(cache)}, ASSETS=${JSON.stringify(assets)};
const PREFIX='scryer-archive-', STATE='archive-offline-active-v1', STATE_KEY='/__offline_active__', COMPLETE='/__offline_complete__';
const STATIC=new Map(ASSETS.map(asset=>[asset.path,asset]));
const hashed=path=>/^\/assets\/[^/]+-[\w-]{8,}\.(?:js|css)$/.test(path)||/^\/engine\/(?:archive-engine-|archive_engine-)[a-f0-9]{20}\.(?:js|wasm)$/.test(path);
const CLOUDFLARE_SCRIPT=/<script>\(function\(\)\{function c\(\)\{[\s\S]*?__CF\$cv\$params[\s\S]*?<\/script>/g;
async function state(){try{return await(await(await caches.open(STATE)).match(STATE_KEY)).json()}catch{return {}}}
async function checked(asset){
 const path=asset.path==='/'?'/index.html':asset.path;
 const response=await fetch(new Request(new URL(path,self.location.origin),{cache:'reload',credentials:'same-origin'}));
 if(response.status!==200)throw new Error('Offline asset unavailable: '+asset.path);
 let bytes=await response.arrayBuffer();
 // Cloudflare's bot detection injects a per-request script into HTML. The CSP blocks it, and it
 // would never match the build hash, so it is removed before checking and caching.
 if((response.headers.get('Content-Type')||'').includes('text/html'))bytes=await new Response((await new Response(bytes).text()).replace(CLOUDFLARE_SCRIPT,'')).arrayBuffer();
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
 if(digest!==asset.sha256)throw new Error('Offline asset version mismatch: '+asset.path);
 // A new response also drops the redirect flag (Pages sends /index.html to /), which page loads reject.
 return new Response(bytes,{status:200,statusText:response.statusText,headers:response.headers});
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(CACHE),complete=await cache.match(COMPLETE);
 if(complete&&await complete.text()===CACHE)return;
 try{
  for(const asset of ASSETS)await cache.put(asset.path,await checked(asset));
  await cache.put(COMPLETE,new Response(CACHE));
 }catch(error){await caches.delete(CACHE);throw error;}
 // No automatic skipWaiting: the page asks for it once it has no work in progress.
})()));
self.addEventListener('message',event=>{if(event.data==='skip-waiting')self.skipWaiting();});
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 const keys=await caches.keys(),prior=await state(),others=keys.filter(key=>key.startsWith(PREFIX)&&key!==CACHE);
 // Legacy workers have no pointer: their activation kept the oldest surviving
 // active cache; later caches may belong to abandoned waiting installs.
 const previous=others.includes(prior.active)?prior.active:others.includes(prior.previous)?prior.previous:others[0];
 await(await caches.open(STATE)).put(STATE_KEY,new Response(JSON.stringify({active:CACHE,previous})));
 await Promise.all(others.filter(key=>key!==previous).map(key=>caches.delete(key)));
 // Retain one previous ACTIVE cohort for in-flight old HTML and lazy imports.
 // No clients.claim: updates never take over another active archive job.
})()));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  if(event.request.mode==='navigate')return await cache.match('/index.html',{ignoreVary:true})||await cache.match('/',{ignoreVary:true})||Response.error();
  const asset=STATIC.get(url.pathname);
  if(asset)return await cache.match(asset.path,{ignoreVary:true})||checked(asset);
  if(hashed(url.pathname)){
   const prior=await state();
   for(const name of [prior.active,prior.previous]){
    if(typeof name!=='string'||name===CACHE||!name.startsWith(PREFIX))continue;
    const response=await(await caches.open(name)).match(url.pathname,{ignoreVary:true});if(response)return response;
   }
   return new Response('This application version is unavailable',{status:404,headers:{'Content-Type':'text/plain','Cache-Control':'no-store'}});
  }
  return fetch(event.request);
 })());
});
`;
}
