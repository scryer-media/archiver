/** A job paused because its output grew far past its input, waiting for the user's answer. */
export interface ExpansionPause {written:number;input:number;answer:(keep:boolean)=>void}

/** Asks through `show`, which draws the pause and later calls `answer`; the returned promise is the user's answer. */
export function askExpansion(show:(pause:ExpansionPause|undefined)=>void){
 return (written:number,input:number)=>new Promise<boolean>(resolve=>{
  let open=true;
  show({written,input,answer:keep=>{if(!open)return;open=false;show(undefined);resolve(keep);}});
 });
}
export function expansionMessage(pause:ExpansionPause,size:(bytes:number)=>string){
 const times=Math.floor(pause.written/Math.max(1,pause.input));
 return `Paused: ${size(pause.written)} written from ${size(pause.input)}, ${times.toLocaleString()}× its size. Archives built to fill a disk grow like this. Keep going only if you expect it to be this large.`;
}
