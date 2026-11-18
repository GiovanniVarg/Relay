import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
/** Strips Telegram bot tokens (and `bot<token>` URLs) from any text that may be logged, returned or streamed. */
export const redactSecrets = (text: string) => text.replace(/(?:bot)?\d+:[A-Za-z0-9_-]{30,}/g, '[redacted]');
export function validPort(value: string | number): number { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > 65535 || !/^\d+$/.test(String(value))) throw new Error('PORT must be an integer from 1 to 65535'); return n; }
export class Security {
  sessions = new Map<string, { csrf: string; touched: number }>();
  constructor(public port: number) {}
  validate(req: IncomingMessage) {
    const hosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    if (!req.headers.host || !hosts.includes(req.headers.host)) throw new HttpError(403, 'Host is not allowed');
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'Origin is not allowed');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-origin requests are not allowed');
  }
  session(req: IncomingMessage) {
    const cookies=new Map((req.headers.cookie??'').split(';').map(s=>{const at=s.indexOf('=');return [s.slice(0,at).trim(),s.slice(at+1)]}));
    const token = cookies.get('relay_session_'+this.port)??cookies.get('relay_session');
    const session = token ? this.sessions.get(token) : undefined;
    if (!session || Date.now() - session.touched > 86400000) throw new HttpError(401, 'Open Relay to establish a local session');
    session.touched = Date.now();
    return session;
  }
  bootstrap(req: IncomingMessage, res: ServerResponse) {
    try { return this.session(req); } catch {}
    for (const [key, value] of this.sessions) if (Date.now() - value.touched > 86400000) this.sessions.delete(key);
    if (this.sessions.size >= 1000) throw new HttpError(429, 'Too many local sessions');
    const token = randomBytes(32).toString('hex'); const session = { csrf: randomBytes(32).toString('hex'), touched: Date.now() };
    this.sessions.set(token, session);
    res.setHeader('Set-Cookie', `relay_session_${this.port}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    return session;
  }
  mutation(req: IncomingMessage) {
    const session = this.session(req); const token = req.headers['x-csrf-token'];
    const supplied = typeof token === 'string' ? Buffer.from(token, 'utf8') : Buffer.alloc(0); const expected = Buffer.from(session.csrf, 'utf8');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(403, 'CSRF token is missing or invalid');
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json') && req.method !== 'DELETE') throw new HttpError(415, 'Expected application/json');
  }
}
// Only trusted server transports may retain bytes verified by a request signature.
const verifiedBodies=new WeakMap<IncomingMessage,Buffer>();
export function cacheVerifiedRequestBody(req:IncomingMessage,body:Buffer):void{if(verifiedBodies.has(req))throw new HttpError(409,'Request body was already verified');verifiedBodies.set(req,Buffer.from(body));}
export async function jsonBody(req: IncomingMessage,maxBytes=240000): Promise<Record<string, unknown>> {
  const verified=verifiedBodies.get(req);if(verified){if(verified.length>maxBytes)throw new HttpError(413,'Request body is too large');try{const body:unknown=JSON.parse(verified.toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body))throw new Error();return body as Record<string,unknown>;}catch{throw new HttpError(400,'Expected a JSON object');}}
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > maxBytes) throw new HttpError(413, 'Request body is too large'); chunks.push(bytes); }
  try { const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body as Record<string, unknown>; } catch { throw new HttpError(400, 'Expected a JSON object'); }
}
export function stringValue(value: unknown, name: string, max: number, min = 0): string { if (typeof value !== 'string' || value.length < min || value.length > max || value.includes('\u0000')) throw new HttpError(400, `${name} must be text between ${min} and ${max} characters`); return value; }
export function only(body: Record<string, unknown>, keys: string[]) { if (Object.keys(body).some(k => !keys.includes(k))) throw new HttpError(400, 'Unknown or read-only field'); }
