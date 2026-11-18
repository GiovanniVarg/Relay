import { existsSync } from 'node:fs';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { BrowserStatus, BrowserView } from '../shared/capabilities.js';
import type { BrowserWatchAction, BrowserWatchClearReason, BrowserWatchEvent, BrowserWatchPayload } from '../shared/browser-watch.js';
import { Store, id } from './store.js';
import { Capabilities } from './capabilities.js';
import { HttpError } from './security.js';
import { BrowserProxy } from './browser-proxy.js';
import { BrowserSessionSecrets } from './browser-session-secrets.js';
import type { SecretVaultLike } from './typesafe.js';

type Launch = (profile: string, options: { headless: boolean; acceptDownloads: boolean; serviceWorkers: 'block'; chromiumSandbox: boolean; channel: 'chromium'; proxy: { server: string; bypass: string }; args: string[]; timeout: number }) => Promise<BrowserContext>;
type Session = { id: string; observable: boolean; context: BrowserContext; page: Page; humanControl: boolean; proxy: BrowserProxy };
type Observer = { listeners: Set<(payload: BrowserWatchPayload) => void>; timer: ReturnType<typeof setInterval>; status: string; };
export interface BrowserOptions { launch?: Launch; blockedOrigins?: () => string[]; vault?: SecretVaultLike; }
const loopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname.toLowerCase()) || hostname.toLowerCase().endsWith('.localhost');
export class Browser {
  private sessions = new Map<string, Session>();
  private queues = new Map<string, Promise<unknown>>();
  private closing = false;
  private humanOwned = new Set<string>();
  // Operator leases are independent of frame generations: closing an old context must not
  // revoke the newer control operation that is replacing it.
  private operatorIntents = new Map<string, number>();
  private observers = new Map<string, Observer>();
  private generations = new Map<string, number>();
  private captures = new Map<string, Promise<void>>();
  private lastCapture = new Map<string, number>();
  private readonly sessionSecrets: BrowserSessionSecrets;
  constructor(readonly store: Store, readonly capabilities: Capabilities, private options: BrowserOptions = {}) { this.sessionSecrets = new BrowserSessionSecrets(store.dataDir, options.vault); }
  private check(agentId: string, signal?: AbortSignal, human = false) {
    if (this.closing) throw new HttpError(409, 'Browser service is stopping');
    if (signal?.aborted) throw signal.reason ?? new Error('Browser action cancelled');
    if (!this.capabilities.browserGrant(agentId).enabled) throw new HttpError(403, 'Grant this bot browser access in Connections first');
    if (!human && this.humanOwned.has(agentId)) throw new HttpError(409, 'The browser is under human control. Return control before the bot continues.');
  }
  isHumanOwned(agentId: string): boolean { return this.humanOwned.has(agentId); }
  private nextOperatorIntent(agentId: string): number { const intent = (this.operatorIntents.get(agentId) ?? 0) + 1; this.operatorIntents.set(agentId, intent); return intent; }
  private checkOperatorIntent(agentId: string, intent: number) {
    if (this.closing || this.operatorIntents.get(agentId) !== intent) throw new HttpError(409, 'Browser control request was superseded or revoked. Refresh browser status.');
  }
  private emit(agentId: string, payload: BrowserWatchPayload) { for (const listener of [...(this.observers.get(agentId)?.listeners ?? [])]) listener(payload); }
  private publishStatus(agentId: string, force = false) { const observer = this.observers.get(agentId); if (!observer) return; const status = this.statusSnapshot(agentId), value = JSON.stringify(status); if (force || value !== observer.status) { observer.status = value; this.emit(agentId, { type: 'status', sessionId: status.sessionId ?? null, status }); } }
  private invalidate(agentId: string, reason: BrowserWatchClearReason, retire = true) {
    this.generations.set(agentId, (this.generations.get(agentId) ?? 0) + 1);
    const session = this.sessions.get(agentId); if (retire && session) session.observable = false;
    this.emit(agentId, { type: 'clear', sessionId: session?.id ?? null, reason });
  }
  private activity(agentId: string, action: BrowserWatchAction, phase: 'started' | 'complete' | 'failed') { this.emit(agentId, { type: 'activity', sessionId: this.sessions.get(agentId)?.id ?? null, action, phase }); }
  watch(agentId: string, listener: (event: BrowserWatchEvent) => void): () => void {
    const status = this.statusSnapshot(agentId); let sequence = 0, open = true;
    const deliver = (payload: BrowserWatchPayload) => { if (open) { try { listener({ ...payload, agentId, sequence: ++sequence, observedAt: new Date().toISOString() } as BrowserWatchEvent); } catch { /* A consumer cannot disrupt browser actions or other observers. */ } } };
    deliver({ type: 'status', sessionId: status.sessionId ?? null, status });
    if (this.closing) { deliver({ type: 'clear', sessionId: null, reason: 'shutdown' }); return () => { open = false; }; }
    let observer = this.observers.get(agentId);
    if (!observer) { const timer = setInterval(() => this.observe(agentId), 1000); timer.unref(); observer = { listeners: new Set(), timer, status: JSON.stringify(status) }; this.observers.set(agentId, observer); }
    observer.listeners.add(deliver);
    // Defer so a synchronous initial status can safely terminate an SSE subscription.
    queueMicrotask(() => this.observe(agentId));
    return () => { if (!open) return; open = false; observer!.listeners.delete(deliver); if (!observer!.listeners.size && this.observers.get(agentId) === observer) { clearInterval(observer!.timer); this.observers.delete(agentId); } };
  }
  private observe(agentId: string) {
    if (this.closing || !this.observers.has(agentId)) return;
    this.publishStatus(agentId);
    const session = this.sessions.get(agentId), generation = this.generations.get(agentId) ?? 0;
    if (!session?.observable || !this.capabilities.browserGrant(agentId).enabled || this.captures.has(agentId) || Date.now() - (this.lastCapture.get(agentId) ?? 0) < 1000) return;
    const url = session.page.url(); try { this.url(url, true); } catch { this.invalidate(agentId, 'unavailable', false); return; }
    const observer = this.observers.get(agentId)!;
    this.lastCapture.set(agentId, Date.now());
    const capture = (async () => {
      try {
        const bytes = await session.page.screenshot({ type: 'jpeg', quality: 55, fullPage: false, timeout: 2000 });
        if (this.closing || this.observers.get(agentId) !== observer || !observer.listeners.size || !session.observable || this.sessions.get(agentId) !== session || (this.generations.get(agentId) ?? 0) !== generation || !this.capabilities.browserGrant(agentId).enabled || session.page.url() !== url || bytes.byteLength > 512 * 1024) return;
        this.url(session.page.url(), true);
        this.emit(agentId, { type: 'frame', sessionId: session.id, url, jpeg: bytes.toString('base64'), capturedAt: new Date().toISOString() });
      } catch { /* Freshness remains the time of the last successfully published frame. */ }
    })();
    this.captures.set(agentId, capture); void capture.finally(() => { if (this.captures.get(agentId) === capture) this.captures.delete(agentId); });
  }
  private url(value: string, blank = false): URL {
    let url: URL; try { url = new URL(value); } catch { throw new HttpError(400, 'Browser URL must be absolute HTTP or HTTPS'); }
    if (blank && value === 'about:blank') return url;
    if (value.length > 4096 || !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hostname === '169.254.169.254') throw new HttpError(400, 'This browser destination is not permitted');
    const normalized = new URL(url.href); if (normalized.protocol === 'ws:') normalized.protocol = 'http:'; if (normalized.protocol === 'wss:') normalized.protocol = 'https:';
    for (const value of this.options.blockedOrigins?.() ?? ['http://127.0.0.1:3210']) {
      try { const blocked = new URL(value); if (normalized.origin === blocked.origin || loopback(normalized.hostname) && loopback(blocked.hostname) && normalized.port === blocked.port) throw new HttpError(403, 'The Relay browser cannot access Relay itself'); } catch (error) { if (error instanceof HttpError) throw error; }
    }
    return url;
  }
  private queue<T>(agentId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(agentId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(action); this.queues.set(agentId, result);
    void result.finally(() => { if (this.queues.get(agentId) === result) this.queues.delete(agentId); }).catch(() => {});
    return result;
  }
  private async session(agentId: string, headed = false, signal?: AbortSignal, operatorGuard?: () => void): Promise<Session> {
    operatorGuard?.();
    const existing = this.sessions.get(agentId); if (existing) { if (!existing.observable) throw new HttpError(409, 'Browser session is closing or being replaced'); return existing; }
    this.check(agentId, signal, headed || !!operatorGuard);
    const generation = this.generations.get(agentId) ?? 0;
    const restoreGuard = () => { operatorGuard?.(); this.check(agentId, signal, headed || !!operatorGuard); if ((this.generations.get(agentId) ?? 0) !== generation) throw new HttpError(409, 'Browser session request was revoked or replaced'); };
    const profile = await this.sessionSecrets.profile(agentId); restoreGuard();
    const launch = this.options.launch ?? (async (profile, options) => { return chromium.launchPersistentContext(profile, options); });
    const proxy = new BrowserProxy(value => { this.check(agentId, undefined, true); this.url(value); }); const proxyUrl = await proxy.start();
    let context: BrowserContext; try { restoreGuard(); context = await launch(profile, { headless: !headed, acceptDownloads: false, serviceWorkers: 'block', chromiumSandbox: true, channel: 'chromium', proxy: { server: proxyUrl, bypass: '' }, args: ['--proxy-bypass-list=<-loopback>'], timeout: 20000 }); } catch (error) { await proxy.close(); throw error; }
    try {
      operatorGuard?.(); this.check(agentId, signal, headed || !!operatorGuard);
      if ((this.generations.get(agentId) ?? 0) !== generation) throw new HttpError(409, 'Browser session request was revoked or replaced');
      await context.route('**/*', async route => { try { this.check(agentId, undefined, true); this.url(route.request().url(), true); await route.continue(); } catch { await route.abort('blockedbyclient').catch(() => {}); } });
      operatorGuard?.();
      const cookies = await this.sessionSecrets.load(agentId, restoreGuard); restoreGuard(); await context.addCookies(cookies); restoreGuard();
      operatorGuard?.();
      const page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(15000);
      await page.goto('about:blank');
      operatorGuard?.(); this.check(agentId, signal, headed || !!operatorGuard);
      if ((this.generations.get(agentId) ?? 0) !== generation) throw new HttpError(409, 'Browser session request was revoked or replaced');
      const session = { id: id(), observable: true, context, page, humanControl: headed, proxy }; this.sessions.set(agentId, session);
      page.on('framenavigated', frame => { if (this.sessions.get(agentId) === session && (frame === page.mainFrame() || frame.url() === page.url())) { this.invalidate(agentId, 'navigation', false); this.publishStatus(agentId); } });
      page.on('download', download => { void download.cancel().catch(() => {}); });
      context.on('page', popup => { if (popup !== page) void popup.close().catch(() => {}); });
      context.on('close', () => { void proxy.close(); if (this.sessions.get(agentId) === session) { this.invalidate(agentId, 'session_closed'); this.sessions.delete(agentId); this.publishStatus(agentId); } });
      this.publishStatus(agentId);
      return session;
    } catch (error) { await context.close().catch(() => {}); await proxy.close(); throw error; }
  }
  private async action<T>(agentId: string, signal: AbortSignal | undefined, name: BrowserWatchAction, action: (page: Page) => Promise<T>): Promise<T> {
    this.check(agentId, signal);
    return this.queue(agentId, async () => {
      this.check(agentId, signal); const session = await this.session(agentId, false, signal);
      this.activity(agentId, name, 'started');
      let stopping: Promise<void> | undefined; const stop = () => { if (!stopping) { this.invalidate(agentId, 'session_closed'); stopping = session.context.close().finally(() => session.proxy.close()); } void stopping.catch(() => {}); };
      signal?.addEventListener('abort', stop, { once: true });
      try { this.check(agentId, signal); const value = await action(session.page); this.check(agentId, signal); await this.saveSession(agentId, session, () => this.check(agentId, signal)); this.check(agentId, signal); this.activity(agentId, name, 'complete'); this.publishStatus(agentId); return value; }
      catch (error) { this.activity(agentId, name, 'failed'); throw error; }
      finally { signal?.removeEventListener('abort', stop); if (signal?.aborted) { stop(); await stopping!.catch(() => {}); if (this.sessions.get(agentId) === session) this.sessions.delete(agentId); } }
    });
  }
  private async saveSession(agentId: string, session: Session, guard: () => void = () => {}, shutdown = false) {
    const generation = this.generations.get(agentId) ?? 0, intent = this.operatorIntents.get(agentId);
    const check = () => { guard(); if ((!shutdown && this.closing) || this.sessions.get(agentId) !== session || session.page.isClosed() || (this.generations.get(agentId) ?? 0) !== generation || this.operatorIntents.get(agentId) !== intent) throw new HttpError(409, 'Browser session changed, is closing or being replaced. Refresh browser status.'); };
    check(); const cookies = (await session.context.cookies()).filter(cookie => cookie.expires === -1); check(); await this.sessionSecrets.save(agentId, cookies, check);
  }
  statusSnapshot(agentId: string): BrowserStatus {
    const granted = this.capabilities.browserGrant(agentId).enabled; const session = this.sessions.get(agentId);
    let available = !!this.options.launch, error: string | undefined;
    try { if (!available) { available = existsSync(chromium.executablePath()); if (!available) error = 'Install the Relay browser with Setup Relay.cmd (or npx playwright install chromium from the Relay installation folder)'; } } catch { error = 'Install Relay browser dependencies first'; }
    if (!error && this.sessionSecrets.unavailable()) error = 'Private browser session persistence is unavailable on this platform. Session sign-ins are kept only while the browser is open.';
    return { granted, available, running: !!session, humanControl: this.humanOwned.has(agentId), url: session?.page.url() ?? null, sessionId: session?.id ?? null, ...(error ? { error } : {}) };
  }
  async status(agentId:string):Promise<BrowserStatus>{return this.statusSnapshot(agentId);}
  async open(agentId: string, value: string, signal?: AbortSignal): Promise<BrowserView> {
    this.url(value); if (!/^https?:/i.test(value)) throw new HttpError(400, 'Browser navigation needs HTTP or HTTPS');
    return this.action(agentId, signal, 'open', async page => { await page.goto(value, { waitUntil: 'domcontentloaded' }); this.url(page.url()); return this.view(page); });
  }
  async read(agentId: string, signal?: AbortSignal): Promise<BrowserView> {
    return this.action(agentId, signal, 'read', page => this.view(page));
  }
  private async view(page: Page): Promise<BrowserView> {
      this.url(page.url(), true);
      const controls = await page.locator('a,button,input,textarea,select').evaluateAll(elements => elements.filter(element => (element as HTMLElement).getClientRects().length).slice(0, 150).map(element => {
        const parts: string[] = []; let node: Element | null = element; while (node) { if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; } const parent: HTMLElement | null = node.parentElement; let position = 1; if (parent) { for (const sibling of Array.from(parent.children)) { if (sibling === node) break; if (sibling.tagName === node.tagName) position++; } } parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + position + ')'); node = parent; }
        return { selector: parts.join(' > '), tag: element.tagName.toLowerCase(), type: element.getAttribute('type') ?? '', text: (element.getAttribute('aria-label') || element.getAttribute('placeholder') || (element as HTMLElement).innerText || element.getAttribute('name') || '').slice(0, 180) };
      }));
      return { url: page.url(), title: await page.title(), text: (await page.locator('body').innerText({ timeout: 5000 })).slice(0, 32000), controls };
  }
  private selector(value: string) { if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new HttpError(400, 'Choose a browser control selector from the current view'); return value; }
  async click(agentId: string, selector: string, signal?: AbortSignal): Promise<BrowserView> {
    return this.action(agentId, signal, 'click', async page => { await page.locator(this.selector(selector)).click(); this.url(page.url(), true); return this.view(page); });
  }
  async fill(agentId: string, selector: string, value: string, signal?: AbortSignal): Promise<BrowserView> {
    if (typeof value !== 'string' || value.length > 16000) throw new HttpError(400, 'Browser field value is too large');
    return this.action(agentId, signal, 'fill', async page => {
      const target = page.locator(this.selector(selector));
      const sensitive = await target.evaluate(element => { const field = element as HTMLInputElement; const meta = [field.type, field.name, field.id, field.autocomplete, field.getAttribute('aria-label'), field.getAttribute('placeholder'), ...Array.from(field.labels ?? []).map(label => label.textContent)].join(' '); return field.type === 'password' || /password|passwd|credit.?card|card.?number|security.?code|\bcvv\b|\bcvc\b|cc-(?:number|exp|csc|name)|payment|one.?time|\botp\b/i.test(meta); });
      if (sensitive) throw new HttpError(403, 'Use human browser takeover to enter passwords, verification codes or payment details');
      await target.fill(value); return this.view(page);
    });
  }
  async screenshot(agentId: string, signal?: AbortSignal): Promise<{ bytes: Buffer; url: string }> { return this.action(agentId, signal, 'screenshot', async page => { this.url(page.url(), true); return { bytes: await page.screenshot({ type: 'png', fullPage: false }), url: page.url() }; }); }
  /** Human-authenticated route only; no agent tool can enable takeover. */
  async takeover(agentId: string): Promise<BrowserStatus> { return this.operatorControl(agentId, 'takeover'); }
  async returnControl(agentId: string): Promise<BrowserStatus> { return this.operatorControl(agentId, 'return'); }
  private async operatorControl(agentId: string, action: 'takeover' | 'return'): Promise<BrowserStatus> {
    if (action === 'takeover') this.check(agentId, undefined, true);
    else { this.capabilities.browserGrant(agentId); if (this.closing) throw new HttpError(409, 'Browser service is stopping'); }
    const intent = this.nextOperatorIntent(agentId), guard = () => this.checkOperatorIntent(agentId, intent);
    if (action === 'takeover') this.humanOwned.add(agentId);
    this.invalidate(agentId, 'session_replaced', action === 'takeover');
    // A non-retiring clear still requires a status to reestablish the client feed,
    // even when Return keeps the same ownership or cookie persistence later fails.
    this.publishStatus(agentId, action === 'return'); this.activity(agentId, action, 'started');
    try {
      await this.queue(agentId, async () => {
        guard();
        const current = this.sessions.get(agentId), url = current?.page.url();
        if (action === 'return' && current?.observable && !current.page.isClosed() && this.capabilities.browserGrant(agentId).enabled) {
          // Human verification can live in page/sessionStorage state. Hand this exact
          // live page back rather than closing it and loading its URL in a new context.
          const generation = this.generations.get(agentId) ?? 0;
          await this.saveSession(agentId, current, guard); guard();
          this.check(agentId, undefined, true);
          if (this.sessions.get(agentId) !== current || !current.observable || current.page.isClosed() || (this.generations.get(agentId) ?? 0) !== generation) throw new HttpError(409, 'Browser session changed, is closing or being replaced. Refresh browser status.');
          this.humanOwned.delete(agentId);
          this.publishStatus(agentId);
          return;
        }
        if (current) {
          if (action === 'return') this.invalidate(agentId, 'session_replaced');
          await this.saveSession(agentId, current, guard); guard();
          await current.context.close(); guard();
          await current.proxy.close(); guard();
          if (this.sessions.get(agentId) === current) this.sessions.delete(agentId);
        }
        if (action === 'return' && !this.capabilities.browserGrant(agentId).enabled) { this.humanOwned.delete(agentId); this.publishStatus(agentId); return; }
        const session = await this.session(agentId, action === 'takeover', undefined, guard); guard();
        if (url && /^https?:/.test(url)) { this.url(url); await session.page.goto(url, { waitUntil: 'domcontentloaded' }); guard(); }
        // Missing/retired sessions still need replacement. Only the current operator
        // lease may release human ownership after that replacement is ready.
        if (action === 'return') this.humanOwned.delete(agentId);
        this.publishStatus(agentId);
      });
      guard(); this.activity(agentId, action, 'complete'); return this.statusSnapshot(agentId);
    } catch (error) { this.activity(agentId, action, 'failed'); guard(); throw error; }
  }
  async revoke(agentId: string, reason: 'revoke' | 'stop' = 'revoke'): Promise<void> { this.nextOperatorIntent(agentId); this.invalidate(agentId, 'revoked'); this.activity(agentId, reason, 'started'); const current = this.sessions.get(agentId); try { if (current) { try { if (reason !== 'stop') await this.saveSession(agentId, current); } finally { try { await current.context.close(); } finally { await current.proxy.close(); if (this.sessions.get(agentId) === current) this.sessions.delete(agentId); } } } this.activity(agentId, reason, 'complete'); } catch (error) { this.activity(agentId, reason, 'failed'); throw error; } finally { this.publishStatus(agentId); } }
  async close(): Promise<void> { this.closing = true; for (const [agentId, observer] of this.observers) { this.invalidate(agentId, 'shutdown'); clearInterval(observer.timer); } this.observers.clear(); await Promise.all([...this.sessions.entries()].map(async ([agentId, session]) => { await this.saveSession(agentId, session, () => {}, true).catch(() => {}); await session.context.close().catch(() => {}); await session.proxy.close(); })); this.sessions.clear(); await Promise.allSettled([...this.captures.values(), ...this.queues.values()]); this.sessionSecrets.close(); }
}
