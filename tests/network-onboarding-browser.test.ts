import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, webcrypto } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { createServer } from 'vite';
import QRCode from 'qrcode';
import { BasicConstraintsExtension, X509CertificateGenerator } from '@peculiar/x509';

test('phone pairing distinguishes secure preparation from failure and keeps a large QR within mobile layouts', { skip: process.env.RELAY_BROWSER_LIVE !== '1', timeout: 60000 }, async () => {
  const cryptoProvider = webcrypto as unknown as Crypto;
  const keys = await cryptoProvider.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const root = await X509CertificateGenerator.createSelfSigned({ serialNumber: '01', name: 'CN=Relay visual fixture', notBefore: new Date(Date.now() - 86400000), notAfter: new Date(Date.now() + 86400000), signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }, keys, extensions: [new BasicConstraintsExtension(true, undefined, true)] }, cryptoProvider);
  const publicCA = root.toString('pem'), fingerprint = createHash('sha256').update(Buffer.from(root.rawData)).digest('hex');
  const profile = { url: 'https://192.168.1.20:3443', ca: publicCA, fingerprint, transport: { kind: 'webtransport-v1', endpoint: 'https://192.168.1.20:3443/relay', pin: 'b'.repeat(64) } };
  const connectionLink = 'https://controller.example/#connect=' + Buffer.from(JSON.stringify(profile)).toString('base64url');
  const qrDataUrl = await QRCode.toDataURL(connectionLink, { errorCorrectionLevel: 'M', margin: 3, width: 224 });
  const qrBytes = Buffer.from(qrDataUrl.split(',')[1], 'base64');
  const source = `import{createElement,useCallback,useState}from'react';import{createRoot}from'react-dom/client';import{NetworkPanel}from'/NetworkPanel.tsx';import{applyAppearance}from'/appearance.ts';import'/style.css';import'/network-panel.css';
  window.fixtureCalls=[];window.fixtureTheme=applyAppearance;
  const base={enabled:true,listening:true,url:'https://192.168.1.20:3443',address:'192.168.1.20',port:3443,controllerOrigins:['https://controller.example'],publicCA:${JSON.stringify(publicCA)},fingerprint:${JSON.stringify(fingerprint)},error:null,interfaces:[{name:'Wi-Fi',address:'192.168.1.20',netmask:'255.255.255.0'}],devices:[]};
  function App(){const[phase,setPhase]=useState('pending');const api=useCallback(async(path,method='GET',body)=>{window.fixtureCalls.push({path,method,body});if(path==='/network')return{...base,transport:phase==='ready'?{kind:'webtransport-v1',endpoint:base.url+'/relay',pin:'b'.repeat(64)}:null,transportError:phase==='failed'?'Synthetic transport failed':null};if(path==='/network/computers')return{computers:[]};if(path==='/network/invites')return{code:'ABCD-EFGH-JKMP',expiresAt:Date.now()+300000};throw Error('Unexpected fixture API '+path);},[phase]);return createElement('main',null,createElement('nav',null,...['pending','failed','ready'].map(value=>createElement('button',{onClick:()=>setPhase(value),key:value},'Show '+value))),createElement('div',{style:{padding:12,maxWidth:510,margin:'auto'}},createElement(NetworkPanel,{key:phase,api,phoneOnly:true})));}createRoot(document.getElementById('root')).render(createElement(App));`;
  const vite = await createServer({ configFile: false, root: resolve('client'), cacheDir: resolve('.data-ui-preview/network-onboarding-vite-' + randomUUID()), esbuild: { jsx: 'automatic' }, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'network-onboarding-fixture', resolveId(id) { if (id === '/network-onboarding.tsx') return '\0network-onboarding'; }, load(id) { if (id === '\0network-onboarding') return source; } }] });
  let browser: Browser | undefined;
  try {
    await vite.listen(); browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } }), errors: string[] = [];
    await page.addInitScript({ content: 'window.__name = value => value;' });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/network-onboarding-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/network-onboarding.tsx"></script>' }));
    await page.route('**/api/network/connection-qr?*', route => route.fulfill({ contentType: 'image/png', body: qrBytes }));
    await page.goto(vite.resolvedUrls!.local[0] + 'network-onboarding-fixture');
    await page.getByText('Preparing your secure connection…', { exact: true }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0, 'ordinary preparation is not an error');
    assert.equal((await page.locator('body').innerText()).includes('Restart Relay'), false);
    assert.equal(await page.getByRole('button', { name: 'Connect phone', exact: true }).count(), 0, 'no code can be requested before transport is ready');
    assert.equal(await page.evaluate(() => (window as any).fixtureCalls.filter((call: any) => call.method !== 'GET').length), 0);
    await mkdir(resolve('.data-ui-preview/controller-guided'), { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => (window as any).fixtureTheme(value), theme);
      await page.screenshot({ path: '.data-ui-preview/controller-guided/final-network-pending-' + theme + '-390.png', animations: 'disabled' });
    }
    await page.getByRole('button', { name: 'Show failed', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Couldn’t start the secure connection' }).waitFor();
    assert.equal(await page.getByText('Preparing your secure connection…', { exact: true }).count(), 0);
    await page.getByText('Synthetic transport failed', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show ready', exact: true }).click();
    const qr = page.getByRole('img', { name: 'QR code for the controller website and public host connection details', exact: true });
    await qr.waitFor();
    const pixels = await qr.evaluate(async element => {
      const image = element as HTMLImageElement; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data; let dark = 0, white = 0;
      for (let index = 0; index < data.length; index += 4) { if (data[index + 3] === 255 && data[index] < 20 && data[index + 1] < 20 && data[index + 2] < 20) dark++; if (data[index + 3] === 255 && data[index] > 235 && data[index + 1] > 235 && data[index + 2] > 235) white++; }
      return { width: canvas.width, height: canvas.height, dark, white };
    });
    assert.equal(pixels.width, 224); assert.equal(pixels.height, 224); assert.ok(pixels.dark > 500 && pixels.white > 500, 'the fixture displays actual opaque QR modules, not a blank placeholder');
    assert.equal(await page.getByRole('link', { name: 'Open controller website', exact: true }).getAttribute('href'), connectionLink, 'the shown QR encodes the exact public-only pinned controller link');
    assert.match(await page.locator('.network-panel').evaluate(element => getComputedStyle(element).fontFamily), /Segoe UI|system-ui/);
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await page.getByText('Preparing your secure connection…', { exact: true }).count(), 0);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(value => (window as any).fixtureTheme(value), theme);
        const bounds = await qr.boundingBox(); assert.ok(bounds);
        assert.ok(bounds.width >= 220 && bounds.width <= 225, 'phone QR keeps its readable size: ' + JSON.stringify({ width, bounds, card: await page.locator('.network-panel').boundingBox() }));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const button = page.getByRole('button', { name: 'Connect phone', exact: true });
        assert.ok((await button.boundingBox())!.height >= 44);
        await mkdir(resolve('.data-ui-preview/controller-guided'), { recursive: true });
        await page.screenshot({ path: '.data-ui-preview/controller-guided/final-network-' + theme + '-' + width + '.png', animations: 'disabled' });
      }
    }
    assert.equal(await page.evaluate(() => (window as any).fixtureCalls.filter((call: any) => call.method !== 'GET').length), 0);
    await page.getByRole('button', { name: 'Connect phone', exact: true }).click();
    await page.getByRole('textbox', { name: 'One-time connection code', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => (window as any).fixtureCalls.filter((call: any) => call.path === '/network/invites' && call.method === 'POST').length), 1);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await vite.close(); }
});
