import {scopedSessionStorage as sessionStorage} from './controller-scope';
import { useEffect, useRef, useState } from 'react';

const BEFORE_RELOAD = 'relay:before-runtime-reload';
type Drafts = Record<string, string>;
interface RuntimeHealth { service?: string; ok?: boolean; instanceId?: string; updateHeld?: boolean; }
export function normalizeDrafts(value: unknown): Drafts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries: [string, string][] = []; let size = 0;
  for (const [key, text] of Object.entries(value).reverse()) {
    if (!key || key.length > 200 || typeof text !== 'string' || !text || text.length > 16000 || size + text.length > 320000) continue;
    entries.unshift([key, text]); size += text.length;
    if (entries.length === 40) break;
  }
  return Object.fromEntries(entries);
}
function loadDrafts(key: string): Drafts {
  try { const raw = sessionStorage.getItem(key); return raw && raw.length <= 640000 ? normalizeDrafts(JSON.parse(raw)) : {}; }
  catch { return {}; }
}
function saveDrafts(key: string, drafts: Drafts): boolean {
  try {
    const bounded = normalizeDrafts(drafts);
    // Never reload away text that could not be retained within this tab's storage limit.
    if (Object.entries(drafts).some(([id, text]) => text && bounded[id] !== text)) return false;
    if (Object.keys(bounded).length) sessionStorage.setItem(key, JSON.stringify(bounded)); else sessionStorage.removeItem(key);
    return true;
  } catch { return !Object.values(drafts).some(Boolean); }
}
export function useSessionDrafts(key: string) {
  const [drafts, setDrafts] = useState<Drafts>(() => loadDrafts(key));
  const latest = useRef(drafts); latest.current = drafts;
  useEffect(() => { saveDrafts(key, drafts); }, [key, drafts]);
  useEffect(() => {
    const retain = (event: Event) => { if (!saveDrafts(key, latest.current) && event.cancelable) event.preventDefault(); };
    window.addEventListener(BEFORE_RELOAD, retain);
    window.addEventListener('pagehide', retain);
    return () => { saveDrafts(key, latest.current); window.removeEventListener(BEFORE_RELOAD, retain); window.removeEventListener('pagehide', retain); };
  }, [key]);
  return [drafts, setDrafts] as const;
}
export function runtimeAction(previous: string | undefined, health: RuntimeHealth): 'ready' | 'wait' | 'reload' {
  if (health.service !== 'relay' || health.ok !== true || health.updateHeld) return 'wait';
  return previous && health.instanceId && previous !== health.instanceId ? 'reload' : 'ready';
}
/** The instance nonce detects a successful restart even if polling misses the brief outage. */
export function useRuntimeConnection() {
  const [status, setStatus] = useState('');
  useEffect(() => {
    let stopped = false, instance: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let pendingReload = false;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1800)]) });
        if (!response.ok) throw new Error('Relay is reconnecting');
        const health = await response.json() as RuntimeHealth;
        if (stopped) return;
        const action = runtimeAction(instance, health);
        if (action === 'wait') setStatus('Relay is restarting. Reconnecting…');
        else if (action === 'reload' && !pendingReload) {
          pendingReload = true;
          setStatus('Relay is back. Loading the updated app…');
          requestAnimationFrame(() => {
            if (stopped) return;
            if (window.dispatchEvent(new Event(BEFORE_RELOAD, { cancelable: true }))) window.location.reload();
            else { pendingReload = false; setStatus('Relay updated, but this tab could not save its draft. Keep this page open until the draft is sent or saved.'); }
          });
        } else if (action === 'ready') { instance = health.instanceId ?? instance; setStatus(''); }
      } catch { if (!stopped) setStatus('Relay is reconnecting… Your draft stays in this tab.'); }
      finally { if (!stopped) timer = setTimeout(() => void poll(), 2000); }
    };
    void poll();
    return () => { stopped = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, []);
  return status;
}
