import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync,statSync} from 'node:fs';
import {tmpdir,platform} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ZipStream,crc32} from '../engine/zip-stream.ts';

assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
assert.equal(crc32(new TextEncoder().encode('6789'),crc32(new TextEncoder().encode('12345'))),0xcbf43926,'CRC continues across chunks');

const pack=async build=>{const chunks=[];const zip=new ZipStream(async bytes=>{chunks.push(bytes.slice());},Date.UTC(2024,5,1,12,0,0));await build(zip);await zip.finish();return Buffer.concat(chunks);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const big=new Uint8Array(3*1024*1024+17);for(let i=0;i<big.length;i++)big[i]=(i*2654435761>>>13)&255;
const hello=new TextEncoder().encode('hello zip\n'),unicode=new TextEncoder().encode('ünïcødé');
const modified=new Date(2020,0,2,3,4,6).getTime();
const archive=await pack(async zip=>{
 await zip.directory('a');await zip.directory('a/b');
 zip.setTime('a/b/hello.txt',modified);
 await zip.begin('a/b/hello.txt');await zip.write(hello);
 await zip.directory('later');
 await zip.begin('empty.bin');
 await zip.begin('ünï/çødé.txt');await zip.write(unicode);
 await zip.begin('big.bin');for(let at=0;at<big.length;at+=1<<20)await zip.write(big.subarray(at,at+(1<<20)));
 await assert.rejects(zip.begin('a/b/hello.txt'),/Duplicate/);
 await assert.rejects(zip.begin('../escape'),/Unsafe/);
});
const dir=mkdtempSync(join(tmpdir(),'zip-stream-'));
try{
 const file=join(dir,'out.zip');writeFileSync(file,archive);
 const python=spawnSync('python3',['-I','-c',`
import zipfile,hashlib,json,sys
z=zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps({i.filename:[hashlib.sha256(z.read(i)).hexdigest() if not i.is_dir() else None,list(i.date_time),i.is_dir()] for i in z.infolist()}))
`,file],{encoding:'utf8'});
 assert.equal(python.status,0,python.stderr);
 const listing=JSON.parse(python.stdout);
 assert.deepEqual(Object.keys(listing),['a/','a/b/','a/b/hello.txt','later/','empty.bin','ünï/çødé.txt','big.bin']);
 assert.equal(listing['a/b/hello.txt'][0],sha(hello));assert.equal(listing['big.bin'][0],sha(big));assert.equal(listing['ünï/çødé.txt'][0],sha(unicode));assert.equal(listing['empty.bin'][0],sha(new Uint8Array()));
 assert.deepEqual(listing['a/b/hello.txt'][1],[2020,1,2,3,4,6],'entry keeps its modification time');
 assert.equal(listing['later/'][2],true,'a directory added while a file is open is written after it');
 if(platform()==='darwin'){
  const out=join(dir,'ditto');const ditto=spawnSync('ditto',['-x','-k',file,out],{encoding:'utf8'});
  assert.equal(ditto.status,0,ditto.stderr);
  assert.equal(sha(readFileSync(join(out,'big.bin'))),sha(big));assert.equal(sha(readFileSync(join(out,'ünï/çødé.txt'))),sha(unicode));
  assert.ok(existsSync(join(out,'later'))&&statSync(join(out,'later')).isDirectory());
 }
 // More entries than a classic ZIP can count need the ZIP64 end records.
 const many=await pack(async zip=>{for(let i=0;i<70000;i++)await zip.begin(`f/${i}`);});
 const manyFile=join(dir,'many.zip');writeFileSync(manyFile,many);
 const count=spawnSync('python3',['-I','-c','import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(len(z.infolist()))',manyFile],{encoding:'utf8'});
 assert.equal(count.status,0,count.stderr);assert.equal(count.stdout.trim(),'70000');
}finally{rmSync(dir,{recursive:true,force:true});}
console.log(JSON.stringify({status:'PASS',scope:'Streamed stored ZIP read back by Python zipfile'+(platform()==='darwin'?' and ditto':'')}));
