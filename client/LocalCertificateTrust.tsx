import { useEffect, useId, useRef, useState } from 'react';

type Api = <T>(path: string, method?: string, body?: unknown, options?: { signal?: AbortSignal; sensitive?: boolean }) => Promise<T>;
type LocalTrust = { platform: string; supported: boolean; trusted: boolean; fingerprint: string | null; certificateName: string; scope: 'current-user'; pending?: boolean };
export function LocalCertificateTrust({ api, fingerprint }: { api: Api; fingerprint?: string | null }) {
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  const id = useId(), lifecycle = useRef<AbortController | undefined>(undefined), working = useRef(false);
  const [status, setStatus] = useState<LocalTrust>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!local) return;
    const controller = new AbortController(); lifecycle.current = controller; working.current = false; setBusy(false); setStatus(undefined); setError('');
    void api<LocalTrust>('/network/local-trust', 'GET', undefined, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setStatus(value); }).catch(() => { if (!controller.signal.aborted) setError('Certificate trust could not be checked. Reopen this panel to retry.'); });
    return () => controller.abort();
  }, [api, local, fingerprint]);
  async function trust() {
    const controller = lifecycle.current;
    if (!status || !status.supported || !status.fingerprint || !controller || controller.signal.aborted || working.current) return;
    working.current = true; setBusy(true); setError('');
    try {
      const value = await api<LocalTrust>('/network/local-trust', 'POST', { fingerprint: status.fingerprint, confirm: true }, { signal: controller.signal });
      if (!controller.signal.aborted) setStatus(value);
    } catch { if (!controller.signal.aborted) setError('Trust was not confirmed. Check the Windows prompt, then try again.'); }
    finally { if (!controller.signal.aborted) { working.current = false; setBusy(false); } }
  }
  if (!local) return null;
  const ready = !!status?.fingerprint && status.trusted && !status.pending;
  return <section className="network-certificate" aria-labelledby={id} aria-busy={busy}>
    <div className="network-row"><h4 id={id}>This computer’s secure connection</h4><span className={`network-badge ${ready ? 'is-ready' : ''}`}>{ready ? 'Ready' : status?.pending ? 'Approval pending' : status ? status.fingerprint ? 'Trust once' : 'Enable connections' : 'Checking…'}</span></div>
    {!ready && <>
      <p className="network-muted">{status && !status.fingerprint ? 'Enable local connections below to create this host’s public certificate. Relay will check trust again when it is ready.' : status?.supported ? 'Install only this Relay public certificate for your current Windows user. Windows may ask you to approve it. Other devices need their own one-time trust setup.' : status ? 'Use the public certificate below to set up trust on this device. On iPhone, install its profile and enable it in Certificate Trust Settings.' : 'Checking whether this device trusts Relay’s public certificate.'}</p>
      {status?.supported && <><button className="network-primary" type="button" disabled={busy || !!status.pending || !status.fingerprint} onClick={() => void trust()}>{busy ? 'Waiting for Windows…' : 'Trust Relay on this computer'}</button>{status.fingerprint && <details><summary>Certificate to trust</summary><p className="network-muted">{status.certificateName} · Current user only</p><code>{status.fingerprint}</code></details>}</>}
    </>}
    {ready && <p className="network-muted" role="status">Relay’s certificate is trusted for this Windows user.</p>}
    {status?.pending && <p className="network-muted" role="status">Finish the Windows approval, then close and reopen this panel to check trust.</p>}
    {error && <p className="network-error" role="alert">{error}</p>}
  </section>;
}
