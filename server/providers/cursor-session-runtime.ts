import type { ProviderRequest } from '../../shared/types.js';
import type { AppTools } from '../app-tools-bridge.js';
/** Process-private wire allowance reserves the reviewed future image envelope; it grants no image capability. */
export const CURSOR_WIRE_BYTES = 24 * 1024 * 1024;
export const CURSOR_SMALL_JSON_BYTES = 1024 * 1024;
/** V8 old space only. Native buffers, SDK subprocesses and total OS memory are not capped by this flag. */
export const CURSOR_WORKER_HEAP_MIB = 512;
export const CURSOR_JSON_LIMITS = Object.freeze({ depth: 32, nodes: 32768, entries: 4096, string: 8 * 1024 * 1024 });
export const CURSOR_CHECKPOINT_LOSS_WARNING = 'Local agent storage could not open its database, so this run is continuing in memory. Its checkpoint may be unavailable after the process exits.';
/** Bound graph traversal before stringify or a downstream SDK/legacy schema can expand issue lists. */
export function assertCursorJson(value: unknown, maxBytes: number = CURSOR_SMALL_JSON_BYTES): void {
 const active = new WeakSet<object>(); const stack: {value:unknown;depth:number;exit?:boolean}[] = [{value,depth:0}]; let nodes = 0, bytes = 0;
 const add = (count:number) => { bytes += count; if(bytes>maxBytes) throw new Error('Cursor JSON exceeds the byte safety limit'); };
 const string = (text:string) => { if(text.length>CURSOR_JSON_LIMITS.string) throw new Error('Cursor JSON string exceeds the safety limit'); add(2); for(let i=0;i<text.length;i++){const c=text.charCodeAt(i); if(c===34||c===92)add(2); else if(c<32)add([8,9,10,12,13].includes(c)?2:6); else if(c<128)add(1); else if(c<2048)add(2); else if(c>=0xd800&&c<=0xdbff){const next=text.charCodeAt(i+1);if(next>=0xdc00&&next<=0xdfff){add(4);i++;}else add(6);}else if(c>=0xdc00&&c<=0xdfff)add(6);else add(3);} };
 while(stack.length){const item=stack.pop()!;const entry=item.value;if(item.exit){active.delete(entry as object);continue;} if(++nodes>CURSOR_JSON_LIMITS.nodes||item.depth>CURSOR_JSON_LIMITS.depth)throw new Error('Cursor JSON graph exceeds the depth or node safety limit');
  if(entry===null||entry===undefined){add(4);continue;} if(typeof entry==='string'){string(entry);continue;}if(typeof entry==='boolean'){add(entry?4:5);continue;}if(typeof entry==='number'){if(!Number.isFinite(entry))throw new Error('Cursor JSON requires finite numbers');add(String(entry).length);continue;}
  if(typeof entry!=='object'||active.has(entry))throw new Error('Cursor JSON requires an acyclic data graph');
  const array=Array.isArray(entry);if(array&&Object.getPrototypeOf(entry)!==Array.prototype)throw new Error('Cursor JSON requires ordinary arrays');if(Object.getOwnPropertyDescriptor(entry,'toJSON'))throw new Error('Cursor JSON cannot contain custom serialization');if(!array&&Object.getPrototypeOf(entry)!==Object.prototype&&Object.getPrototypeOf(entry)!==null)throw new Error('Cursor JSON requires plain data objects');
  if(array&&entry.length>CURSOR_JSON_LIMITS.entries)throw new Error('Cursor JSON collection exceeds the entry safety limit');
  const keys=Object.keys(entry);if(array&&(keys.length!==entry.length||keys.some((key,index)=>key!==String(index))))throw new Error('Cursor JSON requires dense arrays');if(keys.length>CURSOR_JSON_LIMITS.entries)throw new Error('Cursor JSON collection exceeds the entry safety limit');
  active.add(entry);stack.push({value:entry,depth:item.depth,exit:true});add(2+Math.max(0,keys.length-1));
  for(const key of keys){const property=Object.getOwnPropertyDescriptor(entry,key)!;if(!('value'in property))throw new Error('Cursor JSON cannot contain accessor properties');if(!array){string(key);add(1);}stack.push({value:property.value,depth:item.depth+1});}
 }
}
/** Host-only callbacks are never serialized into the SDK operation or prompt. */
export function cursorRequestData(request: ProviderRequest): Omit<ProviderRequest,'appTools'|'interact'> & {appTools?:{definitions:AppTools['definitions']}} {
 const {appTools,interact:_interact,...wire}=request;return {...wire,...(appTools?{appTools:{definitions:appTools.definitions}}:{})};
}
export function boundedCursorAppTools(tools: AppTools): AppTools {
 if(!tools || typeof tools.call !== 'function') throw new Error('Relay app tools require a process-local host callback; this worker transport does not support them');
 assertCursorJson(tools.definitions);
 return {definitions:tools.definitions,async call(id,name,args){assertCursorJson(args);const result=await tools.call(id,name,args);assertCursorJson(result);return result;}};
}
