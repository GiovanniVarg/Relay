import { HttpError } from './security.js';
// Only host admission creates this branded, attempt-bound proof, before any run/tool dispatch.
const rejected = new WeakMap<object, {taskId:string;attempt:number}>();
export function preDispatchConflict(message:string, identity?:{taskId:string;attempt:number}):HttpError {
 const error=new HttpError(409,message); if(identity)rejected.set(error,{...identity}); return error;
}
export function provenPreDispatch(error:unknown, taskId:string, attempt:number):boolean {
 const proof=typeof error==='object'&&error!==null?rejected.get(error):undefined;
 return proof?.taskId===taskId&&proof.attempt===attempt;
}
