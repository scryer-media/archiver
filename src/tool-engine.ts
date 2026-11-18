import {WriteBudget,markOutputLimited} from '../engine/output-budget';
import {chooseNativeStream} from './native-stream';
import {creationPlans} from '../engine/create-plan';
import { createDownload, type DownloadJob } from '../engine/download';
import { ArchiveEngine as NativeEngine, type EngineProgress, type EngineResult, type CreateOptions, type ExtractionOptions } from '../engine/client';
import { createDestination, removeDestination, type DestinationJob } from '../engine/destination';
import { acquireStorageLease, removeStorage, type StorageLease } from '../engine/storage';
/** The ZIP download's name: the archive's name without its archive extensions, such as `photos.part01.rar` → `photos.zip`. */
export function zipDownloadName(files:File[]):string{
  const first=[...files].map(file=>file.name).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))[0]??'';
  const stem=first.replace(/\.(tar\.[a-z0-9]+|tgz|zip|7z|rar|tar|r\d\d|z\d\d|\d{3})$/i,'').replace(/\.(part\d+|7z|zip|rar)$/i,'');
  return (stem||'extracted')+'.zip';
}
export class ArchiveEngine {
  private downloads: DownloadJob[] = [];
  private destinations: DestinationJob[] = [];
  private leases: StorageLease[] = [];
  private pendingCleanup: Promise<boolean>[] = [];
  private native: NativeEngine;
  private currentBudget?:WriteBudget;
  private temporaryNative = new Set<NativeEngine>();
  private stage='';
  private worker?: Worker;
  private pending = false;
  private busy = false;
  private decodedTar?: { input: File; file: File };
  private generation = 0;
  private cancellationEpoch = 0;
  private reject?: (error: Error) => void;
  constructor(private progress?: (progress: EngineProgress) => void) { this.native = new NativeEngine(update=>this.emitProgress(update),()=>this.currentBudget); }
  private emitProgress(update:EngineProgress):void { this.progress?.({...update,phase:this.stage?this.stage+':'+update.phase:update.phase}); }
  private fallback(op: string, files: File[], password?: string, format?: string, directories?: string[], outputDirectory?: FileSystemDirectoryHandle, downloadStream?: WritableStream<Uint8Array>, creation?: CreateOptions, extraction?:ExtractionOptions): Promise<EngineResult> {
    if (this.pending) return Promise.reject(new Error('An operation is already running'));
    this.pending = true;
    const generation = ++this.generation;
    const budget=this.currentBudget??new WriteBudget(creation?.outputLimitBytes??extraction?.outputLimitBytes),grant=budget.remaining;
    return new Promise((resolve, reject) => {
      this.reject = reject;
      let ownedLease: StorageLease | undefined;
      void acquireStorageLease().then(lease => {
        if (generation !== this.generation) { lease.release(); return; }
        ownedLease = lease; this.leases.push(lease);
        const worker = this.worker = new Worker(new URL('./fallback.worker.ts', import.meta.url), { type: 'module' });
        const finish = (error?: Error, result?: EngineResult) => {
          if (generation !== this.generation) return;
          worker.terminate(); this.worker = undefined; this.reject = undefined; this.pending = false;
          if (error) { this.pendingCleanup.push(removeStorage(lease)); this.leases = this.leases.filter(item => item !== lease); reject(error); }
          else resolve(result!);
        };
        worker.onmessage = ({ data }) => { if(generation!==this.generation)return;if (data.progress) { this.emitProgress(data.progress); return; }try{budget.record(data.writeBudgetUsed,grant);}catch(error){finish(error===budget.failure?markOutputLimited(error as Error):error as Error);return;} finish(data.error ? Object.assign(new Error(data.error),{nativeCodecError:data.nativeCodecError===true},data.outputLimited===true?{outputLimited:true}:{}) : undefined, data); };
        worker.onerror = event => finish(new Error(event.message || 'Archive worker failed'));
        worker.onmessageerror = () => finish(new Error('Archive worker response could not be decoded'));
        worker.postMessage({ writeBudgetGrant:grant,outputLimitBytes:budget.limit,op, files, names: files.map(file => file.webkitRelativePath || file.name), password, format, directories, outputDirectory, downloadStream, extraction, creation:creation?{fileOptions:creation.fileOptions,codec:creation.codec,filter:creation.filter,level:creation.level,dictionarySize:creation.dictionarySize,deltaDistance:creation.deltaDistance,encryptHeaders:creation.encryptHeaders}:undefined, storageId: lease.name },downloadStream?[downloadStream]:[]);
      }).catch(error => { if (generation === this.generation) { this.worker?.terminate(); this.worker = undefined; this.pending = false; this.reject = undefined; if (ownedLease) { this.pendingCleanup.push(removeStorage(ownedLease)); this.leases = this.leases.filter(item => item !== ownedLease); } reject(error); } });
    });
  }
  private async exclusive<T extends EngineResult>(action: () => Promise<T>,limit?:number): Promise<T> {
    if (this.busy) throw new Error('An operation is already running');
    const budget=this.currentBudget=new WriteBudget(limit);
    this.busy = true;this.stage='';
    const epoch = this.cancellationEpoch;
    try { const result=await action();return {...result,writeBudgetUsed:budget.used,writeBudgetLimit:budget.limit}; } finally { if (epoch === this.cancellationEpoch) {this.busy = false;this.stage='';this.currentBudget=undefined;} }
  }
  /** Looks at an archive before extraction: whether a streamed download can deliver it (a raw compressed stream, or exactly one regular file), and its expanded size when the archive lists one. */
  inspect(files: File[], password?: string, format?: string, options:ExtractionOptions={}) {
    return this.exclusive(async () => {
      if(this.isTarStream(files))return {complete:true,files:[],streamable:false,totalBytes:undefined as number|undefined};
      if(files.length===1&&(/\.(gz|zst|zstd|br|xz|bz2|bzip2|lzma|lz4|deflate|zlib)$/i.test(files[0].name)||!!format&&['gz','zstd','br','xz','bz2','lzma','lz4','deflate','zlib'].includes(format)))return {complete:true,files:[],streamable:true,totalBytes:undefined as number|undefined};
      const members=(await this.listInternal(files,password,format,options)).entries?.filter(entry=>!entry.isDirectory);
      const total=members?.reduce((sum,entry)=>sum+entry.size,0);
      return {complete:true,files:[],streamable:members?.length===1&&(!members[0].isLink||options.links==='copy-safe'),totalBytes:members?.every(entry=>Number.isSafeInteger(entry.size)&&entry.size>=0)&&Number.isSafeInteger(total)?total:undefined};
    },options.outputLimitBytes);
  }
  list(files: File[], password?: string, format?: string, options:ExtractionOptions={}) { return this.exclusive(() => this.listInternal(files, password, format,options),options.outputLimitBytes); }
  /**
   * Extracts an archive. `delivery: 'download'` streams its one file to the browser's Downloads;
   * `delivery: 'zip'` streams every file it holds as one ZIP, for browsers that cannot write to a folder.
   */
  extract(files: File[], password?: string, format?: string, destination?: FileSystemDirectoryHandle, delivery?: 'download'|'zip',options:ExtractionOptions={}) {
    return this.exclusive(async () => {
      if(delivery==='zip'&&!this.rawStream(files,format)){
        if(destination)throw new Error('Choose one output destination');
        return this.deliver(zipDownloadName(files),stream=>this.extractInternal(files,password,format,undefined,stream,{...options,zipDownload:true}));
      }
      if(delivery==='zip')delivery='download';
      if(delivery==='download'){
        if(destination)throw new Error('Choose one output destination');
        if(this.isTarStream(files))throw new Error('Streamed downloads of compressed TAR extraction are not supported; choose a folder');
        const epoch=this.cancellationEpoch;
        const raw=this.rawStream(files,format);
        let name=files[0]?.name.replace(/\.[^.]+$/,'')||'decoded.bin';
        if(!raw){
          const metadata=await this.listInternal(files,password,format,options),members=metadata.entries?.filter(entry=>!entry.isDirectory);
          if(!members||members.length!==1)throw new Error('Streamed download extraction requires exactly one file; choose a folder for multiple files');
          if(members[0].isLink===undefined&&!await this.fallbackFiles(files))throw new Error('Native runtime needs an update before safe streamed archive downloads are available');
          if(members[0].isLink&&options.links!=='copy-safe')throw new Error('Archive links are not downloaded');
          name=members[0].name;
          if(!name||name.startsWith('/')||/[\\\0:]/.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Unsafe archive output path');
        }
        this.checkEpoch(epoch);
        return this.deliver(name,stream=>this.extractInternal(files,password,format,undefined,stream,options));
      }
      if (!destination) return this.extractInternal(files,password,format,undefined,undefined,options);
      const epoch=this.cancellationEpoch;
      const browserInput=!format?await this.fallbackFiles(files):undefined;
      if(!this.isTarStream(files)&&(options.links==='copy-safe'||format==='zip'||format==='tar'||!format&&browserInput)){await this.listInternal(files,password,format,options);this.checkEpoch(epoch);}
      const job=await createDestination(destination);
      try {
        this.checkEpoch(epoch);this.destinations.push(job);
        const result=await this.extractInternal(files,password,format,job.directory,undefined,options);
        this.checkEpoch(epoch);
        this.destinations=this.destinations.filter(item=>item!==job);
        return {...result,savedDirectory:job.name};
      } catch(error) {
        const removed=await removeDestination(job);this.destinations=this.destinations.filter(item=>item!==job);
        if(!removed)throw new Error(String(error)+'; could not remove partial extraction directory '+job.name);
        throw error;
      }
    },options.outputLimitBytes);
  }
  create(files: File[], options: CreateOptions = {}) { return this.exclusive(() => {
    if(files.some(file=>!Number.isSafeInteger(file.size)||file.size<0))throw Error('Input file size is not supported by this browser');
    if(options.outputDirectory)throw Error('Archive creation does not support a selected output folder; choose a streamed download or prepared output');
    const plans=creationPlans(files.map(file=>file.webkitRelativePath||file.name),options);
    options={...options,fileOptions:plans.length?plans:undefined};
    if(options.format==='par3'||options.protection==='par3'||options.protection==='par3-embedded')throw new Error('PAR3 creation is not available; existing PAR3 sets can still be opened, verified and repaired.');
    if(options.delivery!=='download')return this.createInternal(files,options);
    const format=options.format||'zip',compressedTar=/^tar\.(gz|gzip|zstd|zst|br|brotli|xz|bz2|bzip2|lzma|lz4|deflate|zlib)$/.test(format),tarPackage=format==='tar'||compressedTar;
    if(!compressedTar&&!['zip','tar','gz','gzip','zstd','zst','br','brotli','xz','bz2','bzip2','lzma','lz4','deflate','zlib'].includes(format))throw new Error('This format needs seekable or staged output; choose the ordinary output workflow');
    if(tarPackage&&options.password)throw new Error('TAR does not support passwords; choose ZIP');
    const paths=[...files.map(file=>({name:file.webkitRelativePath||file.name,directory:false,size:file.size})),...(options.directories||[]).map(name=>({name,directory:true,size:0}))];
    if(!paths.length)throw new Error('Choose at least one file or directory');
    const seen=new Map<string,boolean>();
    for(const item of paths){
      const name=item.name;
      if(!name||name.startsWith('/')||/[\\\0:]/.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..')||seen.has(name))throw new Error('Unsafe or duplicate input path');
      seen.set(name,item.directory);

    }
    for(const name of seen.keys()){let slash=name.indexOf('/');while(slash!==-1){if(seen.get(name.slice(0,slash))===false)throw new Error('Input file/directory collision');slash=name.indexOf('/',slash+1);}}
    if(!compressedTar&&!['zip','tar'].includes(format)&&(files.length!==1||options.directories?.length||options.password))throw new Error('Standalone streams require one file and no password or directories');
    const name=compressedTar||['zip','tar'].includes(format)?'archive.'+format:(files[0]?.name||'archive')+'.'+format;
    return this.deliver(name,downloadStream=>this.createInternal(files,{...options,downloadStream}));
  },options.outputLimitBytes); }
  private async deliver(name:string,action:(stream:WritableStream<Uint8Array>)=>Promise<EngineResult>):Promise<EngineResult>{
    const epoch=this.cancellationEpoch,job=await createDownload(name);this.downloads.push(job);
    try{this.checkEpoch(epoch);const result=await action(job.writable);this.checkEpoch(epoch);return {...result,files:[],downloadSent:true,downloadName:job.name,message:'Sent to browser download; check the browser downloads list for final disk status'};}
    catch(error){job.cancel();throw error;}
    finally{job.release();this.downloads=this.downloads.filter(item=>item!==job);}
  }
  /** A lone compressed stream (not a TAR): it decodes to one file, so it never needs a ZIP. */
  private rawStream(files:File[],format?:string){return files.length===1&&!this.isTarStream(files)&&(/\.(gz|zst|zstd|br|xz|bz2|bzip2|lzma|lz4|deflate|zlib)$/i.test(files[0].name)||!!format&&['gz','zstd','br','xz','bz2','lzma','lz4','deflate','zlib'].includes(format));}
  private checkEpoch(epoch: number): void { if (epoch !== this.cancellationEpoch) throw new Error('Operation cancelled'); }
  private async fallbackFiles(files: File[]): Promise<File[] | undefined> {
    if (files.length !== 1) return;
    const file = files[0];
    if (/\.(zip|tar)$/i.test(file.name)) return files;
    const header = new Uint8Array(await file.slice(0, 512).arrayBuffer());
    if (header[0] === 0x50 && header[1] === 0x4b) return files;
    if (new TextDecoder().decode(header.slice(257, 262)) === 'ustar') return [new File([file], file.name + '.tar')];
  }
  private isTarStream(files: File[]) { return files.length === 1 && /(?:\.tar\.(gz|zst|zstd|br|xz|bz2|bzip2|lzma|lz4|deflate|zlib)|\.tgz)$/i.test(files[0].name); }
  private async decodeTar(file: File, password?: string, format?: string, epoch = this.cancellationEpoch): Promise<File> {
    this.checkEpoch(epoch);
    if (this.decodedTar?.input === file) return this.decodedTar.file;
    this.stage='decode-tar';
    const result = await this.native.extract([file], password, format);
    this.checkEpoch(epoch);
    if (result.files.length !== 1) throw new Error('Expected a single decompressed TAR stream');
    const decoded = new File([result.files[0].blob], 'archive.tar');
    this.decodedTar = { input: file, file: decoded };
    return decoded;
  }
  private async listInternal(files: File[], password?: string, format?: string,options:ExtractionOptions={}): Promise<EngineResult> {
    const epoch = this.cancellationEpoch;
    if (this.isTarStream(files)) { const decoded = await this.decodeTar(files[0], password, format, epoch); this.checkEpoch(epoch); this.stage='list-tar';return this.native.list([decoded],undefined,'tar',options); }
    const fallback = !format ? await this.fallbackFiles(files) : ['zip','tar'].includes(format) ? files.map(file => new File([file], 'archive.' + format)) : undefined;
    this.checkEpoch(epoch);
    if(format==='tar'||fallback?.[0]?.name.toLowerCase().endsWith('.tar'))return this.native.list(fallback||files,password,'tar',options);
    return fallback ? this.fallback('list', fallback, password,undefined,undefined,undefined,undefined,undefined,options) : this.native.list(files, password, format,options);
  }
  private async extractInternal(files: File[], password?: string, format?: string, outputDirectory?: FileSystemDirectoryHandle, downloadStream?: WritableStream<Uint8Array>,options:ExtractionOptions={}): Promise<EngineResult> {
    const epoch = this.cancellationEpoch;
    if (this.isTarStream(files)) {
      if(outputDirectory){
        const scratch='.archive-stream-'+crypto.randomUUID(),directory=await outputDirectory.getDirectoryHandle(scratch,{create:true});
        try{
          this.stage='decode-tar';await this.native.extract(files,password,format,directory);this.checkEpoch(epoch);
          const decoded:File[]=[];for await(const entry of (directory as any).values())if(entry.kind==='file')decoded.push(await entry.getFile());
          if(decoded.length!==1)throw new Error('Expected one decompressed TAR stream');
          this.stage='extract-tar';return await this.native.extract([new File([decoded[0]],'archive.tar')],undefined,'tar',outputDirectory,undefined,options);
        }finally{await outputDirectory.removeEntry(scratch,{recursive:true});}
      }
      const decoded = await this.decodeTar(files[0], password, format, epoch); this.checkEpoch(epoch); this.stage='extract-tar';return this.native.extract([decoded],undefined,'tar',undefined,downloadStream,options);
    }
    const streamFormat=format||files[0]?.name.toLowerCase().match(/\.(gz|zstd|zst|br|deflate|zlib|xz|bz2|bzip2|lzma|lz4)$/)?.[1];
    if(files.length===1&&streamFormat&&['gz','gzip','zstd','zst','br','brotli','deflate','zlib','xz','bz2','bzip2','lzma','lz4'].includes(streamFormat)){
      if(password&&options.streamBackend==='native')throw Error('Browser stream decompression does not support passwords');
      const direct=!!outputDirectory||!!downloadStream;
      if(!password&&chooseNativeStream(streamFormat,'decompress',options,direct)){
        this.stage='browser-decompress';
        try{return await this.fallback('extract',files,undefined,streamFormat,undefined,outputDirectory,downloadStream,undefined,options);}
        catch(error){this.checkEpoch(epoch);if(direct||options.streamBackend==='native'||!(error as {nativeCodecError?:boolean}).nativeCodecError)throw error;const removed=await Promise.all(this.pendingCleanup.splice(0));if(removed.some(value=>!value))throw Error('Could not remove failed browser decompression stage');this.checkEpoch(epoch);this.stage='wasm-decompress-retry';}
      }
      return this.native.extract(files,password,format,outputDirectory,downloadStream,options);
    }
    const fallback = !format ? await this.fallbackFiles(files) : ['zip','tar'].includes(format) ? files.map(file => new File([file], 'archive.' + format)) : undefined;
    this.checkEpoch(epoch);
    if(format==='tar'||fallback?.[0]?.name.toLowerCase().endsWith('.tar'))return this.native.extract(fallback||files,password,'tar',outputDirectory,downloadStream,options);
    return fallback ? this.fallback('extract', fallback, password, undefined, undefined, outputDirectory, downloadStream,undefined,options) : this.native.extract(files, password, format, outputDirectory, downloadStream,options);
  }
  private async createInternal(files: File[], options: CreateOptions = {}): Promise<EngineResult> {
    const epoch = this.cancellationEpoch;
    const aliases: Record<string, string> = { gzip: 'gz', bzip2: 'bz2', brotli: 'br', zst: 'zstd' };
    const requested = options.format || 'zip';
    const format = requested.startsWith('tar.') ? 'tar.' + (aliases[requested.slice(4)] || requested.slice(4)) : aliases[requested] || requested;
    options = { ...options, format };
    const streams = ['gz', 'zstd', 'br', 'xz', 'bz2', 'lzma', 'lz4', 'deflate', 'zlib'];
    if (format.startsWith('tar.') && streams.includes(format.slice(4))) {
      if (options.password) throw new Error('Compressed TAR streams do not support archive passwords. Choose ZIP or 7z.');
      const temporary=new NativeEngine(update=>this.emitProgress(update),()=>this.currentBudget);
      this.temporaryNative.add(temporary);
      try{
        this.stage='pack-tar';const result=await temporary.create(files,{format:'tar',directories:options.directories});
        this.checkEpoch(epoch);
        if(result.files.length!==1)throw Error('Expected one temporary TAR archive');
        const tar=new File([result.files[0].blob],'archive.tar');
        this.stage='compress-tar';return await this.createInternal([tar],{...options,fileOptions:undefined,directories:undefined,format:format.slice(4)});
      }finally{
        this.temporaryNative.delete(temporary);
        if(!await temporary.dispose()){this.pendingCleanup.push(Promise.resolve(false));throw Error('Could not remove intermediate TAR storage');}
      }
    }
    if (streams.includes(format) && (files.length !== 1 || options.directories?.length)) throw new Error('A standalone stream takes one file. Choose TAR with this compression format to package multiple files.');
    if(streams.includes(format)){
      if(options.password)throw Error('Standalone streams do not support archive passwords');
      if(chooseNativeStream(format,'compress',options)) {this.stage='browser-compress';return this.fallback('create',files,undefined,format,undefined,undefined,options.downloadStream,options);}
    }
    return ['7z', 'tar', 'par2', ...streams].includes(format) ? this.native.create(files, options) : this.fallback('create', files, options.password, format, options.directories,undefined,options.downloadStream,options);
  }
  operate(op: 'embed' | 'verifyEmbedded' | 'repairEmbedded' | 'removeEmbedded' | 'rebuildParity', files: File[], options?: CreateOptions) { return this.exclusive(() => this.native.operate(op, files, options),options?.outputLimitBytes); }
  embed(files: File[], options?: CreateOptions) { return this.operate('embed', files, options); }
  verifyEmbedded(files: File[], options?: CreateOptions) { return this.operate('verifyEmbedded', files, options); }
  repairEmbedded(files: File[], options?: CreateOptions) { return this.operate('repairEmbedded', files, options); }
  removeEmbedded(files: File[], options?: CreateOptions) { return this.operate('removeEmbedded', files, options); }
  rebuildParity(files: File[], options?: CreateOptions) { return this.operate('rebuildParity', files, options); }
  verify(files: File[], options?: CreateOptions) { return this.exclusive(() => this.native.verify(files, options),options?.outputLimitBytes); }
  repair(files: File[], password?: string, options?: CreateOptions) { return this.exclusive(() => this.native.repair(files, password, options),options?.outputLimitBytes); }
  dispose(): Promise<boolean> {
    for(const job of this.downloads.splice(0)){job.cancel();job.release();}
    this.decodedTar = undefined; this.currentBudget=undefined; this.busy = false; this.cancellationEpoch++; this.generation++; this.worker?.terminate(); this.worker = undefined; this.pending = false;
    this.reject?.(new Error('Cancelled')); this.reject = undefined; const nativeCleanup = this.native.dispose();
    const temporaryCleanup=[...this.temporaryNative].map(engine=>engine.dispose());this.temporaryNative.clear();
    const cleanup = [...temporaryCleanup, ...this.destinations.splice(0).map(job=>removeDestination(job)), ...this.pendingCleanup.splice(0), ...this.leases.splice(0).map(lease => removeStorage(lease)), nativeCleanup];
    return Promise.all(cleanup).then(results => results.every(Boolean));
  }
}
