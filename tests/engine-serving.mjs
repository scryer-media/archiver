import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {brotliCompressSync,brotliDecompressSync} from 'node:zlib';
import {createHandler,acceptsBrotli} from '../worker/serve.mjs';
import {productionHeaders} from '../scripts/production-headers.mjs';
const policy=productionHeaders(),handler=createHandler(await readFile(new URL('../public/_headers',import.meta.url),'utf8'));
const wasm=new Uint8Array([0,97,115,109,1,0,0,0]),name='/engine/archive_engine-0123456789abcdef0123.wasm';
const files=new Map([[name,wasm],[name+'.br',brotliCompressSync(wasm)],['/index.html',new TextEncoder().encode('<p>app</p>')]]);
const requested=[];
const env={ASSETS:{async fetch(input){const path=new URL(input instanceof Request?input.url:input).pathname;requested.push(path);const body=files.get(path);return body?new Response(body,{status:200,headers:{'Content-Type':'application/octet-stream'}}):new Response('missing',{status:404});}}};
const get=(path,encoding,method='GET')=>handler.fetch(new Request('https://archiver.test'+path,{method,headers:encoding===undefined?{}:{'Accept-Encoding':encoding}}),env);
for(const [header,expected] of [['gzip, deflate, br, zstd',true],['br;q=0, gzip',false],['BR;q=0.5',true],['gzip',false],[undefined,false]])assert.equal(acceptsBrotli(header),expected,String(header));
// Brotli copy, with the full policy and a year of caching for the hashed name.
let response=await get(name,'gzip, br');
assert.equal(response.headers.get('Content-Encoding'),'br');assert.equal(response.headers.get('Content-Type'),'application/wasm');
assert.equal(response.headers.get('Cache-Control'),'public, max-age=31536000, immutable');assert.equal(response.headers.get('Vary'),'Accept-Encoding');
for(const [header,value] of Object.entries(policy))assert.equal(response.headers.get(header),value,header);
assert.deepEqual(new Uint8Array(brotliDecompressSync(Buffer.from(await response.arrayBuffer()))),wasm);
// No Brotli: the plain file, never the .br bytes.
requested.length=0;response=await get(name,'gzip');
assert.equal(response.headers.get('Content-Encoding'),null);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),wasm);assert.deepEqual(requested,[name]);
// A missing Brotli copy falls back to the plain file.
files.delete(name+'.br');response=await get(name,'br');assert.equal(response.headers.get('Content-Encoding'),null);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),wasm);
// HEAD has headers and no body; other paths and misses still carry the policy.
response=await get(name,'gzip','HEAD');assert.equal(response.status,200);assert.equal((await response.arrayBuffer()).byteLength,0);
for(const path of ['/index.html','/engine/archive_engine-ffff.wasm','/nope']){response=await get(path,'br');for(const [header,value] of Object.entries(policy))assert.equal(response.headers.get(header),value,path+' '+header);assert.equal(response.headers.get('Content-Encoding'),null);}
console.log('PASS: hashed engine files go out as their Brotli copy with the production policy');
