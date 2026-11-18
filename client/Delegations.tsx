import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Info, LoaderCircle, RefreshCw, Users } from 'lucide-react';
import type { DelegationRecord } from '../shared/delegation';
import type { GroupEvent, GroupRun, ProviderId } from '../shared/types';
import { providerName } from './Models';
import { RunInteractions, type useRunInteractions } from './Interactions';

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export interface HerdrStatus { available: boolean; version?: string; error?: string; quarantines?: { id: string; workspace?: string; source: 'herdr' | 'provider'; runId?: string; provider?: ProviderId; createdAt: string; reason: string }[]; }
type Reconciliation = { stopped: boolean; error?: string };

export function useHerdrStatus(api: Api, enabled: boolean) {
  const apiRef = useRef(api); apiRef.current = api;
  const [status, setStatus] = useState<HerdrStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const request = useRef(0);
  async function refresh() {
    const revision = ++request.current;
    setChecking(true);
    try {
      const result = await apiRef.current<HerdrStatus>('/herdr');
      if (revision === request.current) setStatus(result);
    } catch (failure) {
      if (revision === request.current) setStatus({ available: false, error: (failure as Error).message });
    } finally { if (revision === request.current) setChecking(false); }
  }
  useEffect(() => {
    if (enabled) void refresh();
    else { request.current++; setStatus(null); setChecking(false); }
    return () => { request.current++; };
  }, [enabled]);
  return { status, checking, refresh };
}

export function HerdrStatusView({ status, checking, refresh }: { status: HerdrStatus | null; checking: boolean; refresh: () => void }) {
  return <div className="herdr-status-view">
    <div className="herdr-status-heading"><span className={`connection-dot ${status?.available ? 'connected' : ''}`}/><strong>{checking ? 'Checking Herdr…' : status?.available ? 'Herdr is ready' : 'Herdr is not ready'}</strong>{status?.version && <span className="herdr-version">{status.version}</span>}</div>
    <p>{status?.available ? 'Lead & workers can use the Relay-managed background runtime.' : 'Install the Relay-managed Herdr runtime, then check again. Existing chats remain available.'}</p>
    {status?.error && <p className="provider-warning" role="status">{status.error}</p>}
    <button type="button" className="secondary small" disabled={checking} onClick={refresh}><RefreshCw size={13} className={checking ? 'spin' : ''}/>{checking ? 'Checking…' : 'Check again'}</button>
  </div>;
}

export function HerdrSettings({ api }: { api: Api }) {
  const connection = useHerdrStatus(api, true);
  const [checks, setChecks] = useState<Record<string, { busy: boolean; message: string }>>({});
  async function recheck(id: string) {
    if (checks[id]?.busy) return;
    setChecks(previous => ({ ...previous, [id]: { busy: true, message: '' } }));
    try {
      const result = await api<Reconciliation>('/herdr/reconcile', 'POST', { delegationId: id });
      setChecks(previous => ({ ...previous, [id]: { busy: false, message: result.stopped ? 'Owned worker termination confirmed. No task was replayed.' : result.error || 'Termination remains unconfirmed.' } }));
      await connection.refresh();
    } catch (failure) { setChecks(previous => ({ ...previous, [id]: { busy: false, message: (failure as Error).message } })); }
  }
  return <section className="herdr-settings"><div className="settings-section-header"><div><h3>Herdr workers</h3><p>Background execution for Lead & workers groups.</p></div></div><HerdrStatusView {...connection}/><p className="subtle-text herdr-settings-note">Bots keep their saved subscription, model, and permissions. Permission requests still appear in the chat.</p>{!!connection.status?.quarantines?.length && <div className="delegation-reconciliation"><h3>Execution exclusions</h3><p>These calls may still own running processes. Their inference slots and overlapping workspaces remain reserved.</p>{connection.status.quarantines.map(item => <details key={item.id}><summary>{item.provider ? providerName(item.provider) : 'Worker'} · {item.runId || item.id}</summary><p>{item.reason}</p>{item.workspace && <code className="workspace-path">{item.workspace}</code>}<p className="subtle-text">Exclusion ID: {item.id}</p><button type="button" className="secondary small" disabled={checks[item.id]?.busy} onClick={() => void recheck(item.id)}>{checks[item.id]?.busy ? 'Checking…' : 'Recheck termination'}</button>{checks[item.id]?.message && <p role="status">{checks[item.id].message}</p>}</details>)}</div>}</section>;
}

export function groupEventBelongsToRun(event: GroupEvent, run: Pick<GroupRun, 'id' | 'roomId'>): boolean {
  if (!event || typeof event !== 'object') return false;
  switch (event.type) {
    case 'snapshot': return event.run?.id === run.id && event.run.roomId === run.roomId && Array.isArray(event.messages) && event.messages.every(message => message.roomId === run.roomId);
    case 'run':
    case 'done': return event.run?.id === run.id && event.run.roomId === run.roomId;
    case 'message': return event.message?.runId === run.id && event.message.roomId === run.roomId;
    case 'delta':
    case 'status':
    case 'interactionResolved': return event.runId === run.id;
    case 'delegation': return event.runId === run.id && event.delegation?.parentRunId === run.id;
    case 'interaction': return event.interaction?.runId === run.id;
    default: return false;
  }
}

export function delegationStatus(record: DelegationRecord): string {
  if (record.terminationUnconfirmed) return 'Outcome unknown';
  switch (record.status) {
    case 'queued': return 'Queued';
    case 'running': return 'Working';
    case 'attention': return 'Needs your attention';
    case 'complete': return record.executionVerified ? 'Verified complete' : 'Finished · unverified';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Stopped';
    case 'interrupted': return 'Outcome unknown';
    case 'unrun': return 'Not run';
  }
}

export function DelegationList({ runId, records, reconcile }: { runId: string; records: DelegationRecord[]; reconcile?: (delegationId: string) => Promise<Reconciliation> }) {
  const [checks, setChecks] = useState<Record<string, { busy: boolean; message: string }>>({});
  const checking = useRef(new Set<string>());
  const ownRecords = records.filter(record => record.parentRunId === runId);
  if (!ownRecords.length) return null;
  const completed = ownRecords.filter(record => record.status === 'complete').length;
  const attention = ownRecords.filter(record => record.status === 'attention').length;
  async function recheck(id: string) {
    if (!reconcile || checking.current.has(id)) return;
    checking.current.add(id);
    setChecks(previous => ({ ...previous, [id]: { busy: true, message: '' } }));
    try {
      const result = await reconcile(id);
      setChecks(previous => ({ ...previous, [id]: { busy: false, message: result.stopped ? 'The worker has stopped. Its previous task has not been replayed.' : result.error || 'Termination is not confirmed. The workspace remains reserved.' } }));
    } catch (failure) { setChecks(previous => ({ ...previous, [id]: { busy: false, message: (failure as Error).message } })); }
    finally { checking.current.delete(id); }
  }
  return <details className="delegation-list">
    <summary><Users size={14}/><span>Worker activity</span><span className={attention ? 'delegation-attention' : 'delegation-count'}>{attention ? `${attention} needs attention` : `${completed} of ${ownRecords.length} finished`}</span><ChevronDown size={13}/></summary>
    <div className="delegation-rows">{ownRecords.map(record => <details className={`delegation-worker delegation-${record.status}`} key={record.id}>
      <summary><span className={`delegation-state-dot ${record.status}`}/><strong>{record.workerName}</strong><span>{delegationStatus(record)}</span><ChevronDown size={12}/></summary>
      <div className="delegation-worker-details">
        <div className="delegation-route">{record.route ? `${providerName(record.route.provider)} · ${record.route.model}` : 'Route not selected'} · {record.mode === 'agent' ? 'Agent' : record.mode === 'work' ? 'Work' : 'Chat'}</div>
        <dl><dt>Assignment</dt><dd>{record.task}</dd><dt>Expected result</dt><dd>{record.expectedResult}</dd>{record.dependsOn.length > 0 && <><dt>Depends on</dt><dd>{record.dependsOn.map(id => ownRecords.find(other => other.workerId === id)?.workerName || 'Another worker').join(', ')}</dd></>}</dl>
        {record.result && <div className="delegation-result"><strong>Result</strong><p>{record.result}</p></div>}
        {record.evidence.length > 0 && <div className="delegation-evidence"><strong>Execution evidence</strong><ul>{record.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
        {record.status === 'complete' && !record.executionVerified && <p className="delegation-verification-note"><Info size={13}/>This result has not been independently verified.</p>}
        {record.error && <p className="form-error">{record.error}</p>}
        {record.workspace && <details className="delegation-workspace"><summary>Workspace</summary><code>{record.workspace}</code></details>}
        {record.terminationUnconfirmed && reconcile && <div className="delegation-reconciliation"><p>Termination is not confirmed. The workspace remains reserved.</p><button type="button" className="secondary small" disabled={checks[record.id]?.busy} onClick={() => void recheck(record.id)}>{checks[record.id]?.busy && <LoaderCircle size={13} className="spin"/>}Recheck stopped worker</button>{checks[record.id]?.message && <p role="status">{checks[record.id].message}</p>}</div>}
      </div>
    </details>)}</div>
  </details>;
}

export function WorkerInteractions({ runId, state, returnFocus }: { runId: string; state: ReturnType<typeof useRunInteractions>; returnFocus: () => void }) {
  return <>{Object.values(state.entries).filter(interaction => interaction.runId === runId && interaction.status === 'pending').map(interaction => <div className="worker-interaction" key={interaction.id}>
    <p className="worker-interaction-label">{interaction.workerName || 'A worker'} needs your attention</p>
    <RunInteractions runId={runId} state={{ ...state, entries: { [`${runId}:${interaction.id}`]: interaction } }} returnFocus={returnFocus}/>
  </div>)}</>;
}
