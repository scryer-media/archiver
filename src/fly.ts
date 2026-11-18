/** Rows that fly from the Create screen into the queue row that now holds them. */
const MAX_GHOSTS=10;
const visible=(rect:DOMRect)=>rect.height>0&&rect.bottom>0&&rect.top<innerHeight;

/** Snapshots the visible rows now, before the screen clears; the returned function sends them to the target once it is on the page. */
export function captureFlight(rows:Element[]):(target:()=>Element|null)=>void{
 if(matchMedia('(prefers-reduced-motion: reduce)').matches)return()=>{};
 const ghosts=rows.map(row=>({row,rect:row.getBoundingClientRect()})).filter(item=>visible(item.rect)).slice(0,MAX_GHOSTS).map(({row,rect})=>{
  const ghost=document.createElement('div');ghost.className='file-row fly-ghost';ghost.setAttribute('aria-hidden','true');
  if(row.classList.contains('file-row'))ghost.innerHTML=row.innerHTML;
  else{const name=document.createElement('span');name.className='file-name';name.textContent=(row.querySelector('.file-name')??row.querySelector('td,th'))?.textContent??'';ghost.append(name);}
  ghost.querySelectorAll('button,input,select').forEach(control=>control.remove());
  Object.assign(ghost.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});
  return ghost;
 });
 // The ghosts stand in for the rows while the screen clears underneath them.
 for(const ghost of ghosts)document.body.append(ghost);
 return find=>{
  const target=find();
  if(!target){for(const ghost of ghosts)ghost.remove();return;}
  target.scrollIntoView({block:'nearest'});
  const end=target.getBoundingClientRect();
  let landed=0;
  ghosts.forEach((ghost,index)=>{
   const start=ghost.getBoundingClientRect(),scale=Math.min(1,end.width/start.width),dx=end.left+end.width/2-(start.left+start.width/2),dy=end.top+end.height/2-(start.top+start.height/2);
   const flight=ghost.animate([{transform:'none',opacity:1},{transform:`translate(${dx*0.6}px,${dy*0.6}px) scale(${0.85*scale})`,opacity:0.85,offset:0.6},{transform:`translate(${dx}px,${dy}px) scale(${0.6*scale})`,opacity:0}],{duration:560,delay:index*45,easing:'cubic-bezier(.4,0,.2,1)',fill:'both'});
   let done=false;
   const land=()=>{if(done)return;done=true;ghost.remove();if(++landed<ghosts.length)return;
    // The queue may have redrawn its rows meanwhile, so pulse the row that is on the page now.
    const row=find();if(row){row.classList.remove('arrived');void (row as HTMLElement).offsetWidth;row.classList.add('arrived');}};
   flight.onfinish=flight.oncancel=land;
   // A page that is not painting never finishes the animation; the ghost still goes.
   setTimeout(land,560+index*45+400);
  });
 };
}
