import type {Filter} from './model.ts';
export interface Executable {label:string;architecture?:string;filter?:Filter;reason:string}
const matches=(bytes:Uint8Array,values:number[])=>values.every((value,index)=>bytes[index]===value);
export function executableHeader(bytes:Uint8Array,fileSize:number):Executable|undefined {
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 const answer=(label:string,architecture?:string,filter?:Filter,reason='Executable architecture identified from its header.'):Executable=>({label,architecture,filter,reason});
 if(matches(bytes,[0x7f,69,76,70])){
  if(bytes.length<16||![1,2].includes(bytes[4])||![1,2].includes(bytes[5])||bytes[6]!==1)return answer('ELF (unrecognized header)',undefined,undefined,'ELF header is incomplete or unsupported; no instruction filter selected.');
  const wide=bytes[4]===2,little=bytes[5]===1,min=wide?64:52;
  if(bytes.length<min||view.getUint32(20,little)!==1||view.getUint16(wide?52:40,little)<min)return answer('ELF (incomplete header)',undefined,undefined,'ELF header validation was incomplete; no instruction filter selected.');
  const type=view.getUint16(16,little),machine=view.getUint16(18,little);
  if(![2,3].includes(type))return answer(type===4?'ELF core dump':'ELF object or data',undefined,undefined,'Core dumps and relocatable objects do not receive an automatic instruction filter.');
  const map:Record<number,[string,Filter,number,boolean]>={3:['x86','x86',1,true],62:['x86-64','x86',2,true],183:['ARM64','arm64',2,true],20:['PowerPC','ppc',1,false],21:['PowerPC64','ppc',2,false],2:['SPARC','sparc',1,false],18:['SPARC32+','sparc',1,false],43:['SPARC64','sparc',2,false],50:['IA-64','ia64',2,true]};
  if(machine===40)return answer('ELF · ARM','ARM',undefined,'The ELF ARM machine field does not distinguish ARM, Thumb or mixed code.');
  if(machine===243&&little)return answer('ELF · RISC-V','RISC-V','riscv');
  const arch=map[machine];if(arch&&arch[2]===bytes[4]&&arch[3]===little)return answer('ELF · '+arch[0],arch[0],arch[1]);
  return answer('ELF executable',undefined,undefined,'Architecture, class or byte order is unsupported for automatic filtering.');
 }
 if(matches(bytes,[77,90])){
  if(bytes.length<64)return answer('PE (incomplete header)',undefined,undefined,'PE architecture was outside the bounded sample.');
  const at=view.getUint32(60,true);
  if(at<64||at+24>bytes.length||at+24>fileSize||view.getUint32(at,true)!==0x4550)return answer('DOS or PE executable',undefined,undefined,'No complete valid PE header in the bounded sample.');
  const optional=view.getUint16(at+20,true),sections=view.getUint16(at+6,true),flags=view.getUint16(at+22,true);
  if(optional<2||at+24+optional>bytes.length||at+24+optional+sections*40>fileSize||sections===0||sections>96||!(flags&2))return answer('PE (unsupported header)',undefined,undefined,'PE header bounds or executable flags are unsupported.');
  const magic=view.getUint16(at+24,true),wide=magic===0x20b;if(![0x10b,0x20b].includes(magic)||optional<(wide?112:96))return answer('PE (unsupported header)',undefined,undefined,'PE optional header is unsupported.');
  const machine=view.getUint16(at+4,true);
  if([0xa641,0xa64e].includes(machine))return answer('PE · hybrid ARM64',undefined,undefined,'Hybrid ARM64EC/ARM64X images do not receive one automatic instruction filter.');
  const map:Record<number,[string,Filter,boolean]>={0x14c:['x86','x86',false],0x8664:['x86-64','x86',true],0x1c0:['ARM','arm',false],0x1c2:['Thumb','thumb',false],0x1c4:['Thumb-2','thumb',false],0xaa64:['ARM64','arm64',true],0x200:['IA-64','ia64',true]};
  const arch=map[machine];return arch&&arch[2]===wide?answer('PE · '+arch[0],arch[0],arch[1]):answer('PE executable',undefined,undefined,'PE machine type is unsupported for automatic filtering.');
 }
 if(bytes.length<4)return;
 const magic=view.getUint32(0,false);
 if([0xcafebabe,0xbebafeca,0xcafebabf,0xbfbafeca].includes(magic)&&bytes.length>=8){
  const little=[0xbebafeca,0xbfbafeca].includes(magic),wide=[0xcafebabf,0xbfbafeca].includes(magic),count=view.getUint32(4,little),entry=wide?32:20;
  if(count>0&&count<=32&&8+count*entry<=bytes.length){
   let valid=true;for(let index=0;index<count;index++){const at=8+index*entry,offset=wide?view.getBigUint64(at+8,little):BigInt(view.getUint32(at+8,little)),size=wide?view.getBigUint64(at+16,little):BigInt(view.getUint32(at+12,little));if(offset+size>BigInt(fileSize)||size===0n)valid=false;}
   if(valid)return answer('Universal Mach-O',undefined,undefined,'Universal binaries can contain several architectures; no single instruction filter selected.');
  }
 }
 if([0xfeedface,0xcefaedfe,0xfeedfacf,0xcffaedfe].includes(magic)){
  const little=[0xcefaedfe,0xcffaedfe].includes(magic),wide=[0xfeedfacf,0xcffaedfe].includes(magic),min=wide?32:28;
  if(bytes.length<min)return answer('Mach-O (incomplete header)',undefined,undefined,'Mach-O header is incomplete.');
  const type=view.getUint32(12,little),commands=view.getUint32(20,little);
  if(min+commands>fileSize||![2,6,7,8].includes(type))return answer('Mach-O object or data',undefined,undefined,'Only executable and shared-code Mach-O images receive automatic filters.');
  const cpu=view.getUint32(4,little),map:Record<number,[string,Filter,boolean,boolean]>={7:['x86','x86',false,true],0x1000007:['x86-64','x86',true,true],0x100000c:['ARM64','arm64',true,true],18:['PowerPC','ppc',false,false],0x1000012:['PowerPC64','ppc',true,false]};
  if(cpu===12)return answer('Mach-O · ARM','ARM',undefined,'ARM/Thumb interworking is ambiguous from this header.');
  const arch=map[cpu];return arch&&arch[2]===wide&&arch[3]===little?answer('Mach-O · '+arch[0],arch[0],arch[1]):answer('Mach-O executable',undefined,undefined,'Mach-O architecture or byte order is unsupported for automatic filtering.');
 }
}
