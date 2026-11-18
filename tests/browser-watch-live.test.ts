import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Page } from 'playwright';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createApp } from '../server/index.js';
import type { Bootstrap, ProviderAdapter, ProviderId } from '../shared/types.js';
import type { BrowserWatchEvent } from '../shared/browser-watch.js';

type Frame = Extract<BrowserWatchEvent, { type: 'frame' }>;
const adapters = Object.fromEntries(['openai', 'claude', 'cursor', 'gemini', 'grok'].map(id => [id, {
  id, inspect: async () => ({ id, installed: false, authenticated: false, authMode: 'unknown', accountLabel: '', plan: '', models: [] }),
  close: async () => {}, login: async () => ({ message: '' }), stream: async () => { throw Error('No inference in the disposable browser-watch fixture'); },
}])) as unknown as Record<ProviderId, ProviderAdapter>;

async function until<T>(read: () => T | undefined | Promise<T | undefined>, label: string, timeout = 7000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await delay(20);
  }
}

async function observe(url: string, cookie: string) {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { Cookie: cookie }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const reader = response.body!.getReader(), events: BrowserWatchEvent[] = [];
  let ended = false, failure: unknown;
  const pump = (async () => {
    const decoder = new TextDecoder(); let pending = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const boundary = pending.indexOf('\n\n'); if (boundary < 0) break;
          const message = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          for (const line of message.split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as BrowserWatchEvent);
        }
      }
    } catch (error) { if (!controller.signal.aborted) failure = error; }
    finally { ended = true; reader.releaseLock(); }
  })();
  return { events, pump, abort: () => controller.abort(), get ended() { return ended; }, check() { if (failure) throw failure; } };
}

async function swatch(frame: Frame): Promise<number[]> {
  const bytes = Buffer.from(frame.jpeg, 'base64');
  assert.ok(bytes.length > 100 && bytes.length <= 512 * 1024);
  assert.equal(bytes.readUInt16BE(0), 0xffd8);
  const image = await loadImage(bytes);
  assert.ok(image.width >= 320 && image.height >= 300, 'JPEG decodes into a real viewport');
  const canvas = createCanvas(image.width, image.height), context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return Array.from(context.getImageData(80, 80, 1, 1).data);
}

test('real owned Chromium watch streams JPEG pixels independently of navigation, isolates bots, revokes and closes without persistence', {
  timeout: 45000, skip: process.env.RELAY_BROWSER_LIVE !== '1',
}, async t => {
  for (const key of ['RELAY_CODEX_LIVE_DATA_DIR', 'RELAY_CODEX_SHELL_DATA_DIR', 'RELAY_CODEX_SHELL_CWD']) assert.equal(process.env[key], undefined, `${key} must be unset`);
  assert.ok(existsSync(chromium.executablePath()), 'Real Chromium is unavailable; install only through the separately approved setup flow');
  const evidenceRoot = resolve('.data-browser-watch'); await mkdir(evidenceRoot, { recursive: true });
  const directory = await mkdtemp(join(evidenceRoot, 'temp-live-watch-'));
  const captures: { at: number; options: Parameters<Page['screenshot']>[0] }[] = [];
  let activeCaptures = 0, maximumCaptures = 0;
  const app = createApp({ dataDir: join(directory, 'data'), adapters, port: 0, browserOptions: {
    launch: async (profile, options) => {
      // Observe starts/options while forwarding every capture unchanged to real Chromium.
      const context = await chromium.launchPersistentContext(profile, options);
      for (const page of context.pages()) {
        const screenshot = page.screenshot.bind(page);
        page.screenshot = async options => {
          captures.push({ at: Date.now(), options }); maximumCaptures = Math.max(maximumCaptures, ++activeCaptures);
          try { return await screenshot(options); } finally { activeCaptures--; }
        };
      }
      return context;
    },
  } });
  const held = new Set<ServerResponse>(); let scriptRequested = false, closed = false;
  const fixture = createServer((request, response) => {
    if (request.url === '/hold.js') { scriptRequested = true; held.add(response); response.once('close', () => held.delete(response)); return; }
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Set-Cookie', 'synthetic_watch=owned; Path=/');
    response.end(`<!doctype html><title>Synthetic browser-watch fixture</title>
      <style>body{background:#fafafa;font:20px sans-serif}#swatch{position:absolute;left:20px;top:20px;width:300px;height:180px;background:rgb(220,20,20)}#form{position:absolute;left:20px;top:240px}</style>
      <div id="swatch"></div><div id="form"><label>Name <input id="fixture-name"></label><button id="fixture-save" onclick="document.querySelector('#swatch').style.background='rgb(20,40,220)';document.querySelector('#result').textContent=document.querySelector('#fixture-name').value">Save</button><p id="result"></p></div>
      ${request.url === '/pending' ? '<script defer src="/hold.js"></script>' : ''}`);
  });
  const streams: Awaited<ReturnType<typeof observe>>[] = [];
  let pendingNavigation: Promise<unknown> | undefined;
  const releaseScripts = () => { for (const response of held) { response.setHeader('Content-Type', 'application/javascript'); response.end('/* synthetic deferred script released */'); } held.clear(); };
  try {
    await new Promise<void>(done => fixture.listen(0, '127.0.0.1', done));
    const fixtureUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    const base = `http://127.0.0.1:${await app.listen(0)}`;
    const bootstrapResponse = await fetch(base + '/api/bootstrap'), bootstrap = await bootstrapResponse.json() as Bootstrap;
    const cookie = bootstrapResponse.headers.get('set-cookie')!.split(';')[0], [agent, peer] = bootstrap.agents;
    const api = (path: string, method: string, body: unknown) => fetch(base + '/api' + path, { method, headers: { Cookie: cookie, 'X-CSRF-Token': bootstrap.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await fetch(base + `/api/browser/${agent.id}/events`)).status, 401);
    const watching = await observe(base + `/api/browser/${agent.id}/events`, cookie); streams.push(watching);
    const waiting = await observe(base + `/api/browser/${peer.id}/events`, cookie); streams.push(waiting);
    const initial = await until(() => watching.events[0], 'initial status');
    assert.equal(initial.type, 'status'); assert.equal(initial.sequence, 1); assert.equal(initial.sessionId, null);
    await delay(1100);
    assert.equal(existsSync(join(app.store.dataDir, 'browser')), false, 'observation before grant creates no browser profile');
    assert.equal(watching.events.some(event => event.type === 'frame'), false);
    assert.equal((await api(`/capabilities/${agent.id}/browser`, 'PATCH', { enabled: true })).status, 200);
    await delay(1100);
    assert.equal(existsSync(join(app.store.dataDir, 'browser')), false, 'grant plus observation does not launch a context');

    let navigationSettled = false;
    pendingNavigation = app.browser.open(agent.id, fixtureUrl + '/pending').finally(() => { navigationSettled = true; });
    // Attach rejection handling immediately, including if a later assertion fails before cleanup.
    void pendingNavigation.catch(() => {});
    await until(() => scriptRequested ? true : undefined, 'held deferred script request');
    const started = await until(() => watching.events.find(event => event.type === 'activity' && event.action === 'open' && event.phase === 'started'), 'open activity during pending navigation');
    const pendingStatus = await until(() => watching.events.find(event => event.type === 'status' && event.status.url === fixtureUrl + '/pending'), 'status during pending navigation');
    assert.equal(navigationSettled, false);
    const pendingFrame = await until(() => watching.events.find((event): event is Frame => event.type === 'frame' && event.url === fixtureUrl + '/pending'), 'actual JPEG while DOMContentLoaded is held', 5500);
    assert.equal(navigationSettled, false, 'JPEG is delivered while the real open action remains pending');
    assert.ok(started.sequence < pendingFrame.sequence && pendingStatus.sequence < pendingFrame.sequence);
    const red = await swatch(pendingFrame); assert.ok(red[0] > 180 && red[1] < 70 && red[2] < 70, `pending page renders red: ${red}`);
    t.diagnostic(`Actual JPEG delivered during held navigation: ${Buffer.from(pendingFrame.jpeg, 'base64').length} bytes`);
    releaseScripts(); await pendingNavigation;

    await app.browser.fill(agent.id, '#fixture-name', 'Synthetic value must not enter activity');
    const beforeClick = watching.events.at(-1)!.sequence;
    assert.match((await app.browser.click(agent.id, '#fixture-save')).text, /Synthetic value must not enter activity/);
    const examined = new Set<number>();
    const changed = await until(async () => {
      for (const event of watching.events) if (event.type === 'frame' && event.sequence > beforeClick && !examined.has(event.sequence)) {
        examined.add(event.sequence); const pixel = await swatch(event);
        if (pixel[0] < 70 && pixel[1] < 90 && pixel[2] > 180) return event;
      }
      return undefined;
    }, 'decoded blue JPEG after fill/click');
    const blue = await swatch(changed); assert.ok(blue[0] < 70 && blue[1] < 90 && blue[2] > 180, `click changes decoded pixels to blue: ${blue}`);
    assert.equal(changed.sessionId, pendingFrame.sessionId);
    const cookieFile = join(app.store.dataDir, 'browser', agent.id, 'session-cookies.json');
    const cookiesBefore = await stat(cookieFile), bytesBefore = await readFile(cookieFile);
    const lastSequence = changed.sequence;
    await until(() => watching.events.filter(event => event.type === 'frame' && event.sequence > lastSequence).length >= 2 ? true : undefined, 'two further watch-only frames');
    assert.equal((await stat(cookieFile)).mtimeMs, cookiesBefore.mtimeMs, 'watch-only captures never rewrite session cookies');
    assert.deepEqual(await readFile(cookieFile), bytesBefore);
    assert.equal(waiting.events.some(event => event.type === 'frame' || event.type === 'activity'), false, 'waiting bot never receives active bot pixels/activity');
    assert.ok(waiting.events.every(event => event.agentId === peer.id && event.sessionId === null));
    assert.equal(existsSync(join(app.store.dataDir, 'browser', peer.id)), false);
    const activities = watching.events.filter(event => event.type === 'activity');
    assert.ok(activities.some(event => event.action === 'fill' && event.phase === 'complete'));
    assert.ok(activities.some(event => event.action === 'click' && event.phase === 'complete'));
    for (const event of activities) assert.deepEqual(Object.keys(event).sort(), ['action', 'agentId', 'observedAt', 'phase', 'sequence', 'sessionId', 'type']);
    assert.doesNotMatch(JSON.stringify(activities), /Synthetic value|fixture-name|fixture-save/);
    for (const stream of streams) { stream.check(); assert.ok(stream.events.every((event, index) => event.sequence === index + 1)); }
    const frames = watching.events.filter((event): event is Frame => event.type === 'frame');
    assert.ok(captures.length >= frames.length);
    assert.equal(maximumCaptures, 1, 'real screenshot calls never overlap');
    for (const capture of captures) assert.deepEqual(capture.options, { type: 'jpeg', quality: 55, fullPage: false, timeout: 2000 });
    // Date.now() rounds to milliseconds and this wrapper runs just after Browser's rate check.
    for (let index = 1; index < captures.length; index++) assert.ok(captures[index].at - captures[index - 1].at >= 998, 'real screenshot starts respect the 1000 ms interval (2 ms instrumentation tolerance)');

    await assert.rejects(app.browser.open(agent.id, base), /Relay itself/);
    await assert.rejects(app.browser.open(agent.id, base.replace('127.0.0.1', 'localhost')), /Relay itself/);
    const revokeStart = watching.events.length;
    assert.equal((await api(`/capabilities/${agent.id}/browser`, 'PATCH', { enabled: false })).status, 200);
    const cleared = await until(() => watching.events.slice(revokeStart).find(event => event.type === 'clear' && event.reason === 'revoked'), 'revocation clear');
    await delay(1400);
    assert.equal(watching.events.some(event => event.type === 'frame' && event.sequence > cleared.sequence), false, 'no frame follows revocation');
    assert.equal((await app.browser.status(agent.id)).running, false);
    const records = JSON.stringify(app.store.db.prepare('SELECT kind,data FROM records').all());
    assert.doesNotMatch(records, /"jpeg"|"capturedAt"|Synthetic value must not enter activity/);
    for (const frame of frames) assert.equal(records.includes(frame.jpeg), false);
    assert.deepEqual(app.artifacts.list(), []);
    assert.equal(existsSync(app.artifacts.root), false);
    const profileNames = await readdir(join(app.store.dataDir, 'browser', agent.id));
    assert.ok(profileNames.every(name => !/\.(?:jpe?g|png)$/i.test(name)), 'no preview image file is created in the owned profile root');
    waiting.abort(); await until(() => waiting.ended ? true : undefined, 'aborted observer cleanup'); await waiting.pump;
    const closeStart = Date.now(); await app.close(); closed = true;
    await until(() => watching.ended ? true : undefined, 'SSE EOF on app shutdown'); await watching.pump;
    assert.ok(Date.now() - closeStart < 5000, 'app shutdown does not hang on an open SSE reader');
    assert.ok(watching.events.some(event => event.type === 'clear' && event.reason === 'shutdown'));
    t.diagnostic(`Decoded ${frames.length} real JPEG frames; red→blue pixels, cookie mtime, waiting-bot isolation, revoke and SSE shutdown verified`);
  } finally {
    releaseScripts();
    for (const stream of streams) stream.abort();
    if (!closed) await app.close();
    await Promise.all(streams.map(stream => stream.pump));
    await pendingNavigation?.catch(() => {});
    fixture.closeAllConnections(); await new Promise<void>(done => fixture.close(() => done()));
    const parent = await realpath(evidenceRoot), target = await realpath(directory), child = relative(parent, target);
    assert.ok(child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child) && child.startsWith('temp-live-watch-'), 'cleanup stays inside the disposable evidence directory');
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
