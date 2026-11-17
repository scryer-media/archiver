// A repair may leave private backups and donor files beside its targets.
// Publication is driven by verified target metadata, never filename suffixes.
export function publicationPolicy(value:unknown):{files?:ReadonlySet<string>;directories?:ReadonlySet<string>}{
  if(value===undefined||value===null)return {};
  if(!Array.isArray(value))throw new Error('Invalid verified publication manifest');
  const files=new Set<string>(),directories=new Set<string>();
  for(const name of value){
    if(typeof name!=='string'||!name||name.startsWith('/')||/[\\\0:]/.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..')||name.split('/')[0]==='.work'||files.has(name))throw new Error('Unsafe or duplicate verified publication path');
    files.add(name);const parts=name.split('/');for(let index=1;index<parts.length;index++)directories.add(parts.slice(0,index).join('/'));
  }
  return {files,directories};
}
