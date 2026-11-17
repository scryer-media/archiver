// Browser-side verification of newly created parity sets; no fixtures are mutated.
export async function verifyCreatedRecovery({engine,sourceFiles,sidecars,expected,options={},nestedExpected}) {
 const hash=async blob=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),x=>x.toString(16).padStart(2,'0')).join('');
 const canon=name=>name.normalize('NFC');
 const filesOf=result=>result.files.map(file=>new File([file.blob],file.name));
 async function exact(files,wanted){
  const actual=new Map();for(const file of files){const name=canon(file.name);if(actual.has(name))throw Error('Duplicate recovered output');actual.set(name,{bytes:file.size,sha256:await hash(file)});}
  const names=new Set();for(const item of wanted.filter(x=>!x.directory)){const name=canon(item.name);if(names.has(name))throw Error('Duplicate recovery oracle');names.add(name);const got=actual.get(name);if(!got||got.bytes!==item.bytes||got.sha256!==item.sha256)throw Error('Recovery hash mismatch: '+item.name);}
  if(actual.size!==names.size)throw Error('Unexpected recovered output count');return Object.fromEntries(actual);
 }
 await exact(sourceFiles,expected);
 const healthy=await engine.verify([...sourceFiles,...sidecars],options);if(healthy.complete!==true||healthy.files.length!==0)throw Error('Created recovery set failed healthy verification');
 const original=sourceFiles[0];if(!original||original.size<32)throw Error('Recovery source too small for corruption');
 const offset=Math.min(1048576,Math.floor(original.size/2)),bytes=new Uint8Array(await original.slice(offset,offset+16).arrayBuffer());for(let i=0;i<bytes.length;i++)bytes[i]^=0x5a;
 const damaged=new File([original.slice(0,offset),bytes,original.slice(offset+16)],original.name),sources=[damaged,...sourceFiles.slice(1)];
 const damagedStatus=await engine.verify([...sources,...sidecars],options);if(damagedStatus.complete!==false||damagedStatus.files.length!==0)throw Error('Corruption falsely verified healthy');
 const repaired=await engine.repair([...sources,...sidecars],undefined,options);if(repaired.complete!==true)throw Error('Created set did not report complete repair');
 const restored=filesOf(repaired),repairedFiles=await exact(restored,expected);
 const index=sidecars.filter(file=>!/\.vol/i.test(file.name));if(index.length!==1)throw Error('Expected one parity index for insufficient control');
 let insufficient,result,repairError;
 try{result=await engine.repair([...sources,...index],undefined,options);}catch(error){repairError=error;}
 const semantic=text=>/insufficient|missing|not enough|lost.+blocks|repair did not complete/i.test(text)&&!/worker|trap|memory access|timed out|quota/i.test(text);
 if(repairError){if(!semantic(repairError.message))throw repairError;insufficient={error:repairError.message};}
 else{if(result.complete!==false||result.files.length!==0||!semantic((result.status||'')+' '+(result.message||'')))throw Error('Invalid insufficient-recovery outcome');insufficient={complete:result.complete,status:result.status,message:result.message};}
 let nested;
 if(nestedExpected){if(restored.length!==1)throw Error('Combined archive repair expected one protected archive');const result=await engine.extract(restored,options.password||'');nested=await exact(filesOf(result),nestedExpected);}
 return {healthy:{complete:healthy.complete},corruption:{offset,count:16,xor:90},damagedComplete:damagedStatus.complete,repair:{complete:repaired.complete,files:repairedFiles},insufficient,nested};
}
