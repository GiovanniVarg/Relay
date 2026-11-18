import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium} from 'playwright';
import {createApp} from '../server/index.js';
import {PROVIDER_IDS} from '../server/store.js';
import type {Agent, GroupRun, ProviderAdapter, ProviderId, ProviderRequest} from '../shared/types.js';

test('mounted Smart group uses real authenticated guidance and delivers a visible outcome without stale speakers', {timeout: 60000, skip: process.env.RELAY_BROWSER_LIVE !== '1'}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-smart-browser-')), evidence = resolve('../evidence');
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(done => {enter = done;}), released = new Promise<void>(done => {release = done;});
  let stale = '', chosen = '', decisions = 0; const calls: ProviderRequest[] = [];
  const adapters = Object.fromEntries(PROVIDER_IDS.map(provider => [provider, {id: provider, inspect: async () => ({id: provider, installed: true, authenticated: true, authMode: 'subscription', accountLabel: 'Synthetic local test', plan: 'Included', models: [{id: 'fixture', name: 'Fixture', verified: true}]}), login: async () => ({message: 'Fixture'}), close: async () => {}, stream: async (request: ProviderRequest) => {
    calls.push(request);
    if (request.runId.startsWith('group-moderator-')) {decisions++; if (decisions === 1) {enter(); await released; return {text: JSON.stringify({speakerId: stale, reason: 'Explore an initial option.', focus: 'Consider a larger rollout.'})};} return {text: JSON.stringify({speakerId: decisions === 2 ? chosen : null, reason: decisions === 2 ? 'Jun can check the newly requested rollback constraint.' : 'The team has a practical release path.', focus: decisions === 2 ? 'Check the smallest reversible rollout and rollback verification.' : ''})};}
    return {text: request.runId.startsWith('group-summary-') ? '**Recommendation:** start with a small, reversible rollout.\n\n- Verify rollback before release.\n- Watch the first cohort, then expand.\n\nJun identified rollback verification as the key remaining check.' : 'Start with one small cohort. Verify the rollback command before release, and expand only after the first cohort stays healthy.'};
  }}])) as unknown as Record<ProviderId, ProviderAdapter>;
  const app = createApp({dataDir: dir, port: 0, adapters, clientDir: resolve('dist/client')}); let browser;
  try {
    for (const provider of PROVIDER_IDS) {app.store.saveBilling(provider, {mode: 'included', confirmed: true, automaticRouting: true, allowanceNote: 'Synthetic'}); app.store.saveModelPreferences(provider, {defaultModel: 'fixture', allowedModels: ['fixture']});}
    const names = ['Mira', 'Theo', 'Jun'], roles = ['Lead', 'Implementation', 'Review'];
    const agents = app.store.list<Agent>('agent').slice(0, 3).map((agent, i) => app.store.put<Agent>('agent', {...agent, name: names[i], role: roles[i], initials: names[i][0], routeMode: 'openai', model: 'fixture', instructions: 'Synthetic perspective ' + i}));
    stale = agents[1].id; chosen = agents[2].id; const room = app.groups.create(agents.map(agent => agent.id), 'Release team');
    const port = await app.listen(0); browser = await chromium.launch({headless: true}); const page = await browser.newPage({viewport: {width: 1280, height: 920}}), errors: string[] = [], guidanceRequests: string[] = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('response', response => {if (response.status() >= 400) errors.push(response.status() + ' ' + new URL(response.url()).pathname);});
    page.on('request', request => {if (request.method() === 'POST' && /\/api\/runs\/[^/]+\/message$/.test(new URL(request.url()).pathname)) guidanceRequests.push(new URL(request.url()).pathname);});
    await page.addInitScript(({agentId, roomId}) => {localStorage.setItem('relay.agent', agentId); localStorage.setItem('relay.room', roomId); if (localStorage.getItem('relay.advanced') === null) localStorage.setItem('relay.advanced', 'false');}, {agentId: agents[0].id, roomId: room.id});
    // Establish the browser's own cookie before mounting background terminal hooks.
    assert.equal((await page.request.get(`http://127.0.0.1:${port}/api/bootstrap`)).status(), 200);
    await page.goto(`http://127.0.0.1:${port}/`); const composer = page.getByRole('textbox', {name: 'Discussion topic or follow-up'}); await composer.waitFor(); await page.getByText('3 bots · Smart discussion', {exact: true}).waitFor();
    await composer.fill('Help us choose a reliable release plan.'); await composer.press('Enter'); await entered;
    const run = app.store.groupRuns(room.id).at(-1)!; assert.equal(run.executionMode, 'smart');
    const denied = await page.request.post(`http://127.0.0.1:${port}/api/runs/${run.id}/message`, {data: {content: 'UNAUTHENTICATED_GUIDANCE'}}); assert.equal(denied.status(), 403); assert.equal(app.store.groupMessages(room.id).some(message => message.content === 'UNAUTHENTICATED_GUIDANCE'), false);
    await page.getByRole('button', {name: 'Reply to your message', exact: true}).click(); await composer.fill('Keep it small and reversible. Ask Jun to check the rollback.'); await composer.press('Enter');
    await page.waitForFunction(() => document.querySelector('textarea')?.value === '');
    assert.equal(app.store.groupMessages(room.id).filter(message => message.content === 'Keep it small and reversible. Ask Jun to check the rollback.').length, 1); release();
    await page.getByText('Recommendation:', {exact: true}).waitFor(); await page.waitForFunction(() => !document.querySelector('.simple-group-activity'));
    const messages = app.store.groupMessages(room.id), completed = app.store.get<GroupRun>('group-run', run.id)!;
    assert.equal(completed.status, 'complete'); assert.deepEqual(messages.filter(message => message.role === 'assistant').map(message => message.agentId), [chosen, agents[0].id]); assert.equal(guidanceRequests.length, 1);
    assert.ok(messages.filter(message => message.role === 'assistant').every(message => !!message.content && message.status === 'complete'));
    assert.ok(calls.every(request => !request.appTools && request.execution?.mode === 'chat'));
    await mkdir(evidence, {recursive: true}); await page.screenshot({path: join(evidence, 'groups-smart-desktop.jpg'), type: 'jpeg', fullPage: true});
    await page.evaluate(() => localStorage.setItem('relay.advanced', 'true')); await page.reload(); const mode = page.getByRole('combobox', {name: 'Discussion session mode'}); await mode.waitFor(); assert.equal(await mode.inputValue(), 'smart'); await mode.selectOption('continuous'); assert.equal(await mode.inputValue(), 'continuous');
    await page.evaluate(() => localStorage.setItem('relay.advanced', 'false')); await page.setViewportSize({width: 390, height: 844}); await page.reload(); await composer.waitFor(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true); await page.screenshot({path: join(evidence, 'groups-smart-narrow.jpg'), type: 'jpeg', fullPage: true});
    assert.deepEqual(errors, []); await writeFile(join(evidence, 'groups-smart-browser-proof.json'), JSON.stringify({synthetic: true, providerCalls: calls.length, selectedSpeakers: messages.filter(message => message.role === 'assistant').map(message => message.authorName), guidanceRequests: guidanceRequests.length, executionMode: run.executionMode, status: completed.status, errors}, null, 2));
  } finally {release(); await browser?.close(); await app.close(); await rm(dir, {recursive: true, force: true});}
});
