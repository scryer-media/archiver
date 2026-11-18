// Packs extracted files into one ZIP as they are produced, so an archive with many files
// downloads through a single save prompt. Entries are stored, not compressed. Each file's
// CRC and size go in a data descriptor after its bytes, so nothing is buffered or seeked.
// ZIP64 records are written only where a size, offset or entry count needs them.

const CRC_TABLE=(()=>{const table=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0;}return table;})();
export function crc32(bytes:Uint8Array,crc=0):number{
 let c=~crc;
 for(let i=0;i<bytes.length;i++)c=CRC_TABLE[(c^bytes[i])&255]^(c>>>8);
 return (~c)>>>0;
}

const U32=0xffffffff,U16=0xffff;
const FLAGS_DESCRIPTOR=0x0808,FLAGS_UTF8=0x0800;
const VERSION_ZIP64=45,MADE_BY_UNIX=(3<<8)|VERSION_ZIP64;
const FILE_ATTRIBUTES=(0o100644<<16)>>>0,DIRECTORY_ATTRIBUTES=((0o40755<<16)|0x10)>>>0;

interface Entry {name:string;bytes:Uint8Array;offset:number;crc:number;size:number;directory:boolean;mtime:number}
class Bytes {
 private view:DataView;private at=0;readonly bytes:Uint8Array;
 constructor(length:number){this.bytes=new Uint8Array(length);this.view=new DataView(this.bytes.buffer);}
 u16(value:number){this.view.setUint16(this.at,value,true);this.at+=2;return this;}
 u32(value:number){this.view.setUint32(this.at,value>>>0,true);this.at+=4;return this;}
 u64(value:number){this.view.setBigUint64(this.at,BigInt(value),true);this.at+=8;return this;}
 raw(value:Uint8Array){this.bytes.set(value,this.at);this.at+=value.length;return this;}
}
/** MS-DOS date and time in local time; dates before 1980 clamp to 1980-01-01. */
function dosDateTime(ms:number){
 const date=new Date(ms);
 if(!Number.isFinite(ms)||date.getFullYear()<1980)return {time:0,date:(1<<5)|1};
 const year=Math.min(date.getFullYear(),2107);
 return {time:(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1),date:((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate()};
}
const unixSeconds=(ms:number)=>{const seconds=Math.floor(ms/1000);return seconds>=0&&seconds<=U32?seconds:undefined;};
const checkName=(name:string)=>{if(!name||name.startsWith('/')||/[\\\0]/.test(name)||name.replace(/\/$/,'').split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('Unsafe ZIP entry path: '+name);};

export class ZipStream {
 private offset=0;
 private entries:Entry[]=[];
 private byName=new Map<string,Entry>();
 private times=new Map<string,number>();
 private open?:Entry;
 private waitingDirectories:Entry[]=[];
 private done=false;
 private encoder=new TextEncoder();
 /** `sink` receives the ZIP bytes in order; `now` dates entries whose time is not known. */
 private sink:(bytes:Uint8Array)=>Promise<void>;
 private now:number;
 constructor(sink:(bytes:Uint8Array)=>Promise<void>,now=Date.now()){this.sink=sink;this.now=now;}
 get current(){return this.open?.name;}
 get currentSize(){return this.open?.size??0;}
 get fileCount(){return this.entries.filter(entry=>!entry.directory).length;}
 get bytesWritten(){return this.offset;}
 has(name:string){return this.byName.has(name);}
 /** Modification time in milliseconds for an entry, before or after it is written; the central directory carries it. */
 setTime(name:string,ms:number){if(Number.isFinite(ms))this.times.set(name,ms);const entry=this.byName.get(name)??this.byName.get(name+'/');if(entry&&Number.isFinite(ms))entry.mtime=ms;}
 private async emit(bytes:Uint8Array){if(!bytes.byteLength)return;await this.sink(bytes);this.offset+=bytes.byteLength;}
 private claim(name:string,directory:boolean):Entry{
  if(this.done)throw new Error('ZIP download is already finished');
  checkName(name);
  if(this.byName.has(name))throw new Error('Duplicate ZIP entry: '+name);
  const entry={name,bytes:this.encoder.encode(name),offset:0,crc:0,size:0,directory,mtime:this.times.get(name.replace(/\/$/,''))??this.now};
  if(entry.bytes.length>U16)throw new Error('ZIP entry path is too long: '+name);
  this.byName.set(name,entry);return entry;
 }
 private localHeader(entry:Entry){
  const {time,date}=dosDateTime(entry.mtime);
  return new Bytes(30+entry.bytes.length).u32(0x04034b50).u16(VERSION_ZIP64).u16(entry.directory?FLAGS_UTF8:FLAGS_DESCRIPTOR).u16(0).u16(time).u16(date)
   .u32(0).u32(0).u32(0).u16(entry.bytes.length).u16(0).raw(entry.bytes).bytes;
 }
 private async writeDirectory(entry:Entry){entry.offset=this.offset;this.entries.push(entry);await this.emit(this.localHeader(entry));}
 /** Adds a directory entry. While a file is open it is written right after that file ends. */
 async directory(name:string){
  const key=name.replace(/\/+$/,'')+'/';if(this.byName.has(key))return;
  const entry=this.claim(key,true);
  if(this.open)this.waitingDirectories.push(entry);else await this.writeDirectory(entry);
 }
 /** Starts a file entry, ending the open one first. */
 async begin(name:string){
  if(this.open)await this.end();
  const entry=this.claim(name,false);entry.offset=this.offset;this.entries.push(entry);this.open=entry;
  await this.emit(this.localHeader(entry));
 }
 async write(chunk:Uint8Array){
  const entry=this.open;if(!entry)throw new Error('No ZIP entry is open');
  entry.crc=crc32(chunk,entry.crc);entry.size+=chunk.byteLength;
  await this.emit(chunk);
 }
 /** Ends the open file entry with its data descriptor. */
 async end(){
  const entry=this.open;if(!entry)return;this.open=undefined;
  const wide=entry.size>=U32;
  const descriptor=new Bytes(wide?24:16).u32(0x08074b50).u32(entry.crc);
  if(wide)descriptor.u64(entry.size).u64(entry.size);else descriptor.u32(entry.size).u32(entry.size);
  await this.emit(descriptor.bytes);
  for(const directory of this.waitingDirectories.splice(0))await this.writeDirectory(directory);
 }
 /** Ends the open entry and writes the central directory. The sink receives no more bytes after this. */
 async finish(){
  if(this.done)return;
  await this.end();this.done=true;
  const start=this.offset;
  for(const entry of this.entries){
   const wideSize=entry.size>=U32,wideOffset=entry.offset>=U32;
   const zip64=(wideSize?16:0)+(wideOffset?8:0),seconds=unixSeconds(entry.mtime);
   const extraLength=(zip64?4+zip64:0)+(seconds===undefined?0:9);
   const {time,date}=dosDateTime(entry.mtime);
   const header=new Bytes(46+entry.bytes.length+extraLength).u32(0x02014b50).u16(MADE_BY_UNIX).u16(VERSION_ZIP64).u16(entry.directory?FLAGS_UTF8:FLAGS_DESCRIPTOR).u16(0).u16(time).u16(date)
    .u32(entry.crc).u32(wideSize?U32:entry.size).u32(wideSize?U32:entry.size).u16(entry.bytes.length).u16(extraLength).u16(0).u16(0).u16(0)
    .u32(entry.directory?DIRECTORY_ATTRIBUTES:FILE_ATTRIBUTES).u32(wideOffset?U32:entry.offset).raw(entry.bytes);
   if(zip64){header.u16(0x0001).u16(zip64);if(wideSize)header.u64(entry.size).u64(entry.size);if(wideOffset)header.u64(entry.offset);}
   if(seconds!==undefined)header.u16(0x5455).u16(5).raw(Uint8Array.of(1)).u32(seconds);
   await this.emit(header.bytes);
  }
  const size=this.offset-start,count=this.entries.length;
  if(count>=U16||size>=U32||start>=U32){
   const record=this.offset;
   await this.emit(new Bytes(56).u32(0x06064b50).u64(44).u16(MADE_BY_UNIX).u16(VERSION_ZIP64).u32(0).u32(0).u64(count).u64(count).u64(size).u64(start).bytes);
   await this.emit(new Bytes(20).u32(0x07064b50).u32(0).u64(record).u32(1).bytes);
  }
  await this.emit(new Bytes(22).u32(0x06054b50).u16(0).u16(0).u16(Math.min(count,U16)).u16(Math.min(count,U16)).u32(Math.min(size,U32)).u32(Math.min(start,U32)).u16(0).bytes);
 }
}
