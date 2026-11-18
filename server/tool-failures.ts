/** Host-only error identity: a response body/status code cannot assert that a mutation never happened. */
const noEffects=new WeakMap<Error,'read_only'|'source_prewrite'>();
export function noEffectFailure(value:unknown,boundary:'read_only'|'source_prewrite'):Error {const error=value instanceof Error?value:new Error(String(value));noEffects.set(error,boundary);return error;}
export function noEffectBoundary(value:unknown){return value instanceof Error?noEffects.get(value):undefined;}
/** Use only around a tool operation whose responsible implementation cannot perform the requested mutation. */
export async function readOnlyOperation<T>(read:()=>T|Promise<T>):Promise<T>{try{return await read();}catch(error){throw noEffectFailure(error,'read_only');}}
