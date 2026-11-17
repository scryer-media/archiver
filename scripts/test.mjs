// Bounded source-only checks: no browser, server, native build or large fixtures.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const tests=[
 'input-read-window','output-budget','output-budget-worker','production-csp','password','delivery-model','progress-model','create-file-options','creation-policy',
 'download-contracts','download-preflight','download-lifecycle','download-native-bridge',
 'native-stream','offline-cache-contracts','repair-publication','zip-security',
 'zip-security-aes','zip-security-resources','zip-links','destination-filesystem-aliases',
 'compressed-tar-destination',
];
const results=[];
for(const test of tests){
 const start=performance.now();
 const result=spawnSync(process.execPath,[`tests/${test}.mjs`],{
  cwd:root,encoding:'utf8',timeout:45_000,maxBuffer:2*1024*1024,
 });
 const status=result.status===0&&!result.error?'PASS':'FAIL';
 results.push({test,status,elapsedMs:Math.round(performance.now()-start)});
 console.log(`${status} ${test}`);
 if(status==='FAIL')console.error(result.error?.message||result.stderr||result.stdout||`Exited ${result.status}, signal ${result.signal}`);
}
console.log(JSON.stringify({scope:'Bounded Node component/security tests; not browser or native integration proof',results}));
if(results.some(result=>result.status!=='PASS'))process.exitCode=1;
