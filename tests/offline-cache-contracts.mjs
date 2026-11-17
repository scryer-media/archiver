import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
import {offlineWorkerSource} from '../scripts/offline-worker.mjs';
const origin='https://offline.test',url=path=>new URL(typeof path==='string'?path:path.url,origin).href;
class Cache {
 entries=new Map();lastMatch;
 async put(request,response){const input=typeof request==='string'?new Request(url(request)):request;this.entries.set(input.url,{request:input,response:response.clone()});}
 async match(request,options={}){this.lastMatch=options;const input=typeof request==='string'?new Request(url(request)):request,entry=this.entries.get(input.url);if(!entry)return;
  if(!options.ignoreVary)for(const name of (entry.response.headers.get('vary')||'').split(',').map(name=>name.trim()).filter(Boolean))if(input.headers.get(name)!==entry.request.headers.get(name))return;
  return entry.response.clone();
 }
}
const stores=new Map(),caches={async open(name){if(!stores.has(name))stores.set(name,new Cache());return stores.get(name)},async keys(){return [...stores.keys()]},async delete(name){return stores.delete(name)}};
let network=new Map(),calls=[],offline=false,staleIndex;
async function fetchAsset(request){if(offline)throw Error('Network offline');calls.push({path:new URL(request.url).pathname,cache:request.cache});const path=new URL(request.url).pathname;
 const data=path==='/index.html'&&staleIndex&&request.cache!=='reload'?staleIndex:network.get(path);
 return new Response(data??'<html>SPA fallback</html>',{status:200,headers:{'Content-Type':path.endsWith('.js')?'text/javascript':'text/html','Vary':'Origin'}});
}
const hex=bytes=>createHash('sha256').update(bytes).digest('hex');
function cohort(letter){const path='/assets/index-'+letter.repeat(8)+'.js',body='window.cohort='+JSON.stringify(letter),html='<script type="module" crossorigin src="'+path+'"></script>';
 const bodies=new Map([['/index.html',html],[path,body],['/download-sw.js','download-'+letter]]),assets=[{path:'/',sha256:hex(html)},...[...bodies].map(([path,body])=>({path,sha256:hex(body)}))];return {name:'scryer-archive-'+letter,path,body,html,bodies,assets};}
function worker(cohort){const handlers={};vm.runInNewContext(offlineWorkerSource(cohort.name,cohort.assets),{self:{location:{origin},addEventListener:(name,fn)=>handlers[name]=fn},caches,fetch:fetchAsset,Request,Response,URL,crypto:webcrypto,Uint8Array,Array,Map,Promise,Error,JSON});
 const event=async name=>{let pending;handlers[name]({waitUntil:promise=>pending=promise});await pending;};return {install:()=>event('install'),activate:()=>event('activate'),async request(path,mode){let response;const request=new Request(url(path),{headers:{Origin:origin}});handlers.fetch({request:{...request,url:request.url,method:'GET',headers:request.headers,mode:mode||'cors'},respondWith:promise=>response=promise});return response;}};}
const A=cohort('A'),a=worker(A);network=A.bodies;await a.install();await a.activate();
const cachedA=await caches.open(A.name);assert.equal(await cachedA.match(new Request(url(A.path),{headers:{Origin:origin}})),undefined,'Original default match must reproduce the Origin variant miss');
assert.equal(await(await a.request(A.path)).text(),A.body);assert.equal(cachedA.lastMatch.ignoreVary,true);
const oldHtml=await a.request('/','navigate');assert.equal(await oldHtml.text(),A.html);
const Waiting=cohort('W'),waiting=worker(Waiting);network=Waiting.bodies;await waiting.install();
const B=cohort('B'),b=worker(B);network=B.bodies;staleIndex=A.html;await b.install();assert.ok(calls.every(item=>item.cache==='reload'),'Install must bypass stale HTTP cache');await b.activate();
assert.deepEqual((await caches.keys()).filter(key=>key.startsWith('scryer-archive-')),[A.name,B.name],'Keep previous ACTIVE cohort, not newer obsolete waiting cohort');
const before=calls.length;assert.equal(await(await b.request(A.path)).text(),A.body,'Old HTML hash must survive activation');assert.equal(calls.length,before,'Old content-hashed asset must not hit SPA fallback');
assert.equal(await(await b.request('/','navigate')).text(),B.html);
await(await caches.open(A.name)).put('/private-old.txt',new Response('old private response'));assert.notEqual(await(await b.request('/private-old.txt')).text(),'old private response','Do not cross-cache unversioned responses');
offline=true;assert.equal(await(await b.request('/','navigate')).text(),B.html);assert.equal(await(await b.request(B.path)).text(),B.body);assert.equal(await(await b.request(A.path)).text(),A.body);offline=false;
const C=cohort('C'),c=worker(C);network=C.bodies;await c.install();await c.activate();assert.deepEqual((await caches.keys()).filter(key=>key.startsWith('scryer-archive-')),[B.name,C.name]);assert.equal((await c.request(A.path)).status,404,'Expired hashes must never receive SPA HTML');
const D=cohort('D'),d=worker(D);network=new Map(D.bodies);network.set('/index.html',B.html);await assert.rejects(d.install(),/version mismatch/);assert.equal(stores.has(D.name),false,'Failed partial install must be removed');assert.equal(await(await c.request('/','navigate')).text(),C.html,'Failed install preserves active cohort');assert.equal(await(await c.request(B.path)).text(),B.body,'Failed install preserves previous cohort');
// Rolling back to an existing validated cohort reuses it without network writes.
network=B.bodies;const rolledBack=worker(B),networkBefore=calls.length;await rolledBack.install();assert.equal(calls.length,networkBefore);await rolledBack.activate();
const E=cohort('E'),e=worker(E);network=E.bodies;await e.install();await e.activate();assert.deepEqual((await caches.keys()).filter(key=>key.startsWith('scryer-archive-')),[B.name,E.name],'Track actual active predecessor across rollback');
stores.clear();network=A.bodies;await a.install();await a.activate();await caches.delete("archive-offline-active-v1");network=Waiting.bodies;await waiting.install();network=B.bodies;await b.install();await b.activate();assert.deepEqual((await caches.keys()).filter(key=>key.startsWith("scryer-archive-")),[A.name,B.name],"Legacy bootstrap retains oldest active cache, not abandoned waiting cache");
console.log('Offline cache contracts passed: Origin Vary, reload/integrity, atomic failed install, old HTML hash across activation, previous active selection, offline hits and bounded two-cohort rollback');
