import type {ArchiveEntry} from './client';
/**
 * The entries a selective extraction writes. `only` names entries exactly as `list`
 * returns them; each must exist and be a regular file. Without `only`, every entry.
 */
export function selectEntries<T extends Pick<ArchiveEntry,'name'|'isDirectory'|'isLink'>>(entries:T[],only?:string[]):T[]{
  if(only===undefined)return entries;
  if(!Array.isArray(only)||!only.length||only.some(name=>typeof name!=='string'))throw new Error('Choose at least one entry to extract');
  const byName=new Map(entries.map(entry=>[entry.name,entry]));
  for(const name of only){
    const entry=byName.get(name);
    if(!entry)throw new Error('Selected entry is not in the archive: '+name);
    if(entry.isDirectory)throw new Error('Selected entry is a directory: '+name);
    if(entry.isLink)throw new Error('Selected entry is a link; links are not extracted selectively: '+name);
  }
  const wanted=new Set(only);
  return entries.filter(entry=>wanted.has(entry.name));
}
