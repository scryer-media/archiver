export type Confidence='high'|'medium'|'unknown';
export type Filter='none'|'x86'|'arm'|'arm64'|'thumb'|'ia64'|'sparc'|'ppc'|'riscv';
export interface Detection {name:string;label:string;kind:'empty'|'compressed-media'|'compressed-archive'|'raw-audio'|'raw-image'|'text'|'executable'|'unknown';mime?:string;extension?:string;architecture?:string;suggestedFilter?:Filter;confidence:Confidence;reason:string;status:'detected'|'unknown'|'budget-exhausted'|'error';bytesRead:number}
export interface Recommendation {name:string;codec:'copy'|'deflate'|'lzma2';filter?:Filter;level?:number;dictionarySize?:number;deltaDistance?:number;label:string;reason:string;confidence:Confidence}
export function unknownDetection(name:string,reason='No reliable signature in the bounded sample.',status:Detection['status']='unknown'):Detection{return{name,label:'Unknown',kind:'unknown',confidence:'unknown',reason,status,bytesRead:0};}
export function recommendForFormat(detection:Detection,format:'zip'|'7z'):Recommendation {
 const store=['empty','compressed-media','compressed-archive'].includes(detection.kind);
 return {name:detection.name,codec:store?'copy':format==='zip'?'deflate':'lzma2',...(format==='7z'?{filter:store?'none':detection.suggestedFilter||'none'}:{}),label:detection.label,confidence:detection.confidence,reason:store?detection.reason+' Store avoids recompression work; it is not a guarantee of the smallest archive.':detection.reason+' General compression is a conservative starting point.'};
}
export const SNIFF_LIMITS=Object.freeze({initialBytes:512,bytesPerFile:65536,totalBytes:32*1024*1024,maxInspectedFiles:65536,batchSize:64,workerDeadlineMs:30000});
