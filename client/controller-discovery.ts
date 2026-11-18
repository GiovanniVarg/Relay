import type { ControllerProfile } from './controller-storage';

/** Never pick a host because its response happened to arrive first. */
export function chooseKnownHost(profiles: ControllerProfile[], reachable: ReadonlySet<string>, preferred?: string): ControllerProfile | undefined {
  const available = profiles.filter(profile => profile.autoConnect && reachable.has(profile.id));
  return available.find(profile => profile.id === preferred) ?? (available.length === 1 ? available[0] : undefined);
}

/** Known addresses only: no subnet, loopback, port, or SSID discovery. */
export async function checkKnownHosts(profiles: ControllerProfile[], check: (profile: ControllerProfile, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<Set<string>> {
  const queue = profiles.filter(profile => profile.autoConnect).slice(0, 16);
  const reachable = new Set<string>();
  let next = 0;
  async function run() {
    while (!signal.aborted && next < queue.length) {
      const profile = queue[next++], timeout = new AbortController();
      const abort = () => timeout.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 5000);
      try { await check(profile, timeout.signal); if (!timeout.signal.aborted) reachable.add(profile.id); }
      catch { /* Individual failures leave the saved profile intact. */ }
      finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    }
  }
  await Promise.all([run(), run()]);
  return reachable;
}
