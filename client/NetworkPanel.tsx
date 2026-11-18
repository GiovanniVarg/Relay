import { useEffect, useId, useRef, useState } from 'react';
import { LocalCertificateTrust } from './LocalCertificateTrust';

export const DEFAULT_CONTROLLER_ORIGIN = 'https://relay-controller-giovannivarg.vercel.app';
type Api = <T>(path: string, method?: string, body?: unknown,
  options?: { signal?: AbortSignal; sensitive?: boolean }) => Promise<T>;
interface Device {
  id: string; name: string; platform: string; role: 'controller' | 'worker';
  lastSeenAt: number; revokedAt: number | null;
}
interface NetworkStatus {
  enabled: boolean; listening: boolean; url: string | null; address: string; port: number;
  controllerOrigins: string[]; publicCA: string | null; fingerprint: string | null; error: string | null;
  interfaces: Array<{ name: string; address: string; netmask: string }>; devices: Device[];
  transport?: { kind: 'webtransport-v1'; endpoint: string; pin: string } | null; transportError?: string | null;
}
interface Computer {
  id: string; name: string; platform: string; online: boolean; ready: boolean; modelCount: number;
}
interface Provider {
  id: 'openai' | 'claude' | 'cursor' | 'opencode';
  models: Array<{ id: string; name: string; available: boolean; modalities: string[] }>;
}
interface Invite { code: string; expiresAt: number; role: 'controller' | 'worker' }
interface ConnectionProfile { url: string; ca: string; fingerprint: string; transport?: NonNullable<NetworkStatus['transport']> }
const PROVIDER_NAMES: Record<Provider['id'], string> = {
  openai: 'OpenAI', claude: 'Claude', cursor: 'Cursor', opencode: 'OpenCode',
};

function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
      && !url.hostname.includes('*') ? url.origin : null;
  } catch { return null; }
}
function profileLink(origin: string, profile: ConnectionProfile): string {
  const bytes = new TextEncoder().encode(JSON.stringify(profile));
  const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${origin}/#connect=${encoded}`;
}
function lastSeen(value: number): string {
  if (!Number.isFinite(value)) return 'Not yet seen';
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function ComputerCard({ computer, api }: { computer: Computer; api: Api }) {
  const [expanded, setExpanded] = useState(false);
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!expanded || providers !== null) return;
    const controller = new AbortController();
    setLoading(true); setError(false);
    void api<{ providers: Provider[] }>(`/network/computers/${encodeURIComponent(computer.id)}/models`,
      'GET', undefined, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setProviders(result.providers);
    }).catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, computer.id, expanded, providers]);
  const filter = query.trim().toLowerCase();
  const filtered = (providers ?? []).map(provider => ({ ...provider,
    models: provider.models.filter(model => `${provider.id} ${model.name} ${model.id}`.toLowerCase().includes(filter)),
  })).filter(provider => provider.models.length > 0);
  return <article className="network-computer">
    <div className="network-row">
      <div className="network-grow"><h4>{computer.name}</h4><p className="network-muted">{computer.platform} · {computer.modelCount} models</p></div>
      <span className={`network-badge ${computer.online && computer.ready ? 'is-ready' : ''}`}>
        {!computer.online ? 'Offline' : computer.ready ? 'Ready' : 'Setup needed'}
      </span>
    </div>
    {!computer.ready && <p className="network-muted">Finish setup and sign in to providers on this computer.</p>}
    <details onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>Models and setup</summary>
      {expanded && <div className="network-model-details">
        <p className="network-muted">This computer uses its own official CLI logins and subscription approvals.</p>
        {loading && <p role="status">Loading models…</p>}
        {error && <p className="network-error" role="alert">Models could not load. Close and reopen these details to retry.</p>}
        {providers !== null && <>
          <label className="network-field">Filter models
            <input type="search" value={query} onChange={event => setQuery(event.target.value)}
              placeholder="Model or provider name" aria-label={`Filter models on ${computer.name}`} />
          </label>
          <div className="network-model-list" tabIndex={0} aria-label={`Models on ${computer.name}`}>
            {filtered.map(provider => <section key={provider.id}>
              <h5>{PROVIDER_NAMES[provider.id]}</h5>
              <ul>{provider.models.map(model => <li key={model.id}>
                <span className="network-grow"><strong>{model.name || model.id}</strong>
                  {model.name && model.name !== model.id && <small>{model.id}</small>}</span>
                <span className="network-muted">{model.available ? 'Available' : 'Not ready'}</span>
              </li>)}</ul>
            </section>)}
            {!filtered.length && <p className="network-muted">{filter ? 'No models match this filter.' : 'No models reported yet.'}</p>}
          </div>
        </>}
      </div>}
    </details>
  </article>;
}

export function NetworkPanel({ api, phoneOnly = false }: { api: Api; phoneOnly?: boolean }) {
  const id = useId();
  const [tab, setTab] = useState<'controller' | 'computer' | 'devices'>('controller');
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  const [computers, setComputers] = useState<Computer[]>([]);
  const [address, setAddress] = useState('');
  const [port, setPort] = useState('3443');
  const [controllerOrigin, setControllerOrigin] = useState(DEFAULT_CONTROLLER_ORIGIN);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState(false);
  const [computerError, setComputerError] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const initialized = useRef(false);
  const working = useRef(false);
  const sequence = useRef(0);
  const lifecycle = useRef<{ controller: AbortController | null; generation: number }>({ controller: null, generation: 0 });
  const refresh = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++lifecycle.current.generation;
    lifecycle.current.controller = controller;
    working.current = false;
    setBusy(null);
    let polling = false;
    const update = async () => {
      if (polling || working.current || controller.signal.aborted) return;
      polling = true;
      const request = ++sequence.current;
      try {
        const results = await Promise.allSettled([
          api<NetworkStatus>('/network', 'GET', undefined, { signal: controller.signal }),
          api<{ computers: Computer[] }>('/network/computers', 'GET', undefined, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted || request !== sequence.current || generation !== lifecycle.current.generation) return;
        if (results[0].status === 'fulfilled') {
          const current = results[0].value;
          setStatus(current); setPollError(false);
          if (!initialized.current) {
            initialized.current = true;
            setAddress(current.address || current.interfaces[0]?.address || '');
            setPort(String(current.port || 3443));
            setControllerOrigin(current.controllerOrigins[0] || DEFAULT_CONTROLLER_ORIGIN);
          }
        } else setPollError(true);
        if (results[1].status === 'fulfilled') { setComputers(results[1].value.computers); setComputerError(false); }
        else setComputerError(true);
      } finally { polling = false; }
    };
    refresh.current = update;
    void update();
    const timer = setInterval(() => { void update(); }, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api]);

  useEffect(() => {
    if (!invite) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [invite]);
  useEffect(() => setQrFailed(false), [status?.url, status?.controllerOrigins[0], status?.transport?.pin]);

  async function action(label: string, operation: (signal: AbortSignal) => Promise<void>) {
    const controller = lifecycle.current.controller;
    if (!controller || controller.signal.aborted || working.current) return;
    const generation = lifecycle.current.generation;
    working.current = true; ++sequence.current;
    setBusy(label); setError(null); setFeedback(null);
    try { await operation(controller.signal); }
    catch { if (!controller.signal.aborted) setError('That action could not finish. Check the host connection and try again.'); }
    finally {
      if (!controller.signal.aborted && lifecycle.current.generation === generation) {
        working.current = false; setBusy(null); void refresh.current();
      }
    }
  }
  function enable() {
    const origin = httpsOrigin(controllerOrigin.trim());
    const value = Number(port);
    if (!address) { setError('Choose a LAN address on this computer.'); return; }
    if (!Number.isInteger(value) || value < 1024 || value > 65535) { setError('Choose a port from 1024 to 65535.'); return; }
    if (!origin) { setError('Use an HTTPS website origin without a path, such as https://relay.example.com.'); return; }
    void action('enable', async signal => {
      const result = await api<NetworkStatus>('/network/enable', 'POST', { address, port: value, controllerOrigins: [origin] }, { signal });
      if (!signal.aborted) { if (result.interfaces) setStatus(result); setFeedback('Connection settings requested. Host status will update shortly.'); }
    });
  }
  function disable() {
    void action('disable', async signal => {
      await api('/network/disable', 'POST', {}, { signal });
      if (!signal.aborted) { setInvite(null); setFeedback('Disconnection requested. Accepted background jobs can continue on workers.'); }
    });
  }
  function createInvite(role: Invite['role']) {
    void action('invite', async signal => {
      const result = await api<{ code: string; expiresAt: number }>('/network/invites', 'POST', { role }, { signal, sensitive: true });
      if (!/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){2}$/.test(result.code)
        || !Number.isFinite(result.expiresAt)) throw new Error('Invalid invite');
      if (!signal.aborted) setInvite({ ...result, role });
    });
  }
  function revoke(device: Device) {
    void action('revoke', async signal => {
      await api(`/network/devices/${encodeURIComponent(device.id)}`, 'DELETE', undefined, { signal });
      if (!signal.aborted) { setConfirmRevoke(null); setFeedback('Device access disconnected.'); }
    });
  }
  async function copyCode() {
    if (!invite || invite.expiresAt <= Date.now()) return;
    const signal = lifecycle.current.controller?.signal;
    try {
      await navigator.clipboard.writeText(invite.code);
      if (!signal?.aborted) setFeedback('Connection code copied.');
    } catch { if (!signal?.aborted) setError('Clipboard access is unavailable. Select the code to copy it.'); }
  }
  const active = !!status?.listening;
  const profile: ConnectionProfile | null = status?.url && status.publicCA && status.fingerprint
    ? { url: status.url, ca: status.publicCA, fingerprint: status.fingerprint } : null;
  const origin = httpsOrigin(status?.controllerOrigins[0] || DEFAULT_CONTROLLER_ORIGIN);
  const pairingReady = active && status?.transport?.kind === 'webtransport-v1';
  const controllerProfile = profile && status?.transport ? { ...profile, transport: status.transport } : null;
  const link = pairingReady && controllerProfile && origin ? profileLink(origin, controllerProfile) : null;
  const legacyLink = active && profile && origin ? profileLink(origin, profile) : null;
  function downloadProfile() {
    if (!profile) return;
    const blob = new Blob([JSON.stringify(profile, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'relay-connection.json'; document.body.appendChild(anchor);
    anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
  }
  const shownInvite = invite && invite.role === (tab === 'computer' ? 'worker' : 'controller') && tab !== 'devices' ? invite : null;
  const expired = !!shownInvite && shownInvite.expiresAt <= now;
  const devices = status?.devices ?? [];
  const unavailableAddress = !!address && !status?.interfaces.some(nic => nic.address === address);

  return <div className={`network-panel${phoneOnly ? ' network-phone' : ''}`}>
    <div className="network-intro">
      <div className="network-row"><strong>One Relay host. Your own devices.</strong>
        <span className={`network-badge ${active ? 'is-ready' : ''}`}>{active ? 'Connections on' : status ? 'Connections off' : 'Loading…'}</span></div>
      <p>Keep your devices on the same local network. A paired controller can use this host’s chats, files, terminal, and AI tools.</p>
    </div>
    <div className="network-notices" aria-live="polite">
      {error && <p className="network-error" role="alert">{error}</p>}
      {feedback && <p className="network-feedback" role="status">{feedback}</p>}
      {pollError && <p className="network-error" role="alert">Host status could not refresh. Connection details may be out of date.</p>}
      {status?.error && <p className="network-error" role="alert">Connections could not start. Check that this computer is connected to your local network.</p>}
    </div>
    {!phoneOnly && <div className="network-tabs" role="tablist" aria-label="Connection type">
      {(['controller', 'computer', 'devices'] as const).map(value => <button key={value} type="button" role="tab"
        id={`${id}-tab-${value}`} aria-controls={`${id}-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
        onKeyDown={event => {
          const tabs = ['controller', 'computer', 'devices'] as const;
          const current = tabs.indexOf(value);
          const next = event.key === 'ArrowRight' ? tabs[(current + 1) % tabs.length]
            : event.key === 'ArrowLeft' ? tabs[(current + tabs.length - 1) % tabs.length]
              : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[2] : undefined;
          if (next) { event.preventDefault(); setTab(next); document.getElementById(`${id}-tab-${next}`)?.focus(); }
        }}
        onClick={() => { setTab(value); setError(null); setFeedback(null); }}>
        {value === 'controller' ? 'Controller' : value === 'computer' ? 'Computer' : 'Trusted devices'}
      </button>)}
    </div>}
    <section className="network-choice" role={phoneOnly ? 'region' : 'tabpanel'} id={`${id}-panel-${tab}`}
      aria-label={phoneOnly ? 'Phone connection' : undefined} aria-labelledby={phoneOnly ? undefined : `${id}-tab-${tab}`}>
      {tab === 'controller' && <>
        <h3>{phoneOnly ? 'Scan to connect your phone' : 'Use this host from your phone or browser'}</h3>
        <p>Scan the QR, allow Local Network access if asked, then enter the one-time code below. Next time, Relay reconnects automatically.</p>
        {!active ? <button className="network-primary" type="button" onClick={enable} disabled={!!busy || !status || !address}>
          {busy === 'enable' ? 'Enabling…' : 'Enable local connections'}</button> : !pairingReady ? <div className="network-error" role="alert"><strong>Simple pairing is not ready</strong><p>{status?.transportError || 'Restart Relay to finish starting its secure local connection. Legacy connection options are available under Advanced.'}</p></div> : <>
          <div className="network-onboarding">
            <div className="network-grow">
              <h4>1. Scan to open Relay</h4>
              {link && <a className="network-button network-primary" href={link} target="_blank" rel="noopener noreferrer">Open controller website</a>}
              <p className="network-muted">No certificate installation needed. On iPhone, use Safari → Share → Add to Home Screen to keep Relay as an app.</p>
            </div>
            {link && !qrFailed && <figure className="network-qr">
              <img src={`/api/network/connection-qr?origin=${encodeURIComponent(origin!)}`} width="160" height="160"
                alt="QR code for the controller website and public host connection details" onError={() => setQrFailed(true)} />
              <figcaption>Public connection details only. Enter the code separately.</figcaption>
            </figure>}
          </div>
          <h4>2. Create your one-time code</h4>
          <button className="network-primary" type="button" onClick={() => createInvite('controller')} disabled={!!busy}>
            {busy === 'invite' ? 'Creating code…' : phoneOnly ? 'Connect phone' : 'Connect phone or browser'}</button>
        </>}
      </>}
      {tab === 'computer' && <>
        <h3>Add a computer as an @remote job target</h3>
        <p>Each computer runs jobs with its own official CLI logins and subscription approvals. Controller credentials and provider accounts are not copied.</p>
        {!active ? <button className="network-primary" type="button" onClick={enable} disabled={!!busy || !status || !address}>
          {busy === 'enable' ? 'Enabling…' : 'Enable local connections'}</button> : <>
          <ol className="network-steps">
            <li><a className="network-button" href="/api/network/worker-package" download="Relay Worker.zip">Download Relay Worker</a>
              <button className="network-link-button" type="button" onClick={downloadProfile} disabled={!profile}>Download connection profile</button></li>
            <li>Keep <code>relay-connection.json</code> with the extracted setup files. On Windows, run <code>Setup Relay Worker.cmd</code>. On Mac, run <code>Setup Relay Worker.command</code>.</li>
            <li>Create a code here and enter it when setup asks. Sign in to the providers you want to use on that computer.</li>
          </ol>
          <button className="network-primary" type="button" onClick={() => createInvite('worker')} disabled={!!busy}>
            {busy === 'invite' ? 'Creating code…' : 'Connect a computer'}</button>
        </>}
        <div className="network-computers"><h4>Connected computers</h4>
          {computerError && <p className="network-error">Computers could not refresh. Their status may be out of date.</p>}
          {!computers.length && <p className="network-muted">Connected computers will appear here after setup.</p>}
          {computers.map(computer => <ComputerCard key={computer.id} computer={computer} api={api} />)}
        </div>
      </>}
      {shownInvite && <div className={`network-invite ${expired ? 'is-expired' : ''}`}>
        <label className="network-field" htmlFor={`${id}-code`}>One-time connection code
          <input id={`${id}-code`} className="network-code" value={shownInvite.code} readOnly autoComplete="off"
            spellCheck={false} onFocus={event => event.currentTarget.select()} />
        </label>
        <div className="network-row"><p className="network-muted">{expired ? 'This code expired. Create a new one.'
          : `Expires at ${new Date(shownInvite.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}. Works once.`}</p>
          <button type="button" onClick={() => { void copyCode(); }} disabled={expired}>Copy code</button></div>
        <p className="network-muted">Enter this only on the trusted device you are connecting. It grants {shownInvite.role === 'worker' ? 'worker access' : 'control of this host'}.</p>
      </div>}
      {tab === 'devices' && <>
        <h3>Review access to this host</h3>
        <p className="network-warning">Disconnecting access may leave work running on an offline computer; inspect its last result.</p>
        {!devices.length && <p className="network-muted">No devices have been connected yet.</p>}
        <ul className="network-device-list">{devices.map(device => <li key={device.id}>
          <div className="network-row"><div className="network-grow"><h4>{device.name}</h4>
            <p className="network-muted">{device.role === 'controller' ? 'Controller' : 'Worker'} · {device.platform}</p>
            <p className="network-muted">{device.revokedAt !== null ? 'Access disconnected' : `Last seen ${lastSeen(device.lastSeenAt)}`}</p>
          </div>{device.revokedAt === null && <button type="button" disabled={!!busy} onClick={() => setConfirmRevoke(device.id)}>Disconnect</button>}</div>
          {confirmRevoke === device.id && <div className="network-confirm">
            <p>Disconnect access for this device?</p><div className="network-actions">
              <button className="network-danger" type="button" disabled={!!busy} onClick={() => revoke(device)}>Disconnect device</button>
              <button type="button" disabled={!!busy} onClick={() => setConfirmRevoke(null)}>Cancel</button>
            </div>
          </div>}
        </li>)}</ul>
      </>}
    </section>
    <details className="network-advanced" onToggle={event => setAdvanced(event.currentTarget.open)}><summary>Advanced connection settings</summary>
      <form noValidate onSubmit={event => { event.preventDefault(); enable(); }}>
        <div className="network-form-grid">
          <label className="network-field" htmlFor={`${id}-address`}>LAN address
            <select id={`${id}-address`} value={address} onChange={event => setAddress(event.target.value)} disabled={!!busy || !status}>
              <option value="">Choose a network</option>
              {unavailableAddress && <option value={address}>{address} (unavailable)</option>}
              {status?.interfaces.map(nic => <option key={`${nic.name}-${nic.address}`} value={nic.address}>{nic.address} · {nic.name}</option>)}
            </select>
          </label>
          <label className="network-field" htmlFor={`${id}-port`}>HTTPS port
            <input id={`${id}-port`} type="number" inputMode="numeric" min="1024" max="65535" step="1" value={port}
              onChange={event => setPort(event.target.value)} disabled={!!busy} />
          </label>
        </div>
        {status && !status.interfaces.length && <p className="network-muted">No private LAN interface is available. Connect this computer to Wi-Fi or Ethernet.</p>}
        <label className="network-field" htmlFor={`${id}-origin`}>Controller website origin
          <input id={`${id}-origin`} type="url" value={controllerOrigin} onChange={event => setControllerOrigin(event.target.value)}
            autoCapitalize="off" spellCheck={false} disabled={!!busy} placeholder={DEFAULT_CONTROLLER_ORIGIN} />
        </label>
        <p className="network-muted">Simple pairing uses a QR-verified encrypted local connection. Only change these settings if your network requires it.</p>
        {active && status?.url && <p className="network-host">Host address <code>{status.url}</code></p>}
        <div className="network-actions"><button className="network-primary" type="submit" disabled={!!busy || !status || !address}>
          {busy === 'enable' ? 'Saving…' : active ? 'Apply settings' : 'Enable connections'}</button>
          {(status?.enabled || active) && <button type="button" disabled={!!busy} onClick={disable}>{busy === 'disable' ? 'Disabling…' : 'Disable connections'}</button>}
        </div>
      </form>
      <p className="network-muted">Disabling connections stops access to this host. Accepted background jobs can continue on workers.</p>
      {advanced && <LocalCertificateTrust api={api} fingerprint={status?.fingerprint} />}
      {legacyLink && <div className="network-actions"><a className="network-button" href={legacyLink} target="_blank" rel="noopener noreferrer">Open legacy HTTPS controller</a>{!pairingReady && <button type="button" disabled={!!busy} onClick={() => createInvite('controller')}>Create legacy pairing code</button>}</div>}
      {profile && <div className="network-certificate"><h4>Legacy HTTPS certificate · SHA-256</h4><code>{profile.fingerprint}</code>
        <div className="network-actions"><a className="network-button" href="/api/network/certificate" download="relay-local-ca.cer">Download public certificate</a>
          <button type="button" onClick={downloadProfile}>Download public profile</button></div>
        <p className="network-muted">These certificate options are for legacy browsers and worker setup. Simple QR pairing does not install a certificate. Each device keeps its own credentials.</p>
      </div>}
    </details>
  </div>;
}
