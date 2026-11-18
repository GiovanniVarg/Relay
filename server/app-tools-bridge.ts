import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { HttpError } from './security.js';

export interface AppTools {
  definitions: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  call(callId: string, name: string, args: unknown): Promise<unknown>;
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const cancelled = () => new Error('Relay app-tool connection closed or cancelled');
// The real Agent catalog includes app controls, workspace tools and up to 100 tools per MCP connection.
const MAX_TOOLS = 512;
const MAX_SERIALIZED_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_SERIALIZED_BYTES + 4096;
const encodedBytes = (value: string) => Buffer.byteLength(value, 'utf8');
// Only callback failures carry this marker. Session validation, replay and cancellation
// must remain fatal protocol errors rather than recoverable model-visible tool results.
export class AppToolExecutionError extends Error {
  constructor(cause: unknown) { super('Relay app action failed', { cause }); }
}
function authorityError(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 409 && /^(?:Agent tool authority expired$|This Agent run is no longer active; app action scope expired$|Tool call (?:ID|identity) (?:reused|was reused)\b)/.test(error.message)
    || error.status === 400 && /(?:too large|nested too deeply|too deeply nested)/i.test(error.message));
}
export function createAppToolSession(appTools: AppTools, signal: AbortSignal) {
  if (!appTools || typeof appTools.call !== 'function') throw new Error('Relay app tools require a process-local host callback; this worker transport does not support them');
  if (!Array.isArray(appTools.definitions) || !appTools.definitions.length || appTools.definitions.length > MAX_TOOLS
    || appTools.definitions.some(tool => !/^(?:relay_[A-Za-z0-9_]{1,60}|mcp_[a-f0-9]{28})$/.test(tool.name) || typeof tool.description !== 'string' || !object(tool.inputSchema))
    || new Set(appTools.definitions.map(tool => tool.name)).size !== appTools.definitions.length)
    throw new Error('Invalid Relay app-tool definitions');
  const serialized = JSON.stringify(appTools.definitions);
  if (encodedBytes(serialized) > MAX_SERIALIZED_BYTES) throw new Error('Relay app-tool definitions exceed the safety limit');
  const definitions: AppTools['definitions'] = JSON.parse(serialized);
  const names = new Set(definitions.map(tool => tool.name));
  const controller = new AbortController();
  const activeSignal = AbortSignal.any([signal, controller.signal]);
  const calls = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  const call = async (id: string, name: string, args: unknown, callSignal?: AbortSignal): Promise<unknown> => {
    const currentSignal = callSignal ? AbortSignal.any([activeSignal, callSignal]) : activeSignal;
    if (currentSignal.aborted) throw cancelled();
    if (typeof id !== 'string' || !id || id.length > 200 || !names.has(name)) throw new Error('Unknown or unavailable Relay app tool');
    if (!object(args)) throw new Error('Relay app-tool arguments must be an object');
    const fingerprint = JSON.stringify({ name, args });
    if (encodedBytes(fingerprint) > MAX_SERIALIZED_BYTES) throw new Error('Relay app-tool arguments exceed the safety limit');
    const previous = calls.get(id);
    if (previous && previous.fingerprint !== fingerprint) throw new Error('Relay app-tool replay changed the original call');
    if (!previous && calls.size >= 1000) throw new Error('Relay app-tool call limit exceeded');
    let abort!: () => void;
    const interrupted = new Promise<never>((_done, reject) => { abort = () => reject(cancelled()); currentSignal.addEventListener('abort', abort, { once: true }); });
    try {
      let result = previous?.result;
      if (!result) {
        result = Promise.resolve().then(async () => {
          if (currentSignal.aborted) throw cancelled();
          try { return await appTools.call(id, name, JSON.parse(JSON.stringify(args))); }
          catch (error) {
            if (currentSignal.aborted) throw cancelled();
            if (authorityError(error)) throw error;
            throw new AppToolExecutionError(error);
          }
        });
        calls.set(id, { fingerprint, result });
      }
      const value = await Promise.race([result, interrupted]);
      if (currentSignal.aborted) throw cancelled();
      const output = JSON.stringify(value ?? null);
      if (encodedBytes(output) > MAX_SERIALIZED_BYTES) throw new Error('Relay app-tool result exceeds the safety limit');
      return JSON.parse(output);
    } finally { currentSignal.removeEventListener('abort', abort); }
  };
  return { definitions, call, close: () => controller.abort() };
}

/** A private run-scoped MCP facade. Its bootstrap is never part of the model prompt. */
export async function createAppToolsBridge(appTools: AppTools, signal: AbortSignal, privateRoot: string) {
  const session = createAppToolSession(appTools, signal);
  if (signal.aborted) { session.close(); throw cancelled(); }
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(privateRoot, 'app-tools-'));
  const token = randomBytes(32).toString('hex');
  let listed!:()=>void;const ready=new Promise<void>(done=>{listed=done;});
  const server = createServer(async (request, response) => {
    const reply = (status: number, value: unknown) => { if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); } };
    if (request.method !== 'POST' || request.url !== '/' || request.headers.authorization !== `Bearer ${token}`) { reply(403, { error: 'Forbidden' }); return; }
    const controller = new AbortController(); response.once('close', () => controller.abort());
    try {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > MAX_REQUEST_BYTES) throw new Error('Request too large'); chunks.push(bytes); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (value.operation === 'list') { if (signal.aborted) throw cancelled(); reply(200, { tools: session.definitions });listed(); }
      else if (value.operation === 'call') reply(200, { value: await session.call(value.id, value.name, value.args, controller.signal) });
      else throw new Error('Unsupported operation');
    } catch { reply(400, { error: 'Relay app-tool request failed or was cancelled' }); }
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    session.close(); signal.removeEventListener('abort', abort);
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  })();
  const abort = () => { void close().catch(() => {}); };
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Relay app-tool bridge did not start');
    const bootstrap = join(directory, 'bootstrap.json');
    await writeFile(bootstrap, JSON.stringify({ url: `http://127.0.0.1:${address.port}/`, token }), { mode: 0o600, flag: 'wx' });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) throw cancelled();
    const development = import.meta.url.endsWith('.ts');
    const entry = fileURLToPath(new URL(`./app-tools-bridge-stdio.${development ? 'ts' : 'js'}`, import.meta.url));
    const loader = development ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [];
    return { ready,mcpConfig: { mcpServers: { relay_app: { command: process.execPath, args: [...loader, entry, bootstrap] } } },
      toolNames: session.definitions.map(tool => `mcp__relay_app__${tool.name}`), revoke: () => session.close(), close };
  } catch (error) { await close(); throw error; }
}


