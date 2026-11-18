import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { createServer } from 'vite';

test('iPhone installs before pairing and transfers only a public profile into its separate app context', { skip: process.env.RELAY_BROWSER_LIVE !== '1', timeout: 60000 }, async () => {
  const source = "import{createElement}from'react';import{createRoot}from'react-dom/client';import{ControllerGate}from'/ControllerGate.tsx';import'/style.css';import'/controller.css';createRoot(document.getElementById('root')).render(createElement(ControllerGate,null,createElement('p',null,'Workspace')));";
  const vite = await createServer({ configFile: false, root: resolve('client'), cacheDir: resolve('.data-ui-preview/controller-install-vite-' + randomUUID()), define: { __RELAY_HOSTED__: 'true' }, esbuild: { jsx: 'automatic' }, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'iphone-install-fixture', resolveId(id) { if (id === '/iphone-install.tsx') return '\0iphone-install'; }, load(id) { if (id === '\0iphone-install') return source; } }] });
  let browser: Browser | undefined;
  try {
    await vite.listen(); browser = await chromium.launch({ channel: 'chrome', headless: true });
    const options = { viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' };
    const safari = await browser.newContext(options), app = await browser.newContext(options);
    // Development styles load Vite's loopback client. Grant ordinary local-network permission
    // only to these isolated contexts; product identity checks and pairing remain untouched.
    for (const context of [safari, app]) await context.grantPermissions(['local-network-access'], { origin: new URL(vite.resolvedUrls!.local[0]).origin });
    // This loopback development fixture explicitly selects the hosted entry point;
    // localhost normally bypasses it, unlike the public production controller origin.
    // __name supports tsx's serialized browser callbacks, as in the storage browser fixtures.
    for (const context of [safari, app]) await context.addInitScript({ content: 'window.__name = value => value; window.__RELAY_HOSTED__ = true;' });
    await safari.addInitScript(() => { (window as any).copied = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).copied = text; } } }); });
    await app.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { value: true }); });
    const profile = { url: 'https://192.168.1.20:3443', ca: '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----', fingerprint: 'a'.repeat(64), transport: { kind: 'webtransport-v1', endpoint: 'https://192.168.1.20:3443/relay', pin: 'b'.repeat(64) } };
    let privateRequests = 0;
    for (const context of [safari, app]) {
      await context.route('**/install-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/iphone-install.tsx"></script>' }));
      await context.route('**/api/**', route => { privateRequests++; return route.abort(); });
    }
    const page = await safari.newPage(), origin = vite.resolvedUrls!.local[0], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(origin + 'install-fixture#connect=' + Buffer.from(JSON.stringify(profile)).toString('base64url'));
    try { await page.getByRole('heading', { name: 'Use Relay on your iPhone', exact: true }).waitFor({ timeout: 10000 }); }
    catch (error) { throw new Error('Initial iPhone setup did not mount: ' + JSON.stringify({ errors, visible: (await page.locator('body').innerText()).slice(0, 3000) }), { cause: error }); }
    assert.deepEqual(errors, []);
    assert.equal(await page.getByText('Workspace', { exact: true }).count(), 0, 'the hosted gate must not mount a workspace before pairing');
    assert.equal(await page.locator('.relay-controller-primary').count(), 1, 'the initial choice has one main action');
    assert.equal(await page.getByRole('button', { name: 'Check connection', exact: true }).count(), 0);
    await page.waitForFunction(() => !(document.querySelector('.relay-controller-primary') as HTMLButtonElement)?.disabled);
    await mkdir(resolve('.data-ui-preview/controller-guided'), { recursive: true });
    await page.screenshot({ path: '.data-ui-preview/controller-guided/iphone-choice.png' });
    for (const theme of ['light', 'dark']) {
      await page.getByLabel('Appearance', { exact: true }).selectOption(theme);
      await page.screenshot({ path: '.data-ui-preview/controller-guided/final-iphone-choice-' + theme + '.png', animations: 'disabled' });
    }
    await page.getByLabel('Appearance', { exact: true }).selectOption('light');
    await page.getByRole('button', { name: 'Set up Home Screen app', exact: true }).click();
    await page.getByRole('heading', { name: 'Add Relay to your Home Screen', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Continue in Safari', exact: true }).count(), 0, 'installation replaces the connection flow');
    assert.equal(await page.getByRole('button', { name: 'Check connection', exact: true }).count(), 0);
    assert.equal(await page.locator('.relay-controller-primary').count(), 1);
    await page.screenshot({ path: '.data-ui-preview/controller-guided/iphone-install.png' });
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Continue in Safari', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Set up Home Screen app', exact: true }).click();
    await page.getByRole('button', { name: 'Copy setup details', exact: true }).click();
    await page.getByText('Public connection profile copied. Open Relay from the Home Screen and paste it there.', { exact: true }).waitFor();
    const copied = await page.evaluate(() => (window as any).copied as string);
    assert.deepEqual(JSON.parse(copied), profile);
    // Clipboard denial leaves selectable public data; it must not become a pairing error.
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('denied'); }; });
    await page.getByRole('button', { name: 'Copy setup details', exact: true }).click();
    await page.getByText('Copy was unavailable. Select and copy the public profile below, then paste it in the Home Screen app.', { exact: true }).waitFor();
    await page.getByText('Manual copy', { exact: true }).click();
    const manualCopy = page.getByLabel('Public profile for Home Screen app', { exact: true });
    assert.equal(await manualCopy.count(), 1, 'the readonly public profile needs an unambiguous accessible label');
    assert.equal(await manualCopy.inputValue(), copied);
    await manualCopy.focus();
    assert.equal(await manualCopy.evaluate(element => { const field = element as HTMLTextAreaElement; return field.readOnly && field.selectionStart === 0 && field.selectionEnd === field.value.length; }), true, 'manual copy selects the complete readonly public profile');
    await page.evaluate(() => { navigator.clipboard.writeText = () => new Promise<void>(resolve => { (window as any).finishOldCopy = resolve; }); });
    await page.getByRole('button', { name: 'Copy setup details', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Copying…', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).isEnabled(), true);
    await page.screenshot({ path: '.data-ui-preview/controller-guided/final-install-copy-busy.png', animations: 'disabled', fullPage: true });
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.evaluate(() => (window as any).finishOldCopy());
    await page.getByRole('button', { name: 'Set up Home Screen app', exact: true }).click();
    assert.equal(await page.getByRole('status').count(), 0, 'a late copy cannot report success in a new setup generation');
    const installed = await app.newPage(); await installed.goto(origin + 'install-fixture');
    await installed.getByText('Finish your Home Screen setup', { exact: true }).waitFor();
    assert.equal(await installed.getByRole('button', { name: 'Continue in Safari', exact: true }).count(), 0);
    await installed.getByLabel('Copied connection profile', { exact: true }).fill(copied);
    await installed.getByRole('button', { name: 'Use copied connection profile', exact: true }).click();
    await installed.getByRole('button', { name: 'Check connection', exact: true }).waitFor();
    assert.equal(await installed.getByLabel('Copied connection profile', { exact: true }).count(), 0);
    assert.equal(privateRequests, 0, 'install guidance and public paste never send a pairing or private request');
    for (const [view, theme] of [[page, 'light'], [page, 'dark'], [installed, 'light'], [installed, 'dark']] as const) {
      await view.getByLabel('Appearance', { exact: true }).selectOption(theme);
      assert.equal(await view.locator('.relay-controller-primary').isEnabled(), true, 'normal setup controls are enabled');
      assert.equal(await view.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'phone onboarding must not scroll sideways');
      const targets = await view.locator('.relay-controller-primary').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
      assert.ok(targets.every(height => height >= 44), 'main actions remain touch-sized');
      await view.screenshot({ path: '.data-ui-preview/controller-guided/final-' + (view === page ? 'install-' : 'standalone-') + theme + '.png', animations: 'disabled' });
    }
  } finally { await browser?.close(); await vite.close(); }
});
