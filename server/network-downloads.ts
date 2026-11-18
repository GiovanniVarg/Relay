import { createHash, X509Certificate } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import QRCode from 'qrcode';
import type { NetworkAccess } from './network-access.js';
import type { WorkerPublicProfile } from './worker-connection.js';
import { buildWorkerPackage } from './worker-package.js';
import { HttpError } from './security.js';

type PublicStatus = Pick<ReturnType<NetworkAccess['status']>, 'listening' | 'url' | 'publicCA' | 'fingerprint' | 'controllerOrigins'> & {
  transport?: { kind: 'webtransport-v1'; endpoint: string; pin: string } | null;
};
const denied = (status = 400): never => { throw new HttpError(status, 'Connection download unavailable'); };
export function connectionProfile(status: PublicStatus): WorkerPublicProfile {
  if (!status.listening || !status.url || !status.publicCA || !status.fingerprint || status.publicCA.length > 8192) return denied(409);
  try {
    const url = new URL(status.url), ca = new X509Certificate(status.publicCA.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0]??'');
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/'
      || !ca.ca || ca.subject !== ca.issuer || !ca.verify(ca.publicKey)
      || createHash('sha256').update(ca.raw).digest('hex') !== status.fingerprint) return denied(409);
    return { url: url.origin, ca: ca.toString(), fingerprint: status.fingerprint };
  } catch { return denied(409); }
}
export function connectionDestination(status: PublicStatus, origin: string): string {
  try {
    const site = new URL(origin);
    if (site.protocol !== 'https:' || site.origin !== origin || site.username || site.password
      || site.hostname.includes('*') || !status.controllerOrigins.includes(origin)) return denied();
  } catch { return denied(); }
  const profile = connectionProfile(status);
  let transport: NonNullable<PublicStatus['transport']> | undefined;
  if (status.transport) {
    const candidate = status.transport;
    if (candidate.kind !== 'webtransport-v1' || candidate.endpoint !== profile.url + '/relay' || !/^[a-f0-9]{64}$/.test(candidate.pin)) return denied(409);
    // Pin only the current leaf in QR: the bounded signed future catalog arrives over that pinned channel.
    transport = { kind: candidate.kind, endpoint: candidate.endpoint, pin: candidate.pin };
  }
  return origin + '/#connect=' + Buffer.from(JSON.stringify({ url: profile.url, ca: profile.ca, fingerprint: profile.fingerprint, ...(transport ? { transport } : {}) })).toString('base64url');
}
/** The app calls this only after its normal authenticated session / signed LAN guard. */
export async function networkDownloads(req: IncomingMessage, res: ServerResponse, url: URL,
  options: { access: Pick<NetworkAccess, 'status'>; installation: string }): Promise<boolean> {
  const qr = url.pathname === '/api/network/connection-qr', archive = url.pathname === '/api/network/worker-package';
  if (!qr && !archive) return false;
  if (req.method !== 'GET') return denied(405);
  const status = options.access.status();
  if (qr) {
    if ([...url.searchParams.keys()].some(key => key !== 'origin') || url.searchParams.getAll('origin').length !== 1) return denied();
    const destination = connectionDestination(status, url.searchParams.get('origin')!);
    let svg: string;
    try { svg = await QRCode.toString(destination, { type: 'svg', errorCorrectionLevel: 'M', margin: 3, width: 240 }); }
    catch { return denied(409); }
    if (Buffer.byteLength(svg) > 256 * 1024) return denied(409);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" }); res.end(svg); return true;
  }
  if (url.search) return denied();
  const bytes = await buildWorkerPackage(options.installation, connectionProfile(status));
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="Relay Worker.zip"',
    'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes); return true;
}
