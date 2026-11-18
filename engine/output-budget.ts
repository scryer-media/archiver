export const GIB = 1024 ** 3;
export const DEFAULT_OUTPUT_LIMIT = 20 * GIB;
export function outputLimit(value: number | undefined): number {
  const limit = value === undefined ? DEFAULT_OUTPUT_LIMIT : value;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Write budget must be a positive, finite whole number of bytes');
  return limit;
}
/** Marks an error as "the write budget ran out", so callers can tell it apart without reading the message. */
export function markOutputLimited<T>(error:T):T{if(error&&typeof error==='object')Object.assign(error,{outputLimited:true});return error;}
export function isOutputLimited(error:unknown):boolean{return !!error&&typeof error==='object'&&(error as {outputLimited?:unknown}).outputLimited===true;}
export class WriteBudget {
  readonly limit: number;
  used = 0;
  failure?:Error;
  constructor(limit?: number, internalGrant = false) {
    if (internalGrant && Number.isSafeInteger(limit) && limit! >= 0) this.limit = limit!;
    else this.limit = outputLimit(limit);
  }
  get remaining(): number { return this.limit - this.used; }
  charge(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid output write size');
    if (bytes > this.remaining) throw this.exceeded();
    this.used += bytes;
  }
  exceeded():Error { return this.failure??=new Error('Write budget exceeded. Raise Write budget in Advanced safety; temporary stages and scratch writes count too.'); }
  record(used: unknown, grant: number): void {
    if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0 || used > grant) throw new Error('Worker did not report a valid write-budget counter');
    this.charge(used);
  }
}
// Count bytes accepted into native output/scratch files, not archive claims.
// A seek beyond EOF also consumes its unwritten gap; overlap growth is not
// charged twice. Shrinks, deletion and cleanup never refund a job's allowance.
export function installWriteBudget(module: any, budget: WriteBudget): void {
  const fs = module.FS;
  const output = (node: any): boolean => { const path = fs.getPath(node); return path === '/out' || path.startsWith('/out/'); };
  const size = (node: any): number => { const value = node.node_ops.getattr(node).size; if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid native output size'); return value; };
  const write = fs.write.bind(fs);
  fs.write = (stream: any, buffer: any, offset: number, length: number, position?: number, ...rest: any[]) => {
    if (output(stream.node)) {
      const at = position === undefined ? stream.position : position;
      if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(at + length)) throw new Error('Invalid native write range');
      budget.charge(length === 0 ? 0 : length + Math.max(0, at - size(stream.node)));
    }
    return write(stream, buffer, offset, length, position, ...rest);
  };
  // Both path truncate and descriptor ftruncate (Rust File.set_len) converge
  // here. Wrapping only FS.truncate would leave the descriptor syscall open.
  const doTruncate = fs.doTruncate.bind(fs);
  fs.doTruncate = (stream: any, node: any, length: number) => {
    if (output(node)) {
      if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid native truncate size');
      budget.charge(Math.max(0, length - size(node)));
    }
    return doTruncate(stream, node, length);
  };
  if(typeof fs.mmap==='function'){
    const mmap=fs.mmap.bind(fs);
    fs.mmap=(stream:any,length:number,position:number,prot:number,flags:number)=>{
      if(output(stream.node)&&(prot&2))throw new Error('Writable output memory maps are not supported under a write budget');
      return mmap(stream,length,position,prot,flags);
    };
  }
  if (typeof fs.allocate === 'function') {
    const allocate = fs.allocate.bind(fs);
    fs.allocate = (stream: any, offset: number, length: number) => {
      if (output(stream.node)) {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(offset + length)) throw new Error('Invalid native allocation range');
        budget.charge(Math.max(0, offset + length - size(stream.node)));
      }
      return allocate(stream, offset, length);
    };
  }
}
