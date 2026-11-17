export type DestinationJob = { parent: FileSystemDirectoryHandle; directory: FileSystemDirectoryHandle; name: string };
export async function createDestination(parent: FileSystemDirectoryHandle): Promise<DestinationJob> {
  const name = 'archive-extracted-' + crypto.randomUUID();
  // File System Access has no exclusive-create primitive. An unpredictable,
  // fresh job directory isolates all writes from existing destination files.
  try { await parent.getDirectoryHandle(name); throw new Error('Extraction directory already exists'); }
  catch (error) { if ((error as Error).name !== 'NotFoundError') throw error; }
  const directory = await parent.getDirectoryHandle(name, { create: true });
  for await (const _entry of (directory as any).entries()) throw new Error('Extraction directory is not empty');
  return { parent, directory, name };
}
export async function removeDestination(job: DestinationJob): Promise<boolean> {
  const deadline = performance.now() + 30_000;
  do {
    try { await job.parent.removeEntry(job.name, { recursive: true }); return true; }
    catch (error) { if ((error as Error).name === 'NotFoundError') return true; }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (performance.now() < deadline);
  return false;
}
const ownedDirectories = new WeakMap<FileSystemDirectoryHandle, Map<string, FileSystemDirectoryHandle>>();
export async function destinationDirectory(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle> {
  if (!path) return root;
  if (/[\\\0:]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /[\x00-\x1f]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe destination path');
  let known=ownedDirectories.get(root);if(!known){known=new Map([['',root]]);ownedDirectories.set(root,known);}
  let directory=root,prefix='';
  for(const part of path.split('/')){
    prefix=prefix?prefix+'/'+part:part;
    const owned=known.get(prefix);
    if(owned){directory=owned;continue;}
    try{await directory.getDirectoryHandle(part);throw new Error('Unexpected existing destination directory: '+prefix);}
    catch(error){if((error as Error).name!=='NotFoundError')throw error;}
    directory=await directory.getDirectoryHandle(part,{create:true});known.set(prefix,directory);
  }
  return directory;
}
export async function destinationParent(root: FileSystemDirectoryHandle, path: string): Promise<{ directory: FileSystemDirectoryHandle; name: string }> {
  if (!path || /[\\\0:]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /[\x00-\x1f]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe destination path');
  const parts=path.split('/'),name=parts.pop()!;
  return {directory:await destinationDirectory(root,parts.join('/')),name};
}

// Conservative Unicode collision key; physical filesystems can have additional aliases.
export function destinationPathIdentity(path: string): string {
  return Array.from(path.normalize('NFC').toUpperCase(), part => part.toLowerCase()).join('').normalize('NFC');
}

export function destinationPathRegistry(): (path: string) => void {
  const names = new Map<string,string>();
  return path => {
    let prefix='';
    for(const part of path.split('/')){
      prefix=prefix?prefix+'/'+part:part;
      const key=destinationPathIdentity(prefix),previous=names.get(key);
      if(previous!==undefined&&previous!==prefix)throw new Error('Destination path aliases another archive path: '+prefix);
      names.set(key,prefix);
    }
  };
}
