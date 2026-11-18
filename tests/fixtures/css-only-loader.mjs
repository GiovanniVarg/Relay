/** SSR discards styles only; delegate every other module and error to Node/tsx. */
export async function load(url, context, nextLoad) {
  if (new URL(url).pathname.endsWith('.css')) return {format:'module',source:'export {};',shortCircuit:true};
  return nextLoad(url, context);
}
