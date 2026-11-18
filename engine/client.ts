import {WriteBudget,outputLimit,markOutputLimited} from './output-budget';
import { acquireStorageLease, cleanAbandonedStorage, removeStorage, type StorageLease } from './storage';
export interface EntryMetadata { modifiedTime?: number; createdTime?: number; changedTime?: number; accessedTime?: number; unixMode?: number; windowsAttributes?: number; uid?: number; gid?: number; owner?: string; group?: string; link?: { kind: 'symbolic' | 'hard' | 'copy' | 'unknown' | 'junction'; target?: string; targetIsDirectory?: boolean }; sparse?: { logicalSize: number; extents: { offset: number; length: number }[] } }
export interface ArchiveEntry { name: string; size: number; isDirectory: boolean; isLink?: boolean; metadata?: EntryMetadata }
export interface ExtractionOptions { outputLimitBytes?: number; links?: 'reject' | 'copy-safe'; streamBackend?: 'auto' | 'native' | 'wasm'; /** With a download stream: pack every extracted file into one ZIP. */ zipDownload?: boolean }
export interface EngineResult { writeBudgetUsed?: number; writeBudgetLimit?: number; downloadSent?: boolean; downloadName?: string; sentBytes?: number; savedFiles?: number; savedDirectory?: string; entries?: ArchiveEntry[]; metadata?: ArchiveEntry[]; directories?: string[]; files: { name: string; blob: Blob; metadata?: EntryMetadata }[]; message?: string; complete?: boolean; status?: string; sets?: unknown[]; metrics?: { inputReads?:{readCalls:number;backingReads:number;backingBytes:number;cacheHitBytes:number;peakCacheBytes:number}; diskBacked: boolean; streamed?: boolean; writtenBytes?: number; wasmMemoryBytes?: number } }
export interface EngineProgress { inputReads?:{readCalls:number;backingReads:number;backingBytes:number;cacheHitBytes:number;peakCacheBytes:number}; phase: string; message: string; writtenBytes?: number; processedBytes?: number; totalBytes?: number; outputBytes?: number; filesProcessed?: number; totalFiles?: number; unit?: 'input' | 'output'; percent?: number }
export interface FileCreateOptions { name: string; codec?: string; filter?: string; level?: number; dictionarySize?: number; deltaDistance?: number }
export interface CreateOptions extends ExtractionOptions { fileOptions?: FileCreateOptions[]; encryptHeaders?: boolean; level?: number; dictionarySize?: number; delivery?: 'download'; downloadStream?: WritableStream<Uint8Array>; outputDirectory?: FileSystemDirectoryHandle; directories?: string[]; format?: string; password?: string; solid?: boolean; codec?: string; blockSize?: number; recoveryPercent?: number; recoveryBlocks?: number; par3Codec?: 'cauchy' | 'fft'; protection?: 'par2' | 'par3' | 'par3-embedded'; replacement?: boolean; volumeScheme?: string; volumeCount?: number; volumeBlocks?: number; volumeBytes?: number; firstRecovery?: number; deduplication?: 'none' | 'aligned' | 'sliding'; storeData?: boolean; par3Interleave?: number; par3CapacityLog2?: number; memoryLimit?: number; filter?: string; deltaDistance?: number }
export const supportedFormats = { read: ['7z', 'rar', 'par3'], write: ['7z', 'par2'], repair: ['PAR2', 'PAR3', 'RAR recovery record', 'REV'] } as const;
let cleanup: Promise<void> | undefined;
export class ArchiveEngine {
  private worker?: Worker;
  private helper?: Worker;
  private helperStop?: ()=>void;
  private helperFail?: (reason:Error)=>void;
  private helperWriter?: WritableStreamDefaultWriter<Uint8Array>;
  private progressPort?: MessagePort;
  private active = false;
  private generation = 0;
  private leases: StorageLease[] = [];
  private pendingCleanup: Promise<boolean>[] = [];
  private reject?: (reason: Error) => void;
  constructor(private onProgress?: (progress: EngineProgress) => void, private jobBudget?:()=>WriteBudget|undefined) {}
  private stopHelper(reason=new Error('Download helper stopped')):void{
    this.helperStop?.();this.helperStop=undefined;this.helperFail?.(reason);this.helperFail=undefined;
    this.helper?.terminate();this.helper=undefined;
    const writer=this.helperWriter;this.helperWriter=undefined;
    if(writer)void writer.abort(reason).catch(()=>{}).finally(()=>{try{writer.releaseLock();}catch{}});
  }
  private run(op: string, files: File[], options: CreateOptions = {}): Promise<EngineResult> {
    if (this.active) return Promise.reject(new Error('An operation is already running'));
    let budget:WriteBudget;
    try{outputLimit(options.outputLimitBytes);budget=this.jobBudget?.()??new WriteBudget(options.outputLimitBytes);}catch(error){return Promise.reject(error);}
    const grant=budget.remaining;

    this.active = true;
    const generation = ++this.generation;
    return new Promise((resolve, reject) => {
      this.reject = reject;
      let ownedLease: StorageLease | undefined;
      void (async () => {
        cleanup ??= cleanAbandonedStorage().catch(() => {});
        await cleanup;
        const lease = await acquireStorageLease();
        if (generation !== this.generation) { lease.release(); return; }
        ownedLease = lease; this.leases.push(lease);
        const channel = (options.outputDirectory || options.downloadStream) ? new MessageChannel() : undefined;
        if (channel) this.progressPort=channel.port1;
        if (channel) channel.port1.onmessage = ({data}) => this.onProgress?.(data);
        const worker = this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        let finished=false,budgetRecorded=false,deliveryDone:Promise<void>|undefined;
        const finish = (error?: Error, result?: EngineResult) => {
          if (generation !== this.generation||finished||!this.active) return;
          finished=true;
          if(!result?.downloadSent&&result?.metrics?.writtenBytes!==undefined)this.onProgress?.({phase:'finalizing',message:'Finished writing selected folder',writtenBytes:result.metrics.writtenBytes,outputBytes:result.metrics.writtenBytes,filesProcessed:result.savedFiles,totalFiles:result.savedFiles});
          worker.terminate();this.stopHelper(error); channel?.port1.close(); this.progressPort=undefined; this.worker = undefined; this.active = false; this.reject = undefined;
          if (error) { this.pendingCleanup.push(removeStorage(lease)); this.leases = this.leases.filter(item => item !== lease); reject(error); }
          else resolve(result!);
        };
        worker.onmessage = ({ data }) => {
          if(generation!==this.generation||finished)return;
          if(data.progress){this.onProgress?.(data.progress);return;}
          try{if(!budgetRecorded){budget.record(data.writeBudgetUsed,grant);budgetRecorded=true;}}catch(error){finish(error===budget.failure?markOutputLimited(error as Error):error as Error);return;}
          if(data.error)finish(data.outputLimited===true?markOutputLimited(new Error(data.error)):new Error(data.error));else if(deliveryDone)void deliveryDone.then(()=>finish(undefined,data),error=>finish(error));else finish(undefined,data);
        };
        worker.onerror = event => finish(new Error(event.message || 'Archive worker failed'));
        worker.onmessageerror = () => finish(new Error('Archive worker response could not be decoded'));
        let downloadBridge:{shared:SharedArrayBuffer;port:MessagePort}|undefined;
        if(options.downloadStream){
          const downstream=this.helperWriter=options.downloadStream.getWriter();
          let completed!:()=>void,failed!:(reason:Error)=>void;
          deliveryDone=new Promise<void>((resolve,reject)=>{completed=resolve;failed=reject;});
          this.helperFail=failed;void deliveryDone.catch(error=>finish(error));
          const release=()=>{if(this.helperWriter===downstream)this.helperWriter=undefined;downstream.releaseLock();};
          // A transferable stream can acknowledge close before its downstream
          // close settles. Keep the authoritative completion on the main thread.
          const download=new WritableStream<Uint8Array>({
            async write(chunk){try{await downstream.write(chunk);}catch(error){failed(error as Error);throw error;}},
            async close(){try{await downstream.close();completed();}catch(error){failed(error as Error);throw error;}finally{release();}},
            async abort(reason){failed(reason instanceof Error?reason:new Error(String(reason)));try{await downstream.abort(reason);}finally{release();}},
          },{highWaterMark:1,size:chunk=>chunk.byteLength});
          if(!crossOriginIsolated||typeof SharedArrayBuffer==='undefined')throw new Error('Native streamed downloads require cross-origin isolation');
          const helper=this.helper=new Worker(new URL('./direct-output.worker.ts',import.meta.url),{type:'module'});
          const shared=new SharedArrayBuffer(16+1024*1024),commands=new MessageChannel();
          await new Promise<void>((ready,failed)=>{
            const timer=setTimeout(()=>failed(new Error('Download helper did not initialize')),30000);
            const abort=()=>{clearTimeout(timer);failed(new Error('Download helper initialization cancelled'));};this.helperStop=abort;
            helper.onmessage=({data})=>{if(data.ready){clearTimeout(timer);this.helperStop=undefined;ready();}};
            helper.onerror=event=>{clearTimeout(timer);failed(new Error(event.message||'Download helper failed'));};
            helper.onmessageerror=()=>{clearTimeout(timer);failed(new Error('Download helper message failed'));};
            try{helper.postMessage({init:true,download,zip:options.zipDownload===true,shared,commandPort:commands.port1,progress:channel?.port2},[download,commands.port1,...(channel?[channel.port2]:[])]);}catch(error){clearTimeout(timer);failed(error);}
          }).catch(error=>{commands.port2.close();throw error;});
          if(generation!==this.generation){helper.terminate();commands.port2.close();return;}
          helper.onerror=event=>finish(new Error(event.message||'Download helper failed'));
          helper.onmessageerror=()=>finish(new Error('Download helper message failed'));
          downloadBridge={shared,port:commands.port2};
        }
        // The writable stream goes straight from the responsive main thread to
        // its helper. Native WASM receives only a SAB and command port: passing
        // the stream through the blocked native worker would deadlock its proxy.
        const requestOptions={...options,outputLimitBytes:budget.limit,writeBudgetGrant:grant,downloadStream:undefined,downloadBridge};
        worker.postMessage({ op, files, password: options.password, solid: options.solid, options:requestOptions, names: files.map(file => file.webkitRelativePath || file.name), temporaryDirectory: lease.name, progressPort: downloadBridge?undefined:channel?.port2 }, downloadBridge?[downloadBridge.port]:channel?[channel.port2]:[]);
      })().catch(error => { if (generation === this.generation&&this.active) { this.worker?.terminate();this.stopHelper(); this.progressPort?.close(); this.progressPort=undefined; this.worker = undefined; this.active = false; this.reject = undefined; if (ownedLease) { this.pendingCleanup.push(removeStorage(ownedLease)); this.leases = this.leases.filter(item => item !== ownedLease); } reject(error); } });
    });
  }
  operate(op: 'embed' | 'verifyEmbedded' | 'repairEmbedded' | 'removeEmbedded' | 'rebuildParity', files: File[], options: CreateOptions = {}) { return this.run(op, files, options); }
  embed(files: File[], options?: CreateOptions) { return this.operate('embed', files, options); }
  verifyEmbedded(files: File[], options?: CreateOptions) { return this.operate('verifyEmbedded', files, options); }
  repairEmbedded(files: File[], options?: CreateOptions) { return this.operate('repairEmbedded', files, options); }
  removeEmbedded(files: File[], options?: CreateOptions) { return this.operate('removeEmbedded', files, options); }
  rebuildParity(files: File[], options?: CreateOptions) { return this.operate('rebuildParity', files, options); }
  list(files: File[], password?: string, format?: string, extractionOptions: ExtractionOptions = {}) { return this.run('list', files, { password, format, ...extractionOptions }); }
  extract(files: File[], password?: string, format?: string, outputDirectory?: FileSystemDirectoryHandle, downloadStream?: WritableStream<Uint8Array>, extractionOptions: ExtractionOptions = {}) { return this.run('extract', files, { password, format, outputDirectory, downloadStream, ...extractionOptions }); }
  create(files: File[], options?: CreateOptions) { return this.run('create', files, options); }
  verify(files: File[], options: CreateOptions = {}) { return this.run('verify', files, options); }
  repair(files: File[], password?: string, options: CreateOptions = {}) { return this.run('repair', files, { ...options, password }); }
  dispose(): Promise<boolean> {
    this.generation++; this.worker?.terminate();this.stopHelper(); this.progressPort?.close(); this.progressPort=undefined; this.worker = undefined; this.active = false;
    this.reject?.(new Error('Operation cancelled')); this.reject = undefined;
    const cleanup = [...this.pendingCleanup.splice(0), ...this.leases.splice(0).map(lease => removeStorage(lease))];
    return Promise.all(cleanup).then(results => results.every(Boolean));
  }
}
