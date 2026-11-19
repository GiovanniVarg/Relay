import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ATTACHMENT_LIMITS, type AttachmentMime, type AttachmentParseResult, type AttachmentErrorCode } from '../shared/attachments.js';
export class AttachmentError extends Error { constructor(public code: AttachmentErrorCode, message: string) { super(message); this.name = 'AttachmentError'; } }
/** Compiled workers use 128 MiB; source workers allow 256 MiB for the TS loader. Neither is a total-native-memory or OS sandbox. */
export class AttachmentExtractor {
  private children = new Set<ChildProcess>();
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private timeoutMs: number = ATTACHMENT_LIMITS.timeoutMs) {}
  count(): number { return Math.max(this.pending.size, this.children.size); }
  parse(bytes: Buffer, mimeType: AttachmentMime): Promise<AttachmentParseResult> {
    if (this.closed) return Promise.reject(new AttachmentError('canceled', 'Attachment extraction is closed'));
    if (!bytes.length || bytes.length > ATTACHMENT_LIMITS.bytes) return Promise.reject(new AttachmentError('limit', 'Attachment must be between 1 byte and 4 MiB'));
    const promise = new Promise<AttachmentParseResult>((resolve, reject) => {
      const source = import.meta.url.endsWith('.ts');
      const child = fork(fileURLToPath(new URL(source ? './attachment-worker.ts' : './attachment-worker.js', import.meta.url)), [], { execArgv: [`--max-old-space-size=${source ? 256 : 128}`, ...(source ? ['--import', 'tsx'] : [])], serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } });
      this.children.add(child);
      let outcome: { error?: Error; value?: AttachmentParseResult } | undefined;
      let delivered = false;
      const deliver = () => { if (delivered || !outcome) return; delivered = true; this.children.delete(child); if (outcome.error) reject(outcome.error); else resolve(outcome.value!); };
      const finish = (error?: Error, value?: AttachmentParseResult) => { if (outcome) return; outcome = { error, value }; clearTimeout(timer); child.kill(); if (!child.pid || child.exitCode !== null || child.signalCode !== null) deliver(); };
      const timer = setTimeout(() => finish(new AttachmentError('timeout', 'Attachment parsing exceeded its time limit')), this.timeoutMs);
      child.once('error', () => finish(new AttachmentError('invalid', 'Attachment parser could not start')));
      child.once('exit', () => { if (!outcome) finish(new AttachmentError(this.closed ? 'canceled' : 'invalid', this.closed ? 'Attachment parsing canceled' : 'Attachment parser exited without a result')); deliver(); });
      child.once('message', (message: unknown) => {
        const result = message as { ok: boolean; result?: AttachmentParseResult; code?: AttachmentErrorCode; error?: string };
        if (result?.ok && result.result && typeof result.result.parser === 'string' && (result.result.text?.length ?? 0) <= ATTACHMENT_LIMITS.textCharacters) finish(undefined, result.result);
        else finish(new AttachmentError(result?.code ?? 'invalid', result?.error ?? 'Attachment parsing failed'));
      });
      child.send({ bytes, mimeType }, error => { if (error) finish(new AttachmentError('invalid', 'Attachment parser input failed')); });
    });
    this.pending.add(promise); void promise.finally(() => this.pending.delete(promise)).catch(() => {}); return promise;
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending]); }
  async close(): Promise<void> { this.closed = true; for (const child of this.children) child.kill(); await this.drain(); }
}
