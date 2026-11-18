import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AssignmentSource } from '../shared/chat-assignments';
import type { RemoteQuestion } from '../shared/remote-jobs';
import { RunInteractions, useRunInteractions } from './Interactions';
import { RichText } from './RichText';

export type AssignmentApi = <T>(path: string, method?: string, body?: unknown, options?: { signal: AbortSignal }) => Promise<T>;
export type AssignmentView = {
  id: string; requestId: string; source: AssignmentSource; messageId?: string; agentId: string; computerId?: string;
  taskId: string; capsuleId: string; createdAt: string; botName: string; computerName?: string;
  state: string; active: boolean; recoveryRequired: boolean; error?: string; progress?: string; hasResult: boolean;
};
type ResultPage = { text: string; offset: number; end: number; total: number; truncated: boolean };
type AssignmentDetail = {
  assignment: AssignmentView; result: ResultPage; events: { name: string; summary: string; at?: string }[];
  localRuns: { runId: string; agentName: string }[]; remoteQuestion?: RemoteQuestion;
  context: { selectedMessages: number; omittedMessages: number; characters: number; truncated: boolean };
};
const failureText = (failure: unknown) => failure instanceof Error ? failure.message : 'Could not reach Relay. Your input has been kept.';
const sameSource = (a?: AssignmentSource, b?: AssignmentSource) => !!a && !!b && a.kind === b.kind && a.id === b.id;
const changed = (source: AssignmentSource) => window.dispatchEvent(new CustomEvent('relay:assignments-changed', { detail: { source } }));
const pathFor = (id: string) => `/assignments/${encodeURIComponent(id)}`;
const validPage = (page: ResultPage, offset: number) => page.offset === offset && page.end === offset + page.text.length && page.total >= page.end;

/** Source keys isolate drafts and fence requests when the user switches chats. CSS is imported by main. */
export function AssignmentActivity({ source, api }: { source: AssignmentSource; api: AssignmentApi }) {
  return <AssignmentList key={`${source.kind}/${source.id}`} source={source} api={api} />;
}
function AssignmentList({ source, api }: { source: AssignmentSource; api: AssignmentApi }) {
  const [assignments, setAssignments] = useState<AssignmentView[]>([]), [error, setError] = useState('');
  const apiRef = useRef(api); apiRef.current = api;
  useEffect(() => {
    let alive = true, epoch = 0, active = false, timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    async function refresh() {
      const ticket = ++epoch; clearTimeout(timer); controller?.abort(); controller = new AbortController();
      try {
        const response = await apiRef.current<{ assignments: AssignmentView[] }>(`/assignments?kind=${encodeURIComponent(source.kind)}&id=${encodeURIComponent(source.id)}`, 'GET', undefined, { signal: controller.signal });
        if (!alive || ticket !== epoch) return;
        const rows = response.assignments.filter(item => sameSource(item.source, source));
        active = rows.some(item => item.active); setAssignments(rows); setError('');
      } catch (failure) { if (alive && ticket === epoch && !controller.signal.aborted) setError(failureText(failure)); }
      finally { if (alive && ticket === epoch) timer = setTimeout(() => void refresh(), active ? 1500 : 5000); }
    }
    const refreshEvent = (event: Event) => { if (sameSource((event as CustomEvent<{ source?: AssignmentSource }>).detail?.source, source)) void refresh(); };
    window.addEventListener('relay:assignments-changed', refreshEvent); void refresh();
    return () => { alive = false; epoch++; clearTimeout(timer); controller?.abort(); window.removeEventListener('relay:assignments-changed', refreshEvent); };
  }, [source.kind, source.id]);
  if (!assignments.length && !error) return null;
  return <section className="assignment-activity" aria-label="Background assignments">
    {error && <p className="assignment-error" role="status">Background activity could not refresh. {error}</p>}
    {assignments.map(assignment => <AssignmentCard key={assignment.id} view={assignment} api={api} />)}
  </section>;
}
function AssignmentCard({ view, api }: { view: AssignmentView; api: AssignmentApi }) {
  const [expanded, setExpanded] = useState(false), [detail, setDetail] = useState<AssignmentDetail>();
  const [result, setResult] = useState<ResultPage>(), [outputNotice, setOutputNotice] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(''), [refresh, setRefresh] = useState(0);
  const [pollError, setPollError] = useState('');
  const [draft, setDraft] = useState(''), [targetRunId, setTargetRunId] = useState('');
  const [paging, setPaging] = useState(false);
  const apiRef = useRef(api), alive = useRef(true), outputVersion = useRef(0), latestResult = useRef(result);
  apiRef.current = api; latestResult.current = result;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!view.active && !expanded) return;
    let disposed = false, epoch = 0, timer: ReturnType<typeof setTimeout>, controller: AbortController | undefined;
    async function poll() {
      const ticket = ++epoch; controller = new AbortController();
      try {
        const snapshot = await apiRef.current<AssignmentDetail>(`${pathFor(view.id)}?offset=0&limit=12000`, 'GET', undefined, { signal: controller.signal });
        if (disposed || ticket !== epoch) return;
        if (snapshot.assignment.id !== view.id || !sameSource(snapshot.assignment.source, view.source) || !validPage(snapshot.result, 0)) throw new Error('Relay returned an inconsistent activity snapshot.');
        setDetail(snapshot); setPollError('');
        const page = snapshot.result, previous = latestResult.current;
        const keepPages = previous && previous.text.startsWith(page.text) && page.end <= previous.end && page.total >= previous.end;
        const next = keepPages ? { ...previous, total: page.total, truncated: previous.end < page.total } : page;
        if (previous && !keepPages && previous.text !== page.text) {
          outputVersion.current++;
          if (!page.text.startsWith(previous.text)) setOutputNotice('The task output changed; showing the current result.');
        }
        latestResult.current = next; setResult(next);
      } catch (failure) { if (!disposed && ticket === epoch && !controller?.signal.aborted) setPollError(failureText(failure)); }
      finally { if (!disposed && ticket === epoch) timer = setTimeout(() => void poll(), view.active ? 1500 : 5000); }
    }
    void poll();
    return () => { disposed = true; epoch++; clearTimeout(timer); controller?.abort(); };
  }, [view.id, view.active, expanded, refresh]);
  function refreshed() { setRefresh(value => value + 1); changed(view.source); }
  async function stop() {
    if (busy) return; setBusy('stop'); setError('');
    try { await apiRef.current(pathFor(view.id) + '/cancel', 'POST', {}); if (alive.current) refreshed(); }
    catch (failure) { if (alive.current) setError(failureText(failure)); }
    finally { if (alive.current) setBusy(''); }
  }
  async function guide(event: FormEvent) {
    event.preventDefault(); if (busy || !draft.trim()) return;
    const runs = detail?.localRuns ?? [], target = runs.length === 1 ? runs[0].runId : targetRunId;
    if (!runs.some(run => run.runId === target)) { setError('Choose the worker run that should receive this guidance.'); return; }
    const submitted = draft; setBusy('guidance'); setError('');
    try {
      await apiRef.current(pathFor(view.id) + '/guidance', 'POST', { content: submitted, targetRunId: target });
      if (alive.current) { setDraft(current => current === submitted ? '' : current); refreshed(); }
    } catch (failure) { if (alive.current) setError(failureText(failure)); }
    finally { if (alive.current) setBusy(''); }
  }
  async function more() {
    const previous = latestResult.current; if (!previous || paging || previous.end >= previous.total) return;
    const version = outputVersion.current; setPaging(true); setError('');
    try {
      const next = await apiRef.current<AssignmentDetail>(`${pathFor(view.id)}?offset=${previous.end}&limit=12000`);
      if (!alive.current || version !== outputVersion.current || latestResult.current?.end !== previous.end) return;
      if (next.assignment.id !== view.id || !sameSource(next.assignment.source, view.source) || !validPage(next.result, previous.end)) throw new Error('The result changed while loading. Open the activity again to refresh it.');
      const merged = { ...next.result, offset: 0, text: previous.text + next.result.text };
      latestResult.current = merged; setResult(merged);
    } catch (failure) { if (alive.current) setError(failureText(failure)); }
    finally { if (alive.current) setPaging(false); }
  }
  const current = view, runs = detail?.localRuns ?? [];
  const terminal = ['done','error','complete', 'completed', 'failed', 'cancelled', 'canceled'].includes(view.state);
  return <article className="assignment-card" aria-label={`${view.botName} background task`}>
    <header><div className="assignment-heading"><strong>{view.botName}</strong>{view.computerName && <span>on {view.computerName}</span>}</div><span className={`assignment-state${view.active ? ' is-active' : ''}`}>{current.state.replace(/[_-]/g, ' ')}</span></header>
    {view.progress && <p className="assignment-progress">{view.progress.slice(0, 500)}</p>}
    {view.recoveryRequired && <p className="assignment-attention" role="status">This task needs attention. Relay cannot confirm what happened on the worker. Check {view.computerName || 'the worker computer'} before starting it again.</p>}
    {view.error && <p className="assignment-error">{view.error}</p>}
    {!expanded && (result?.text && detail?.assignment.state === view.state ? <p className="assignment-preview">{result.text.slice(0, 180)}{result.text.length > 180 ? '…' : ''}</p> : view.hasResult ? <p className="assignment-progress">Result ready</p> : null)}
    <div className="assignment-actions"><button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Hide activity' : 'View activity'}</button>{view.active && <button type="button" disabled={!!busy} onClick={() => void stop()}>{busy === 'stop' ? 'Stopping…' : 'Stop task'}</button>}</div>
    {error && <p className="assignment-error" role="status">{error}</p>}
    {pollError && <p className="assignment-error" role="status">Activity could not refresh. {pollError}</p>}
    {!terminal && detail && (view.active || expanded) && runs.map(run => <LocalRunQuestions key={run.runId} runId={run.runId} agentName={run.agentName} api={api} />)}
    {!terminal && detail?.remoteQuestion && <RemoteAnswer key={`${detail.remoteQuestion.id}/${detail.remoteQuestion.revision}`} question={detail.remoteQuestion} computer={view.computerName || 'the worker computer'} assignmentId={view.id} api={api} refreshed={refreshed} />}
    {expanded && <div className="assignment-expanded">
      {!detail && <p className="assignment-progress">Loading activity…</p>}
      {!!detail?.events.length && <ol className="assignment-events">{detail.events.slice(-20).map((event, index) => <li key={`${event.at || ''}/${index}`}><span>{event.name.replace(/[_-]/g, ' ')}</span><p>{event.summary}</p></li>)}</ol>}
      {outputNotice && <p className="assignment-progress">{outputNotice}</p>}
      {result?.text && <div className="assignment-result"><RichText content={result.text} /></div>}
      {result && result.end < result.total && <button type="button" disabled={paging} onClick={() => void more()}>{paging ? 'Loading…' : 'Show more'}</button>}
      {view.active && runs.length > 0 && <form className="assignment-guidance" onSubmit={event => void guide(event)}>
        {runs.length > 1 && <label>Worker run<select value={targetRunId} onChange={event => setTargetRunId(event.target.value)} required><option value="">Choose a run</option>{runs.map((run, index) => <option key={run.runId} value={run.runId}>{run.agentName} · run {index + 1}</option>)}</select></label>}
        <label>Add guidance<textarea rows={2} value={draft} maxLength={16000} onChange={event => setDraft(event.target.value)} placeholder="Clarify the task or add information" /></label>
        <button type="submit" disabled={!!busy || !draft.trim() || (runs.length > 1 && !runs.some(run => run.runId === targetRunId))}>{busy === 'guidance' ? 'Sending…' : 'Send guidance'}</button>
      </form>}
      {detail?.context && <details className="assignment-context"><summary>Context details</summary><p>{detail.context.selectedMessages} selected messages · {detail.context.characters.toLocaleString()} characters · {detail.context.omittedMessages} omitted{detail.context.truncated ? ' · limited to fit' : ''}</p></details>}
    </div>}
  </article>;
}
function LocalRunQuestions({ runId, agentName, api }: { runId: string; agentName: string; api: AssignmentApi }) {
  const state = useRunInteractions(api), stateRef = useRef(state);
  const [error, setError] = useState(''); stateRef.current = state;
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { await stateRef.current.reconcile(runId); if (alive) setError(''); }
      catch (failure) { if (alive) setError(failureText(failure)); }
      finally { if (alive) timer = setTimeout(() => void poll(), 1500); }
    }
    void poll(); return () => { alive = false; clearTimeout(timer); };
  }, [runId]);
  return <div className="assignment-questions" aria-label={`${agentName} questions`}>
    {error && <p className="assignment-error" role="status">Could not check worker questions. {error}</p>}
    <RunInteractions runId={runId} state={state} returnFocus={() => {}} autoFocus={false} />
  </div>;
}
function RemoteAnswer({ question, computer, assignmentId, api, refreshed }: { question: RemoteQuestion; computer: string; assignmentId: string; api: AssignmentApi; refreshed: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const alive = useRef(true), inFlight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const complete = question.questions.length > 0 && question.questions.every(field => answers[field.id]?.trim() && (!field.options?.length || field.options.some(option => option.id === answers[field.id])));
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!complete || inFlight.current || sent || question.localOnly) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      await api(pathFor(assignmentId) + '/remote-answer', 'POST', { questionId: question.id, revision: question.revision, answers });
      if (alive.current) { setSent(true); refreshed(); }
    } catch (failure) { if (alive.current) { setError(failureText(failure)); if ((failure as { status?: number })?.status === 409) refreshed(); } }
    finally { if (alive.current) { inFlight.current = false; setBusy(false); } }
  }
  return <section className="assignment-remote-question" aria-label="Worker question"><strong>{question.title}</strong><p>{question.description}</p>
    {question.localOnly ? <p>Complete sign-in on {computer} in its worker window. Credentials stay on that computer.</p> : <form onSubmit={event => void submit(event)}>
      {question.questions.map(field => <label key={field.id}>{field.question}{field.options?.length ? <select required disabled={busy} value={answers[field.id] || ''} onChange={event => setAnswers(previous => ({ ...previous, [field.id]: event.target.value }))}><option value="">Choose an answer</option>{field.options.map(option => <option key={option.id} value={option.id}>{option.label}{option.description ? ` — ${option.description}` : ''}</option>)}</select> : <textarea required disabled={busy} rows={2} maxLength={8000} value={answers[field.id] || ''} onChange={event => setAnswers(previous => ({ ...previous, [field.id]: event.target.value }))} />}</label>)}
      {error && <p className="assignment-error" role="status">{error}</p>}<button type="submit" disabled={busy || sent || !complete}>{busy ? 'Sending…' : sent ? 'Answer sent' : 'Send answer'}</button>
    </form>}
  </section>;
}
