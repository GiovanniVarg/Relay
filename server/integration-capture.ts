import { randomBytes } from 'node:crypto';
import type { InteractionAnswer, RunInteraction } from '../shared/types.js';
import { INTEGRATION_CREDENTIAL_PREFIX, isIntegrationReceiver, type IntegrationReceiver } from '../shared/integration-credentials.js';
import type { AppActionScope } from './app-actions.js';
import { HttpError, only, stringValue } from './security.js';
interface Capture {
    id: string;
    target: string;
    receiver: IntegrationReceiver;
    scope: AppActionScope;
    check: () => void;
    apply: (token: string, check: () => void, receiver: IntegrationReceiver) => Promise<unknown>;
    expires: number;
    committed: boolean;
    completing: boolean;
    result?: unknown;
    timer: ReturnType<typeof setTimeout>;
    abort: () => void;
}
/** The interaction carries only an opaque question ID. Tokens travel directly from password UI to this session-bound service. */
export class IntegrationCapture {
    private captures = new Map<string, Capture>();
    private nonces = new Map<string, {
        session: string;
        capture: Capture;
        interactionId: string;
    }>();
    constructor(private hooks: {
        interactions: (runId: string) => RunInteraction[];
        answer: (runId: string, id: string, answer: InteractionAnswer) => unknown;
        remember: (token: string) => void;
    }) { }
    private pending(c: Capture) { c.check(); if (c.scope.signal.aborted || !c.scope.isActive() || Date.now() >= c.expires || this.captures.get(c.id) !== c)
        throw new HttpError(409, 'Secure entry expired or was cancelled'); }
    private interaction(c: Capture, id?: string) { this.pending(c); const entry = this.hooks.interactions(c.scope.runId).find(i => (!id || i.id === id) && i.status === 'pending' && i.questions?.some(q => q.id === INTEGRATION_CREDENTIAL_PREFIX + c.id)); if (!entry)
        throw new HttpError(409, 'Secure entry is no longer pending'); return entry; }
    async begin(scope: AppActionScope, target: string, receiver: IntegrationReceiver, apply: Capture['apply'], check: () => void) { if (!scope.interact)
        throw new HttpError(503, 'Secure conversational entry is unavailable'); if(!isIntegrationReceiver(receiver)||target!==receiver.kind+':'+receiver.agentId)throw new HttpError(400,'A valid secure receiver is required'); receiver=Object.freeze({...receiver}); const label=receiver.kind==='mcp'?'MCP':'Telegram'; check(); if (this.captures.size >= 20 || [...this.captures.values()].some(c => c.scope.runId === scope.runId))
        throw new HttpError(409, 'A secure entry request is already pending'); const c = {} as Capture; Object.assign(c, { id: randomBytes(24).toString('hex'), target, receiver, scope, apply, check, expires: Date.now() + 300000, committed: false, completing: false, abort: () => this.expire(c) }); c.timer = setTimeout(c.abort, 300000); c.timer.unref(); this.captures.set(c.id, c); scope.signal.addEventListener('abort', c.abort, { once: true }); try {
        await scope.interact({ kind: 'question', title: 'Connect ' + label + ' securely', description: 'Use the masked field here. The credential goes directly to Relay and is encrypted for your Windows account. Never paste it into chat.', questions: [{ id: INTEGRATION_CREDENTIAL_PREFIX + c.id, question: label + ' token — secure entry only' }] });
        if (!c.committed)
            throw new HttpError(409, 'Secure setup cancelled');
        return c.result;
    }
    finally {
        this.expire(c);
    } }
    request(session: string, body: Record<string, unknown>) { only(body, ['runId', 'interactionId']); const runId = stringValue(body.runId, 'Run ID', 100, 1), interactionId = stringValue(body.interactionId, 'Interaction ID', 100, 1); const c = [...this.captures.values()].find(c => c.scope.runId === runId && this.hooks.interactions(runId).some(i => i.id === interactionId && i.questions?.some(q => q.id === INTEGRATION_CREDENTIAL_PREFIX + c.id))); if (!c)
        throw new HttpError(409, 'Secure entry expired'); this.interaction(c, interactionId); for (const [nonce, value] of this.nonces)
        if (value.capture === c)
            this.nonces.delete(nonce); const nonce = randomBytes(32).toString('hex'); this.nonces.set(nonce, { session, capture: c, interactionId }); return { nonce, expiresAt: new Date(c.expires).toISOString(), receiver: c.receiver }; }
    async submit(session: string, body: Record<string, unknown>, signal: AbortSignal) { only(body, ['nonce', 'token']); const nonce = stringValue(body.nonce, 'Nonce', 100, 1), token = stringValue(body.token, 'Token', 8192, 1), n = this.nonces.get(nonce); if (!n || n.session !== session)
        throw new HttpError(403, 'Secure entry session is invalid'); this.nonces.delete(nonce); const c = n.capture; this.hooks.remember(token); const check = () => { this.interaction(c, n.interactionId); if (signal.aborted)
        throw new HttpError(409, 'Secure entry disconnected'); }; check(); if (c.completing)
        throw new HttpError(409, 'Secure setup is already active'); c.completing = true; try {
        c.result = await c.apply(token, check, c.receiver);
        check();
        c.committed = true;
        this.hooks.answer(c.scope.runId, n.interactionId, { decision: 'allow', answers: { [INTEGRATION_CREDENTIAL_PREFIX + c.id]: ['Credential connected securely.'] } });
        return { connected: true };
    }
    finally {
        c.completing = false;
    } }
    guardText(runId: string, text: string) { if ([...this.captures.values()].some(c => c.scope.runId === runId) && !/^\s*(stop|cancel)[.!]?\s*$/i.test(text))
        throw new HttpError(409, 'Use the masked secure credential field; never paste a token in chat'); }
    guardAnswer(runId: string, id: string, value: unknown) { const c = [...this.captures.values()].find(c => c.scope.runId === runId && this.hooks.interactions(runId).some(i => i.id === id && i.questions?.some(q => q.id === INTEGRATION_CREDENTIAL_PREFIX + c.id))); if (!c)
        return; const answer = value as InteractionAnswer; if (answer?.decision === 'deny')
        return; if (c.completing && c.committed && JSON.stringify(answer) == JSON.stringify({ decision: 'allow', answers: { [INTEGRATION_CREDENTIAL_PREFIX + c.id]: ['Credential connected securely.'] } }))
        return; throw new HttpError(409, 'Use the masked secure credential field'); }
    revoke(target: string) { for (const c of [...this.captures.values()])
        if (c.target === target)
            this.expire(c); }
    private expire(c: Capture) { this.captures.delete(c.id); clearTimeout(c.timer); c.scope.signal.removeEventListener('abort', c.abort); for (const [nonce, n] of this.nonces)
        if (n.capture === c)
            this.nonces.delete(nonce); const entry = this.hooks.interactions(c.scope.runId).find(i => i.status === 'pending' && i.questions?.some(q => q.id === INTEGRATION_CREDENTIAL_PREFIX + c.id)); if (entry)
        try {
            this.hooks.answer(c.scope.runId, entry.id, { decision: 'deny' });
        }
        catch { } }
    close() { for (const c of [...this.captures.values()])
        this.expire(c); }
}
