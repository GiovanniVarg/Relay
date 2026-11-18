import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { CircleHelp, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { InteractionAnswer, RunInteraction } from '../shared/types';
import { providerName } from './Models';
import {TypeSafeConnection,type TypeSafeApi} from './TypeSafeConnection';
import {IntegrationCredentialEntry} from './IntegrationCredentialEntry';
import {INTEGRATION_CREDENTIAL_PREFIX} from '../shared/integration-credentials';
import {TYPESAFE_CREDENTIAL_PREFIX} from '../shared/typesafe';
export const isSecureCredentialInteraction=(entry:RunInteraction)=>isTypeSafeCredentialInteraction(entry)||entry.questions?.some(q=>q.id.startsWith(INTEGRATION_CREDENTIAL_PREFIX))===true;
export const isTypeSafeCredentialInteraction=(entry:RunInteraction)=>entry.kind==='question'&&entry.questions?.some(question=>question.id.startsWith(TYPESAFE_CREDENTIAL_PREFIX))===true;

type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Answers = Record<string, string[]>;
const interactionKey = (interaction: Pick<RunInteraction, 'runId' | 'id'>) => `${interaction.runId}:${interaction.id}`;
const questionAnswers = (answers: Answers, id: string): string[] => Object.hasOwn(answers, id) && Array.isArray(answers[id]) ? answers[id] : [];

export function useRunInteractions(api: Api) {
  const [entries, setEntries] = useState<Record<string, RunInteraction>>({});
  const [answers, setAnswers] = useState<Record<string, Answers>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const resolved = useRef(new Set<string>());
  const finishedRuns = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const revisions = useRef(new Map<string, number>());

  function receive(interaction: RunInteraction) {
    const key = interactionKey(interaction);
    revisions.current.set(interaction.runId, (revisions.current.get(interaction.runId) || 0) + 1);
    if (interaction.status !== 'pending') { resolve(interaction.runId, interaction.id); return; }
    if (finishedRuns.current.has(interaction.runId) || resolved.current.has(key)) return;
    setEntries(previous => ({ ...previous, [key]: interaction }));
  }
  function resolve(runId: string, id: string) {
    const key = interactionKey({ runId, id });
    revisions.current.set(runId, (revisions.current.get(runId) || 0) + 1);
    resolved.current.add(key);
    setEntries(previous => { const next = { ...previous }; delete next[key]; return next; });
  }
  function finish(runId: string) {
    finishedRuns.current.add(runId);
    setEntries(previous => Object.fromEntries(Object.entries(previous).filter(([, entry]) => entry.runId !== runId)));
    setAnswers(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(runId + ':'))));
    setErrors(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(runId + ':'))));
    setSubmitting(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(runId + ':'))));
  }
  async function reconcile(runId: string, retry = true): Promise<void> {
    const revision = revisions.current.get(runId) || 0;
    const result = await api<{ interactions: RunInteraction[] }>(`/runs/${encodeURIComponent(runId)}/interactions`);
    // A newer SSE event wins over a snapshot that was already in flight.
    if (revision !== (revisions.current.get(runId) || 0)) {
      if (retry) await reconcile(runId, false);
      return;
    }
    const pending = result.interactions.filter(entry => entry.runId === runId && entry.status === 'pending');
    const keys = new Set(pending.map(interactionKey));
    setEntries(previous => {
      const next = { ...previous };
      for (const [key, entry] of Object.entries(next)) if (entry.runId === runId && !keys.has(key)) { resolved.current.add(key); delete next[key]; }
      for (const entry of pending) if (!finishedRuns.current.has(runId) && !resolved.current.has(interactionKey(entry))) next[interactionKey(entry)] = entry;
      return next;
    });
  }
  function updateAnswers(interaction: RunInteraction, questionId: string, value: string[]) {
    if(isSecureCredentialInteraction(interaction))return;
    const key = interactionKey(interaction);
    setAnswers(previous => ({ ...previous, [key]: { ...previous[key], [questionId]: value } }));
  }
  async function respond(interaction: RunInteraction, decision: InteractionAnswer['decision']) {
    if(isSecureCredentialInteraction(interaction))return;
    const key = interactionKey(interaction);
    if (inFlight.current.has(key) || resolved.current.has(key) || finishedRuns.current.has(interaction.runId)) return;
    inFlight.current.add(key);
    setSubmitting(previous => ({ ...previous, [key]: true }));
    setErrors(previous => ({ ...previous, [key]: '' }));
    try {
      const answer: InteractionAnswer = { decision, ...(decision === 'allow' && interaction.kind === 'question' ? { answers: answers[key] || {} } : {}) };
      const result = await api<{ interaction: RunInteraction }>(`/runs/${encodeURIComponent(interaction.runId)}/interactions/${encodeURIComponent(interaction.id)}`, 'POST', answer);
      if (result.interaction.status === 'pending') throw new Error('The response has not been accepted yet. Try again.');
      resolve(interaction.runId, interaction.id);
    } catch (failure) {
      const error = failure as Error & { status?: number };
      if (error.status === 409) {
        try {
          await reconcile(interaction.runId);
          setErrors(previous => ({ ...previous, [key]: 'This request changed. Review the current request and try again.' }));
        } catch (refreshFailure) {
          setErrors(previous => ({ ...previous, [key]: `Could not refresh this request. ${(refreshFailure as Error).message}` }));
        }
      } else setErrors(previous => ({ ...previous, [key]: error.message }));
    } finally {
      inFlight.current.delete(key);
      setSubmitting(previous => ({ ...previous, [key]: false }));
    }
  }
  async function cancelSecure(interaction:RunInteraction){await api('/runs/'+encodeURIComponent(interaction.runId)+'/cancel','POST',{});resolve(interaction.runId,interaction.id);}
  const secure:{secureApi?:TypeSafeApi;cancelSecure?:(entry:RunInteraction)=>Promise<void>}={secureApi:api as TypeSafeApi,cancelSecure};
  return { entries, answers, errors, submitting, receive, resolve, finish, reconcile, updateAnswers, respond,...secure };
}

export function RunInteractions({ runId, state, returnFocus,resetKey,autoFocus=true }: { runId: string; state: ReturnType<typeof useRunInteractions>; returnFocus: () => void;resetKey?:string;autoFocus?:boolean }) {
  const pending = Object.values(state.entries).filter(entry => entry.runId === runId && entry.status === 'pending');
  return <>{pending.map(interaction => {
    const key = interactionKey(interaction);
    if(interaction.questions?.some(question=>question.id.startsWith(INTEGRATION_CREDENTIAL_PREFIX))){const api=state.secureApi,cancel=state.cancelSecure;return api&&cancel?<IntegrationCredentialEntry key={key} autoFocus={autoFocus} api={api} runId={interaction.runId} interactionId={interaction.id} onConnected={()=>state.resolve(interaction.runId,interaction.id)} onCancel={()=>cancel(interaction)}/>:<section key={key} className="interaction-card"><p>Secure credential entry is unavailable. Reopen this conversation after Relay reconnects.</p></section>;}
    if(isTypeSafeCredentialInteraction(interaction)){const api=state.secureApi,cancel=state.cancelSecure;return api&&cancel?<TypeSafeConnection key={key} autoFocus={autoFocus} api={api} resetKey={resetKey} request={{runId:interaction.runId,interactionId:interaction.id}} onConnected={()=>state.resolve(interaction.runId,interaction.id)} onCancel={()=>cancel(interaction)}/>:<section key={key} className="interaction-card"><p>Secure credential entry is unavailable. Reopen this conversation after Relay reconnects.</p></section>;}
    return <InteractionCard key={key} interaction={interaction} concurrent={pending.length > 1} answers={state.answers[key] || {}} busy={!!state.submitting[key]} error={state.errors[key] || ''} update={(questionId, value) => state.updateAnswers(interaction, questionId, value)} respond={decision => state.respond(interaction, decision)} returnFocus={returnFocus}/>;
  })}</>;
}

function InteractionCard({ interaction, concurrent, answers, busy, error, update, respond, returnFocus }: { interaction: RunInteraction; concurrent: boolean; answers: Answers; busy: boolean; error: string; update: (questionId: string, answers: string[]) => void; respond: (decision: InteractionAnswer['decision']) => Promise<void>; returnFocus: () => void }) {
  const id = useId();
  const cardRef = useRef<HTMLElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const focusRef = useRef(returnFocus);
  focusRef.current = returnFocus;
  useEffect(() => { if (error) errorRef.current?.focus({ preventScroll: true }); }, [error]);
  useLayoutEffect(() => {
    const card = cardRef.current;
    return () => { if (card?.contains(document.activeElement)) focusRef.current(); };
  }, []);
  const questions = interaction.questions || [];
  const complete = interaction.kind !== 'question' || questions.length > 0 && questions.every(question => questionAnswers(answers, question.id).some(answer => answer.trim().length > 0));
  return <section ref={cardRef} className="interaction-card" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} aria-busy={busy}>
    <div className="interaction-provider">{interaction.kind === 'approval' ? <ShieldCheck size={14}/> : <CircleHelp size={14}/>}<span>{providerName(interaction.provider)} · {interaction.kind === 'approval' ? 'Permission request' : 'Question'}</span></div>
    <h3 id={`${id}-title`}>{interaction.title}</h3>
    <p id={`${id}-description`}>{interaction.description}</p>
    <span className="sr-only" role="status">{providerName(interaction.provider)} needs your {interaction.kind === 'approval' ? 'permission' : 'answer'}: {interaction.title}</span>
    {interaction.details && (interaction.humanRequired ? <pre className="interaction-details">{interaction.details}</pre> : <details className="interaction-details"><summary>Request details</summary><pre>{interaction.details}</pre></details>)}
    <p className="subtle-text">{interaction.kind === 'approval' ? 'Type approve or no in the chat below.' : questions.length > 1 ? 'Reply below with one line per question: question ID: answer. Separate multiple choices with |.' : questions[0]?.multiple ? 'Reply in chat. Separate multiple choices with |.' : 'Reply in the chat below to continue.'} Type stop to end the task.</p>
    <div className="interaction-chat-questions">{questions.map(question => <p key={question.id}><strong>{questions.length > 1 ? question.id + ': ' : ''}{question.question}</strong>{question.options?.length ? <span> · {question.options.join(' / ')}</span> : null}</p>)}</div>
    {(concurrent || interaction.workerName) && <p className="subtle-text">{concurrent ? 'Several requests are waiting. ' : 'If several requests arrive, '}Begin your reply with <code>{interaction.id}: your answer</code>{interaction.workerName && <> or use {interaction.workerName}: your answer</>}.</p>}
    <details><summary>Answer with a form</summary>
    <form onSubmit={event => { event.preventDefault(); if (complete && !busy) void respond('allow'); }}>
      {interaction.kind === 'question' && <fieldset className="interaction-questions" disabled={busy}><legend className="sr-only">Your answers</legend>{questions.map((question, index) => <QuestionField key={question.id} question={question} id={`${id}-${index}`} answers={questionAnswers(answers, question.id)} update={value => update(question.id, value)}/>)}</fieldset>}
      {error && <p ref={errorRef} className="form-error" tabIndex={-1} role="alert">{error}</p>}
      <div className="interaction-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void respond('deny')}>Deny</button><button type="submit" className="primary" disabled={busy || !complete}>{busy && <LoaderCircle className="spin" size={14}/>} {busy ? 'Sending…' : interaction.kind === 'approval' ? 'Allow once' : 'Submit answer'}</button></div>
    </form></details>
  </section>;
}

function QuestionField({ question, id, answers, update }: { question: NonNullable<RunInteraction['questions']>[number]; id: string; answers: string[]; update: (answers: string[]) => void }) {
  const options = question.options || [];
  const custom = answers.find(answer => !options.includes(answer)) || '';
  const [customDraft, setCustomDraft] = useState(custom);
  const [selectedOptions, setSelectedOptions] = useState(() => answers.filter(answer => options.includes(answer)));
  const [customOpen, setCustomOpen] = useState(!!custom);
  return <fieldset className="interaction-question"><legend>{question.question}</legend>{options.length ? <>
    <div className="interaction-options">{options.map((option, optionIndex) => <label key={optionIndex}><input type={question.multiple ? 'checkbox' : 'radio'} name={id} checked={selectedOptions.includes(option)} onChange={event => { const selected = question.multiple ? event.target.checked ? [...selectedOptions, option] : selectedOptions.filter(answer => answer !== option) : [option]; setSelectedOptions(selected); if (!question.multiple) setCustomDraft(''); update([...new Set([...selected, ...(question.multiple && customDraft ? [customDraft] : [])])]); }}/><span>{option}</span></label>)}</div>
    <details className="interaction-other" open={customOpen} onToggle={event => setCustomOpen(event.currentTarget.open)}><summary>Write another answer</summary><input aria-label={`Another answer: ${question.question}`} maxLength={4000} value={customDraft} onChange={event => { const value = event.target.value; setCustomDraft(value); if (!question.multiple) setSelectedOptions([]); update([...new Set([...(question.multiple ? selectedOptions : []), ...(value ? [value] : [])])]); }}/></details>
  </> : <textarea aria-label={question.question} rows={2} maxLength={4000} value={answers[0] || ''} onChange={event => update([event.target.value])}/>}</fieldset>;
}
