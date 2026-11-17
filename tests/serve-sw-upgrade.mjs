import http from 'node:http';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {offlineWorkerSource} from '../scripts/offline-worker.mjs';
const port=Number(process.argv[2]||4196),root=process.argv[3];
if(!root||!root.startsWith('/private/tmp/archive-5gb-test/qa/'))throw Error('Provide authorized tiny QA fixture directory');
await mkdir(root,{recursive:true});
const sha=body=>createHash('sha256').update(body).digest('hex'),versions=new Map(),requests=[];
for(const name of ['A','BAD','B','C']){
 const tag=name==='BAD'?'dddddddd':name.toLowerCase().repeat(8),jsPath='/assets/entry-'+tag+'.js',cssPath='/assets/style-'+tag+'.css';
 const js=`window.generation=${JSON.stringify(name)};export const generation=${JSON.stringify(name)};`,css=`body{--generation:${name}}`;
 const html=`<!doctype html><html><head><link rel="stylesheet" href="${cssPath}"><script type="module" src="${jsPath}"></script></head><body><p id="fixture">Generation ${name}</p><script>navigator.serviceWorker.register('/sw.js')</script></body></html>`;
 const assets=[{path:'/',sha256:sha(html)},{path:'/index.html',sha256:sha(html)},{path:jsPath,sha256:sha(js)},{path:cssPath,sha256:sha(css)}];
 const files=new Map([['/',html],['/index.html',html],[jsPath,js],[cssPath,css]]),worker=offlineWorkerSource('scryer-archive-qa-'+name,assets);
 versions.set(name,{name,html,jsPath,cssPath,files,worker});await mkdir(join(root,name),{recursive:true});await writeFile(join(root,name,'index.html'),html);await writeFile(join(root,name,'sw.js'),worker);
}
let current='A';
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1:'+port);if(url.pathname==='/__qa/control'&&req.method==='POST'){
  let body='';for await(const chunk of req){body+=chunk;if(body.length>1024){res.writeHead(413);res.end();return;}}const next=JSON.parse(body).generation;if(!versions.has(next)){res.writeHead(400);res.end();return;}current=next;res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({generation:current}));return;
 }
 if(url.pathname==='/__qa/state'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({current,requests}));return;}
 const version=versions.get(current);requests.push({generation:current,path:url.pathname,origin:req.headers.origin||null,cacheControl:req.headers['cache-control']||null});if(requests.length>500)requests.shift();
 const headers={'Vary':'Origin','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cache-Control':'public,max-age=3600'};if(req.headers.origin)headers['Access-Control-Allow-Origin']=req.headers.origin;
 if(url.pathname==='/sw.js'){res.writeHead(200,{...headers,'Content-Type':'text/javascript','Cache-Control':'no-store'});res.end(version.worker);return;}
 const body=version.files.get(url.pathname);if(body!==undefined){const type=url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'text/html';res.writeHead(200,{...headers,'Content-Type':type});res.end(current==='BAD'&&url.pathname===version.jsPath?body+'/* unexpected bytes */':body);return;}
 // Deliberately model an SPA host removing old hashes: the worker must not use this HTML as JavaScript.
 res.writeHead(200,{...headers,'Content-Type':'text/html'});res.end(version.html);
});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({ready:true,port,fixtureRoot:root,generations:[...versions.keys()]})));
