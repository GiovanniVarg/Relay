import {validAccountDescriptor,defaultAccountId} from '../../shared/accounts.js';
import {validateManifest,IMAGE_CHUNK_BYTES} from './images.js';
import {parseCapabilityRequirements,parseRequiredInputModalities} from '../../shared/capabilities.js';
import { timingSafeEqual,createHash } from 'node:crypto';
import type { Binding, Frame, FrameType, WorkerJob,WorkerOutcome } from './types.js';
export const FRAME_LIMIT = 512 * 1024;
export const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const tokenKeys=['inputTokens','outputTokens','cachedInputTokens','cacheWriteTokens','totalTokens','reasoningTokens'];
function counters(value:unknown,nullable=false):boolean{return record(value)&&Object.entries(value).every(([key,count])=>tokenKeys.includes(key)&&(nullable&&count===null||Number.isSafeInteger(count)&&Number(count)>=0));}
function usageMetadata(result:Record<string,any>):boolean {
  const snapshot=result.sessionUsage;
  return (result.actualModel===undefined||text(result.actualModel,150))&&(result.sessionId===undefined||text(result.sessionId,500))
    &&(result.usage===undefined||counters(result.usage))&&(result.usageCounters===undefined||counters(result.usageCounters))
    &&(snapshot===undefined||record(snapshot)&&['openai','claude','cursor','opencode'].includes(snapshot.provider)&&(snapshot.accountKey===null||text(snapshot.accountKey,300))&&snapshot.scope==='agent'&&['cursor-sdk','provider-response'].includes(snapshot.source)&&['reported','unavailable'].includes(snapshot.availability)&&text(snapshot.observedAt,100)&&(snapshot.sessionId===undefined||text(snapshot.sessionId,500))&&counters(snapshot.tokens,true)&&['rawCostCents','chargedCents'].every(key=>snapshot[key]===null||typeof snapshot[key]==='number'&&Number.isFinite(snapshot[key])&&snapshot[key]>=0));
}
export function validateJob(v: unknown): asserts v is WorkerJob {
  if (!record(v) || Object.keys(v).some(k => !['delegationId','parentRunId','agentId','provider','request','account'].includes(k)) || !id(v.delegationId) || !id(v.parentRunId) || !id(v.agentId) || !['openai', 'claude', 'cursor'].includes(v.provider)) throw Error('Invalid worker job identity');
  const r = v.request;
  if (!record(r) || Object.keys(r).some(k => !['runId','conversationId','model','instructions','history','maxSeconds','mode','workspace','expectedAccount','expectedConnectionScope','requiredCapabilities','requiredInputModalities','accountId','accountProfileGeneration'].includes(k))
    || !id(r.runId) || !id(r.conversationId) || !text(r.model, 150) || !r.model || !text(r.instructions, 80_000)
    || !Number.isFinite(r.maxSeconds) || r.maxSeconds < 1 || r.maxSeconds > 3600
    || !Array.isArray(r.history) || !r.history.length || r.history.length > 1000
    || r.history.some((m: any) => !record(m) || Object.keys(m).some(k=>!['role','content','messageId','imageRefs'].includes(k)) || (m.messageId!==undefined&&!id(m.messageId)) || (m.imageRefs!==undefined&&(!Array.isArray(m.imageRefs)||m.imageRefs.length>4||m.imageRefs.some((ref:unknown)=>!id(ref))||new Set(m.imageRefs).size!==m.imageRefs.length||!id(m.messageId))) || !['user','assistant'].includes(m.role) || !text(m.content, 80_000))
    || !record(r.expectedAccount) || !text(r.expectedAccount.accountLabel, 180) || !r.expectedAccount.accountLabel || !text(r.expectedAccount.plan, 80)
    || ![undefined, 'chat', 'work', 'agent'].includes(r.mode) || (r.mode !== undefined && r.mode !== 'chat' && !text(r.workspace, 10_000)))
    throw Error('Invalid worker request');
  if(v.account!==undefined&&(!validAccountDescriptor(v.account,v.provider)||r.accountId!==v.account.accountId||r.accountProfileGeneration!==v.account.profileGeneration||!r.expectedConnectionScope))throw Error('Invalid worker account binding');
  if(r.accountId!==undefined&&(r.accountId!==defaultAccountId(v.provider)&&!v.account||typeof r.accountId!=='string'))throw Error('Worker account requires its host-owned profile descriptor');
  parseCapabilityRequirements(r.requiredCapabilities);parseRequiredInputModalities(r.requiredInputModalities);
  if(r.expectedConnectionScope!==undefined&&(!text(r.expectedConnectionScope,300)||!r.expectedConnectionScope))throw Error('Invalid worker connection scope');
  if (v.provider === 'cursor' && r.mode === 'agent') throw Error('Cursor Agent mode is unavailable');
  if (v.provider === 'cursor' && r.mode === 'work') throw Error('Cursor Herdr workers support Chat mode only; Work sandbox support is unavailable');
  if (JSON.stringify(r).length > 100_000) throw Error('Worker request exceeds the context limit');
}
function payloadValid(type: FrameType, p: any): boolean {
  if (!record(p)) return false;
  switch (type) {
    case 'resultChunk':return Object.keys(p).every(k=>['index','text'].includes(k))&&Number.isSafeInteger(p.index)&&p.index>=0&&p.index<4&&text(p.text,65536)&&p.text.length>0;
    case 'inference': return p.phase==='started'?Object.keys(p).length===1:p.phase==='completed'&&Object.keys(p).every(k=>['phase','result'].includes(k))&&record(p.result)&&p.result.text===''&&Object.keys(p.result).every(k=>['text','usage','usageCounters','sessionUsage','actualModel','sessionId'].includes(k))&&usageMetadata(p.result)&&JSON.stringify(p.result).length<16000;
    case 'imageInit': try { if(Object.keys(p).length!==1)return false;validateManifest(p.images);return true;} catch{return false;}
    case 'imageChunk': return Object.keys(p).length===3&&Object.keys(p).every(k=>['imageIndex','chunkIndex','data'].includes(k))&&Number.isSafeInteger(p.imageIndex)&&p.imageIndex>=0&&p.imageIndex<4&&Number.isSafeInteger(p.chunkIndex)&&p.chunkIndex>=0&&p.chunkIndex<22&&typeof p.data==='string'&&p.data.length>0&&p.data.length<=4*Math.ceil(IMAGE_CHUNK_BYTES/3)&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.data);
    case 'imagesReady': return Object.keys(p).length===1&&typeof p.manifestSha256==='string'&&/^[a-f0-9]{64}$/.test(p.manifestSha256);
    case 'ready': return Number.isSafeInteger(p.pid) && p.pid > 0 && typeof p.conpty === 'boolean';
    case 'child': return Number.isSafeInteger(p.pid) && p.pid > 0 && typeof p.exited === 'boolean';
    case 'start': case 'cancel': return Object.keys(p).length === 0;
    case 'event': return p.type === 'delta' ? text(p.text, 128_000) : p.type === 'status' ? text(p.message, 1000) : p.type === 'tool' && text(p.name, 150) && text(p.summary, 1000);
    case 'interaction': return id(p.id) && record(p.prompt) && ['approval','question'].includes(p.prompt.kind) && text(p.prompt.title, 500) && text(p.prompt.description, 20_000) && (p.prompt.details === undefined || text(p.prompt.details, 64_000)) && (p.prompt.questions === undefined || (Array.isArray(p.prompt.questions) && p.prompt.questions.length <= 16 && p.prompt.questions.every((q: any) => record(q) && text(q.id, 500) && q.id.length > 0 && text(q.question, 20_000) && (q.multiple === undefined || typeof q.multiple === 'boolean') && (q.options === undefined || (Array.isArray(q.options) && q.options.length <= 100 && q.options.every((o: any) => text(o, 20_000)))))));
    case 'interactionExpired': return id(p.id);
    case 'answer': return id(p.id) && record(p.answer) && ['allow','deny'].includes(p.answer.decision) && (p.answer.answers === undefined || (record(p.answer.answers) && Object.values(p.answer.answers).every(v => Array.isArray(v) && v.every(t => text(t, 20_000)))));
    case 'result': return record(p.result) && text(p.result.text, 256_000) && (p.textManifest===undefined?p.result.text.length>0:p.result.text===''&&record(p.textManifest)&&Object.keys(p.textManifest).every(k=>['characters','chunks','sha256'].includes(k))&&Number.isSafeInteger(p.textManifest.characters)&&p.textManifest.characters>0&&p.textManifest.characters<=256000&&Number.isSafeInteger(p.textManifest.chunks)&&p.textManifest.chunks>0&&p.textManifest.chunks<=4&&typeof p.textManifest.sha256==='string'&&/^[a-f0-9]{64}$/.test(p.textManifest.sha256)) && (p.result.actualModel === undefined || text(p.result.actualModel, 150)) && (p.result.sessionId === undefined || text(p.result.sessionId, 500)) && (p.result.usage === undefined || (record(p.result.usage) && ['inputTokens','outputTokens'].every(k => Number.isSafeInteger(p.result.usage[k]) && p.result.usage[k] >= 0) && (p.result.usage.cachedInputTokens === undefined || (Number.isSafeInteger(p.result.usage.cachedInputTokens) && p.result.usage.cachedInputTokens >= 0)))) && typeof p.executionVerified === 'boolean' && Array.isArray(p.evidence) && p.evidence.length <= 100 && p.evidence.every((e: any) => text(e, 1000));
    case 'failed': return text(p.error, 600) && typeof p.cleanup === 'boolean';
    case 'stopped': return typeof p.cleanup === 'boolean';
  }
}
export function validateFrame(value: unknown, binding: Binding, lastSeq: number, allowed: readonly FrameType[], now = Date.now()): Frame {
  if (!record(value) || Object.keys(value).some(k => !['v','delegationId','parentRunId','epoch','token','seq','type','payload'].includes(k))
    || value.v !== 1 || value.delegationId !== binding.delegationId || value.parentRunId !== binding.parentRunId || value.epoch !== binding.epoch
    || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token) || !/^[a-f0-9]{64}$/.test(binding.token)
    || !timingSafeEqual(Buffer.from(value.token), Buffer.from(binding.token)) || now > binding.expiresAt
    || value.seq !== lastSeq + 1 || !allowed.includes(value.type) || !payloadValid(value.type, value.payload)) throw Error('Invalid, foreign, expired, or duplicate bridge frame');
  return value as Frame;
}
export function frame(binding: Binding, seq: number, type: FrameType, payload: unknown): Frame {
  return { v: 1, delegationId: binding.delegationId, parentRunId: binding.parentRunId, epoch: binding.epoch, token: binding.token, seq, type, payload };
}
export class FrameReader {
  private buffer = Buffer.alloc(0);
  constructor(private accept: (value: unknown) => void) {}
  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let n: number;
    while ((n = this.buffer.indexOf(10)) >= 0) {
      if (n > FRAME_LIMIT) throw Error('Bridge frame exceeds the size limit');
      const line = this.buffer.subarray(0, n); this.buffer = this.buffer.subarray(n + 1);
      if (!line.length) throw Error('Empty bridge frame');
      try { this.accept(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))); } catch (e) { throw e instanceof SyntaxError ? Error('Malformed bridge JSON') : e; }
    }
    if (this.buffer.length > FRAME_LIMIT) throw Error('Bridge frame exceeds the size limit');
  }
}
export function encode(value: Frame): string { const out = JSON.stringify(value); if (Buffer.byteLength(out) > FRAME_LIMIT) throw Error('Bridge frame exceeds the size limit'); return out + '\n'; }
/** Preflight every exact-byte frame before writing any result. Aggregate text remains bounded. */
export function resultFrames(binding:Binding,sequence:number,outcome:WorkerOutcome):Frame[]{
 const text=outcome.result.text;
 if(typeof text!=='string'||!text.length||text.length>256000)throw Error('Worker result text exceeds the structured result limit');
 const terminal=frame(binding,sequence+1,'result',outcome);
 if(Buffer.byteLength(JSON.stringify(terminal))<=FRAME_LIMIT){encode(terminal);return [terminal];}
 const chunks:Frame[]=[];for(let start=0;start<text.length;start+=65536)chunks.push(frame(binding,sequence+chunks.length+1,'resultChunk',{index:chunks.length,text:text.slice(start,start+65536)}));
 chunks.push(frame(binding,sequence+chunks.length+1,'result',{...outcome,result:{...outcome.result,text:''},textManifest:{characters:text.length,chunks:chunks.length,sha256:createHash('sha256').update(text).digest('hex')}}));
 for(const item of chunks)encode(item);
 return chunks;
}
export function unknownOutcome(message: string): Error & { code: string } { return Object.assign(Error(message), { code: 'HERDR_OUTCOME_UNKNOWN' }); }
