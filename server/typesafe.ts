import { randomBytes } from 'node:crypto';
import type { Store } from './store.js';
import { HttpError, only, stringValue } from './security.js';
import { typeSafeErrorMessage, type TypeSafeCatalogIssue, type TypeSafeErrorCode } from '../shared/typesafe-errors.js';
import type { InteractionAnswer, RunInteraction } from '../shared/types.js';
import { TYPESAFE_CREDENTIAL_PREFIX, type TypeSafeAnswer, type TypeSafeConnectRequest, type TypeSafeCredentialChallenge, type TypeSafeCredentialRequest, type TypeSafeDecisionRequest, type TypeSafeDecisionResult, type TypeSafeHostHooks, type TypeSafeModel, type TypeSafeQuestion, type TypeSafeScope, type TypeSafeStatus } from '../shared/typesafe.js';
export interface SecretVaultLike {
    has(name: string): Promise<boolean>;
    get(name: string): Promise<string | null | undefined>;
    set(name: string, value: string, check?: () => void): Promise<void>;
    remove(name: string): Promise<void>;
    close(): void | Promise<void>;
    availability(): {
        available: boolean;
        protection?: string;
        error?: string;
    } | Promise<{
        available: boolean;
        protection?: string;
        error?: string;
    }>;
}
export interface TypeSafeOptions extends TypeSafeHostHooks {
    rememberSecret?:(value:string)=>void;
    fetch?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
}
export class TypeSafeRequestError extends HttpError {
    constructor(status: number, public readonly code: TypeSafeErrorCode, public readonly catalogIssue?: TypeSafeCatalogIssue) {
        super(status, typeSafeErrorMessage(code)!);
    }
}
interface Configuration {
    id: string;
    enabled: boolean;
    model: string;
    models: TypeSafeModel[];
    validatedAt: string | null;
}
interface Capture {
    id: string;
    questionId: string;
    scope: TypeSafeScope;
    expires: number;
    committed: boolean;
    completing: boolean;
    timer: ReturnType<typeof setTimeout>;
    abort: () => void;
}
interface Nonce {
    session: string;
    expires: number;
    capture?: Capture;
    interactionId?: string;
    claimed: boolean;
    generation: number;
}
const KEY = 'typesafe-api-key', TTL = 300000, BASE = 'https://api.typesafe.ai', REDACTED = '[redacted TypeSafe credential]', COMPLETED = 'TypeSafe connected securely.';
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new HttpError(400, 'Expected a plain object'); return value as Record<string, unknown>; };
const modelName = (value: unknown) => { const text = stringValue(value, 'Model', 512, 1); if (/[\u0000-\u001f\u007f-\u009f]/.test(text))
    throw new HttpError(400, 'Invalid TypeSafe model'); return text; };
const probability = (value: unknown): number => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new HttpError(502, 'TypeSafe returned an invalid probability'); return value; };
function boundedJSON(value: unknown, depth = 0, maxEntries = 100): void { if (depth > 8)
    throw new HttpError(400, 'TypeSafe data is too deeply nested'); if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return; if (typeof value === 'number' && Number.isFinite(value))
    return; if (Array.isArray(value)) {
    if (value.length > 100)
        throw new HttpError(400, 'TypeSafe array is too large');
    for (const item of value)
        boundedJSON(item, depth + 1, maxEntries);
    return;
} const body = object(value); if (Object.keys(body).length > maxEntries)
    throw new HttpError(400, 'TypeSafe object is too large'); for (const [key, item] of Object.entries(body)) {
    if (key.length > 200)
        throw new HttpError(400, 'TypeSafe field name is too long');
    boundedJSON(item, depth + 1, maxEntries);
} }
export class TypeSafeIntegration {
    private key?: string;
    private knownKeys = new Set<string>();
    private captures = new Map<string, Capture>();
    private nonces = new Map<string, Nonce>();
    private inflight = new Set<AbortController>();
    private generation = 0;
    private closed = false;
    private initialized = false;
    private changing = false;
    private disconnecting = false;
    private error?: string;
    private errorCode?: TypeSafeErrorCode;
    private catalogIssue?: TypeSafeCatalogIssue;
    private storage: TypeSafeStatus['storage'] = { available: false, protection: 'Windows DPAPI CurrentUser' };
    private config: Configuration = { id: 'typesafe', enabled: false, model: '', models: [], validatedAt: null };
    private fetcher: typeof fetch;
    private clock: () => number;
    constructor(private store: Store, private vault: SecretVaultLike, private options: TypeSafeOptions = {}) { this.fetcher = options.fetch ?? fetch; this.clock = options.now ?? Date.now; }
    async initialize(): Promise<void> { if (this.initialized)
        return; try {
        const state = await this.vault.availability();
        this.storage = { available: state.available, protection: state.protection ?? 'Windows DPAPI CurrentUser', ...(state.error ? { error: 'Encrypted credential storage is unavailable.' } : {}) };
        if (state.available) {
            this.key = await this.vault.get(KEY) ?? undefined;
            if (this.key)
                this.knownKeys.add(this.key);if(this.key)this.options.rememberSecret?.(this.key);
            const saved = this.store.get<Configuration>('integration', 'typesafe');
            if (saved && typeof saved.enabled === 'boolean' && typeof saved.model === 'string' && Array.isArray(saved.models)) {
                this.config = { id: 'typesafe', enabled: saved.enabled, model: saved.model, models: saved.models.map(item => ({ name: modelName(item.name), description: stringValue(item.description, 'Model description', 2000), ...(item.releaseDate ? { releaseDate: stringValue(item.releaseDate, 'Release date', 30) } : {}) })), validatedAt: typeof saved.validatedAt === 'string' ? saved.validatedAt : null };
            }
        }
    }
    catch {
        this.key = undefined;
        this.storage = { available: false, protection: 'Windows DPAPI CurrentUser', error: 'Encrypted credential storage could not be opened.' };
    } this.initialized = true; }
    status(): TypeSafeStatus { return this.redact({ configured: !!this.key, available: this.storage.available && !this.closed, enabled: !!this.key && this.config.enabled, model: this.config.model, models: structuredClone(this.config.models), validatedAt: this.config.validatedAt, ...(this.error ? { error: this.error, errorCode: this.errorCode, ...(this.catalogIssue ? { catalogIssue: this.catalogIssue } : {}) } : {}), storage: { ...this.storage } }); }
    redact<T>(value: T): T { const walk = (item: unknown, depth: number): unknown => { if (depth > 20)
        return '[omitted]'; if (typeof item === 'string') {
        let text = item;
        for (const key of this.knownKeys) {
            text = text.split(key).join(REDACTED);
            const encoded = JSON.stringify(key).slice(1, -1);
            if (encoded !== key)
                text = text.split(encoded).join(REDACTED);
        }
        return text;
    } if (Array.isArray(item))
        return item.map(entry => walk(entry, depth + 1)); if (item && typeof item === 'object')
        return Object.fromEntries(Object.entries(item).map(([key, entry]) => [String(walk(key, depth + 1)), walk(entry, depth + 1)])); return item; }; return walk(value, 0) as T; }
    private check(scope?: Pick<TypeSafeScope, 'signal' | 'isActive'>) { if (!this.initialized || this.closed)
        throw new TypeSafeRequestError(503, 'service_unavailable'); if (this.disconnecting)
        throw new TypeSafeRequestError(409, 'configuration_busy'); if (scope && (scope.signal.aborted || !scope.isActive()))
        throw new TypeSafeRequestError(409, 'request_expired'); }
    private live(capture: Capture) { this.check(capture.scope); const scope = this.options.liveScope?.(capture.scope.runId); if (!scope || scope.agentId !== capture.scope.agentId || scope.signal.aborted || !scope.isActive() || this.captures.get(capture.id) !== capture || this.clock() >= capture.expires)
        throw new TypeSafeRequestError(409, 'request_expired'); }
    private interaction(capture: Capture, interactionId?: string) { this.live(capture); const matches = (this.options.interactions?.(capture.scope.runId) ?? []).filter(item => item.status === 'pending' && item.runId === capture.scope.runId && item.kind === 'question' && item.questions?.some(question => question.id === capture.questionId) && (!interactionId || item.id === interactionId)); if (matches.length !== 1)
        throw new TypeSafeRequestError(409, 'request_expired'); return matches[0]; }
    private expire(capture: Capture) { if (this.captures.get(capture.id) !== capture)
        return; this.captures.delete(capture.id); clearTimeout(capture.timer); capture.scope.signal.removeEventListener('abort', capture.abort); for (const [nonce, value] of this.nonces)
        if (value.capture === capture)
            this.nonces.delete(nonce); const interaction = this.options.interactions?.(capture.scope.runId).find(item => item.questions?.some(question => question.id === capture.questionId)); if (interaction)
        try {
            this.options.answer?.(capture.scope.runId, interaction.id, { decision: 'deny' });
        }
        catch { } }
    async connectTool(scope: TypeSafeScope): Promise<TypeSafeStatus> { this.check(scope); if (!this.storage.available)
        throw new HttpError(503, 'Encrypted credential storage is unavailable'); if (!this.options.answer || !this.options.interactions || !this.options.liveScope)
        throw new HttpError(503, 'Secure credential entry is unavailable'); if ([...this.captures.values()].some(value => value.scope.runId === scope.runId))
        throw new HttpError(409, 'A secure credential request is already pending'); if (this.captures.size >= 20)
        throw new HttpError(429, 'Too many secure credential requests'); const id = randomBytes(24).toString('hex'); const capture = {} as Capture; Object.assign(capture, { id, questionId: TYPESAFE_CREDENTIAL_PREFIX + id, scope, expires: this.clock() + TTL, committed: false, completing: false, abort: () => this.expire(capture) }); capture.timer = setTimeout(() => this.expire(capture), TTL); capture.timer.unref?.(); this.captures.set(id, capture); scope.signal.addEventListener('abort', capture.abort, { once: true }); try {
        await scope.interact({ kind: 'question', title: 'Connect TypeSafe securely', description: 'Enter the key in the secure field, then press Enter. It is encrypted locally for your Windows account. TypeSafe decisions can consume API credits. Do not paste the key into chat.', questions: [{ id: capture.questionId, question: 'TypeSafe API key — secure entry only' }] });
        if (!capture.committed)
            throw new HttpError(409, 'TypeSafe connection was cancelled');
        return this.status();
    }
    finally {
        this.expire(capture);
    } }
    credentialRequest(sessionId: string, value: TypeSafeCredentialRequest): TypeSafeCredentialChallenge { this.check(); if (!this.storage.available)
        throw new HttpError(503, 'Encrypted credential storage is unavailable'); stringValue(sessionId, 'Local session', 256, 1); const body = object(value); only(body, ['runId', 'interactionId']); let capture: Capture | undefined; let interactionId: string | undefined; if (body.runId !== undefined || body.interactionId !== undefined) {
        const runId = stringValue(body.runId, 'Run ID', 100, 1);
        interactionId = stringValue(body.interactionId, 'Interaction ID', 100, 1);
        const interaction = this.options.interactions?.(runId).find(item => item.id === interactionId);
        const question = interaction?.questions?.find(item => item.id.startsWith(TYPESAFE_CREDENTIAL_PREFIX));
        capture = question ? this.captures.get(question.id.slice(TYPESAFE_CREDENTIAL_PREFIX.length)) : undefined;
        if (!capture || capture.scope.runId !== runId)
            throw new TypeSafeRequestError(409, 'request_expired');
        this.interaction(capture, interactionId);
    } for (const [key, nonce] of this.nonces)
        if (this.clock() >= nonce.expires)
            this.nonces.delete(key); if (this.nonces.size >= 100)
        throw new HttpError(429, 'Too many credential entry requests'); const nonce = randomBytes(32).toString('hex'), expires = Math.min(this.clock() + TTL, capture?.expires ?? Infinity); this.nonces.set(nonce, { session: sessionId, expires, capture, interactionId, claimed: false, generation: this.generation }); return { nonce, expiresAt: new Date(expires).toISOString() }; }
    private nonce(session: string, token: string, claimed: boolean) { const nonce = this.nonces.get(token); if (!nonce)
        throw new TypeSafeRequestError(409, 'request_expired'); if (nonce.session !== session)
        throw new TypeSafeRequestError(403, 'request_expired'); if (nonce.claimed !== claimed || this.clock() >= nonce.expires || nonce.generation !== this.generation || this.closed)
        throw new TypeSafeRequestError(409, 'request_expired'); if (nonce.capture)
        this.interaction(nonce.capture, nonce.interactionId); return nonce; }
    async connectCredential(sessionId: string, value: TypeSafeConnectRequest, signal?: AbortSignal): Promise<TypeSafeStatus> {
        try { return await this.connectCredentialImpl(sessionId, value, signal); }
        catch (error) {
            const failure = error instanceof TypeSafeRequestError ? error : new TypeSafeRequestError(error instanceof HttpError ? error.status : 503, 'unknown');
            this.error = failure.message;
            this.errorCode = failure.code;
            this.catalogIssue = failure.catalogIssue;
            throw failure;
        }
    }
    private async connectCredentialImpl(sessionId: string, value: TypeSafeConnectRequest, signal?: AbortSignal): Promise<TypeSafeStatus> { this.check(); if (!this.storage.available)
        throw new TypeSafeRequestError(503, 'storage_failed'); const body = object(value); only(body, ['nonce', 'apiKey', 'model']);
        if (typeof body.nonce !== 'string' || !body.nonce.length || body.nonce.length > 128)
        throw new TypeSafeRequestError(409, 'request_expired'); const token = body.nonce;
        if (typeof body.apiKey !== 'string' || !body.apiKey.length || body.apiKey.length > 8192 || /\s/.test(body.apiKey) || /^["']|["']$/.test(body.apiKey))
        throw new TypeSafeRequestError(400, 'invalid_key_format'); const key = body.apiKey; const claim = this.nonce(sessionId, token, false); if (this.changing)
        throw new TypeSafeRequestError(409, 'configuration_busy'); claim.claimed = true; this.changing = true; this.knownKeys.add(key);this.options.rememberSecret?.(key); let writeAttempted = false; try {
        const requestSignal = signal && claim.capture ? AbortSignal.any([signal, claim.capture.scope.signal]) : signal ?? claim.capture?.scope.signal;
        const models = await this.catalog(key, requestSignal);
        this.nonce(sessionId, token, true);
        const selected = body.model === undefined ? models.find(model => model.name === 'jev-latest')?.name ?? models[0].name : modelName(body.model);
        if (!models.some(model => model.name === selected))
            throw new HttpError(400, 'Choose an available TypeSafe model');
        const check = () => { if (signal?.aborted)
            throw new TypeSafeRequestError(409, 'cancelled_or_timeout'); this.nonce(sessionId, token, true); if (!this.storage.available)
            throw new TypeSafeRequestError(503, 'storage_failed'); };
        check();
        // A crash or cancellation across the vault's asynchronous rename must not leave an enabled key.
        this.key = undefined;
        this.config = { id: 'typesafe', enabled: false, model: selected, models, validatedAt: new Date(this.clock()).toISOString() };
        this.store.put('integration', this.config);
        writeAttempted = true;
        await this.vault.set(KEY, key, check);
        check();
        this.key = key;
        this.config = { id: 'typesafe', enabled: true, model: selected, models, validatedAt: new Date(this.clock()).toISOString() };
        this.store.put('integration', this.config);
        this.error = undefined;
        this.errorCode = undefined;
        this.catalogIssue = undefined;
        if (claim.capture) {
            const capture = claim.capture;
            capture.committed = true;
            const interaction = this.interaction(capture, claim.interactionId);
            capture.completing = true;
            try {
                this.options.answer!(capture.scope.runId, interaction.id, { decision: 'allow', answers: { [capture.questionId]: [COMPLETED] } });
            }
            finally {
                capture.completing = false;
            }
        }
        return this.status();
    }
    catch (error) {
        if (writeAttempted) {
            this.key = undefined;
            this.config = { ...this.config, enabled: false };
            if (!this.closed) this.store.put('integration', this.config);
            if (claim.capture) claim.capture.committed = false;
            // The vault serializes this cleanup after any in-progress rename. If cleanup fails,
            // the durable disabled marker still prevents the remaining ciphertext activating on restart.
            try { await this.vault.remove(KEY); } catch { }
        }
        if (error instanceof HttpError) throw error;
        throw new TypeSafeRequestError(503, writeAttempted ? 'storage_failed' : 'unknown');
    }
    finally {
        this.nonces.delete(token);
        this.changing = false;
        if (this.key !== key && !writeAttempted)
            this.knownKeys.delete(key);
        while (this.knownKeys.size > 16) {
            const old = [...this.knownKeys].find(value => value !== this.key);
            if (old)
                this.knownKeys.delete(old);
            else
                break;
        }
    } }
    guardText(runId: string, text: string) { const pending = (this.options.interactions?.(runId) ?? []).some(item => item.status === 'pending' && item.questions?.some(question => question.id.startsWith(TYPESAFE_CREDENTIAL_PREFIX))); if (pending && !/^(?:stop|cancel)(?:[.!])?$/i.test(text.trim()))
        throw new HttpError(409, 'Use the secure credential field. API keys cannot be sent as chat messages.'); }
    guardAnswer(runId: string, interactionId: string, value: unknown) { const interaction = this.options.interactions?.(runId).find(item => item.id === interactionId); const question = interaction?.questions?.find(item => item.id.startsWith(TYPESAFE_CREDENTIAL_PREFIX)); if (!question)
        return; const answer = object(value); if (answer.decision === 'deny' && Object.keys(answer).every(key => key === 'decision'))
        return; const capture = this.captures.get(question.id.slice(TYPESAFE_CREDENTIAL_PREFIX.length)); if (capture?.completing && capture.committed && answer.decision === 'allow' && JSON.stringify(answer.answers) === JSON.stringify({ [capture.questionId]: [COMPLETED] }))
        return; throw new HttpError(409, 'Use the secure credential field. API keys cannot be submitted as interaction answers.'); }
    private async request(path: '/v1/models' | '/v1/systemone', key: string, body?: unknown, signal?: AbortSignal): Promise<unknown> { if (this.inflight.size >= 2)
        throw new TypeSafeRequestError(429, 'configuration_busy'); const controller = new AbortController(); this.inflight.add(controller); const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15000); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted)
        controller.abort(); const cancelled = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new TypeSafeRequestError(409, 'cancelled_or_timeout')), { once: true })); try {
        if (controller.signal.aborted)
            throw new TypeSafeRequestError(409, 'cancelled_or_timeout');
        const response = await Promise.race([this.fetcher(BASE + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal }), cancelled]);
        if (response.redirected || response.url && response.url !== BASE + path)
            throw new TypeSafeRequestError(502, 'network_error');
        if (!response.ok) {
            await response.body?.cancel().catch(() => { });
            const code: TypeSafeErrorCode = response.status === 401 || response.status === 403 ? 'auth_rejected' : response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'service_unavailable' : 'unknown';
            throw new TypeSafeRequestError(response.status === 401 || response.status === 403 ? 400 : 502, code);
        }
        const reader = response.body?.getReader();
        if (!reader)
            throw new TypeSafeRequestError(502, path === '/v1/models' ? 'invalid_catalog' : 'unknown', path === '/v1/models' ? 'response_missing' : undefined);
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
            const chunk = await Promise.race([reader.read(), cancelled]);
            if (chunk.done)
                break;
            bytes += chunk.value.byteLength;
            if (bytes > 131072) {
                await reader.cancel().catch(() => { });
                throw new TypeSafeRequestError(502, path === '/v1/models' ? 'invalid_catalog' : 'unknown', path === '/v1/models' ? 'response_too_large' : undefined);
            }
            chunks.push(chunk.value);
        }
        try {
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
            if (path !== '/v1/models') boundedJSON(value, 0, 255);
            return value;
        } catch { throw new TypeSafeRequestError(502, path === '/v1/models' ? 'invalid_catalog' : 'unknown', path === '/v1/models' ? 'invalid_json' : undefined); }
    }
    catch (error) {
        if (error instanceof HttpError)
            throw error;
        throw new TypeSafeRequestError(502, 'network_error');
    }
    finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        this.inflight.delete(controller);
    } }
    private async catalog(key: string, signal?: AbortSignal): Promise<TypeSafeModel[]> {
        const response = await this.request('/v1/models', key, undefined, signal);
        const invalid = (issue: TypeSafeCatalogIssue): never => { throw new TypeSafeRequestError(502, 'invalid_catalog', issue); };
        let body: Record<string, unknown>;
        try { body = object(response); } catch { return invalid('wrapper_shape'); }
        if (!Array.isArray(body.models)) return invalid('wrapper_shape');
        if (!body.models.length) return invalid('models_empty');
        if (body.models.length > 1000) return invalid('model_count_limit');
        const names = new Set<string>();
        const models: TypeSafeModel[] = [];
        for (const value of body.models) {
            let item: Record<string, unknown>;
            try { item = object(value); } catch { return invalid('model_entry_shape'); }
            const name = item.name;
            if (typeof name !== 'string') return invalid('model_name_type');
            if (!name.length || name.length > 512) return invalid('model_name_limit');
            if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return invalid('model_name_control');
            if (name.includes(key)) return invalid('model_name_sensitive');
            if (names.has(name)) continue;
            names.add(name);
            // Display metadata never decides whether an otherwise usable model can connect.
            const description = typeof item.description === 'string' ? this.redact(item.description).slice(0, 2000) : '';
            const releaseDate = typeof item.release_date === 'string' ? this.redact(item.release_date).slice(0, 30) : undefined;
            models.push({ name, description, ...(releaseDate === undefined ? {} : { releaseDate }) });
        }
        return models;
    }
    async test(): Promise<TypeSafeStatus> { this.check(); if (!this.key)
        throw new HttpError(400, 'Connect TypeSafe first'); const generation = this.generation, key = this.key, models = await this.catalog(key); if (generation !== this.generation || this.key !== key || this.closed)
        throw new HttpError(409, 'TypeSafe connection changed during validation'); this.config = { ...this.config, models, model: models.some(model => model.name === this.config.model) ? this.config.model : models.find(model => model.name === 'jev-latest')?.name ?? models[0].name, validatedAt: new Date(this.clock()).toISOString() }; this.store.put('integration', this.config); this.error = undefined; return this.status(); }
    async updateModel(value: {
        model?: string;
        enabled?: boolean;
    }): Promise<TypeSafeStatus> { const body = object(value); only(body, ['model', 'enabled']); if (body.enabled !== undefined && typeof body.enabled !== 'boolean')
        throw new HttpError(400, 'Enabled must be true or false'); if (body.enabled === false && body.model === undefined) {
        this.check();
        this.config.enabled = false;
        this.generation++;
        for (const controller of this.inflight)
            controller.abort();
        this.store.put('integration', this.config);
        return this.status();
    } await this.test(); if (body.model !== undefined) {
        const model = modelName(body.model);
        if (!this.config.models.some(item => item.name === model))
            throw new HttpError(400, 'Choose an available TypeSafe model');
        this.config.model = model;
    } if (body.enabled !== undefined)
        this.config.enabled = body.enabled; this.store.put('integration', this.config); return this.status(); }
    async decide(scope: TypeSafeScope | Pick<TypeSafeScope, 'signal' | 'isActive'>, value: unknown): Promise<TypeSafeDecisionResult> { this.check(scope); if (!this.key || !this.config.enabled || !this.storage.available)
        throw new HttpError(400, 'TypeSafe is not connected and enabled'); const request = this.decision(value); const key = this.key, generation = this.generation, result = object(await this.request('/v1/systemone', key, { model: this.config.model, ...request }, scope.signal)); this.check(scope); if (generation !== this.generation || key !== this.key)
        throw new HttpError(409, 'TypeSafe connection changed during the request'); const model = modelName(result.model), raw = object(result.answers), ids = Object.keys(request.questions); if (Object.keys(raw).length !== ids.length || Object.keys(raw).some(id => !Object.hasOwn(request.questions, id)))
        throw new HttpError(502, 'TypeSafe returned mismatched answer IDs'); const answers = Object.fromEntries(ids.map(id => [id, this.answer(request.questions[id], raw[id])])); const usage = object(result.usage); for (const field of ['input_tokens', 'output_tokens'])
        if (!Number.isSafeInteger(usage[field]) || Number(usage[field]) < 0 || Number(usage[field]) > 1000000000)
            throw new HttpError(502, 'TypeSafe returned invalid usage'); return this.redact({ model, answers, usage: { inputTokens: Number(usage.input_tokens), outputTokens: Number(usage.output_tokens) } }); }
    private decision(value: unknown): TypeSafeDecisionRequest { const body = object(value); only(body, ['state', 'questions']); if (body.state === undefined)
        throw new HttpError(400, 'TypeSafe state is required'); boundedJSON(body.state); const questions = object(body.questions), entries = Object.entries(questions); if (!entries.length || entries.length > 20)
        throw new HttpError(400, 'Supply between 1 and 20 TypeSafe questions'); const normalized = Object.fromEntries(entries.map(([id, value]) => { stringValue(id, 'Question ID', 100, 1); const q = object(value); only(q, ['type', 'instructions', 'criteria']); const instructions = stringValue(q.instructions, 'Question instructions', 4000, 1); if (q.type === 'noul') {
        let criteria: Record<string, string> | undefined;
        if (q.criteria !== undefined) {
            const c = object(q.criteria);
            only(c, ['true', 'false']);
            criteria = Object.fromEntries(Object.entries(c).map(([name, text]) => [name, stringValue(text, 'Noul criteria', 2000)]));
        }
        return [id, { type: 'noul', instructions, ...(criteria ? { criteria } : {}) }];
    } if (q.type === 'choice') {
        const criteria = object(q.criteria), options = Object.entries(criteria);
        if (options.length < 2 || options.length > 255)
            throw new HttpError(400, 'Choice needs between 2 and 255 options');
        return [id, { type: 'choice', instructions, criteria: Object.fromEntries(options.map(([name, text]) => [stringValue(name, 'Choice name', 100, 1), text === null ? null : stringValue(text, 'Choice description', 2000)])) }];
    } if (q.type === 'score') {
        if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10)
            throw new HttpError(400, 'Score needs between 2 and 10 levels');
        return [id, { type: 'score', instructions, criteria: q.criteria.map(text => stringValue(text, 'Score level', 2000, 1)) }];
    } throw new HttpError(400, 'Only Noul, Choice and Score questions are supported'); })) as Record<string, TypeSafeQuestion>; const result = { state: body.state, questions: normalized }, encoded = JSON.stringify(result); if (Buffer.byteLength(encoded) > 65536)
        throw new HttpError(400, 'TypeSafe decision input exceeded its size limit'); if (this.redact(encoded) !== encoded)
        throw new HttpError(400, 'TypeSafe credentials cannot be included in decision input'); return result; }
    private answer(question: TypeSafeQuestion, value: unknown): TypeSafeAnswer { const body = object(value); if (body.type !== question.type)
        throw new HttpError(502, 'TypeSafe returned a mismatched answer type'); if (question.type === 'noul') {
        only(body, ['type', 'noul']);
        return { type: 'noul', noul: probability(body.noul) };
    } const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index)); const p = object(body.probabilities); if (Object.keys(p).length !== keys.length || keys.some(key => !Object.hasOwn(p, key)))
        throw new HttpError(502, 'TypeSafe returned invalid probability labels'); const probabilities = Object.fromEntries(keys.map(key => [key, probability(p[key])])); if (Math.abs(Object.values(probabilities).reduce((sum, value) => sum + value, 0) - 1) > .001)
        throw new HttpError(502, 'TypeSafe returned an invalid probability distribution'); const confidence = probability(body.confidence); if (question.type === 'choice') {
        only(body, ['type', 'choice', 'confidence', 'probabilities']);
        if (typeof body.choice !== 'string' || !Object.hasOwn(question.criteria, body.choice))
            throw new HttpError(502, 'TypeSafe returned an unknown choice');
        return { type: 'choice', choice: body.choice, confidence, probabilities };
    } only(body, ['type', 'score', 'confidence', 'probabilities', 'legend']); if (typeof body.score !== 'number' || !Number.isFinite(body.score) || body.score < 0 || body.score > question.criteria.length - 1)
        throw new HttpError(502, 'TypeSafe returned an invalid score'); const legend = object(body.legend); if (Object.keys(legend).length !== keys.length || keys.some(key => legend[key] !== question.criteria[Number(key)]))
        throw new HttpError(502, 'TypeSafe returned an invalid score legend'); return { type: 'score', score: body.score, confidence, probabilities, legend: Object.fromEntries(keys.map(key => [key, question.criteria[Number(key)]])) }; }
    async disconnect(): Promise<TypeSafeStatus> { this.check(); this.disconnecting = true; this.generation++; this.key = undefined; this.config = { id: 'typesafe', enabled: false, model: '', models: [], validatedAt: null }; for (const controller of this.inflight)
        controller.abort(); for (const capture of [...this.captures.values()])
        this.expire(capture); this.nonces.clear(); try {
        this.store.put('integration', this.config);
        await this.vault.remove(KEY);
        this.store.remove('integration', 'typesafe');
        this.error = undefined;
    }
    catch {
        this.error = 'TypeSafe was disabled, but the encrypted credential could not be removed.';
        throw new HttpError(503, this.error);
    }
    finally {
        this.disconnecting = false;
    } return this.status(); }
    async close(): Promise<void> { if (this.closed)
        return; this.closed = true; this.generation++; for (const controller of this.inflight)
        controller.abort(); for (const capture of [...this.captures.values()])
        this.expire(capture); this.nonces.clear(); this.key = undefined; this.knownKeys.clear(); }
}
