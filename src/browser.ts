/** What this browser can do, so each screen offers only the options that will work here. */
export const canPickFolder=()=>'showDirectoryPicker' in window;
export const canCopy=()=>isSecureContext&&typeof navigator.clipboard?.writeText==='function';
// Without disk-backed browser storage the engine falls back to a 128 MiB memory limit; stay under it so the app's own budget trips first.
const MEMORY_CAPACITY=120*1024*1024;
/** How much output this tab can hold: most of the free browser storage, never more than `budget`. */
export async function tabCapacity(budget:number){
 if(typeof navigator.storage?.getDirectory!=='function')return Math.min(budget,MEMORY_CAPACITY);
 const estimate=await navigator.storage.estimate().catch(()=>undefined);
 if(estimate?.quota===undefined)return budget;
 return Math.min(budget,Math.max(0,Math.floor((estimate.quota-(estimate.usage||0))*0.8)));
}
/** A folder can be added to a new archive: through the folder picker, or a folder file input where there is none. */
export const canAddFolder=()=>canPickFolder()||'webkitdirectory' in HTMLInputElement.prototype;
/** Dragging files in only makes sense with a mouse or trackpad; touch-only devices choose instead. */
export const canDrop=()=>matchMedia('(hover: hover) and (pointer: fine)').matches;
