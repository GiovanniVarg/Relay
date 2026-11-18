import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Check, ChevronLeft, Download, Laptop, Plus, ShieldCheck, Wifi } from 'lucide-react';
import { RelayMark } from './RelayMark';
import { applyAppearance, readCachedAppearance, useAppearance } from './appearance';
import { checkControllerHost, getLocalNetworkPermission } from './controller-host';
import { checkKnownHosts, chooseKnownHost } from './controller-discovery';
import { setControllerScope } from './controller-scope';
import { appleMobileEnvironment, publicInstallProfile, requestPersistentControllerStorage } from './controller-install';
import { bindControllerTransport, controllerFetch } from './controller-transport';
import { downloadCertificateProfile, handshakeController, listProfiles, loadProfile, loadSelectedProfile, parsePublicProfile, privateHttpsOrigin, profileFromFragment, removeProfile, requestSignature, saveProfile, selectProfile, updateProfileMetadata, updateProfilePublicInfo, verifyPinnedProfile, type ControllerProfile, type PublicConnectionProfile } from './controller-storage';

declare const __RELAY_HOSTED__: boolean;
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
type Permission = Awaited<ReturnType<typeof getLocalNetworkPermission>>;
type Problem = { kind: string; message: string };
const errorOf = (error: unknown): Problem => ({ kind: error && typeof error === 'object' && 'kind' in error ? String(error.kind) : 'other', message: error instanceof Error ? error.message : 'The connection could not be completed.' });
const publicProfile = (profile: ControllerProfile): PublicConnectionProfile => {
  if (!profile.publicCA || !profile.fingerprint) throw new Error('Import a fresh public profile from this host to check its identity. Your saved access is still here.');
  return { url: profile.url, ca: profile.publicCA, fingerprint: profile.fingerprint, ...(profile.transport ? { transport: profile.transport } : {}) };
};
const sameProfileGeneration = (left: ControllerProfile, right: ControllerProfile) => left.id === right.id && left.deviceId === right.deviceId && left.pairedAt === right.pairedAt && left.url === right.url;
const deviceName = () => /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'iPhone' : /Windows/.test(navigator.userAgent) ? 'Windows browser' : /Mac/.test(navigator.userAgent) ? 'Mac browser' : 'Browser';

async function controlledWorker(): Promise<ServiceWorker> {
  if (!('serviceWorker' in navigator)) throw new Error('Use a current browser over HTTPS to connect.');
  let timer = 0;
  try {
    await Promise.race([
      navigator.serviceWorker.register('/relay-controller-sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready),
      new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error('The connection bridge is taking too long. Reload Relay to try again.')), 15000); }),
    ]);
  } finally { clearTimeout(timer); }
  const expected = new URL('/relay-controller-sw.js', location.origin).href;
  if (navigator.serviceWorker.controller?.scriptURL !== expected) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', changed); reject(new Error('Reload Relay to activate its connection bridge.')); }, 15000);
      function changed() { if (navigator.serviceWorker.controller?.scriptURL === expected) { clearTimeout(timeout); navigator.serviceWorker.removeEventListener('controllerchange', changed); resolve(); } }
      navigator.serviceWorker.addEventListener('controllerchange', changed); changed();
    });
  }
  return navigator.serviceWorker.controller!;
}

export function ControllerGate({ children }: { children: ReactNode }) {
  const hosted = (typeof __RELAY_HOSTED__ !== 'undefined' && __RELAY_HOSTED__) || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(location.hostname);
  return hosted ? <HostedControllerGate>{children}</HostedControllerGate> : <>{children}</>;
}

function HostedControllerGate({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<ControllerProfile[]>([]), [selected, setSelected] = useState<ControllerProfile>();
  const [candidate, setCandidate] = useState<PublicConnectionProfile>(), [verified, setVerified] = useState<PublicConnectionProfile>();
  const [active, setActive] = useState<ControllerProfile>(), [view, setView] = useState<'setup' | 'hosts' | 'workspace'>('setup');
  const [repair, setRepair] = useState(false), [autoConnect, setAutoConnect] = useState(true);
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [problem, setProblem] = useState<Problem>();
  const [permission, setPermission] = useState<Permission>('unknown'), [reachable, setReachable] = useState<Set<string>>(new Set());
  const [hostName, setHostName] = useState('My Relay'), [name, setName] = useState(deviceName), [url, setUrl] = useState(''), [profileText, setProfileText] = useState(''), [code, setCode] = useState('');
  const [install, setInstall] = useState<InstallPrompt>(), [installGuide, setInstallGuide] = useState(false);
  const [installCopy, setInstallCopy] = useState('');
  const [appearance, setAppearance] = useState(readCachedAppearance);
  useAppearance(appearance);
  const generation = useRef(0), operation = useRef<AbortController | undefined>(undefined), mountedProfile = useRef<ControllerProfile | undefined>(undefined);
  const transportCleanup = useRef<(() => void) | undefined>(undefined);
  const boundProfile = useRef<ControllerProfile | undefined>(undefined), unknownProbeDone = useRef(false), unknownBatchAt = useRef(0);
  const autoAllowed = useRef(true), autoRunning = useRef(false), retryAt = useRef(0), retryDelay = useRef(15000);
  const current = useRef({ profiles, selected, candidate, permission, busy, view });
  current.current = { profiles, selected, candidate, permission, busy, view };
  const { ios, standalone } = appleMobileEnvironment(navigator.userAgent, navigator.platform, navigator.maxTouchPoints, window.matchMedia('(display-mode: standalone)').matches, (navigator as Navigator & { standalone?: boolean }).standalone === true);
  const persistenceRequested = useRef(false);

  function cancel() { generation.current++; operation.current?.abort(); operation.current = undefined; setBusy(false); setCode(''); }
  function showHosts() {
    cancel(); autoAllowed.current = false; const token = generation.current;
    current.current = { ...current.current, view: 'hosts' }; setView('hosts');
    void listProfiles().then(saved => { if (token === generation.current) setProfiles(saved); }).catch(error => { if (token === generation.current) setProblem(errorOf(error)); });
  }
  function choose(profile?: ControllerProfile) {
    cancel(); autoAllowed.current = false; setProblem(undefined); setVerified(undefined); setRepair(false); setSelected(profile);
    setCandidate(profile?.publicCA && profile.fingerprint ? publicProfile(profile) : undefined);
    setAutoConnect(profile?.autoConnect ?? true); setHostName(profile?.name ?? 'My Relay'); setUrl(profile?.url ?? ''); setView('setup');
  }
  function importCandidate(profile: PublicConnectionProfile) {
    cancel(); autoAllowed.current = false;
    // A newly scanned host is the user's intent; global selection must never replace it.
    const matching = current.current.profiles.find(saved => saved.url === profile.url && saved.fingerprint === profile.fingerprint);
    setCandidate(profile); setSelected(matching); setRepair(false); setVerified(undefined); setUrl(profile.url); setAutoConnect(matching?.autoConnect ?? true); setHostName(matching?.name ?? 'My Relay'); setProblem(undefined); setView('setup');
  }

  async function openProfile(profile: ControllerProfile, token: number) {
    const stillCurrent = () => token === generation.current && !operation.current?.signal.aborted;
    if (!stillCurrent()) return;
    const storedProfile = await loadProfile(profile.id);
    if (!stillCurrent() || !storedProfile || !sameProfileGeneration(storedProfile, profile)) return;
    profile = storedProfile;
    if (boundProfile.current && !sameProfileGeneration(boundProfile.current, profile)) {
      if (!window.dispatchEvent(new Event('relay:before-runtime-reload', { cancelable: true }))) {
        if (stillCurrent()) setProblem({ kind: 'draft', message: 'Your draft could not be saved. Free some browser storage, then choose the host again.' });
        return;
      }
      if (!stillCurrent()) return;
      await selectProfile(profile.id);
      if (!stillCurrent()) return;
      sessionStorage.setItem('relay.controller.profile', profile.id);
      location.reload();
      return;
    }
    const worker = await controlledWorker();
    if (!stillCurrent()) return;
    transportCleanup.current?.();
    transportCleanup.current = bindControllerTransport(profile);
    await handshakeController(worker, profile);
    boundProfile.current = profile;
    if (!stillCurrent()) return;
    const response = await fetch('/api/bootstrap', { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: operation.current?.signal });
    if (!response.ok) throw new Error(response.status === 401 ? 'Access needs attention. Check the hosting computer’s clock and this controller’s access, then retry or repair this host.' : `The host could not open your workspace (${response.status}). Try again.`);
    const bootstrap = await response.json() as { csrfToken?: unknown };
    if (typeof bootstrap.csrfToken !== 'string' || !bootstrap.csrfToken) throw new Error('The host returned an incomplete secure session. Reload Relay and try again.');
    if (!stillCurrent()) return;
    const updated = await updateProfileMetadata(profile.id, { deviceId: profile.deviceId, pairedAt: profile.pairedAt }, { lastConnectedAt: new Date().toISOString() });
    if (!stillCurrent() || !updated) return;
    await selectProfile(profile.id);
    if (!stillCurrent()) return;
    sessionStorage.setItem('relay.controller.profile', profile.id);
    if (!mountedProfile.current) setControllerScope(profile.id, { claimLegacy: profile.legacyStorage === true });
    mountedProfile.current = updated; setActive(updated); setSelected(updated); setProblem(undefined); setView('workspace');
    if (!persistenceRequested.current) { persistenceRequested.current = true; requestPersistentControllerStorage(navigator.storage); }
    const saved = await listProfiles();
    if (!stillCurrent()) return;
    setProfiles(saved); retryDelay.current = 15000;
  }

  async function check(profile?: ControllerProfile) {
    cancel(); autoAllowed.current = false; const token = generation.current;
    const publicInfo = profile ? (() => { try { return candidate && candidate.url === profile.url && candidate.fingerprint === profile.fingerprint ? candidate : publicProfile(profile); } catch (error) { setProblem(errorOf(error)); return undefined; } })() : candidate;
    if (!publicInfo) { setProblem({ kind: 'invalid-profile', message: 'Scan the host’s QR code or import its public profile first.' }); return; }
    operation.current = new AbortController(); setBusy(true); setProblem(undefined);
    // Deliberately call before the first await: the LAN probe belongs to this user gesture.
    const proof = checkControllerHost(publicInfo, { signal: operation.current.signal });
    let proofSucceeded = false;
    try {
      const checked = await proof;
      if (token !== generation.current) return;
      proofSucceeded = true;
      setVerified({ url: checked.url, ca: checked.ca, fingerprint: checked.fingerprint, ...(checked.transport ? { transport: checked.transport } : {}) }); setPermission(await getLocalNetworkPermission());
      if (token !== generation.current) return;
      if (profile) {
        const refreshed = await updateProfilePublicInfo(profile.id, { deviceId: profile.deviceId, pairedAt: profile.pairedAt }, { url: checked.url, ca: checked.ca, fingerprint: checked.fingerprint, ...(checked.transport ? { transport: checked.transport } : {}) });
        if (token !== generation.current) return;
        if (!refreshed) throw new Error('This saved host changed in another window. Reload Relay before reconnecting.');
        await openProfile(refreshed, token);
      }
    } catch (error) { if (token === generation.current) { if (!proofSucceeded) setVerified(undefined); setProblem(errorOf(error)); } }
    finally { if (token === generation.current) setBusy(false); }
  }

  useEffect(() => {
    let alive = true; const bootGeneration = generation.current;
    const beforeInstall = (event: Event) => { event.preventDefault(); setInstall(event as InstallPrompt); };
    const message = (event: MessageEvent) => {
      const profile = mountedProfile.current;
      if (!profile || event.data?.profileId !== profile.id || event.data?.deviceId !== profile.deviceId || event.data?.pairedAt !== profile.pairedAt) return;
      if (event.data?.type === 'NETWORK_UNREACHABLE') setProblem({ kind: 'offline', message: 'Connection lost. Your saved access and drafts are kept. Reconnect when the host is available.' });
      if (event.data?.type === 'AUTH_REQUIRED' || event.data?.type === 'AUTH_REVOKED' || event.data?.type === 'AUTH_FAILED') setProblem({ kind: 'auth', message: 'Access needs attention. Check the host’s clock and controller access, or repair this host with a new code.' });
    };
    const offline = () => setProblem({ kind: 'offline', message: 'You’re offline. Your saved access and drafts are kept.' });
    // An existing PWA/tab can receive a new public QR fragment without a document navigation.
    // Preserve it for the fresh gate to validate; never reuse the currently bound workspace.
    const hashchange = () => {
      if (!location.hash.startsWith('#connect=')) return;
      if (!window.dispatchEvent(new Event('relay:before-runtime-reload', { cancelable: true }))) {
        setProblem({ kind: 'draft', message: 'Your draft could not be saved. Free some browser storage, then reload Relay to open the scanned host.' }); return;
      }
      cancel(); location.reload();
    };
    window.addEventListener('beforeinstallprompt', beforeInstall); window.addEventListener('offline', offline); window.addEventListener('hashchange', hashchange); navigator.serviceWorker?.addEventListener('message', message);
    void (async () => {
      try {
        let imported: PublicConnectionProfile | undefined;
        try { imported = profileFromFragment(location.hash); }
        finally { if (location.hash.startsWith('#connect=')) history.replaceState(history.state, '', location.pathname + location.search); }
        const saved = await listProfiles(), tabProfile = sessionStorage.getItem('relay.controller.profile');
        const preferred = (tabProfile ? await loadProfile(tabProfile) : undefined) ?? await loadSelectedProfile(), allowed = await getLocalNetworkPermission();
        if (!alive || bootGeneration !== generation.current) return;
        setProfiles(saved); setPermission(allowed);
        if (imported) {
          autoAllowed.current = false;
          const matching = saved.find(profile => profile.url === imported!.url && profile.fingerprint === imported!.fingerprint);
          setCandidate(imported); setUrl(imported.url); setSelected(matching); setAutoConnect(matching?.autoConnect ?? true); setHostName(matching?.name ?? 'My Relay');
        } else if (preferred) {
          setSelected(preferred); setAutoConnect(preferred.autoConnect); setHostName(preferred.name); setUrl(preferred.url);
          if (preferred.publicCA && preferred.fingerprint) setCandidate(publicProfile(preferred));
        } else if (saved.length) setView('hosts');
      } catch (error) { if (alive && bootGeneration === generation.current) setProblem(errorOf(error)); }
      finally { if (alive) setLoaded(true); }
    })();
    return () => { alive = false; generation.current++; operation.current?.abort(); window.removeEventListener('beforeinstallprompt', beforeInstall); window.removeEventListener('offline', offline); window.removeEventListener('hashchange', hashchange); navigator.serviceWorker?.removeEventListener('message', message); };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    let disposed = false;
    const controller = new AbortController();
    async function resume(networkWake = false) {
      const state = current.current;
      if (disposed || document.visibilityState === 'hidden' || !navigator.onLine || (state.permission !== 'granted' && !(state.permission === 'unknown' && !unknownProbeDone.current)) || state.busy || autoRunning.current || Date.now() < retryAt.current) return;
      if (mountedProfile.current && state.view !== 'workspace') return;
      if (!mountedProfile.current && !autoAllowed.current) return;
      autoRunning.current = true; const token = generation.current;
      try {
        // Each round reads current consent and generations, including changes made in another tab.
        const freshProfiles = await listProfiles();
        if (disposed || token !== generation.current) return;
        const mounted = mountedProfile.current;
        const freshActive = mounted ? freshProfiles.find(profile => profile.id === mounted.id) : undefined;
        if (mounted && (!mounted.autoConnect || !freshActive || !sameProfileGeneration(freshActive, mounted) || !freshActive.autoConnect || current.current.view !== 'workspace')) return;
        setProfiles(freshProfiles);
        const known = freshProfiles.filter(profile => profile.autoConnect && (state.permission === 'granted' || !!profile.lastConnectedAt));
        if (!known.length) return;
        if (state.permission === 'unknown') { unknownProbeDone.current = true; unknownBatchAt.current = Date.now(); }
        const checkedHosts = new Map<string, PublicConnectionProfile>();
        const found = await checkKnownHosts(known, async (profile, signal) => { const checked = await checkControllerHost(publicProfile(profile), { signal }); checkedHosts.set(profile.id, { url: checked.url, ca: checked.ca, fingerprint: checked.fingerprint, ...(checked.transport ? { transport: checked.transport } : {}) }); }, controller.signal);
        if (disposed || token !== generation.current) return;
        setReachable(found);
        const chosen = chooseKnownHost(known, found, mounted?.id ?? state.selected?.id);
        if (!chosen || (mountedProfile.current && current.current.view !== 'workspace')) return;
        const activeReachable = mounted && found.has(mounted.id);
        const needsReconnect = !mounted || problem?.kind === 'offline' || problem?.kind === 'trust-or-network';
        // Another host cannot interrupt a healthy workspace. On network change, a missing active
        // host may yield to exactly one verified saved host, through the full document reload guard.
        if (mounted && chosen.id !== mounted.id && (activeReachable || (!networkWake && !needsReconnect))) return;
        const stillSaved = await loadProfile(chosen.id);
        if (disposed || token !== generation.current || !stillSaved?.autoConnect || !sameProfileGeneration(stillSaved, chosen) || (mountedProfile.current && current.current.view !== 'workspace')) return;
        const checked = checkedHosts.get(chosen.id);
        if (!checked) return;
        const refreshed = await updateProfilePublicInfo(stillSaved.id, { deviceId: stillSaved.deviceId, pairedAt: stillSaved.pairedAt }, checked);
        if (disposed || token !== generation.current || !refreshed?.autoConnect) return;
        // Refresh a healthy host’s signed future pins without remounting or replacing its transport.
        if (mounted && chosen.id === mounted.id && !needsReconnect) return;
        operation.current = new AbortController(); await openProfile(refreshed, token);
      } catch (error) { if (!disposed && token === generation.current) setProblem(errorOf(error)); }
      finally { autoRunning.current = false; retryAt.current = Date.now() + retryDelay.current; retryDelay.current = Math.min(retryDelay.current * 2, 120000); }
    }
    const wake = (event: Event) => {
      if (event.type === 'visibilitychange' && document.visibilityState !== 'visible') return;
      retryAt.current = 0;
      void getLocalNetworkPermission().then(value => {
        if (disposed) return;
        current.current = { ...current.current, permission: value }; setPermission(value);
        if (value === 'granted') void resume(true);
        else if (value === 'unknown' && !autoRunning.current && Date.now() - unknownBatchAt.current >= 30000) {
          // Safari may not expose a granular permission result. Saved opt-in hosts may receive
          // one readonly batch per foreground/network wake, coalesced and throttled to 30 seconds.
          // No interval can reset this flag or repeat an unknown-permission probe.
          unknownProbeDone.current = false; void resume(true);
        }
      });
    };
    void resume(); const timer = setInterval(() => { if (current.current.permission === 'granted') void resume(); }, 15000);
    window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake);
    const network = (navigator as Navigator & { connection?: EventTarget }).connection; network?.addEventListener('change', wake);
    return () => { disposed = true; controller.abort(); clearInterval(timer); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); network?.removeEventListener('change', wake); };
  }, [loaded, permission, problem?.kind]);

  async function pair(event: FormEvent) {
    event.preventDefault(); if (!verified || busy) return;
    const oneTimeCode = code.replace(/[\s-]/g, '').toUpperCase(); setCode('');
    if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(oneTimeCode)) { setProblem({ kind: 'code', message: 'Enter the 12-character one-time code from the host.' }); return; }
    if (!name.trim() || name.trim().length > 80 || !hostName.trim() || hostName.trim().length > 80) { setProblem({ kind: 'name', message: 'Use names between 1 and 80 characters.' }); return; }
    cancel(); const token = generation.current; operation.current = new AbortController(); setBusy(true); setProblem(undefined);
    try {
      await verifyPinnedProfile(verified);
      const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const exported = await crypto.subtle.exportKey('jwk', keys.publicKey), publicKey: JsonWebKey = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y };
      const body = JSON.stringify({ code: oneTimeCode.match(/.{4}/g)!.join('-'), name: name.trim(), platform: 'controller', publicKey });
      const signature = await requestSignature(keys.privateKey, 'POST', '/api/network/pair', new TextEncoder().encode(body));
      if (token !== generation.current) return;
      const response = await controllerFetch(verified, '/api/network/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', ...signature }, body, signal: operation.current?.signal });
      if (!response.ok) throw new Error(response.status === 401 ? 'That code was rejected or expired. Create a fresh one-time code on the host.' : `The host rejected pairing (${response.status}). Create a fresh code before trying again.`);
      const device = await response.json() as { id?: unknown; role?: unknown };
      if (typeof device.id !== 'string' || !device.id || device.role !== 'controller') throw new Error('The host did not authorize a controller device.');
      if (token !== generation.current) return;
      const accepted: ControllerProfile = { id: selected?.id ?? crypto.randomUUID(), name: hostName.trim(), autoConnect, url: verified.url, deviceId: device.id, privateKey: keys.privateKey, publicKey, pairedAt: new Date().toISOString(), lastConnectedAt: new Date().toISOString(), publicCA: verified.ca, fingerprint: verified.fingerprint, ...(verified.transport ? { transport: verified.transport } : {}), ...(selected?.legacyStorage ? { legacyStorage: true as const } : {}) };
      await saveProfile(accepted, selected ? { replaceGeneration: { deviceId: selected.deviceId, pairedAt: selected.pairedAt } } : undefined);
      if (token !== generation.current) return;
      const saved = await listProfiles();
      if (token !== generation.current) return;
      setProfiles(saved); await openProfile(accepted, token);
    } catch (error) { if (token === generation.current) setProblem(errorOf(error)); }
    finally { setCode(''); if (token === generation.current) setBusy(false); }
  }

  async function setProfileReconnect(profile: ControllerProfile, value: boolean) {
    const updated = { ...profile, autoConnect: value };
    // Reflect this explicit choice synchronously so a simultaneous online event cannot use old consent.
    setProfiles(previous => previous.map(saved => saved.id === profile.id ? updated : saved));
    if (mountedProfile.current && sameProfileGeneration(mountedProfile.current, profile)) {
      mountedProfile.current = updated; setActive(updated);
    }
    try {
      const saved = await updateProfileMetadata(profile.id, { deviceId: profile.deviceId, pairedAt: profile.pairedAt }, { autoConnect: value });
      if (!saved) { setProfiles(await listProfiles()); setProblem({ kind: 'auth', message: 'This saved host changed in another window. Reload Relay before changing its settings.' }); }
    }
    catch (error) { setProblem(errorOf(error)); setProfiles(await listProfiles()); }
  }

  async function importFile(file?: File) {
    if (!file) return;
    cancel(); const token = generation.current;
    try {
      if (file.size > 200000) throw new Error('This profile is too large.');
      const text = await file.text();
      if (token !== generation.current) return;
      importCandidate(parsePublicProfile(text));
    } catch (error) { if (token === generation.current) setProblem(errorOf(error)); }
  }
  async function downloadRoot() {
    if (!candidate) return;
    try {
      await verifyPinnedProfile(candidate);
      if (ios) { await downloadCertificateProfile(candidate); return; }
      const encoded = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(candidate.ca)?.[1].replace(/\s/g, '');
      if (!encoded) throw new Error('The public certificate is incomplete. Import a fresh public profile.');
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      const link = document.createElement('a'), downloadUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pkix-cert' }));
      link.href = downloadUrl; link.download = 'RelayLocalCA.cer'; link.click(); setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);
    } catch (error) { setProblem(errorOf(error)); }
  }

  async function copyInstallProfile() {
    const profile = candidate ?? (active ? publicProfile(active) : undefined);
    if (!profile) return;
    try {
      const text = publicInstallProfile(profile);
      await navigator.clipboard.writeText(text);
      setInstallCopy('Public connection profile copied. Open Relay from the Home Screen and paste it there.');
    } catch {
      setInstallCopy('Copy was unavailable. Select and copy the public profile below, then paste it in the Home Screen app.');
    }
  }

  function pasteInstallProfile() {
    try { importCandidate(parsePublicProfile(profileText)); setProfileText(''); }
    catch (error) { setProblem(errorOf(error)); }
  }

  useEffect(() => () => { transportCleanup.current?.(); transportCleanup.current = undefined; }, []);

  const pinnedConnection = candidate?.transport?.kind === 'webtransport-v1';
  const trustProblem = problem?.kind === 'trust-or-network';
  const status = busy ? 'Checking secure connection…' : verified ? 'Secure connection checked' : selected ? 'Saved host · ready to check' : candidate ? 'Host profile imported' : 'Start on your hosting computer';
  const showSetup = !active || view !== 'workspace';
  return <>
    {active && <div className="relay-controller-topbar"><span><span className={`relay-controller-dot ${problem ? '' : 'is-ready'}`} />{active.name}</span><button type="button" onClick={showHosts}>Hosts</button></div>}
    {active && problem && view === 'workspace' && <aside className="relay-controller-banner" aria-live="polite"><span className="relay-controller-banner-message"><span>{problem.message}</span><small>Requests are not retried automatically.</small></span><button type="button" disabled={busy} onClick={() => void check(active)}>Reconnect</button><button type="button" onClick={showHosts}>Choose host</button></aside>}
    {showSetup && <main className={`relay-controller-shell ${active ? 'is-overlay' : ''}`}><section className="relay-controller-card" aria-labelledby="relay-connect-title" aria-busy={busy}>
      <header className="relay-controller-header"><div className="relay-controller-brand"><RelayMark /><span>Relay</span></div><label className="relay-controller-theme"><span className="sr-only">Appearance</span><select aria-label="Appearance" value={appearance} onChange={event => { const value = event.target.value as typeof appearance; setAppearance(value); applyAppearance(value); }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></header>
      {view === 'hosts' ? <>
        <h1 id="relay-connect-title">Your hosts</h1><p>Home, office, or another computer. Each host keeps its own access and workspace.</p>
        <ul className="relay-controller-hosts">{profiles.map(profile => <li key={profile.id}><div><Laptop size={20} aria-hidden="true" /><div><strong>{profile.name}</strong><small>{profile.id === active?.id ? 'Current host' : reachable.has(profile.id) ? 'Secure host available' : 'Saved host'} · {profile.url}</small></div></div><button type="button" disabled={busy} onClick={() => choose(profile)}>Select {profile.name}</button><details><summary>Manage {profile.name}</summary><form onSubmit={event => { event.preventDefault(); const value = String(new FormData(event.currentTarget).get('name') ?? '').trim(); if (value && value !== profile.name) void updateProfileMetadata(profile.id, { deviceId: profile.deviceId, pairedAt: profile.pairedAt }, { name: value }).then(async saved => { setProfiles(await listProfiles()); if (!saved) return; if (mountedProfile.current && sameProfileGeneration(mountedProfile.current, profile)) { const updated = { ...mountedProfile.current, name: value }; mountedProfile.current = updated; setActive(updated); } }).catch(error => setProblem(errorOf(error))); }}><label>Host name<input name="name" defaultValue={profile.name} maxLength={80} required /></label><button type="submit">Rename {profile.name}</button></form><label className="relay-controller-checkbox"><input type="checkbox" checked={profile.autoConnect} onChange={event => void setProfileReconnect(profile, event.target.checked)} />Reconnect automatically</label><button type="button" onClick={() => { if (!window.confirm(`Remove saved access for ${profile.name} from this browser?`)) return; cancel(); void removeProfile(profile.id).then(async () => { if (active?.id === profile.id) { sessionStorage.removeItem('relay.controller.profile'); await selectProfile(undefined); location.reload(); } else { setProfiles(await listProfiles()); if (selected?.id === profile.id) choose(); } }).catch(error => setProblem(errorOf(error))); }}>Remove {profile.name}</button></details></li>)}</ul>
        <button type="button" className="relay-controller-primary" onClick={() => choose()}><Plus size={18} />Add a host</button>
        {active && <button type="button" onClick={() => setView('workspace')}><ChevronLeft size={16} />Back to {active.name}</button>}
      </> : <>
        {!!profiles.length && <button className="relay-controller-back" type="button" onClick={showHosts}><ChevronLeft size={16} />Your hosts</button>}
        <div className="relay-controller-eyebrow">{verified ? <ShieldCheck size={16} /> : <Wifi size={16} />}<span aria-live="polite">{status}</span></div>
        <h1 id="relay-connect-title">{candidate || selected ? hostName : 'Connect to your Relay'}</h1>
        <p>{candidate || selected ? pinnedConnection ? 'Allow Local Network access if asked, then enter the one-time code from your computer. Relay remembers this host.' : 'Your work stays on this computer. Relay remembers this host for next time.' : 'Open Relay on the computer with your chats, then scan its connection QR code with this device.'}</p>
        {ios && !standalone && !selected && <aside className="relay-controller-note"><strong>Pair where you’ll use Relay</strong><p>Safari and the Home Screen app save access separately. Keep using Safari, or install the Home Screen app before entering your sync code.</p><button type="button" onClick={() => setInstallGuide(true)}>Set up Home Screen app</button></aside>}
        {ios && standalone && !candidate && !selected && <section className="relay-controller-note"><strong>Finish your Home Screen setup</strong><p>Paste the public connection profile copied from Safari, then pair here once. No certificate installation is needed.</p><label>Copied connection profile<textarea rows={3} value={profileText} onChange={event => setProfileText(event.target.value)} autoCapitalize="none" spellCheck={false} /></label><button type="button" onClick={pasteInstallProfile}>Use copied connection profile</button></section>}
        {candidate && <div className="relay-controller-host-address"><Laptop size={18} /><span>{pinnedConnection ? 'Private connection to your Relay' : candidate.url}</span>{verified && <Check size={18} aria-label="Secure host verified" />}</div>}
        {!verified && (candidate || selected) && <button className="relay-controller-primary" type="button" disabled={busy || !loaded} onClick={() => void check(selected)}>{busy ? 'Checking…' : problem ? 'Recheck connection' : 'Check connection'}<ArrowRight size={18} /></button>}
        {verified && (!selected || repair) && <form onSubmit={event => void pair(event)}><label>Host name<input value={hostName} onChange={event => setHostName(event.target.value)} maxLength={80} autoComplete="off" required /></label><label>Sync code<input type="password" value={code} onChange={event => setCode(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-describedby="relay-code-help" required /></label><small id="relay-code-help">Create a one-time code on this host. It is used once and never saved.</small><label className="relay-controller-checkbox"><input type="checkbox" checked={autoConnect} onChange={event => setAutoConnect(event.target.checked)} />Reconnect to this saved host automatically</label><details><summary>Device details</summary><label>This device’s name<input value={name} onChange={event => setName(event.target.value)} maxLength={80} autoComplete="off" required /></label></details><button type="submit" className="relay-controller-primary" disabled={busy}>{busy ? 'Opening your workspace…' : 'Connect securely'}<ArrowRight size={18} /></button></form>}
        {selected && verified && !repair && !busy && <button type="button" onClick={() => { setCode(''); setRepair(true); }}>Repair access for {selected.name}</button>}
        {problem && <div className="relay-controller-error" role="alert"><strong>{problem.kind === 'permission-denied' ? 'Allow local network access' : problem.kind === 'identity-changed' ? 'This host’s identity changed' : trustProblem ? 'Couldn’t securely reach this host' : 'Connection needs attention'}</strong><p>{problem.kind === 'permission-denied' ? 'Open this browser’s site settings and allow Local Network access for Relay. Return here and recheck.' : trustProblem ? pinnedConnection ? 'Keep Relay awake and both devices on the same local network. Allow Local Network access for this browser, then reconnect.' : 'Check that Relay is running, both devices are on the same network, and this device trusts the host’s certificate.' : problem.message}</p>{(problem.kind === 'host-update-required' || /reload/i.test(problem.message)) && <button type="button" onClick={() => location.reload()}>Reload Relay</button>}</div>}
        {!verified && candidate && !pinnedConnection && <details className="relay-controller-trust"><summary>Advanced: legacy certificate setup</summary><h2 id="relay-trust-title">Legacy HTTPS connection</h2><p>Trust this host once, then return and recheck. Relay will hide these steps after a secure connection succeeds.</p><button type="button" onClick={() => void downloadRoot()}><Download size={17} />{ios ? 'Download iPhone certificate profile' : 'Download host certificate'}</button><p>{ios ? 'Install in Settings → General → VPN & Device Management. Then enable it in General → About → Certificate Trust Settings.' : /Windows/.test(navigator.userAgent) ? 'On Windows, open the certificate → Install Certificate → Current User → Trusted Root Certification Authorities. Check the fingerprint before installing.' : /Mac/.test(navigator.userAgent) ? 'On Mac, open the certificate in Keychain Access. Compare the fingerprint, then set this root certificate to Always Trust.' : 'Use this device’s certificate settings to trust the host root. Compare its fingerprint first. Some browsers have their own certificate settings.'}</p><details><summary>Compare host fingerprint</summary><code>{candidate.fingerprint}</code><p>Compare with Relay on the hosting computer before trusting it.</p></details><a href="http://127.0.0.1:3210/?setup=phone-trust" target="_blank" rel="noopener noreferrer">On the hosting computer? Open local Relay ↗</a></details>}
        {!verified && <details className="relay-controller-import"><summary>Advanced connection options</summary><p>From the host’s connection settings, export its public profile. It contains no sync code or private key.</p><label>Import public profile<input type="file" accept="application/json,.json" onChange={event => void importFile(event.target.files?.[0])} /></label><details><summary>Paste a public profile</summary><label>Public profile JSON<textarea rows={4} value={profileText} onChange={event => setProfileText(event.target.value)} spellCheck={false} /></label><button type="button" onClick={() => { try { importCandidate(parsePublicProfile(profileText)); setProfileText(''); } catch (error) { setProblem(errorOf(error)); } }}>Use public profile</button></details><label>Hosting computer address<input type="url" value={url} onChange={event => setUrl(event.target.value)} inputMode="url" placeholder="https://192.168.1.20:3211" autoComplete="off" autoCapitalize="none" spellCheck={false} /></label><button type="button" onClick={() => { try { const origin = privateHttpsOrigin(url); if (!candidate || candidate.url !== origin) throw new Error('Import this host’s public profile to verify its identity before connecting.'); setUrl(origin); } catch (error) { setProblem(errorOf(error)); } }}>Use address</button></details>}
      </>}
      <footer className="relay-controller-footer"><ShieldCheck size={15} /><span>Private, encrypted, on your network</span><button type="button" onClick={() => { if (install) void install.prompt().then(() => install.userChoice).then(() => setInstall(undefined)).catch(() => setInstallGuide(true)); else setInstallGuide(true); }}>Install Relay</button></footer>
      {installGuide && <section className="relay-controller-note">{ios ? <><strong>{standalone ? 'You’re using the Home Screen app' : 'Install first, then pair once'}</strong><p>{standalone ? 'Pair in this app and leave automatic reconnect enabled. Open this same icon next time.' : 'Copy the public connection profile below, then use Safari → Share → Add to Home Screen. Open the new Relay icon, paste the profile, and enter a fresh sync code there. Safari pairing keys do not transfer to the installed app.'}</p>{!standalone && (candidate || active) && <><button type="button" onClick={() => void copyInstallProfile()}>Copy public connection profile</button><details><summary>Manual copy</summary><label htmlFor="relay-install-public-profile">Public profile for Home Screen app</label><textarea id="relay-install-public-profile" rows={3} readOnly value={publicInstallProfile(candidate ?? publicProfile(active!))} onFocus={event => event.currentTarget.select()} /></details>{installCopy && <p role="status">{installCopy}</p>}</>}</> : <p>Use Install in the browser menu. Saved hosts stay in this browser.</p>}<p>Saved access reconnects in this app while the host is reachable. Clearing browser data, removing this app, or revoking its access can require pairing again.</p></section>}
    </section></main>}
    {active && <div hidden={view !== 'workspace'}><Fragment key={active.id}>{children}</Fragment></div>}
  </>;
}
