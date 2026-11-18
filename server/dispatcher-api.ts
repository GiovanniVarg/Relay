import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Dispatcher } from './dispatcher.js';
import type { DispatcherInput } from '../shared/dispatcher.js';
import { HttpError, jsonBody, only, stringValue } from './security.js';
const send = (res: ServerResponse, data: unknown) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
/** Invoked only after the host's Origin/session/CSRF/startup/update gates. */
export async function dispatcherApi(req: IncomingMessage, res: ServerResponse, url: URL, service: Dispatcher): Promise<boolean> {
  const base = '/api/dispatcher';
  if (url.pathname !== base && !url.pathname.startsWith(base + '/')) return false;
  const path = url.pathname.slice(base.length), method = req.method ?? 'GET';
  if (path === '/submissions' && method === 'POST') {
    const body = await jsonBody(req); only(body, ['submissionId', 'prompt', 'agentId', 'draftId', 'attachmentIds']);
    const controller = new AbortController(), abort = () => controller.abort();
    req.once('aborted', abort); res.once('close', abort);
    try {
      if (req.aborted || res.destroyed) controller.abort();
      send(res, await service.submit(body as unknown as DispatcherInput, controller.signal));
    } finally { req.removeListener('aborted', abort); res.removeListener('close', abort); }
    return true;
  }
  const lookup = /^\/submissions\/([a-zA-Z0-9_-]{1,100})$/.exec(path);
  if (lookup && method === 'GET') { send(res, service.lookup(lookup[1])); return true; }
  if (path === '/jobs' && method === 'GET') {
    if ([...url.searchParams.keys()].some(key => key !== 'ids') || url.searchParams.getAll('ids').length !== 1) throw new HttpError(400, 'Supply task IDs');
    const ids = stringValue(url.searchParams.get('ids'), 'Task IDs', 10100).split(',').filter(Boolean);
    send(res, { receipts: service.status(ids) }); return true;
  }
  const cancel = /^\/jobs\/([a-zA-Z0-9_-]{1,100})\/cancel$/.exec(path);
  if (cancel && method === 'POST') { const body = await jsonBody(req); only(body, []); send(res, await service.cancel(cancel[1])); return true; }
  throw new HttpError(404, 'Dispatcher endpoint not found');
}
