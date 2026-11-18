import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ATTACHMENT_LIMITS as L, type AttachmentScope, type ConversationAttachmentScope, type DispatcherAttachmentScope, type AttachmentUpload, type AttachmentMime, type MessageAttachment, type OwnedAttachment } from '../shared/attachments.js';
import type { Agent, Conversation, GroupMessage, GroupRoom, Message } from '../shared/types.js';
import { Store } from './store.js';
import { AttachmentError, AttachmentExtractor } from './attachment-extraction.js';
export { AttachmentError } from './attachment-extraction.js';
const readers=new WeakMap<Store,Attachments>();
export function attachmentReader(store:Store):Attachments{return readers.get(store)??new Attachments(store);}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME_EXT: Record<AttachmentMime, string[]> = { 'text/plain': ['txt'], 'application/pdf': ['pdf'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'] };
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export function attachmentManifest(value: OwnedAttachment): MessageAttachment { const {id,name,mimeType,size,sha256,kind,width,height,extraction}=value;return{id,name,mimeType,size,sha256,kind,...(width===undefined?{}:{width}),...(height===undefined?{}:{height}),...(extraction===undefined?{}:{extraction})}; }
export function decodeAttachmentBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(L.bytes / 3) * 4 || !value.length || value.length % 4 || /[^A-Za-z0-9+/=]/.test(value)) throw new AttachmentError('invalid', 'Attachment requires canonical base64 within 4 MiB');
  const bytes = Buffer.from(value, 'base64'); if (!bytes.length || bytes.length > L.bytes || bytes.toString('base64') !== value) throw new AttachmentError('invalid', 'Attachment base64 is invalid or too large'); return bytes;
}
/** Standalone service. Caller must claim inside the same Store transaction that creates the user message. */
export class Attachments {
  readonly root: string;
  private extractor: AttachmentExtractor;
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(readonly store: Store, private options: { assertWritable?: () => void; extractor?: AttachmentExtractor } = {}) { this.root = join(resolve(store.dataDir), 'attachments'); this.extractor = options.extractor ?? new AttachmentExtractor();readers.set(store,this); }
  count(): number { return Math.max(this.pending.size, this.extractor.count()); }
  private writable(): void { if (this.closed) throw new AttachmentError('canceled', 'Attachment service is closed'); this.options.assertWritable?.(); }
  private operation<T>(fn: () => Promise<T>): Promise<T> { this.writable(); if (this.pending.size >= 2) throw new AttachmentError('limit', 'Two attachment uploads are already being processed'); const pending = fn(); this.pending.add(pending); void pending.finally(() => this.pending.delete(pending)).catch(() => {}); return pending; }
  private scope(scope: AttachmentScope): void {
    const surface=scope?.surface??'conversation';
    if(surface==='group') {if(typeof scope.roomId!=='string'||!scope.roomId||scope.agentId!==undefined||scope.conversationId!==undefined||scope.draftId!==undefined||!this.store.get<GroupRoom>('group-room',scope.roomId))throw new AttachmentError('scope','Attachment group room does not exist or has mixed ownership');return;}
    if(surface==='dispatcher') {if(typeof scope.draftId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(scope.draftId)||scope.agentId!==undefined||scope.conversationId!==undefined||scope.roomId!==undefined)throw new AttachmentError('scope','Attachment dispatcher draft ID or ownership is invalid');return;}
    if(surface!=='conversation'||scope.roomId!==undefined||scope.draftId!==undefined||typeof scope.agentId!=='string'||typeof scope.conversationId!=='string')throw new AttachmentError('scope','Attachment scope has invalid or mixed ownership');
    const conversation=this.store.get<Conversation>('conversation',scope.conversationId);if(!this.store.get<Agent>('agent',scope.agentId)||!conversation||conversation.agentId!==scope.agentId)throw new AttachmentError('scope','Attachment conversation does not belong to this bot');
  }
  private owner(scope:AttachmentScope):AttachmentScope {if(scope.surface==='group')return{surface:'group',roomId:scope.roomId};if(scope.surface==='dispatcher')return{surface:'dispatcher',draftId:scope.draftId};return{agentId:scope.agentId!,conversationId:scope.conversationId!};}
  private sameOwner(a:AttachmentScope,b:AttachmentScope):boolean {return JSON.stringify(this.owner(a))===JSON.stringify(this.owner(b));}
  private target(scope:AttachmentScope,messageId:string):void {this.scope(scope);if(scope.surface==='dispatcher')throw new AttachmentError('scope','Dispatcher attachments require transfer into a direct user message');if(scope.surface==='group'){const message=this.store.get<GroupMessage>('group-message',messageId);if(!message||message.role!=='user'||message.roomId!==scope.roomId)throw new AttachmentError('scope','Attachment target user message is not in this group');}else{const message=this.store.get<Message>('message',messageId);if(!message||message.role!=='user'||message.conversationId!==scope.conversationId)throw new AttachmentError('scope','Attachment target message is not in this conversation');}}
  private record(scope:AttachmentScope,key:string):OwnedAttachment {this.scope(scope);if(typeof key!=='string'||!uuid.test(key))throw new AttachmentError('invalid','Invalid attachment ID');const record=this.store.get<OwnedAttachment>('attachment',key);if(!record||!this.sameOwner(record,scope))throw new AttachmentError('scope','Attachment not found in this scope');this.scope(record);if(record.messageId!==null){try{this.target(scope,record.messageId);}catch(error){if(error instanceof AttachmentError)throw new AttachmentError('scope','Attachment owning message no longer exists');throw error;}}return record;}
  listDrafts(scope:AttachmentScope):MessageAttachment[] {this.scope(scope);return this.store.list<OwnedAttachment>('attachment').filter(record=>record.messageId===null&&this.sameOwner(record,scope)).map(attachmentManifest);}
  private directory(create = false): void {
    const data = resolve(this.store.dataDir); if (!samePath(realpathSync(data), data) || lstatSync(data).isSymbolicLink()) throw new AttachmentError('integrity', 'Attachment data directory is redirected');
    if (create) { try { mkdirSync(this.root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    const info = lstatSync(this.root); if (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync(this.root), this.root)) throw new AttachmentError('integrity', 'Attachment directory is redirected');
  }
  private file(key: string, suffix: 'bin' | 'txt'): string { if (!uuid.test(key)) throw new AttachmentError('integrity', 'Invalid stored attachment ID'); return join(this.root, key + '.' + suffix); }
  private bytes(record: OwnedAttachment, suffix: 'bin' | 'txt'): Buffer {
    try {
      this.directory(); const path = this.file(record.id, suffix); const before = lstatSync(path); const limit = suffix === 'bin' ? L.bytes : L.textCharacters * 4;
      if (!before.isFile() || before.isSymbolicLink() || before.size > limit || !samePath(realpathSync(path), path)) throw new Error();
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let bytes: Buffer;
      try { const held = fstatSync(fd); if (!held.isFile() || held.ino !== before.ino || held.dev !== before.dev || held.size !== before.size) throw new Error(); bytes = readFileSync(fd); const after = lstatSync(path); if (after.isSymbolicLink() || after.ino !== held.ino || after.dev !== held.dev || after.size !== held.size) throw new Error(); }
      finally { closeSync(fd); }
      this.directory(); if (bytes.length > limit || bytes.length !== (suffix === 'bin' ? record.size : Buffer.byteLength(new TextDecoder('utf8', { fatal: true }).decode(bytes))) || hash(bytes) !== (suffix === 'bin' ? record.sha256 : record.extraction?.sha256)) throw new Error();
      if (suffix === 'txt' && (record.extraction?.sourceSha256 !== record.sha256 || new TextDecoder('utf8', { fatal: true }).decode(bytes).length !== record.extraction.characters)) throw new Error();
      return bytes;
    } catch { throw new AttachmentError('integrity', 'Attachment file is missing, redirected or changed'); }
  }
  private publish(key: string, suffix: 'bin' | 'txt', bytes: Buffer): void { this.directory(true); const path = this.file(key, suffix); const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); try { writeFileSync(fd, bytes); fsyncSync(fd); const held = fstatSync(fd), after = lstatSync(path); if (!held.isFile() || after.isSymbolicLink() || held.ino !== after.ino || held.dev !== after.dev || held.size !== bytes.length) throw new AttachmentError('integrity', 'Attachment file changed during publication'); } finally { closeSync(fd); } this.directory(); }
  createDraft(input: AttachmentUpload): Promise<MessageAttachment> {
    return this.operation(async () => {
      this.scope(input); const ownerKeys=input.surface==='group'?['surface','roomId']:input.surface==='dispatcher'?['surface','draftId']:['surface','agentId','conversationId'];if (Object.keys(input).some(key => ![...ownerKeys,'name','mimeType','base64'].includes(key))) throw new AttachmentError('invalid', 'Attachment upload accepts bytes and metadata only');
      if (typeof input.name !== 'string' || Buffer.from(input.name).toString('utf8') !== input.name || !input.name.trim() || input.name.length > 160 || input.name !== basename(input.name) || /[\\/\x00-\x1f\x7f"<>:|?*]/.test(input.name) || input.name.endsWith('.') || input.name.endsWith(' ')) throw new AttachmentError('invalid', 'Attachment name must be a plain filename');
      const extensions = typeof input.mimeType === 'string' && Object.hasOwn(MIME_EXT, input.mimeType) ? MIME_EXT[input.mimeType] : undefined; if (!extensions || !extensions.includes(input.name.split('.').at(-1)?.toLowerCase() ?? '')) throw new AttachmentError('unsupported', 'Attachment MIME and filename must match PNG, JPEG, WebP, TXT, PDF or DOCX');
      const bytes = decodeAttachmentBase64(input.base64); const parsed = await this.extractor.parse(bytes, input.mimeType);
      // Authority and ownership can change while the isolated parser is running.
      this.writable(); this.scope(input); const key = randomUUID(); const record: OwnedAttachment = { id: key, ...this.owner(input), messageId: null, name: input.name, mimeType: input.mimeType, size: bytes.length, sha256: hash(bytes), kind: input.mimeType.startsWith('image/') ? 'image' : 'document', createdAt: new Date().toISOString(), ...(parsed.width ? { width: parsed.width, height: parsed.height } : {}), ...(parsed.text !== undefined ? { extraction: { parser: parsed.parser, version: parsed.version, characters: parsed.text.length, sha256: hash(parsed.text), sourceSha256: hash(bytes), truncated: parsed.truncated, ...(parsed.pages ? { pages: parsed.pages } : {}), warnings: parsed.warnings } } : {}) };
      const published: ('bin' | 'txt')[] = [];
      try { this.publish(key, 'bin', bytes); published.push('bin'); if (parsed.text !== undefined) { this.publish(key, 'txt', Buffer.from(parsed.text)); published.push('txt'); } this.writable(); this.scope(input); this.store.put('attachment', record); }
      catch (error) { for (const suffix of published) { try { this.directory(); unlinkSync(this.file(key, suffix)); } catch {} } throw error; }
      return attachmentManifest(record);
    });
  }
  /** Synchronous preflight; byte/digest verification is repeated by claim, and by every later read. */
  validateDrafts(scope: AttachmentScope, keys: readonly string[]): MessageAttachment[] {
    if (!Array.isArray(keys) || keys.length > 8 || new Set(keys).size !== keys.length) throw new AttachmentError('limit', 'Use up to eight distinct attachments');
    const manifests = keys.map(key => { const record = this.record(scope, key); if (record.messageId !== null) throw new AttachmentError('conflict', 'Attachment is already claimed by a message'); this.bytes(record, 'bin'); if (record.extraction) this.bytes(record, 'txt'); return attachmentManifest(record); });
    if (manifests.filter(item => item.kind === 'image').length > L.images) throw new AttachmentError('limit', 'Use up to four images per message'); return manifests;
  }
  claimDrafts(scope: AttachmentScope, keys: readonly string[], messageId: string): MessageAttachment[] {
    this.writable(); if (!this.store.inTransaction) throw new AttachmentError('conflict', 'Attachment claim requires the message transaction');
    this.target(scope,messageId);
    const manifests = this.validateDrafts(scope, keys); for (const key of keys) this.store.put('attachment', { ...this.record(scope, key), messageId }); return manifests;
  }
  /** Same IDs and verified files move only with accepted Boss submission/message transaction. */
  transferDrafts(from:DispatcherAttachmentScope,keys:readonly string[],to:ConversationAttachmentScope,messageId:string):MessageAttachment[] {
    this.writable();if(!this.store.inTransaction)throw new AttachmentError('conflict','Attachment transfer requires the message transaction');
    if(from.surface!=='dispatcher'||to.surface&&to.surface!=='conversation')throw new AttachmentError('scope','Only dispatcher drafts transfer into a direct conversation');
    this.scope(from);this.target(to,messageId);const manifests=this.validateDrafts(from,keys),records=keys.map(key=>this.record(from,key));
    for(const record of records){const manifest=attachmentManifest(record);this.store.put('attachment',{...manifest,...this.owner(to),createdAt:record.createdAt,messageId});}return manifests;
  }
  /** Host-only owned-byte copy; the destination must already be a user message in this transaction. */
  copyOwned(from:AttachmentScope,keys:readonly string[],sourceMessageId:string|undefined,to:ConversationAttachmentScope,messageId:string):MessageAttachment[]{
    this.writable();if(!this.store.inTransaction)throw new AttachmentError('conflict','Attachment copies require a message transaction');
    if(keys.length>8||new Set(keys).size!==keys.length)throw new AttachmentError('limit','Use up to eight distinct attachments');this.target(to,messageId);
    const records=keys.map(key=>{const record=this.record(from,key);if(record.messageId!==(sourceMessageId??null))throw new AttachmentError('scope','Source message ownership changed');return record;});
    if(records.filter(r=>r.kind==='image').length>L.images)throw new AttachmentError('limit','Use up to four images');
    const written:string[]=[];try{return records.map(record=>{const binary=this.bytes(record,'bin'),text=record.extraction?this.bytes(record,'txt'):undefined,key=randomUUID();this.publish(key,'bin',binary);written.push(key);if(text)this.publish(key,'txt',text);const copied:OwnedAttachment={...attachmentManifest(record),agentId:to.agentId,conversationId:to.conversationId,id:key,messageId,createdAt:new Date().toISOString()};this.store.put('attachment',copied);return attachmentManifest(copied);});}catch(error){for(const key of written){this.store.remove('attachment',key);for(const suffix of ['bin','txt'] as const){try{const file=this.file(key,suffix);const info=lstatSync(file);if(info.isFile()&&!info.isSymbolicLink())unlinkSync(file);}catch{}}}throw error;}
  }
  read(scope: AttachmentScope, key: string, messageId?: string): { attachment: MessageAttachment; bytes: Buffer } { const record = this.record(scope, key); if ((messageId ?? null) !== record.messageId) throw new AttachmentError('scope', 'Attachment message ownership does not match'); return { attachment: attachmentManifest(record), bytes: this.bytes(record, 'bin') }; }
  readText(scope: AttachmentScope, key: string, messageId: string | undefined, offset = 0, limit: number = L.textChunk): { attachment: MessageAttachment; text: string; offset: number; end: number; total: number; truncated: boolean } {
    const record = this.record(scope, key); if ((messageId ?? null) !== record.messageId || !record.extraction) throw new AttachmentError('scope', 'Extracted document is not owned by this message');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > L.textChunk) throw new AttachmentError('limit', 'Invalid extracted text chunk bounds');
    this.bytes(record, 'bin'); const text = new TextDecoder('utf8', { fatal: true }).decode(this.bytes(record, 'txt')); const end = Math.min(text.length, offset + limit);
    return { attachment: attachmentManifest(record), text: text.slice(offset, end), offset, end, total: text.length, truncated: record.extraction.truncated };
  }
  descriptor(scope: AttachmentScope, key: string, messageId?: string): { attachment: MessageAttachment; disposition: 'inline' | 'attachment'; contentType: AttachmentMime; headers: Record<string, string> } {
    const { attachment } = this.read(scope, key, messageId); const disposition = attachment.kind === 'image' ? 'inline' : 'attachment';
    return { attachment, disposition, contentType: attachment.mimeType, headers: { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store', 'Content-Disposition': disposition + `; filename*=UTF-8''` + encodeURIComponent(attachment.name) } };
  }
  deleteDraft(scope: AttachmentScope, key: string): void { this.writable(); const record = this.record(scope, key); if (record.messageId !== null) throw new AttachmentError('conflict', 'Committed attachments are immutable'); this.bytes(record, 'bin'); if (record.extraction) this.bytes(record, 'txt'); this.store.remove('attachment', key); this.directory(); unlinkSync(this.file(key, 'bin')); if (record.extraction) unlinkSync(this.file(key, 'txt')); }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending]); await this.extractor.drain(); }
  async close(): Promise<void> { this.closed = true; await this.extractor.close(); await this.drain(); }
}
