import type {ArchiveEntry,EntryMetadata,ExtractionOptions} from '../engine/client';
import {destinationPathRegistry,destinationPathIdentity} from '../engine/destination';
export const MAX_LINK_BYTES=16*1024;
export function safeArchivePath(name:string):string{
 if(!name||name.startsWith('/')||/[\\\0:]/.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/[\x00-\x1f]/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))throw Error('Unsafe archive path: '+name);
 return name;
}
export function validateArchiveTree(entries:Pick<ArchiveEntry,'name'|'isDirectory'>[]):void{
 const names=new Map<string,boolean>(),register=destinationPathRegistry();
 for(const entry of entries){const name=safeArchivePath(entry.name.replace(/\/$/,''));if(names.has(name))throw Error('Duplicate archive path: '+name);register(name);names.set(name,entry.isDirectory);}
 for(const name of names.keys()){let at=name.indexOf('/');while(at!==-1){if(names.get(name.slice(0,at))===false)throw Error('Archive file/directory path collision: '+name);at=name.indexOf('/',at+1);}}
}
export function resolveArchiveLinks<T extends Pick<ArchiveEntry,'name'|'isDirectory'|'metadata'|'isLink'>>(entries:T[],policy:ExtractionOptions['links']='reject'):Map<string,T>{
 if(policy!=='reject'&&policy!=='copy-safe')throw Error('Unsupported archive link policy');
 validateArchiveTree(entries);const inventory=new Map(entries.map(entry=>[destinationPathIdentity(entry.name),entry])),resolved=new Map<string,T>();
 const visit=(entry:T,stack:Set<string>):T=>{
  const cached=resolved.get(entry.name);if(cached)return cached;
  const link=entry.metadata?.link;
  if(!link&&!entry.isLink){if(entry.isDirectory)throw Error('Archive links cannot target directories');resolved.set(entry.name,entry);return entry;}
  if(policy!=='copy-safe')throw Error('Archive links are not extracted');
  if(!link||!['symbolic','hard','copy'].includes(link.kind)||!link.target)throw Error('Archive link target is unavailable');
  if(stack.has(entry.name)||stack.size>=64)throw Error('Archive link cycle or chain limit exceeded');
  const target=link.target;if(new TextEncoder().encode(target).length>MAX_LINK_BYTES||target.startsWith('/')||/[\\\0:\x00-\x1f]/.test(target))throw Error('Unsafe archive link target');
  const parts=link.kind==='symbolic'?entry.name.split('/').slice(0,-1):[];
  for(const part of target.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!parts.length)throw Error('Archive link target escapes archive root');parts.pop();}else parts.push(part);}
  const name=parts.join('/');safeArchivePath(name);const next=inventory.get(destinationPathIdentity(name));if(!next)throw Error('Archive link target is not an archived file: '+name);
  const result=visit(next,new Set([...stack,entry.name]));resolved.set(entry.name,result);return result;
 };
 for(const entry of entries){if(entry.isDirectory&&(entry.isLink||entry.metadata?.link))throw Error('Directory links are not materialized');if(!entry.isDirectory)visit(entry,new Set());}
 return resolved;
}
export function timestamp(value:unknown):number|undefined{return typeof value==='number'&&Number.isSafeInteger(value)&&Math.abs(value)<=8.64e15?value:undefined;}
export function preserveFileMetadata(blob:Blob,name:string,metadata?:EntryMetadata):Blob{
 const modified=timestamp(metadata?.modifiedTime);return modified===undefined?blob:new File([blob],name.split('/').at(-1)!,{lastModified:modified,type:blob.type});
}
export function metadataDownload(entries:ArchiveEntry[]):Blob{
 const parts:BlobPart[]=['{"version":1,"hostMetadataApplied":false,"entries":['];let bytes=0;
 entries.forEach((entry,index)=>{const record=(index?',':'')+JSON.stringify(entry);bytes+=new TextEncoder().encode(record).length;if(bytes>64*1024*1024)throw Error('Metadata export exceeds the64MiB limit');parts.push(record);});parts.push(']}');return new Blob(parts,{type:'application/json'});
}
