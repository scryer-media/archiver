import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {productionHeaders} from '../scripts/production-headers.mjs';
const headers=productionHeaders(),csp=headers['Content-Security-Policy'];
const directives=new Map(csp.split(';').map(value=>value.trim().split(/\s+/)).map(([name,...values])=>[name,values]));
assert.deepEqual(directives.get('default-src'),["'none'"]);
assert.deepEqual(directives.get('script-src'),["'self'","'wasm-unsafe-eval'"]);
for(const name of ['worker-src','connect-src','style-src','img-src','manifest-src','frame-src'])assert.deepEqual(directives.get(name),["'self'"]);
for(const name of ['object-src','base-uri','form-action','frame-ancestors'])assert.deepEqual(directives.get(name),["'none'"]);
assert.doesNotMatch(csp,/'unsafe-eval'|'unsafe-inline'|https?:|data:|blob:/);
assert.equal(headers['Cross-Origin-Opener-Policy'],'same-origin');assert.equal(headers['Cross-Origin-Embedder-Policy'],'require-corp');
const config=await readFile(new URL('../vite.config.ts',import.meta.url),'utf8');assert.match(config,/preview:\s*\{ headers: productionHeaders\(\)/);assert.doesNotMatch(config,/server:\s*\{[^\n]*productionHeaders/);
const temporary=await mkdtemp('/private/tmp/archive-csp-build-');
try{
 const caches=[];
 for(const [index,policy]of [csp,csp+'; upgrade-insecure-requests'].entries()){
  const directory='dist-'+index,path=temporary+'/'+directory;await mkdir(path+'/engine',{recursive:true});
  await writeFile(path+'/index.html','<!doctype html><p>Small build fixture</p>');await writeFile(path+'/_headers','/*\n  Content-Security-Policy: '+policy+'\n');
  await writeFile(path+'/engine/archive-engine.js','export default ()=>{};');await writeFile(path+'/engine/archive_engine.wasm',new Uint8Array([0,97,115,109,1,0,0,0]));
  execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/build-offline.mjs',import.meta.url)),directory],{cwd:temporary,timeout:10000});
  const worker=await readFile(path+'/sw.js','utf8');assert.doesNotMatch(worker,/"path":"\/_headers"/);caches.push(worker.match(/const CACHE="([^"]+)"/)[1]);
 }
 assert.notEqual(caches[0],caches[1],'Header-only policy updates must change the offline cohort');
}finally{await rm(temporary,{recursive:true});}
if(process.argv[2]){
 const base=new URL(process.argv[2]);const html=await fetch(base);assert.equal(html.headers.get('content-security-policy'),csp);const text=await html.text();const entry=text.match(/src="([^"]+\.js)"/)[1];
 for(const path of [entry,'/sw.js','/download-sw.js']){const response=await fetch(new URL(path,base));assert.equal(response.status,200);for(const [name,value]of Object.entries(headers))assert.equal(response.headers.get(name),value,path+' '+name);}
 console.log('PASS: production HTML, module and both service-worker HTTP response headers');
}
console.log('PASS: same-origin CSP contract; WASM-only compilation allowance; development HMR unchanged');
