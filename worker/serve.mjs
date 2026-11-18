import {parseHeaders} from '../scripts/parse-headers.mjs';
/** Content-hashed engine files: they never change under one name, so browsers keep them for a year. */
export const ENGINE_FILE=/^\/engine\/(?:archive-engine|archive_engine)-[a-f0-9]{20}\.(js|wasm)$/;
const TYPES={js:'text/javascript; charset=utf-8',wasm:'application/wasm'};
/** True when the request accepts Brotli (a `q=0` refuses it). */
export function acceptsBrotli(header){
 return (header||'').split(',').some(part=>{const [name,...params]=part.trim().split(';');if(name.trim().toLowerCase()!=='br')return false;const q=params.map(param=>param.trim()).find(param=>param.startsWith('q='));return q===undefined||Number(q.slice(2))>0;});
}
/**
 * The Worker in front of the static assets. It runs only for engine paths: a hashed engine file goes out as its
 * build-time max-Brotli copy when the browser takes Brotli. Responses from Worker code do not get `_headers`, so the
 * same policy is set here.
 */
export function createHandler(headersText){
 const policy=parseHeaders(headersText);
 const withPolicy=response=>{const out=new Response(response.body,response);for(const [name,value] of Object.entries(policy))out.headers.set(name,value);return out;};
 return {async fetch(request,env){
  const url=new URL(request.url),match=url.pathname.match(ENGINE_FILE);
  if(match&&(request.method==='GET'||request.method==='HEAD')){
   const brotli=acceptsBrotli(request.headers.get('Accept-Encoding'));
   let asset=brotli?await env.ASSETS.fetch(new URL(url.pathname+'.br',url)):undefined,encoded=asset?.status===200;
   if(!encoded)asset=await env.ASSETS.fetch(new URL(url.pathname,url));
   if(asset.status===200){
    const headers=new Headers(policy);
    headers.set('Content-Type',TYPES[match[1]]);headers.set('Cache-Control','public, max-age=31536000, immutable');headers.set('Vary','Accept-Encoding');
    if(encoded)headers.set('Content-Encoding','br');
    return new Response(request.method==='HEAD'?null:asset.body,{status:200,headers,encodeBody:encoded?'manual':'automatic'});
   }
   return withPolicy(asset);
  }
  return withPolicy(await env.ASSETS.fetch(request));
 }};
}
