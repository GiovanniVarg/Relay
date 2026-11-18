import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { AccountProviderId, AccountState } from '../shared/accounts';
import type { BillingConfig, LoginResult, ModelCatalogPage, ModelInfo, ModelPreferences } from '../shared/types';
import { connectionAuthenticated } from '../shared/provider-policy';

type Api = <T>(path: string, method?: string, body?: unknown,
  options?: { signal?: AbortSignal; sensitive?: boolean }) => Promise<T>;
const NAMES: Record<AccountProviderId, string> = { openai: 'OpenAI / ChatGPT', claude: 'Claude', cursor: 'Cursor' };
const PROVIDERS: AccountProviderId[] = ['openai', 'claude', 'cursor'];
const supported = (account: AccountState): boolean => PROVIDERS.includes(account.id as AccountProviderId);
const accountPath = (account: AccountState): string => `/accounts/${encodeURIComponent(account.accountId)}`;
const preferences = (account: AccountState): ModelPreferences => ({ defaultModel: account.modelPreferences.defaultModel,
  allowedModels: account.modelPreferences.allowedModels === null ? null : [...account.modelPreferences.allowedModels] });
const identity = (account: AccountState): string => JSON.stringify([account.profileGeneration,
  account.connectionScope ?? null, account.accountLabel, account.plan]);

function loginUrl(provider: string, value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const domains = provider === 'openai' ? ['openai.com', 'chatgpt.com']
      : provider === 'claude' ? ['claude.ai', 'anthropic.com', 'claude.com'] : provider === 'cursor' ? ['cursor.com'] : [];
    return domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : null;
  } catch { return null; }
}

function useAccounts(api: Api) {
  const [accounts, setAccounts] = useState<AccountState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    const request = ++sequence.current;
    try {
      const result = await api<{ accounts: AccountState[] }>('/accounts', 'GET', undefined, { signal });
      if (!signal.aborted && request === sequence.current) {
        setAccounts(result.accounts.filter(supported)); setError(false); setLoading(false);
      }
    } catch { if (!signal.aborted && request === sequence.current) { setError(true); setLoading(false); } }
  }, [api]);
  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    void reload(); const timer = setInterval(() => { void reload(); }, 5000);
    return () => { current.abort(); clearInterval(timer); };
  }, [reload]);
  const replace = useCallback((account: AccountState) => {
    ++sequence.current;
    setAccounts(current => current.some(item => item.accountId === account.accountId)
      ? current.map(item => item.accountId === account.accountId ? account : item) : [...current, account]);
  }, []);
  const remove = useCallback((id: string) => { ++sequence.current; setAccounts(current => current.filter(account => account.accountId !== id)); }, []);
  return { accounts, loading, error, reload, replace, remove };
}

function blockedCursor(account: AccountState, model: ModelInfo): boolean {
  return account.id === 'cursor' && account.billing.mode === 'included'
    && (/(^|[^a-z0-9])auto($|[^a-z0-9])/i.test(`${model.id} ${model.name}`)
      || /(^|[/:])default$/i.test(model.id.trim()) || /^default$/i.test(model.name.trim()));
}

/** Large explicit policies use the service's bounded native-ID edits. */
async function saveModels(api: Api, account: AccountState, draft: ModelPreferences, revision: string,
  scope: string | undefined, signal: AbortSignal, updated: (account: AccountState) => void): Promise<AccountState> {
  const path = `${accountPath(account)}/models`;
  const binding = { expectedConnectionScope: scope, expectedCatalogRevision: revision };
  const patch = async (body: unknown) => {
    const result = await api<AccountState>(path, 'PATCH', body, { signal });
    if (signal.aborted) throw new Error('Cancelled');
    updated(result); return result;
  };
  if (draft.allowedModels === null || draft.allowedModels.length <= 100) return patch({ ...draft, ...binding });
  let previous = account.modelPreferences.allowedModels;
  if (previous === null) { await patch({ defaultModel: '', allowedModels: [], ...binding }); previous = []; }
  const add = draft.allowedModels.filter(id => !previous!.includes(id));
  const remove = previous.filter(id => !draft.allowedModels!.includes(id));
  const count = Math.max(1, Math.ceil(Math.max(add.length, remove.length) / 100));
  let result = account;
  for (let index = 0; index < count; index++) result = await patch({ ...binding,
    defaultModel: index === count - 1 ? draft.defaultModel : '',
    addModels: add.slice(index * 100, index * 100 + 100), removeModels: remove.slice(index * 100, index * 100 + 100),
  });
  return result;
}

function AccountModels({ account, api, active, disabled, reloadKey, onUpdate, onSaved, onBusy }: {
  account: AccountState; api: Api; active: boolean; disabled: boolean; reloadKey: number;
  onUpdate(account: AccountState): void; onSaved(): void; onBusy(value: boolean): void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(() => preferences(account));
  const [dirty, setDirty] = useState(false);
  const [binding, setBinding] = useState(() => ({ identity: identity(account), scope: account.connectionScope }));
  const [query, setQuery] = useState(''), [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<Array<string | null>>([null]), [index, setIndex] = useState(0);
  const [page, setPage] = useState<ModelCatalogPage | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const revisionRef = useRef<string | null>(null);
  const [catalogChanged, setCatalogChanged] = useState(false);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const operation = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current?.abort(); }; }, []);
  const savedPreferences = JSON.stringify(account.modelPreferences), currentIdentity = identity(account);
  useEffect(() => {
    if (dirty) return;
    setDraft(preferences(account)); setBinding({ identity: identity(account), scope: account.connectionScope });
    revisionRef.current = null; setRevision(null); setCatalogChanged(false); setPage(null); setIndex(0); setCursors([null]);
    setReload(value => value + 1);
  }, [savedPreferences, currentIdentity]);
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(query.trim()); setIndex(0); setCursors([null]); }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const cursor = cursors[index] ?? null;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController(); setLoading(true); setError(null);
    const params = new URLSearchParams({ limit: '100', query: search });
    if (cursor) params.set('cursor', cursor);
    void api<ModelCatalogPage>(`${accountPath(account)}/models?${params}`, 'GET', undefined, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        if ((revisionRef.current && revisionRef.current !== result.revision)
          || (result.connectionScope !== undefined && result.connectionScope !== binding.scope)) {
          setCatalogChanged(true); return;
        }
        revisionRef.current = result.revision; setRevision(result.revision); setPage(result);
      }).catch(() => { if (!controller.signal.aborted) setError('Models could not load. Reload the catalog to try again.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, account.accountId, active, cursor, search, reload, reloadKey, binding.scope]);
  const stale = catalogChanged || binding.identity !== currentIdentity;
  const known = new Map<string, ModelInfo>([...account.models, ...(page?.items ?? [])].map(model => [model.id, model]));
  const selected = draft.allowedModels === null ? null : new Set(draft.allowedModels);
  const options = [...new Set([...(page?.items.map(model => model.id) ?? []), ...(draft.allowedModels ?? []), draft.defaultModel])]
    .filter(modelId => modelId && (modelId === draft.defaultModel || selected === null || selected.has(modelId)));
  const unavailable = draft.allowedModels?.filter(modelId => !known.has(modelId)) ?? [];
  const defaultUnavailable = !!draft.defaultModel && (!known.has(draft.defaultModel) || (selected !== null && !selected.has(draft.defaultModel)));
  function update(next: ModelPreferences) { setDraft(next); setDirty(true); setSaved(false); setError(null); }
  function reset() {
    operation.current?.abort();
    setDraft(preferences(account)); setDirty(false); setBinding({ identity: currentIdentity, scope: account.connectionScope });
    revisionRef.current = null; setRevision(null); setPage(null); setCatalogChanged(false);
    setIndex(0); setCursors([null]); setError(null); setSaved(false); setReload(value => value + 1);
  }
  async function selectAll() {
    if (busy || disabled || stale) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); onBusy(true); setError(null);
    try {
      const ids: string[] = [], included = new Set<string>(), seen = new Set<string>(); let next: string | null = null; let expected = revisionRef.current;
      do {
        const params = new URLSearchParams({ limit: '100' }); if (next) params.set('cursor', next);
        const result: ModelCatalogPage = await api(`${accountPath(account)}/models?${params}`, 'GET', undefined, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if ((expected && result.revision !== expected) || (result.connectionScope !== undefined && result.connectionScope !== binding.scope)) throw new Error('Catalog changed');
        expected = result.revision;
        for (const model of result.items) if (!blockedCursor(account, model) && !included.has(model.id)) { ids.push(model.id); included.add(model.id); }
        if (ids.length > 20000 || (result.nextCursor && seen.has(result.nextCursor))) throw new Error('Catalog limit');
        next = result.nextCursor; if (next) seen.add(next);
      } while (next);
      if (!controller.signal.aborted) {
        revisionRef.current = expected; setRevision(expected);
        update({ defaultModel: ids.includes(draft.defaultModel) ? draft.defaultModel : '', allowedModels: ids });
      }
    } catch { if (!controller.signal.aborted) setError('The full catalog could not load. Reload these settings before selecting all models.'); }
    finally { if (alive.current) { setBusy(false); onBusy(false); } }
  }
  async function save() {
    if (!revision || stale || busy || disabled) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); onBusy(true); setError(null); setSaved(false);
    try {
      const result = await saveModels(api, account, draft, revision, binding.scope, controller.signal, onUpdate);
      if (!controller.signal.aborted) { setDraft(preferences(result)); setDirty(false); setSaved(true); onSaved(); }
    } catch { if (!controller.signal.aborted) setError('Model changes did not finish. Some edits may have saved; refresh this account before trying again.'); }
    finally { if (alive.current) { setBusy(false); onBusy(false); } }
  }
  return <section className="account-models" aria-labelledby={`${id}-title`}>
    <h5 id={`${id}-title`}>Models for this account</h5>
    <p className="accounts-muted">Model IDs stay native to the provider. A listed model is not proof that your subscription covers it.</p>
    {draft.allowedModels === null && <p className="accounts-note">The primary connection currently allows all catalog models, including future discoveries. That policy stays unchanged until you edit it.</p>}
    {stale && <p className="accounts-error" role="alert">This account identity or catalog changed. Discard unsaved model changes and reload before saving.</p>}
    <label className="accounts-field">Search models<input type="search" maxLength={200} value={query}
      onChange={event => setQuery(event.target.value)} placeholder="Name, provider, or exact model ID" /></label>
    {loading && <p className="accounts-muted" role="status">Loading catalog…</p>}
    <fieldset className="account-model-choices" disabled={busy || disabled || stale}>
      <legend className="accounts-sr-only">Allowed models for {account.accountName}</legend>
      {(page?.items ?? []).map(model => <label className="accounts-check account-model-choice" key={model.id}>
        <input type="checkbox" checked={selected === null || selected.has(model.id)} disabled={blockedCursor(account, model)}
          onChange={event => {
            const current = draft.allowedModels === null ? [...known.keys()] : draft.allowedModels;
            const allowedModels = event.target.checked ? [...new Set([...current, model.id])] : current.filter(item => item !== model.id);
            update({ defaultModel: allowedModels.includes(draft.defaultModel) ? draft.defaultModel : '', allowedModels });
          }} />
        <span><strong>{model.name || model.id}</strong><code>{model.id}</code>
          <small>{blockedCursor(account, model) ? 'Auto/default alias unavailable for included-only usage' : model.verified ? 'Verified response identity' : 'Candidate model'}</small></span>
      </label>)}
      {page && !page.items.length && <p className="accounts-muted">{search ? 'No matching models.' : 'No models reported. Complete sign-in, then refresh this account.'}</p>}
    </fieldset>
    {page && <div className="accounts-pagination">
      <button type="button" disabled={!index || loading || busy} onClick={() => setIndex(value => value - 1)}>Previous</button>
      <span>{index + 1} / {Math.max(1, Math.ceil(page.total / 100))} · {page.total} models</span>
      <button type="button" disabled={!page.nextCursor || loading || busy} onClick={() => {
        setCursors(current => [...current.slice(0, index + 1), page.nextCursor]); setIndex(value => value + 1);
      }}>Next</button>
    </div>}
    <div className="accounts-actions">
      <button type="button" disabled={busy || disabled || stale || !revision} onClick={() => { void selectAll(); }}>Enable all current models</button>
      <button type="button" disabled={busy || disabled || stale} onClick={() => update({ defaultModel: '', allowedModels: [] })}>Clear selection</button>
      <button type="button" disabled={busy || disabled} onClick={reset}>{dirty || stale ? 'Discard changes and reload' : 'Reload catalog'}</button>
    </div>
    {!!unavailable.length && <div className="accounts-note"><p>{unavailable.length} saved model IDs are no longer in this account’s catalog.</p>
      <button type="button" disabled={busy || disabled || stale} onClick={() => {
        const allowedModels = draft.allowedModels!.filter(modelId => known.has(modelId));
        update({ defaultModel: allowedModels.includes(draft.defaultModel) ? draft.defaultModel : '', allowedModels });
      }}>Remove unavailable selections</button></div>}
    <label className="accounts-field">Default model
      <select value={draft.defaultModel} disabled={busy || disabled || stale} onChange={event => update({ ...draft, defaultModel: event.target.value })}>
        <option value="">Subscription default · enabled models</option>
        {options.map(modelId => <option value={modelId} key={modelId} disabled={!known.has(modelId) || (selected !== null && !selected.has(modelId))}>
          {!known.has(modelId) || (selected !== null && !selected.has(modelId)) ? 'Unavailable · ' : ''}{known.get(modelId)?.name || modelId}{known.get(modelId)?.name && known.get(modelId)?.name !== modelId ? ` · ${modelId}` : ''}</option>)}
      </select>
    </label>
    <p className="accounts-muted">{draft.allowedModels === null ? 'Current all-model policy' : `${draft.allowedModels.length} explicitly enabled models. New models stay off.`}</p>
    <button className="accounts-primary" type="button" disabled={!dirty || !revision || stale || busy || disabled || defaultUnavailable || !!unavailable.length} onClick={() => { void save(); }}>{busy ? 'Working…' : 'Save models'}</button>
    {saved && <p className="accounts-success" role="status">Model choices saved for this account.</p>}
    {error && <p className="accounts-error" role="alert">{error}</p>}
  </section>;
}

function AccountCard({ account, api, onUpdate, onRemove, onChange }: {
  account: AccountState; api: Api; onUpdate(account: AccountState): void; onRemove(id: string): void; onChange(): void;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState<string | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false), [reloadKey, setReloadKey] = useState(0);
  const [login, setLogin] = useState<LoginResult | null>(null), [loginPending, setLoginPending] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const [billing, setBilling] = useState<BillingConfig>(() => ({ ...account.billing }));
  const [billingDirty, setBillingDirty] = useState(false);
  const [binding, setBinding] = useState(() => ({ identity: identity(account), scope: account.connectionScope,
    expectedAccount: { accountLabel: account.accountLabel, plan: account.plan } }));
  const operation = useRef<AbortController | null>(null), working = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current?.abort(); }; }, []);
  const savedBilling = JSON.stringify(account.billing), currentIdentity = identity(account);
  useEffect(() => {
    if (billingDirty) return;
    setBilling({ ...account.billing }); setBinding({ identity: currentIdentity, scope: account.connectionScope,
      expectedAccount: { accountLabel: account.accountLabel, plan: account.plan } });
  }, [savedBilling, currentIdentity]);
  const authenticated = !loginPending && connectionAuthenticated(account) && !!account.accountLabel.trim();
  const stale = binding.identity !== currentIdentity;
  const approved = authenticated && account.billing.confirmed && account.billing.mode !== 'unknown';
  const url = loginUrl(account.id, login?.url);
  async function action(label: string, task: (signal: AbortSignal) => Promise<void>, failure: string) {
    if (working.current || modelsBusy) return;
    const controller = new AbortController(); operation.current = controller; working.current = true;
    setBusy(label); setError(null); setMessage(null);
    try { await task(controller.signal); }
    catch { if (!controller.signal.aborted) setError(failure); }
    finally { if (alive.current) { working.current = false; setBusy(null); } }
  }
  function startLogin() {
    void action('login', async signal => {
      const result = await api<LoginResult>(`${accountPath(account)}/login`, 'POST', {}, { signal, sensitive: true });
      if (!signal.aborted) { setLogin(result); setLoginPending(true); setBilling({ ...billing, confirmed: false, automaticRouting: false }); setBillingDirty(false); onChange(); }
    }, 'Sign-in could not start. Finish any active jobs for this account, then try again.');
  }
  function refreshAccount() {
    void action('refresh', async signal => {
      const result = await api<AccountState>(`${accountPath(account)}/refresh`, 'POST', {}, { signal });
      if (!signal.aborted) { onUpdate(result); setLoginPending(false); setReloadKey(value => value + 1); setMessage('Account status refreshed from its official CLI.'); onChange(); }
    }, 'This account could not refresh. Check its official CLI sign-in and try again.');
  }
  function saveBilling() {
    if (stale || (billing.confirmed && (!authenticated || billing.mode === 'unknown'))) return;
    void action('billing', async signal => {
      const result = await api<AccountState>(`${accountPath(account)}/billing`, 'PATCH', { ...billing,
        expectedAccount: binding.expectedAccount, expectedConnectionScope: binding.scope }, { signal });
      if (!signal.aborted) { onUpdate(result); setBilling({ ...result.billing }); setBillingDirty(false); setMessage('Usage settings saved for this account.'); onChange(); }
    }, 'Usage approval was not saved. Refresh this account and check its identity, plan, and model choices before trying again.');
  }
  function disconnect() {
    void action('disconnect', async signal => {
      await api(accountPath(account), 'DELETE', undefined, { signal });
      if (!signal.aborted) { onRemove(account.accountId); onChange(); }
    }, 'This account could not be disconnected. Wait for its active jobs to finish, then try again. Other accounts were not changed.');
  }
  return <article className="account-connection" aria-labelledby={`${id}-name`}>
    <div className="accounts-row"><div className="accounts-grow"><h4 id={`${id}-name`}>{account.accountName}</h4>
      <p className="accounts-muted">{NAMES[account.id as AccountProviderId]}{account.isDefault ? ' · Primary connection' : ' · Separate local profile'}</p>
    </div><div className="accounts-badges"><span className={`accounts-badge ${authenticated ? 'is-ready' : ''}`}>{loginPending ? 'Refresh after sign-in' : authenticated ? 'Signed in' : account.installed ? 'Sign-in needed' : 'CLI setup needed'}</span>
      <span className={`accounts-badge ${approved ? 'is-ready' : ''}`}>{approved ? 'Usage approved' : 'Usage approval required'}</span></div></div>
    {account.accountLabel && <p className="account-identity"><strong>{account.accountLabel}</strong><span>{account.plan || 'Plan not reported'}{loginPending ? ' · last inspected identity' : ''}</span></p>}
    {!!account.duplicateAccountIds?.length && <p className="accounts-note">This sign-in is also connected in another profile. Both profiles share the same subscription allowance.</p>}
    {!account.installed && <p className="accounts-muted">Set up this provider’s official CLI on this host, then refresh this account.</p>}
    <div className="accounts-actions"><button type="button" disabled={!!busy || modelsBusy} onClick={startLogin}>{busy === 'login' ? 'Starting sign-in…' : 'Sign in with official CLI'}</button>
      <button type="button" disabled={!!busy || modelsBusy} onClick={refreshAccount}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh account'}</button></div>
    {login && <div className="account-login"><p>{login.message}</p>
      {url && <a className="accounts-button accounts-primary" href={url} target="_blank" rel="noopener noreferrer">Open official {NAMES[account.id as AccountProviderId]} sign-in</a>}
      {login.url && !url && <p className="accounts-error">The provider did not return a recognized HTTPS sign-in page. Follow its official CLI instructions.</p>}
      {login.command && <><p className="accounts-muted">Use the command supplied for this account’s official sign-in:</p><pre><code>{login.command}</code></pre></>}
      <p className="accounts-muted">Complete the official flow, then choose Refresh account. Starting sign-in does not confirm success or approve usage.</p>
    </div>}
    {error && <p className="accounts-error" role="alert">{error}</p>}
    {message && <p className="accounts-success" role="status">{message}</p>}
    <details className="account-settings" onToggle={event => setExpanded(event.currentTarget.open)}><summary>Usage and model settings</summary>
      <section className="account-billing" aria-labelledby={`${id}-usage`}><h5 id={`${id}-usage`}>Usage approval</h5>
        <p className="accounts-muted">Sign-in and plan discovery do not authorize spending. Choose the usage mode you have verified for this account.</p>
        {stale && <p className="accounts-error">Account identity changed. Reload its usage settings before approving them.</p>}
        <label className="accounts-field">Usage mode<select value={billing.mode} disabled={!!busy || modelsBusy || stale}
          onChange={event => { setBilling({ ...billing, mode: event.target.value as BillingConfig['mode'], confirmed: false, automaticRouting: false }); setBillingDirty(true); }}>
          <option value="unknown">Unknown · not approved</option><option value="included">Included subscription allowance</option><option value="metered">Metered · may incur charges</option>
        </select></label>
        {account.id === 'cursor' && <p className="accounts-muted">For included-only Cursor usage, choose explicit models first. Auto/default aliases are not allowed.</p>}
        <label className="accounts-check"><input type="checkbox" checked={billing.confirmed}
          disabled={!!busy || modelsBusy || !authenticated || billing.mode === 'unknown' || stale}
          onChange={event => { setBilling({ ...billing, confirmed: event.target.checked, automaticRouting: event.target.checked ? billing.automaticRouting : false }); setBillingDirty(true); }} />
          <span>I approve the inspected account and plan for this usage mode.</span></label>
        <label className="accounts-check"><input type="checkbox" checked={billing.automaticRouting}
          disabled={!!busy || modelsBusy || !authenticated || !billing.confirmed || billing.mode === 'unknown' || stale}
          onChange={event => { setBilling({ ...billing, automaticRouting: event.target.checked }); setBillingDirty(true); }} />
          <span>Allow Auto routing to use this account.<small>Off for new accounts. Connecting an account never enables paid fallback.</small></span></label>
        <label className="accounts-field">Allowance note (optional)<textarea rows={2} maxLength={1000} value={billing.allowanceNote}
          disabled={!!busy || modelsBusy || stale} onChange={event => { setBilling({ ...billing, allowanceNote: event.target.value }); setBillingDirty(true); }} /></label>
        <div className="accounts-actions"><button className="accounts-primary" type="button" disabled={!billingDirty || !!busy || modelsBusy || stale}
          onClick={saveBilling}>{busy === 'billing' ? 'Saving…' : 'Save usage approval'}</button>
          <button type="button" disabled={!!busy || modelsBusy} onClick={() => { setBilling({ ...account.billing }); setBillingDirty(false);
            setBinding({ identity: currentIdentity, scope: account.connectionScope, expectedAccount: { accountLabel: account.accountLabel, plan: account.plan } }); }}>Reload usage settings</button></div>
      </section>
      <AccountModels account={account} api={api} active={expanded} disabled={!!busy || loginPending} reloadKey={reloadKey}
        onUpdate={onUpdate} onSaved={onChange} onBusy={setModelsBusy} />
      <div className="account-disconnect">{account.isDefault ? <p className="accounts-muted">The existing integration card manages this primary connection. It cannot be disconnected from this account list.</p>
        : confirmDisconnect ? <><p>Disconnect this account from Relay? Its isolated profile stays on disk. Other accounts stay connected.</p>
          <div className="accounts-actions"><button className="accounts-danger" type="button" disabled={!!busy || modelsBusy} onClick={disconnect}>Disconnect account</button>
            <button type="button" disabled={!!busy || modelsBusy} onClick={() => setConfirmDisconnect(false)}>Cancel</button></div></>
          : <button className="accounts-danger" type="button" disabled={!!busy || modelsBusy} onClick={() => setConfirmDisconnect(true)}>Disconnect account</button>}</div>
    </details>
  </article>;
}

export function AccountConnections({ api, onChange, provider }: { api: Api; onChange?: () => void; provider?: AccountProviderId }) {
  const list = useAccounts(api), id = useId();
  const [adding, setAdding] = useState(false), [addProvider, setAddProvider] = useState<AccountProviderId>(provider ?? 'openai');
  const [name, setName] = useState(''), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null), working = useRef(false), alive = useRef(true);
  const changed = useRef(onChange); changed.current = onChange;
  useEffect(() => { if (provider) setAddProvider(provider); }, [provider]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; operation.current?.abort(); }; }, []);
  const accounts = list.accounts.filter(account => !provider || account.id === provider);
  async function add() {
    if (working.current) return;
    if (!name.trim() || name.trim().length > 100) { setError('Give this account a friendly name of 1 to 100 characters.'); return; }
    const controller = new AbortController(); operation.current = controller; working.current = true;
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await api<AccountState>('/accounts', 'POST', { provider: addProvider, name: name.trim() }, { signal: controller.signal });
      if (!controller.signal.aborted) { list.replace(result); setName(''); setAdding(false); setMessage('Account profile added. Choose its official sign-in button to continue.'); changed.current?.(); }
    } catch { if (!controller.signal.aborted) setError('The account profile could not be added. Other accounts were not changed.'); }
    finally { if (alive.current) { working.current = false; setBusy(false); } }
  }
  return <section className="account-connections" aria-labelledby={`${id}-title`}>
    <header className="accounts-row"><div className="accounts-grow"><h3 id={`${id}-title`}>Subscription accounts</h3>
      <p className="accounts-muted">Keep separate sign-ins for each account. Sign-in and usage approval are separate steps.</p></div>
      <button type="button" aria-expanded={adding} aria-controls={`${id}-add`} onClick={() => setAdding(value => !value)}>Add account</button></header>
    {adding && <form className="accounts-add" id={`${id}-add`} noValidate onSubmit={event => { event.preventDefault(); void add(); }}>
      <div className="accounts-form-grid"><label className="accounts-field">Provider<select value={addProvider} disabled={busy || !!provider}
        onChange={event => setAddProvider(event.target.value as AccountProviderId)}>{PROVIDERS.map(value => <option key={value} value={value}>{NAMES[value]}</option>)}</select></label>
        <label className="accounts-field">Friendly account name<input autoComplete="off" maxLength={100} value={name} disabled={busy}
          placeholder="For example: Personal or Work" onChange={event => setName(event.target.value)} /></label></div>
      <p className="accounts-muted">New accounts start with usage unapproved, Auto routing off, and no enabled models. No tokens, cookies, or API keys are entered here.</p>
      <div className="accounts-actions"><button className="accounts-primary" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add account profile'}</button>
        <button type="button" disabled={busy} onClick={() => setAdding(false)}>Cancel</button></div>
    </form>}
    {error && <p className="accounts-error" role="alert">{error}</p>}
    {message && <p className="accounts-success" role="status">{message}</p>}
    {list.loading && <p className="accounts-muted" role="status">Loading account connections…</p>}
    {list.error && <p className="accounts-error" role="alert">The account list could not refresh. Existing sign-ins have not been changed.</p>}
    {!list.loading && !accounts.length && <p className="accounts-muted">Add a subscription account to get started.</p>}
    <div className="accounts-list">{accounts.map(account => <AccountCard key={account.accountId} account={account} api={api}
      onUpdate={list.replace} onRemove={list.remove} onChange={() => { changed.current?.(); void list.reload(); }} />)}</div>
  </section>;
}

export function AccountChoice({ api, value, onChange, provider }: {
  api: Api; value: string; onChange(account: AccountState | null): void; provider?: AccountProviderId;
}) {
  const list = useAccounts(api);
  const accounts = list.accounts.filter(account => !provider || account.id === provider);
  const missing = !!value && !accounts.some(account => account.accountId === value);
  return <label className="account-choice accounts-field">Account
    <select value={value} aria-label="Account" onChange={event => onChange(accounts.find(account => account.accountId === event.target.value) ?? null)}>
      <option value="">Auto · approved accounts</option>
      {missing && <option value={value} disabled>Previously selected account is unavailable</option>}
      {accounts.map(account => <option value={account.accountId} key={account.accountId}>
        {account.accountName} · {NAMES[account.id as AccountProviderId]}{!connectionAuthenticated(account) || !account.accountLabel.trim() ? ' · sign-in needed'
          : account.inferenceAvailable === false ? ' · not ready' : !account.billing.confirmed || account.billing.mode === 'unknown' ? ' · usage approval needed'
            : account.modelPreferences.allowedModels?.length === 0 ? ' · no models enabled' : ''}
      </option>)}
    </select>
    {list.error && <small className="accounts-error">Account choices could not refresh.</small>}
  </label>;
}
