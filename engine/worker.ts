import {WriteBudget,outputLimit,installWriteBudget} from './output-budget';
import { preserveFileMetadata } from '../src/archive-metadata';
import type { EntryMetadata } from './client';
import { publicationPolicy } from './publication';
import { installIoProgress } from './io-progress';
import { mountInputs, protectMemoryDirectories } from './input';
import { DiskVolume } from './opfs';
import { DirectOutput } from './direct-output';
const MEMORY_LIMIT = 128 * 1024 * 1024;
self.onmessage = async ({ data }) => {
  let budget:WriteBudget|undefined;
  let volume: DiskVolume | undefined;
  let direct: DirectOutput | undefined;
  const temporaryDirectory: string = data.temporaryDirectory;
  try {
    const { op, files, password, solid, options = {} } = data;
    const limit=outputLimit(options.outputLimitBytes),grant=options.writeBudgetGrant??limit;
    if(!Number.isSafeInteger(grant)||grant<0)throw new Error('Invalid worker write-budget grant');
    budget=new WriteBudget(Math.min(limit,grant),true);
    const names: string[] = data.names ?? files.map((file: File) => file.webkitRelativePath || file.name);
    if (!files.length && !(op === 'create' && options.directories?.length)) throw new Error('Choose at least one file');
    if (new Set(names).size !== files.length) throw new Error('Input paths must be unique');
    if (names.some(name => !name || name.startsWith('/') || /[\\\0:]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('Unsafe input path');
    self.postMessage({ progress: { phase: 'loading', message: 'Loading local WebAssembly engine' } });
    const version = import.meta.env.VITE_NATIVE_ENGINE_VERSION;
    const runtimeName = import.meta.env.PROD ? `archive-engine-${version}.js` : 'archive-engine.js';
    const runtimeUrl = new URL('/engine/' + runtimeName, self.location.origin).href;
    const { default: createModule } = await import(/* @vite-ignore */ runtimeUrl);
    const module = await createModule({ locateFile: (name: string) => '/engine/' + (import.meta.env.PROD && name.endsWith('.wasm') ? `archive_engine-${version}.wasm` : name), print: () => {}, printErr: () => {} });
    // File-backed WORKERFS reads original input lazily. All mutations, copies,
    // dynamic output files and repair scratch data live under the private /out mount.
    const inputReads=mountInputs(module,files,names);
    module.FS.mkdir('/out');
    installWriteBudget(module,budget);
    const runEngine=(request:any)=>{
      const pointer=module.ccall('engine_run','number',['string'],[JSON.stringify(request)]);
      try{return JSON.parse(module.UTF8ToString(pointer));}finally{module._engine_free(pointer);}
    };
    let totals:{totalBytes:number;totalFiles:number}|undefined;
    if(op==='extract'){
      const candidate=files[Math.max(0,names.findIndex(name=>/(\.001|\.part0*1\.rar)$/i.test(name)))];
      const signature=new Uint8Array(await candidate.slice(0,8).arrayBuffer());
      const archive=(signature[0]===0x37&&signature[1]===0x7a&&signature[2]===0xbc)||(signature[0]===0x52&&signature[1]===0x61&&signature[2]===0x72&&signature[3]===0x21);
      if(archive){
        self.postMessage({progress:{phase:'metadata',message:'Reading archive member sizes'}});
        const metadata=runEngine({...options,op:'list',paths:names.map(name=>'/input/'+name),password:password??'',maxOutput:Number.MAX_SAFE_INTEGER});
        if(metadata.error)throw new Error(metadata.error);
        const members=metadata.entries?.filter((entry:any)=>!entry.isDirectory);
        const totalBytes=members?.reduce((sum:number,entry:any)=>sum+entry.size,0);
        if(Array.isArray(members)&&members.every((entry:any)=>Number.isSafeInteger(entry.size)&&entry.size>=0)&&Number.isSafeInteger(totalBytes))totals={totalBytes,totalFiles:members.length};
      }
    }
    if(options.downloadBridge&&options.outputDirectory)throw new Error('Choose one output destination');
    if (options.downloadBridge) {
      if(op==='extract'&&totals&&totals.totalFiles!==1)throw new Error('Streamed download extraction requires exactly one file');
      direct=DirectOutput.downloadBridge(module,options.downloadBridge,totals);
      direct.mount('/out');module.FS.mkdir('/out/.work');
    }
    if (options.outputDirectory) {
      if (op !== 'extract') throw new Error('Direct output is only available for extraction');
      direct = await DirectOutput.create(module, options.outputDirectory, data.progressPort, totals);
      direct.mount('/out');
      module.FS.mkdir('/out/.work');
    }
    if (!direct && typeof navigator.storage?.getDirectory === 'function') {
      try { volume = await DiskVolume.create(module, temporaryDirectory); volume.mount('/out'); }
      catch (error) { volume?.close(); throw new Error('Could not open private browser disk storage: ' + (error as Error).message); }
    }
    if (!volume && !direct) {
      protectMemoryDirectories(module,module.FS.lookupPath('/out').node);
      const write = module.FS.write.bind(module.FS); let written = 0;
      module.FS.write = (stream: any, buffer: any, offset: number, length: number, position?: number, ...rest: any[]) => {
        if (stream.path?.startsWith('/out/')) {
          if ((position ?? stream.position) + length > MEMORY_LIMIT || written + length > MEMORY_LIMIT) throw new Error('This browser has no disk-backed filesystem. Output and scratch writes are limited to 128 MB.');
          written += length;
        }
        return write(stream, buffer, offset, length, position, ...rest);
      };
    }
    const inputBytes = files.reduce((total: number, file: File) => total + file.size, 0);
    if (!volume && !direct && ['repair', 'create'].includes(op) && inputBytes > MEMORY_LIMIT) throw new Error('Large repairs and creation require browser disk storage. This browser only supports the 128 MB memory fallback.');
    self.postMessage({ progress: { phase: op, message: options.downloadBridge?'Sending bytes to browser download':direct ? 'Streaming directly to selected folder' : volume ? 'Processing with private disk storage; originals stay unchanged' : 'Processing with bounded browser memory' } });
    const inputMetadata = op === 'create' ? files.map((file: File,index: number) => ({ name: names[index], ...(Number.isSafeInteger(file.lastModified) ? { modifiedTime: file.lastModified } : {}) })) : undefined;
    const request = { ...options, inputMetadata, op, paths: names.map(name => '/input/' + name), password: password ?? '', solid: solid ?? false, maxOutput: op==='list'?Number.MAX_SAFE_INTEGER:Math.min(budget.remaining,direct?budget.limit:volume?.quota??MEMORY_LIMIT) };
    const telemetry=installIoProgress(module,op,files,names,progress=>self.postMessage({progress:{...progress,inputReads:{...inputReads}}}),!!direct,totals);
    const result=runEngine(request);
    if(result.error){
      const budgetLimited=request.maxOutput===budget.remaining;
      if(budgetLimited&&/^(Archive (regular members|link copies) exceed output limit|[^\n]*output quota[^\n]*)$/i.test(result.error))throw budget.exceeded();
      throw new Error(result.error);
    }
    if (Array.isArray(result.entries)) result.metadata = result.entries;
    if (direct) {
      direct.finish(); direct.close(); volume?.close();
      self.postMessage({ ...result, writeBudgetUsed:budget.used, files: [], ...(options.downloadBridge?{downloadSent:true,sentBytes:direct.writtenBytes}:{savedFiles:direct.count}), metrics: { inputReads, diskBacked: !options.downloadBridge, streamed: !!options.downloadBridge, writtenBytes: direct.writtenBytes, wasmMemoryBytes: module.ccall('engine_heap_bytes', 'number', [], []) } });
      return;
    }
    telemetry.finish();
    const published=publicationPolicy(result.publishFiles);
    const directories: string[] = [];
    const walkDirectories = (path: string, prefix: string) => {
      for (const name of module.FS.readdir(path)) {
        if (name === '.' || name === '..' || (path === '/out' && name === '.work')) continue;
        const child = path + '/' + name;
        const mode = module.FS.lstat(child).mode;
        if (module.FS.isLink(mode)) throw new Error('Output links are not supported');
        if (module.FS.isDir(mode)) { if(!published.directories||published.directories.has(prefix+name))directories.push(prefix + name); walkDirectories(child, prefix + name + '/'); }
      }
    };
    walkDirectories('/out', '');
    let outputs: { name: string; blob: Blob }[] = [];
    if (volume) outputs = await volume.outputs('/out',published.files);
    else {
      const walk = (path: string, prefix: string) => {
        for (const name of module.FS.readdir(path)) {
          if (name === '.' || name === '..' || (path === '/out' && name === '.work')) continue;
          const next = path + '/' + name;
          if (module.FS.isDir(module.FS.stat(next).mode)) walk(next, prefix + name + '/');
          else if(!published.files||published.files.has(prefix+name))outputs.push({ name: prefix + name, blob: new Blob([module.FS.readFile(next)]) });
        }
      };
      walk('/out', '');
    }
    if(published.files&&(outputs.length!==published.files.size||outputs.some(file=>!published.files!.has(file.name))))throw new Error('Verified repair output is missing');
    const entryMetadata = new Map<string, EntryMetadata>((result.entries ?? []).map((entry: any) => [entry.name, entry.metadata]));
    const describedOutputs = outputs.map(file => ({ ...file, blob: preserveFileMetadata(file.blob, file.name, entryMetadata.get(file.name)), ...(entryMetadata.has(file.name) ? { metadata: entryMetadata.get(file.name) } : {}) }));
    self.postMessage({ ...result, writeBudgetUsed:budget.used, directories, files: describedOutputs, metrics: { inputReads, diskBacked: !!volume, wasmMemoryBytes: module.ccall('engine_heap_bytes', 'number', [], []) } });
  } catch (error) {
    try { direct?.close(); } catch {}
    try { volume?.close(); } catch {}
    self.postMessage({ writeBudgetUsed:budget?.used??0, outputLimited:!!budget?.failure, error: budget?.failure?.message??(error instanceof Error ? error.message : String(error)) });
  }
};
export {};
