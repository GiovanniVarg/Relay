import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Browser } from './browser.js';
import type { BrowserWatchEvent } from '../shared/browser-watch.js';

/** No application queue: each write is bounded, with no retained event history or frame. */
export function browserWatchStream(req: IncomingMessage, res: ServerResponse, browser: Browser, agentId: string): void {
  const maximum = 1024 * 1024;
  let closed = false, blocked = false, off: (() => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true; off?.();
    if (deadline) clearTimeout(deadline); if (heartbeat) clearInterval(heartbeat);
    req.removeListener('aborted', disconnect); res.removeListener('close', cleanup); res.removeListener('drain', drain);
  };
  const disconnect = () => { cleanup(); res.destroy(); };
  const drain = () => { blocked = false; if (deadline) clearTimeout(deadline); deadline = undefined; };
  const write = (value: string) => {
    if (closed) return;
    if (res.destroyed || res.writableLength + Buffer.byteLength(value) > maximum) { disconnect(); return; }
    if (blocked) return;
    try { if (!res.write(value)) { blocked = true; deadline = setTimeout(disconnect, 5000); deadline.unref(); } } catch { disconnect(); }
  };
  const deliver = (event: BrowserWatchEvent) => {
    if (closed) return;
    if (blocked) { if (event.type === 'status' || event.type === 'clear' || res.writableLength > maximum) disconnect(); return; }
    write('data: ' + JSON.stringify(event) + '\n\n');
    if (event.type === 'clear' && event.reason === 'shutdown' && !closed) { cleanup(); res.end(); }
  };
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  req.once('aborted', disconnect); res.once('close', cleanup); res.on('drain', drain);
  heartbeat = setInterval(() => write(': heartbeat\n\n'), 15000); heartbeat.unref();
  try { off = browser.watch(agentId, deliver); if (closed) off(); } catch (error) { cleanup(); res.end(); throw error; }
}
