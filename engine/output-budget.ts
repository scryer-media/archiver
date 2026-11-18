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
/** A reasonable archive expands to at most this many times its own size before the user is asked. */
export const EXPANSION_RATIO = 100;
/** Output up to this size never asks, so small archives of very compressible data run straight through. */
export const EXPANSION_FLOOR = GIB;
/** After the user says keep going, the next question waits until the output is this many times larger again. */
export const EXPANSION_STEP = 10;
export const expansionCheckpoint = (inputBytes: number): number => Math.max(EXPANSION_FLOOR, inputBytes * EXPANSION_RATIO);
export const EXPANSION_STOPPED = 'Stopped: the output kept growing far past the size of its input.';
/** Shared between the page and a worker: [0] the answer (0 waiting, 1 keep going, 2 stop) and, from byte 8, the worker's next allowance. */
export interface ExpansionChannel { shared: SharedArrayBuffer; allowance: number }

/** Worker side: blocks a write that would pass the allowance until the page answers. */
export class ExpansionGate {
  private flag: Int32Array; private next: Float64Array; private allowance: number;
  stopped?: Error;
  constructor(channel: ExpansionChannel) { this.allowance = channel.allowance; this.flag = new Int32Array(channel.shared, 0, 1); this.next = new Float64Array(channel.shared, 8, 1); }
  check(total: number): void {
    if (this.stopped) throw this.stopped;
    while (total > this.allowance) {
      Atomics.store(this.flag, 0, 0);
      (self as unknown as Worker).postMessage({ expansion: { written: total } });
      Atomics.wait(this.flag, 0, 0);
      if (Atomics.load(this.flag, 0) !== 1) throw this.stopped = new Error(EXPANSION_STOPPED);
      this.allowance = this.next[0];
    }
  }
}

export class WriteBudget {
  readonly limit: number;
  used = 0;
  failure?:Error;
  /** Total output, across every stage of the job, at which the user is asked whether to keep going. */
  checkpoint?: number;
  ask?: (written: number) => Promise<boolean>;
  gate?: ExpansionGate;
  constructor(limit?: number, internalGrant = false) {
    if (internalGrant && Number.isSafeInteger(limit) && limit! >= 0) this.limit = limit!;
    else this.limit = outputLimit(limit);
  }
  get remaining(): number { return this.limit - this.used; }
  charge(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid output write size');
    this.gate?.check(this.used + bytes);
    if (bytes > this.remaining) throw this.exceeded();
    this.used += bytes;
  }
  exceeded():Error { return this.failure??=new Error('Write budget exceeded; temporary stages and scratch writes count too.'); }
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

/** Page side: the channel a job's worker pauses on, or nothing when this job has no question to ask or the page cannot share memory. */
export function expansionChannel(budget: WriteBudget): ExpansionChannel | undefined {
  if (budget.checkpoint === undefined || !budget.ask || typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) return;
  return { shared: new SharedArrayBuffer(16), allowance: Math.max(0, budget.checkpoint - budget.used) };
}
/** Without shared memory a worker cannot pause, so the question point becomes where it stops. */
export function expansionGrant(budget: WriteBudget, grant: number, channel?: ExpansionChannel): number {
  return !channel && budget.checkpoint !== undefined && budget.ask ? Math.min(grant, Math.max(0, budget.checkpoint - budget.used)) : grant;
}
/** Puts a paused worker's question to the user, then lets it keep going or stop. */
export async function answerExpansion(budget: WriteBudget, channel: ExpansionChannel, workerWritten: number, alive: () => boolean): Promise<void> {
  const total = budget.used + workerWritten;
  const keep = await (budget.ask?.(total) ?? Promise.resolve(false)).catch(() => false);
  if (!alive()) return;
  const flag = new Int32Array(channel.shared, 0, 1);
  if (keep) { budget.checkpoint = total * EXPANSION_STEP; new Float64Array(channel.shared, 8, 1)[0] = budget.checkpoint - budget.used; Atomics.store(flag, 0, 1); }
  else Atomics.store(flag, 0, 2);
  Atomics.notify(flag, 0);
}
