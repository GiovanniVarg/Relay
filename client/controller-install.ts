import { parsePublicProfile, type PublicConnectionProfile } from './controller-storage';

/** iPad can request a desktop UA; Home Screen storage is still separate from Safari. */
export function appleMobileEnvironment(userAgent: string, platform: string, maxTouchPoints: number, displayStandalone: boolean, navigatorStandalone: boolean) {
  return {
    ios: /iPhone|iPad|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1),
    standalone: displayStandalone || navigatorStandalone,
  };
}

/** An install handoff carries public host identity only, never controller credentials or codes. */
export function publicInstallProfile(profile: PublicConnectionProfile): string {
  const transport = profile.transport ? {
    kind: profile.transport.kind, endpoint: profile.transport.endpoint, pin: profile.transport.pin,
    ...(profile.transport.catalog ? { catalog: { payload: profile.transport.catalog.payload, signature: profile.transport.catalog.signature } } : {}),
  } : undefined;
  return JSON.stringify(parsePublicProfile(JSON.stringify({ url: profile.url, ca: profile.ca, fingerprint: profile.fingerprint, ...(transport ? { transport } : {}) })));
}

/** Persistence is a browser-controlled preference, never a prerequisite for opening a host. */
export function requestPersistentControllerStorage(storage: Pick<StorageManager, 'persist'> | undefined): void {
  try { void storage?.persist?.().catch(() => {}); } catch { /* Unsupported or denied storage must not interrupt a paired session. */ }
}
