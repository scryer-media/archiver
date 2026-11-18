/** Calls `next` once the end of a long list scrolls near view, so the next rows load as the user scrolls instead of behind a button. */
export function loadOnScroll(sentinel:Element,next:()=>void){
 const scroller=sentinel.parentElement,root=scroller&&getComputedStyle(scroller).overflowY!=='visible'?scroller:null;
 const observer=new IntersectionObserver(entries=>{if(!entries.some(entry=>entry.isIntersecting))return;observer.disconnect();if(sentinel.isConnected)next();},{root,rootMargin:'0px 0px 400px 0px'});
 observer.observe(sentinel);
}
/** The quiet line at the end of a list that is still loading rows. */
export const moreLine=(shown:number,count:number)=>`Showing ${shown.toLocaleString()} of ${count.toLocaleString()}`;
