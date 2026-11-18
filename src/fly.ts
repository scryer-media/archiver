/** The hand-off from the Create screen to the queue: the new row grows in, the file rows fly down into it, and only then does the form clear. */
const MAX_GHOSTS=10,GROW=300,FLY=520,STAGGER=40;
const visible=(rect:DOMRect)=>rect.height>0&&rect.bottom>0&&rect.top<innerHeight;
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
// A page that is not painting never finishes an animation, so every wait also has a timer.
const settle=(animation:Animation,ms:number)=>Promise.race([animation.finished.then(()=>{},()=>{}),sleep(ms+120)]);

/** Grows `element` open from nothing: height, padding and opacity. */
function grow(element:HTMLElement){
 const style=getComputedStyle(element),height=element.offsetHeight;
 const animation=element.animate([{height:'0px',paddingTop:'0px',paddingBottom:'0px',opacity:0,overflow:'hidden'},{height:`${height}px`,paddingTop:style.paddingTop,paddingBottom:style.paddingBottom,opacity:1,overflow:'hidden'}],{duration:GROW,easing:'cubic-bezier(.2,0,0,1)'});
 return settle(animation,GROW);
}

/**
 * Runs the hand-off. `add` puts the job in the queue and returns the function that finds its row (the queue may redraw it).
 * `container` is the queue box when it was hidden before this job, so the whole box grows in rather than one row.
 */
export async function handOff(rows:Element[],add:()=>()=>Element|null,container?:HTMLElement){
 const find=add();
 if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
 const first=find() as HTMLElement|null;if(!first)return;
 first.scrollIntoView({block:'nearest',behavior:'smooth'});
 await grow(container&&!container.hidden?container:first);
 const target=find();if(!target)return;
 const end=target.getBoundingClientRect();
 const sources=rows.map(row=>({row:row as HTMLElement,rect:row.getBoundingClientRect()})).filter(item=>visible(item.rect)).slice(0,MAX_GHOSTS);
 const flights=sources.map(({row,rect},index)=>{
  const ghost=document.createElement('div');ghost.className='file-row fly-ghost';ghost.setAttribute('aria-hidden','true');
  if(row.classList.contains('file-row'))ghost.innerHTML=row.innerHTML;
  else{const name=document.createElement('span');name.className='file-name';name.textContent=(row.querySelector('.file-name')??row.querySelector('td,th'))?.textContent??'';ghost.append(name);}
  ghost.querySelectorAll('button,input,select').forEach(control=>control.remove());
  Object.assign(ghost.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});
  document.body.append(ghost);
  // The row leaves its list as its ghost lifts off.
  row.style.visibility='hidden';
  const scale=Math.min(1,end.width/rect.width),dx=end.left+end.width/2-(rect.left+rect.width/2),dy=end.top+end.height/2-(rect.top+rect.height/2);
  const flight=ghost.animate([{transform:'none',opacity:1},{transform:`translate(${dx*0.6}px,${dy*0.6}px) scale(${0.85*scale})`,opacity:0.9,offset:0.6},{transform:`translate(${dx}px,${dy}px) scale(${0.55*scale})`,opacity:0}],{duration:FLY,delay:index*STAGGER,easing:'cubic-bezier(.4,0,.2,1)',fill:'both'});
  return settle(flight,FLY+index*STAGGER).then(()=>ghost.remove());
 });
 await Promise.all(flights);
 const row=find();
 if(row){row.classList.remove('arrived');void (row as HTMLElement).offsetWidth;row.classList.add('arrived');}
}
