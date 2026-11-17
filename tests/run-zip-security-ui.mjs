import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {openBrowserSession} from './lib/browser-session.mjs';
const args=process.argv.slice(2),value=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1]};
const fixtures=value('--fixtures','/private/tmp/archive-zip-migration/security'),endpoint=value('--endpoint','http://127.0.0.1:9226'),url=value('--url','http://127.0.0.1:4185/'),output=value('--output','/private/tmp/archive-zip-migration/browser-security.json');
if(!args.includes('--execute')||!args.includes('--confirm-browser-idle')){console.log(JSON.stringify({status:'NOT_RUN',fixtures,endpoint,url,output,requires:['--execute','--confirm-browser-idle'],scope:'Actual application ZIP list, staged extraction and direct-folder extraction against 27 harmless fixtures; own small OPFS destination is removed'}));process.exit(0)}
const manifest=JSON.parse(await readFile(join(fixtures,'manifest.json'),'utf8')),report={scope:'Actual application and real browser workers, staged/direct output, full control hashes and rejected-output cleanup',cases:[]};let session;
async function install(){
 const {ArchiveEngine}=await import('/src/tool-engine.ts');
 const hash=async blob=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
 const check=(ok,message)=>{if(!ok)throw Error(message)};
 window.zipSecurity=async(spec,encoded,payload)=>{
  const bytes=Uint8Array.from(atob(encoded),x=>x.charCodeAt(0)),file=new File([bytes],spec.archive),engine=new ArchiveEngine(),root=await navigator.storage.getDirectory(),name='zip-security-'+crypto.randomUUID(),destination=await root.getDirectoryHandle(name,{create:true});
  const result={id:spec.id,status:'FAIL'};
  const list=async()=>{const out=[];for await(const item of destination.values())out.push(item.name);return out};
  try{
   let listed,listError;try{listed=await engine.list([file])}catch(error){listError=String(error)}result.listRejected=!!listError;
   let staged,stagedError;try{staged=await engine.extract([file])}catch(error){stagedError=String(error)}
   let direct,directError;try{direct=await engine.extract([file],undefined,undefined,destination)}catch(error){directError=String(error)}
   if(spec.expectation==='accept'){
    check(!listError&&!stagedError&&!directError,'Valid ZIP rejected: '+(listError||stagedError||directError));check(staged.files.length===1,'Unexpected control output count');check(staged.files[0].blob.size===payload.bytes&&await hash(staged.files[0].blob)===payload.sha256,'Staged control SHA mismatch');
    check(direct.savedFiles===1&&direct.savedDirectory,'Direct control not committed');const dir=await destination.getDirectoryHandle(direct.savedDirectory);const files=[];for await(const item of dir.values())if(item.kind==='file')files.push(await item.getFile());check(files.length===1&&files[0].size===payload.bytes&&await hash(files[0])===payload.sha256,'Direct control SHA mismatch');result.fullPayloadHashes=true;
   }else{
    check(stagedError&&directError,'Rejected ZIP returned success');for(const error of [stagedError,directError]){check(/unsafe filename|ambiguous|archive|zip|path|link|special|duplicate|invalid|size|signature|CRC|checksum|overlap|directory|entry|format|metadata|precision/i.test(error),'Unclassified security rejection: '+error);check(!/cannot read|not a function|module|ReferenceError|fetch failed|Unsupported TAR or GZIP/i.test(error),'Infrastructure rejection: '+error)}
    if(spec.id!=='body-corruption')check(listError,'Unsafe metadata accepted by listing');check((await list()).length===0,'Rejected ZIP left destination output');result.stagedError=stagedError;result.directError=directError;result.rejectedDestinationEmpty=true;
   }
   result.status='PASS';
  }catch(error){result.error=String(error)}finally{check(await engine.dispose(),'Engine temporary storage cleanup failed');await root.removeEntry(name,{recursive:true});}
  return result;
 };
 return{installed:true};
}
try{session=await openBrowserSession(endpoint,url);const ready=await session.evaluate('('+install.toString()+')()');if(!ready?.installed)throw Error('Security harness did not initialize');for(const spec of manifest.cases){const bytes=await readFile(join(fixtures,spec.archive));if(bytes.length!==spec.bytes||createHash('sha256').update(bytes).digest('hex')!==spec.sha256)throw Error('Fixture identity changed');const result=await session.evaluate('zipSecurity('+JSON.stringify(spec)+','+JSON.stringify(bytes.toString('base64'))+','+JSON.stringify(manifest.payload)+')',120000);if(!result||!['PASS','FAIL'].includes(result.status))throw Error('Missing structured fixture result');report.cases.push(result);await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));console.log(spec.id,result.status,result.error||'');}}
finally{await session?.close();report.pass=report.cases.filter(x=>x.status==='PASS').length;report.fail=report.cases.filter(x=>x.status!=='PASS').length;await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));}
console.log(JSON.stringify({output,pass:report.pass,fail:report.fail}));if(report.fail||report.cases.length!==manifest.cases.length)process.exitCode=1;
