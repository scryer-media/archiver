import assert from 'node:assert/strict';
import {openBrowserSession} from './lib/browser-session.mjs';
const [endpoint,url]=process.argv.slice(2);if(!endpoint||!url)throw Error('Provide test browser endpoint and app URL');
const page=await openBrowserSession(endpoint,url);
try{
 const start=Date.now();assert.deepEqual(await page.evaluate('(async()=>{await new Promise(resolve=>setTimeout(resolve,150));return {completed:true}})()'),{completed:true});assert.ok(Date.now()-start>=140,'A pending Promise must not be mistaken for its result');
 await assert.rejects(()=>page.evaluate('Promise.reject(new Error("expected asynchronous rejection"))'),/expected asynchronous rejection/);
 assert.equal(await page.evaluate('Promise.resolve(false)'),false);
 assert.deepEqual(await page.evaluate('Promise.resolve({artifacts:[{name:"fixture.bin"}],roundtrip:{allPathsAndHashes:true}})'),{artifacts:[{name:'fixture.bin'}],roundtrip:{allPathsAndHashes:true}});
 console.log('PASS: delayed asynchronous results are awaited, rejected Promises fail, falsy and structured artifact results survive CDP.');
}finally{await page.close();}
