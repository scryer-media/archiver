import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const repo=resolve(process.env.ARCHIVE_REPO||'.');
const root=process.env.TAR_REPORT_ROOT||'/private/tmp/archive-tar-native-'+Date.now();
await mkdir(root,{recursive:false});
const hash=b=>createHash('sha256').update(b).digest('hex'),enc=new TextEncoder();
const checksum=b=>{b.fill(32,148,156);b.set(enc.encode(b.reduce((n,x)=>n+x,0).toString(8).padStart(6,'0')+'\0 '),148);return b;};
function header(name,size=0,type='0',target=''){const b=new Uint8Array(512),put=(at,s)=>b.set(enc.encode(s),at);put(0,name);put(100,'0000644\0');put(108,'0000000\0');put(116,'0000000\0');put(124,size.toString(8).padStart(11,'0')+'\0');put(136,'00000000000\0');put(156,type);put(157,target);put(257,'ustar\0');put(263,'00');return checksum(b);}
const pad=n=>new Uint8Array((512-n%512)%512);
const member=(name,text)=>{const bytes=enc.encode(text);return[header(name,bytes.length),bytes,pad(bytes.length)];};
const record=(k,v)=>{const t=k+'='+v+'\n';let n=enc.encode(t).length+2;while(n!==String(n).length+1+enc.encode(t).length)n=String(n).length+1+enc.encode(t).length;return n+' '+t;};
function pax(values,type='x'){const b=enc.encode(values.map(([k,v])=>record(k,String(v))).join(''));return[header('PaxHeaders/item',b.length,type),b,pad(b.length)];}
const archive=parts=>Buffer.concat([...parts,new Uint8Array(1024)].map(x=>Buffer.from(x)));
const cases=[];
const good=(id,parts,expected,extra={})=>cases.push({id,bytes:archive(parts),expected,...extra});
const bad=(id,parts,error,extra={})=>cases.push({id,bytes:archive(parts),error,...extra});
good('ordinary',member('payload','abc'),{payload:'abc'});
for(const [version,attrs,prefix]of[
 ['0.0',[['GNU.sparse.size',10],['GNU.sparse.numblocks',2],['GNU.sparse.offset',2],['GNU.sparse.numbytes',2],['GNU.sparse.offset',8],['GNU.sparse.numbytes',1]],[]],
 ['0.1',[['GNU.sparse.size',10],['GNU.sparse.map','2,2,8,1']],[]],
 ['1.0',[['GNU.sparse.major',1],['GNU.sparse.minor',0],['GNU.sparse.realsize',10]],[enc.encode('2\n2\n2\n8\n1\n'),new Uint8Array(502)]]
])good('sparse-'+version,[...pax(attrs),header('sparse',prefix.length?515:3),...prefix,enc.encode('ABC'),new Uint8Array(509)],{sparse:'\0\0AB\0\0\0\0C\0'},{independent:true});
const old=header('sparse',3,'S');old.set(enc.encode('ustar  \0'),257);for(const[at,n]of[[386,2],[398,2],[410,8],[422,1],[483,10]])old.set(enc.encode(n.toString(8).padStart(11,'0')+'\0'),at);checksum(old);good('sparse-old-gnu',[old,enc.encode('ABC'),new Uint8Array(509)],{sparse:'\0\0AB\0\0\0\0C\0'},{independent:true});
good('all-hole',[...pax([['GNU.sparse.size',7],['GNU.sparse.map','7,0']]),header('empty')],{empty:'\0'.repeat(7)},{sparse:{logicalSize:7,dataBytes:0},independent:true});
good('empty-directory',[header('empty',0,'5')],{},{directories:['empty']});
bad('sparse-overlap',[...pax([['GNU.sparse.size',10],['GNU.sparse.map','2,2,3,1']]),header('bad',3),enc.encode('ABC'),pad(3)],/sparse|overlap|TAR/i);
bad('packed-mismatch',[...pax([['GNU.sparse.size',10],['GNU.sparse.map','2,2']]),header('bad',3),enc.encode('ABC'),pad(3)],/sparse|size|TAR/i);
bad('all-hole-packed-mismatch',[...pax([['GNU.sparse.size',7],['GNU.sparse.map','7,0']]),header('bad',3),enc.encode('ABC'),pad(3)],/sparse|size|TAR/i);
for(const[id,attrs]of[
 ['mixed-sparse-version-map',[['GNU.sparse.major',1],['GNU.sparse.minor',0],['GNU.sparse.realsize',10],['GNU.sparse.map','2,2,8,1']]],
 ['mixed-sparse-map-pairs',[['GNU.sparse.size',10],['GNU.sparse.map','2,2,8,1'],['GNU.sparse.offset',2],['GNU.sparse.numbytes',2],['GNU.sparse.offset',8],['GNU.sparse.numbytes',1]]],
 ['contradictory-sparse-sizes',[['GNU.sparse.size',10],['GNU.sparse.realsize',11],['GNU.sparse.map','2,2,8,1']]],
 ['unknown-sparse-version',[['GNU.sparse.major',2],['GNU.sparse.minor',0],['GNU.sparse.realsize',10],['GNU.sparse.map','2,2,8,1']]]
]) {const v1=id==='mixed-sparse-version-map';bad(id,[...pax(attrs),header('bad',v1?515:3),...(v1?[enc.encode('2\n2\n2\n8\n1\n'),new Uint8Array(502)]:[]),enc.encode('ABC'),pad(3)],/sparse|version|TAR|format/i);}

const links=[header('copy',0,'2','payload'),...member('payload','abc')];
bad('default-links',links,/links/i);
good('safe-forward-link',links,{copy:'abc',payload:'abc'},{links:'copy-safe'});
for(const target of ['/payload','../payload','C:/payload','//server/share','..\\payload','missing','\\\\server\\share','nested/../../payload','payload:stream'])bad('unsafe-target-'+cases.length,[header('copy',0,'2',target),...member('payload','abc')],/target|unsafe|escape/i,{links:'copy-safe'});
bad('cycle',[header('a',0,'2','b'),header('b',0,'2','a')],/cycle/i,{links:'copy-safe'});
bad('nul-target',[...pax([['linkpath','payload\0hidden']]),header('copy',0,'2','payload'),...member('payload','abc')],/NUL|UTF|TAR|target|^Invalid or unsupported global PAX value$/i,{links:'copy-safe'});
bad('oversized-target',[...pax([['linkpath','a'.repeat(16385)]]),header('copy',0,'2','payload'),...member('payload','abc')],/16 KiB|target|limit/i,{links:'copy-safe'});
good('nested-hard-forward-chain',[header('nested/copy',0,'2','../hard'),header('hard',0,'1','payload'),...member('payload','abc')],{'nested/copy':'abc',hard:'abc',payload:'abc'},{links:'copy-safe'});
bad('precision-overflow-size',[...pax([['GNU.sparse.size','9007199254740992'],['GNU.sparse.map','9007199254740992,0']]),header('overflow')],/size|precision|safe|TAR/i);
const extentMap=Array.from({length:50000},(_,i)=>[i*2,1]).flat().join(',');
const aggregate=[];for(let i=0;i<6;i++)aggregate.push(...pax([['GNU.sparse.size',100000],['GNU.sparse.map',extentMap]]),header('extent-'+i,50000),new Uint8Array(50000),pad(50000));
bad('aggregate-nonempty-extents',aggregate,/sparse extent budget|^TAR retained metadata budget exceeded$/i);

bad('directory-target',[header('copy',0,'2','directory'),header('directory',0,'5')],/directory/i,{links:'copy-safe'});
bad('special',[header('device',0,'3')],/special|unsupported/i);
for(const[a,b]of[['File','file'],['Σ','ς'],['résumé','résumé'],['Dir','dir/child']])bad('alias-'+cases.length,[...member(a,'a'),...member(b,'b')],/aliases|directory|collision/i);
bad('unsafe-member',member('../escape','x'),/unsafe|path/i);
bad('output-quota',member('payload','abc'),/limit|quota/i,{maxOutput:2,extractOnly:true});
const crc=header('payload',3);crc[0]^=1;bad('header-checksum',[crc,enc.encode('abc'),pad(3)],/TAR|checksum|format/i);
const truncated=archive([header('payload',1024),enc.encode('abc')]).subarray(0,515);cases.push({id:'truncated-data',bytes:truncated,error:/TAR|truncat|input/i});
bad('pax-extension-budget',[...pax([['path','x'.repeat(1024*1024+1)]]),...member('payload','abc')],/TAR|limit|allocat|extension/i);
good('fractional-time',[...pax([['mtime','-0.001'],['atime','0'],['ctime','1.234']]),...member('payload','x')],{payload:'x'},{metadata:{modifiedTime:-1,accessedTime:0,changedTime:1234},absentMetadata:['createdTime']});
const compatibilityRoot=new URL('./fixtures/tar-compatibility/',import.meta.url);
const compatibility=JSON.parse(await readFile(new URL('manifest.json',compatibilityRoot),'utf8'));
for(const item of compatibility)cases.push({id:'python-compat-'+item.label,bytes:await readFile(new URL(item.label+'.tar',compatibilityRoot)),expected:Object.fromEntries(item.files.map(f=>[f.name,f.text])),directories:['empty-directory'],allFileMetadata:{modifiedTime:item.label==='pax'?1700000000125:1700000000000},independentFixture:'Existing Python-created GNU/PAX fixture manifest'});
for(const name of ['pax-traversal.tar','gnu-traversal.tar','truncated.tar','bad-checksum.tar','bad-pax-record.tar','link.tar'])cases.push({id:'python-compat-reject-'+name,bytes:await readFile(new URL(name,compatibilityRoot)),error:/TAR|path|unsafe|truncat|checksum|format|PAX|links/i});
const report={scope:'Actual application engine_run Emscripten C ABI, not legacy JavaScript TAR parser; no host links',status:'RUNNING',runtime:{},cases:[]};
const save=()=>writeFile(root+'/evidence.json',JSON.stringify(report,null,2)+'\n');
const manifest=[];
try{
 const js=await readFile(repo+'/public/engine/archive-engine.js'),wasm=await readFile(repo+'/public/engine/archive_engine.wasm');report.runtime={jsSHA256:hash(js),wasmSHA256:hash(wasm)};
 const{default:createModule}=await import(pathToFileURL(repo+'/public/engine/archive-engine.js'));
 const m=await createModule({wasmBinary:wasm,print:()=>{},printErr:()=>{}}),fs=m.FS;
 const clean=p=>{for(const n of fs.readdir(p)){if(n==='.'||n==='..')continue;const q=p+'/'+n;if(fs.isDir(fs.lstat(q).mode)){clean(q);fs.rmdir(q);}else fs.unlink(q);}};
 for(const p of ['/input','/out'])try{fs.mkdir(p);}catch{clean(p);}
 const invoke=r=>{const p=m.ccall('engine_run','number',['string'],[JSON.stringify(r)]);try{return JSON.parse(m.UTF8ToString(p));}finally{m._engine_free(p);}};
 const outputs=()=>{const out={};function walk(p,prefix){for(const n of fs.readdir(p)){if(n==='.'||n==='..')continue;const q=p+'/'+n,mode=fs.lstat(q).mode;assert.ok(!fs.isLink(mode));if(fs.isDir(mode)){out[prefix+n]={directory:true};walk(q,prefix+n+'/');}else{assert.ok(fs.isFile(mode));const b=fs.readFile(q);out[prefix+n]={bytes:b.length,sha256:hash(b)};}}}walk('/out','');return out;};
 for(const c of cases){const record={id:c.id,status:'FAIL'};report.cases.push(record);const archiveName=c.id+'.tar';await writeFile(root+'/'+archiveName,c.bytes);const dirs=new Set(c.directories||[]);for(const n of [...Object.keys(c.expected||{}),...dirs]){const parts=n.split('/');for(let i=1;i<parts.length;i++)dirs.add(parts.slice(0,i).join('/'));}const expected=c.expected&&Object.fromEntries([...Object.entries(c.expected).map(([n,s])=>[n,{bytes:Buffer.byteLength(s),sha256:hash(Buffer.from(s))}]),...Array.from(dirs,n=>[n,{directory:true}])]);manifest.push({id:c.id,archive:archiveName,archiveSHA256:hash(c.bytes),expected,error:c.error?.source,errorFlags:c.error?.flags,links:c.links,maxOutput:c.maxOutput,extractOnly:c.extractOnly,metadata:c.metadata,directories:c.directories,sparse:c.sparse,allFileMetadata:c.allFileMetadata,absentMetadata:c.absentMetadata,independentFixture:c.independentFixture});
  try{if(c.independent){const decoded=execFileSync('python3',['-c','import sys,tarfile,io; a=tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read())); sys.stdout.buffer.write(a.extractfile(a.getmembers()[0]).read())'],{input:c.bytes});assert.equal(hash(decoded),Object.values(expected)[0].sha256);record.independentPython=true;}
   for(const op of ['list','extract']){clean('/input');clean('/out');fs.writeFile('/input/fixture.tar',c.bytes);const response=invoke({op,format:'tar',paths:['/input/fixture.tar'],links:c.links,maxOutput:c.maxOutput??8*1024*1024});record[op]=response;if(c.error&&(op==='extract'||!c.extractOnly)){assert.equal(typeof response.error,'string');assert.match(response.error,c.error);assert.deepEqual(outputs(),{},'Rejection published output');}else{assert.ok(!response.error,response.error);if(c.expected)assert.deepEqual(response.entries.filter(e=>!e.isDirectory).map(e=>e.name).sort(),Object.keys(c.expected||{}).sort());for(const e of response.entries.filter(e=>!e.isDirectory))for(const[k,v]of Object.entries(c.allFileMetadata||{}))assert.equal(e.metadata[k],v);for(const key of c.absentMetadata||[])assert.equal(response.entries[0].metadata[key],undefined);if(op==='extract')assert.deepEqual(outputs(),expected);if(c.metadata)for(const[k,v]of Object.entries(c.metadata))assert.equal(response.entries[0].metadata[k],v);for(const name of c.directories||[])assert.equal(response.entries.find(e=>e.name===name||e.name===name+'/')?.isDirectory,true);if(c.sparse){const sparse=response.entries[0].metadata.sparse;assert.equal(sparse.logicalSize,c.sparse.logicalSize);assert.equal(sparse.extents.reduce((n,e)=>n+e.length,0),c.sparse.dataBytes);}}}
   record.status='PASS';
  }catch(e){record.error=String(e);}await save();
 }
 const writer={id:'writer-unicode-fractional-time',status:'FAIL'};report.cases.push(writer);
 try{clean('/input');clean('/out');const name='dossier-'+ 'é'.repeat(90)+'.bin',data=Buffer.from('writer oracle');fs.writeFile('/input/'+name,data);const response=invoke({op:'create',format:'tar',paths:['/input/'+name],inputMetadata:[{name,modifiedTime:-1}]});assert.ok(!response.error,response.error);const bytes=fs.readFile('/out/archive.tar');await writeFile(root+'/created-unicode.tar',bytes);const result=JSON.parse(execFileSync('python3',['-c','import sys,tarfile,io,json,hashlib; a=tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read())); e=a.getmembers()[0]; print(json.dumps({"name":e.name,"mtime":e.mtime,"sha256":hashlib.sha256(a.extractfile(e).read()).hexdigest()}))'],{input:Buffer.from(bytes)}));assert.equal(result.name,name);assert.equal(result.mtime,-0.001);assert.equal(result.sha256,hash(data));writer.independentPython=result;writer.status='PASS';}catch(e){writer.error=String(e);}await save();
 await writeFile(root+'/fixtures.json',JSON.stringify({scope:report.scope,cases:manifest},null,2)+'\n');
 report.status=report.cases.every(c=>c.status==='PASS')?'PASS':'FAIL';
}catch(e){report.status='FAIL';report.error=String(e);}
await save();console.log(JSON.stringify({status:report.status,cases:report.cases.length,failed:report.cases.filter(c=>c.status!=='PASS').map(c=>({id:c.id,error:c.error})),evidence:root+'/evidence.json',fixtures:root+'/fixtures.json',error:report.error}));if(report.status!=='PASS')process.exitCode=1;
