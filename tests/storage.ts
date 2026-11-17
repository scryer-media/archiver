import {ArchiveEngine} from "../src/tool-engine";
import {acquireStorageLease,cleanAbandonedStorage,removeStorage} from "../engine/storage";
const results:{name:string;ok:boolean;detail?:string}[]=[];
const check=(value:unknown,message:string)=>{if(!value)throw Error(message)};
const report=(done=false)=>document.querySelector("#results")!.textContent=JSON.stringify({done,passed:results.filter(r=>r.ok).length,total:results.length,results},null,2);
const test=async(name:string,fn:()=>Promise<void>)=>{try{await fn();results.push({name,ok:true})}catch(error){results.push({name,ok:false,detail:String(error)})}report()};
const root=await navigator.storage.getDirectory();
const names=async()=>{const result=[];for await(const [name]of(root as any).entries())result.push(name);return result as string[]};
if(new URL(location.href).searchParams.has("quota")){
await test("real quota failure reports error and cleans outputs",async()=>{const before=await names();const engine=new ArchiveEngine();let error="";try{await engine.create([new File([new Uint8Array(4*1024*1024)],"quota.bin")],{format:"7z",codec:"copy"})}catch(reason){error=String(reason)}check(/quota|storage|space/i.test(error),"Expected real storage failure, got "+error);await engine.dispose();await new Promise(r=>setTimeout(r,500));const after=await names();check(after.filter(n=>n.startsWith("archive-native-")).every(n=>before.includes(n)),"Failed operation leaked storage");});
}else{
await test("abandoned cleanup respects live leases and unrelated directories",async()=>{const live=await acquireStorageLease();const abandoned="archive-native-"+crypto.randomUUID(),unrelated="unrelated-test-"+crypto.randomUUID();await root.getDirectoryHandle(live.name,{create:true});await root.getDirectoryHandle(abandoned,{create:true});await root.getDirectoryHandle(unrelated,{create:true});try{await cleanAbandonedStorage();const remaining=await names();check(remaining.includes(live.name),"Live directory was removed");check(!remaining.includes(abandoned),"Abandoned directory was retained");check(remaining.includes(unrelated),"Unrelated directory was removed");}finally{await removeStorage(live);await root.removeEntry(unrelated,{recursive:true});await root.removeEntry(abandoned,{recursive:true}).catch(()=>{});}});
await test("malformed input error cleans worker storage",async()=>{const before=await names();const engine=new ArchiveEngine();let failed=false;try{await engine.extract([new File(["not an archive"],"broken.7z")])}catch{failed=true}check(failed,"Malformed archive accepted");await engine.dispose();await new Promise(r=>setTimeout(r,500));check((await names()).filter(n=>n.startsWith("archive-native-")).every(n=>before.includes(n)),"Error operation leaked storage");});
}report(true);
