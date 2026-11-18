import {readFileSync} from 'node:fs';
// One static-host rule is also applied as real HTTP headers by local preview.
export function productionHeaders(){
 const lines=readFileSync(new URL('../public/_headers',import.meta.url),'utf8').trim().split(/\r?\n/);
 if(lines.shift()!=='/*')throw Error('Production headers must cover all static responses');
 const headers={};
 for(const line of lines){
  const match=line.match(/^\s+([A-Za-z-]+):\s+(.+)$/);
  if(!match||Object.keys(headers).some(name=>name.toLowerCase()===match[1].toLowerCase()))throw Error('Invalid or duplicate production header');
  headers[match[1]]=match[2];
 }
 return headers;
}
