import { isActiveProviderId } from '../shared/types';
import { useEffect, useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import type { Bootstrap, ModelInfo, ModelPreferences, ProviderState,ModelCatalogPage } from '../shared/types';
import {modelBillingAllowed} from '../shared/provider-policy';

const providerNames: Record<string, string> = { openai: 'OpenAI', claude: 'Claude', cursor: 'Cursor',opencode:'OpenCode', gemini: 'Google', grok: 'Grok' };
export const providerName = (id: string): string => providerNames[id] || id;
/** Only active provider connections may expose a sign-in destination. */
export function providerSetupUrl(provider: string, value: string): string | null {
  if (!isActiveProviderId(provider)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;

    const trusted = provider === 'openai'
      ? url.hostname === 'auth.openai.com' || url.hostname.endsWith('.openai.com') || url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com')

      : provider === 'cursor' ? (url.hostname === 'cursor.com' || url.hostname.endsWith('.cursor.com')) : provider==='opencode'&&url.hostname==='opencode.ai'&&url.pathname.startsWith('/v2/docs/');
    return trusted ? url.href : null;
  } catch { return null; }
}
const autoAlias = (model: ModelInfo): boolean => /(^|[^a-z0-9])auto($|[^a-z0-9])/i.test(`${model.id} ${model.name}`) || /(^|[/:])default$/i.test(model.id.trim()) || /^default$/i.test(model.name.trim());
const blockedCursorModel = (provider: ProviderState, model: ModelInfo): boolean => provider.id === 'cursor' && provider.billing.mode === 'included' && autoAlias(model);

export function allowedCatalog(provider?: ProviderState): ModelInfo[] {
  if (!provider || !isActiveProviderId(provider.id)) return [];
  const allowed = provider.modelPreferences.allowedModels;
  if (provider.id === 'cursor' && provider.billing.mode === 'included' && allowed === null) return [];
  return provider.models.filter(model => modelBillingAllowed(provider,model)&&!blockedCursorModel(provider, model) && (allowed === null || allowed.includes(model.id)));
}

export function defaultModelLabel(provider?: ProviderState): string {
  if (provider?.inferenceAvailable === false) return 'Unavailable · ' + providerName(provider.id);
  if (!provider?.models.length) {
    if (provider && !provider.authenticated) return `Connect ${providerName(provider.id)} to load models`;
    return 'No models found · refresh accounts';
  }
  const id = provider?.modelPreferences.defaultModel;
  if (!id) return provider?.id==='opencode'?'Runtime default · enabled models':'Subscription default · economy';
  const model = allowedCatalog(provider).find(model => model.id === id);
  return model ? `Default · ${model.name || model.id} · ${model.verified ? 'Verified' : 'Candidate'}` : `Default unavailable · ${id}`;
}

export function modelIsAvailable(provider: ProviderState | undefined, model: string): boolean {
  return !!provider && allowedCatalog(provider).some(candidate => candidate.id === (model || provider.modelPreferences.defaultModel) || (!model && !provider.modelPreferences.defaultModel));
}

export function ModelPicker({ provider, auto, value, onChange, compact = false, label = 'Model' }: {
  provider?: ProviderState; auto: boolean; value: string; onChange: (value: string) => void; compact?: boolean; label?: string;
}) {
  const catalog = allowedCatalog(provider);
  const [query,setQuery]=useState(''),[page,setPage]=useState(0);
  const filtered=searchModels(catalog,query),pageCount=Math.max(1,Math.ceil(filtered.length/50)),currentPage=Math.min(page,pageCount-1),visible=filtered.slice(currentPage*50,currentPage*50+50);
  const selected=catalog.find(model=>model.id===value);if(selected&&!visible.some(model=>model.id===value))visible.unshift(selected);
  const unavailable = !!value && !catalog.some(model => model.id === value);
  return <div className="model-picker">{!auto&&catalog.length>50&&<label>Search models<input aria-label={label+' search'} type="search" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}} placeholder="Model or provider name / exact ID"/></label>}<select className={compact ? 'composer-model-select' : ''} aria-label={label} disabled={auto} title={auto ? 'Auto chooses among enabled models with confirmed billing. Configure them in Settings.' : !provider?.models.length ? defaultModelLabel(provider) : 'Choose an enabled model or use its saved default.'} value={auto ? '' : value} onChange={event => onChange(event.target.value)}>
    <option value="">{auto ? 'Auto selects model' : defaultModelLabel(provider)}</option>
    {unavailable && <option value={value} disabled>Unavailable · {value}</option>}
    {!auto && visible.map(model => <option key={model.id} value={model.id}>{model.name || model.id}{model.name!==model.id?' · '+model.id:''} · {model.backendProviderName||model.backendProviderId||''} · {model.verified ? 'Verified' : 'Candidate'}</option>)}
  </select>{!auto&&filtered.length>50&&<div className="model-pagination"><button type="button" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous</button><span>{currentPage+1} / {pageCount} · {filtered.length} models</span><button type="button" disabled={currentPage+1>=pageCount} onClick={()=>setPage(currentPage+1)}>Next</button></div>}</div>;
}
export function searchModels(models:ModelInfo[],query:string):ModelInfo[]{const needle=query.trim().toLocaleLowerCase('en-US');return models.filter(model=>!needle||[model.id,model.name,model.backendProviderName,model.backendProviderId,model.description].filter(Boolean).join(' ').toLocaleLowerCase('en-US').includes(needle));}
/** Bounded edits keep large selections out of request bodies and preserve future-model opt-in. */
export async function persistModelChoices(provider:ProviderState,choices:ModelPreferences,api:<T>(path:string,method?:string,body?:unknown)=>Promise<T>):Promise<void>{
 const path='/providers/'+provider.id+'/models',scope=provider.connectionScope?{expectedConnectionScope:provider.connectionScope}:{};
 if(choices.allowedModels===null){await api(path,'PATCH',{...choices,...scope});return;}
 const catalog=await api<ModelCatalogPage>(path+'?limit=1'),binding={...scope,expectedCatalogRevision:catalog.revision};
 let previous=provider.modelPreferences.allowedModels;
 if(previous===null){await api(path,'PATCH',{defaultModel:'',allowedModels:[],...binding});previous=[];}
 const desired=choices.allowedModels,add=desired.filter(id=>!previous!.includes(id)),remove=previous.filter(id=>!desired.includes(id));
 if(choices.defaultModel&&add.includes(choices.defaultModel)){add.splice(add.indexOf(choices.defaultModel),1);add.unshift(choices.defaultModel);}
 const count=Math.max(1,Math.ceil(Math.max(add.length,remove.length)/100));
 for(let index=0;index<count;index++)await api(path,'PATCH',{defaultModel:choices.defaultModel,addModels:add.slice(index*100,index*100+100),removeModels:remove.slice(index*100,index*100+100),...binding});
}

export function SubscriptionModels({ provider, api, reload }: {
  provider: ProviderState;
  api: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
  reload: () => Promise<Bootstrap>;
}) {
  const [preferences, setPreferences] = useState<ModelPreferences>(provider.modelPreferences);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [query,setQuery]=useState(''),[page,setPage]=useState(0);
  const filtered=searchModels(provider.models,query),pageCount=Math.max(1,Math.ceil(filtered.length/50)),currentPage=Math.min(page,pageCount-1),visible=filtered.slice(currentPage*50,currentPage*50+50);
  const persisted = JSON.stringify(provider.modelPreferences);
  useEffect(() => { setPreferences(provider.modelPreferences); }, [persisted]);
  const enabled = allowedCatalog({...provider,modelPreferences:preferences});
  const blockedSelections = provider.models.filter(model => blockedCursorModel(provider, model) && preferences.allowedModels?.includes(model.id));
  const unknown = [...new Set(preferences.allowedModels || [])].filter(id => !provider.models.some(model => model.id === id));
  const defaultUnavailable = !!preferences.defaultModel && !enabled.some(model => model.id === preferences.defaultModel);
  const dirty = JSON.stringify(preferences) !== persisted;
  function update(next: ModelPreferences) { setPreferences(next); setSaved(false); setError(''); }
  function toggle(id: string, checked: boolean) {
    const selected = preferences.allowedModels === null ? provider.models.map(model => model.id) : preferences.allowedModels;
    update({ ...preferences, allowedModels: checked ? [...new Set([...selected, id])] : selected.filter(item => item !== id) });
  }
  return <section className="subscription-models" aria-label={providerName(provider.id)+(provider.id==='opencode'?' runtime models':' subscription models')}>
    <h4>{provider.id==='opencode'?'Models for this managed runtime':'Models for this subscription'}</h4>
    <p className="model-explanation">Choose which models Relay may send messages to. A listed model is a choice, not proof that your plan covers it or has allowance left. “Candidate” means no response has confirmed its identity yet; “Verified” records a response identity, not billing coverage.</p>
    <form onSubmit={async event => {
      event.preventDefault(); setSaving(true); setSaved(false); setError('');
      const choices = provider.id === 'cursor' ? { ...preferences, allowedModels: preferences.allowedModels === null ? enabled.map(model => model.id) : preferences.allowedModels } : preferences;
      try { await persistModelChoices(provider,choices,api); await reload(); setSaved(true); }
      catch (failure) { setError((failure as Error).message); }
      finally { setSaving(false); }
    }}>
      <fieldset disabled={saving} className="model-options">
        <legend className="sr-only">Enabled models</legend>
        {provider.id !== 'cursor'&&provider.id!=='opencode' && <label className="check-label all-models"><input type="checkbox" checked={preferences.allowedModels === null} onChange={event => update({ ...preferences, allowedModels: event.target.checked ? null : provider.models.map(model => model.id) })}/><span>Use all available models<small>Includes models discovered on future refreshes.</small></span></label>}
        {provider.id==='opencode'&&<p className="model-empty">Choose exact backend/model IDs. Newly discovered models stay off. Open models may use paid APIs; a local endpoint can also proxy paid services. Billing confirmation applies only to this configuration.</p>}
        <label>Search models<input aria-label="Search model catalog" type="search" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}} placeholder="Provider, model name or exact ID"/></label>
        {provider.id === 'cursor' && <p className="model-empty">Choose only models you have verified are covered by this Cursor workspace. Saving stores these exact selections; future models stay off. The dynamic Auto model is unavailable with included billing.</p>}
        <div className="subscription-model-list">{visible.map(model => <label className={`model-choice ${blockedCursorModel(provider, model) ? 'blocked-model' : ''}`} key={model.id}><input type="checkbox" disabled={blockedCursorModel(provider, model)} checked={!blockedCursorModel(provider, model) && (preferences.allowedModels === null || preferences.allowedModels.includes(model.id))} onChange={event => toggle(model.id, event.target.checked)}/><span><strong>{model.name || model.id}</strong><code>{model.id}</code>{provider.id==='opencode'&&model.toolCalling===false&&<small>Native Agent unavailable: this model does not support tools.</small>}{model.contextWindow&&<small>Context: {model.contextWindow.toLocaleString()} tokens</small>}{model.backendProviderName&&<small>{model.backendProviderName}</small>}{model.provenance&&<small>{model.provenance.source} · observed {new Date(model.provenance.observedAt).toLocaleString()}</small>}{blockedCursorModel(provider, model) ? <small>Dynamic Auto is not allowed with included billing.</small> : model.description && <small>{model.description}</small>}</span><span className={`model-verification ${model.verified ? 'verified' : ''}`}>{blockedCursorModel(provider, model) ? 'Disabled' : model.verified ? 'Verified' : 'Candidate'}</span></label>)}{unknown.map(id => <label className="model-choice unavailable-model" key={id}><input type="checkbox" checked onChange={() => toggle(id, false)}/><span><strong>{id}</strong><small>Unavailable in the current catalog. Uncheck to remove.</small></span><span className="model-verification">Unavailable</span></label>)}</div>
        <div className="model-pagination"><button type="button" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous</button><span>{filtered.length} matches · page {currentPage+1} / {pageCount}</span><button type="button" disabled={currentPage+1>=pageCount} onClick={()=>setPage(currentPage+1)}>Next</button></div>{!provider.models.length && <p className="model-empty">No model catalog is available yet. Refresh the official provider connection. No account access is implied.</p>}
        <div className="subscription-default-label">Default model<ModelPicker provider={{...provider,modelPreferences:preferences}} auto={false} value={preferences.defaultModel} onChange={value=>update({...preferences,defaultModel:value})} label="Default model"/></div>
      </fieldset>
      {defaultUnavailable && <p className="model-warning">Your saved default is unavailable or disabled. Choose an enabled model or Economy before saving.</p>}
      {!!unknown.length && <p className="model-warning">Remove unavailable model selections before saving{provider.id === 'cursor' ? '.' : ', or choose “Use all available models.”'}</p>}
      {!!blockedSelections.length && <p className="model-warning">A saved Auto selection is not allowed with included billing. <button type="button" className="inline-action" onClick={() => update({ ...preferences, allowedModels: preferences.allowedModels?.filter(id => !blockedSelections.some(model => model.id === id)) || [] })}>Remove disabled Auto selections</button></p>}
      {!enabled.length && <p className="model-warning">No models are enabled. This connection cannot receive a message until a compatible model is available and enabled.</p>}
      <div className="model-save-row"><span role="status">{saving ? 'Saving model choices…' : saved ? <><Check size={12}/>Model choices saved</> : dirty ? 'Unsaved model choices' : `${enabled.length} model${enabled.length === 1 ? '' : 's'} enabled`}</span><button className="secondary small" type="submit" disabled={saving || defaultUnavailable || !!unknown.length || !!blockedSelections.length}>{saving && <LoaderCircle size={12} className="spin"/>}{saving ? 'Saving…' : 'Save models'}</button></div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  </section>;
}
