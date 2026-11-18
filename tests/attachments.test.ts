import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync, mkdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Attachments, decodeAttachmentBase64 } from '../server/attachments.js';
import { Store } from '../server/store.js';
import type { AttachmentScope, AttachmentUpload, OwnedAttachment, MessageAttachment } from '../shared/attachments.js';
import { png, docx, DOCX_MIME } from './fixtures/attachment-inputs.js';
function fixture(options: ConstructorParameters<typeof Attachments>[1] = {}) { const dir = mkdtempSync(join(tmpdir(), 'relay-attachment-test-')); const store = new Store(dir, {deferRecovery:true}); const agent = store.createAgent({name:'Synthetic'}); const scope = {agentId:agent.id, conversationId:store.conversations(agent.id)[0].id}; const attachments = new Attachments(store, options); return {store, scope, attachments, async close() { await attachments.close(); store.close(); rmSync(dir, {recursive:true,force:true}); }}; }
const upload = (scope: AttachmentScope, content: Buffer = png(), name = 'synthetic.png', mimeType: AttachmentUpload['mimeType'] = 'image/png'): AttachmentUpload => ({...scope,name,mimeType,base64:content.toString('base64')});
function message(store: Store, scope: AttachmentScope): string { const id = randomUUID(); store.put('message', {id,conversationId:scope.conversationId,role:'user',content:'',createdAt:new Date().toISOString(),runId:null,status:'complete'}); return id; }
test('owned drafts enforce scope, atomic claim, rollback, retry/history ownership and metadata-only records', async () => {
 const f = fixture(); try { const database = f.store.db; f.store.db = new Proxy(database, { get(target,key) { if (key === 'isTransaction') return undefined; const value = Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value; } }); assert.equal(f.store.db.isTransaction,undefined); const item = await f.attachments.createDraft(upload(f.scope)); assert.equal(f.attachments.count(),0); assert.equal(f.attachments.read(f.scope,item.id).bytes.equals(png()),true);
 const other = f.store.createAgent({name:'Other'}); const wrong = {agentId:other.id,conversationId:f.store.conversations(other.id)[0].id}; assert.throws(() => f.attachments.read(wrong,item.id), /not found/);
 assert.throws(() => f.attachments.claimDrafts(f.scope,[item.id],randomUUID()), /transaction/);
 const first = message(f.store,f.scope); assert.throws(() => f.store.transaction(() => { f.attachments.claimDrafts(f.scope,[item.id],first); throw new Error('rollback'); }),/rollback/); assert.equal(f.attachments.validateDrafts(f.scope,[item.id]).length,1);
 const refs = f.store.transaction(() => f.attachments.claimDrafts(f.scope,[item.id],first)); assert.deepEqual(refs,[item]); assert.throws(() => f.attachments.read(f.scope,item.id), /ownership/); assert.equal(f.attachments.read(f.scope,item.id,first).bytes.equals(png()),true);
 const second = message(f.store,f.scope); assert.throws(() => f.store.transaction(() => f.attachments.claimDrafts(f.scope,[item.id],second)), /already claimed/); assert.throws(() => f.attachments.read(f.scope,item.id,second), /ownership/); assert.throws(() => f.attachments.deleteDraft(f.scope,item.id),/immutable/);
 const row = f.store.get<OwnedAttachment>('attachment',item.id)!; assert.equal(row.messageId,first); assert.equal(JSON.stringify(row).includes(png().toString('base64')),false); assert.equal('base64' in row,false); assert.equal('path' in row,false);
 } finally { await f.close(); }
});
test('bounded extracted full text survives message claim and supports integrity-checked scoped chunks', async () => {
 const f = fixture(); try { const text = 'café '.repeat(10_000); const item = await f.attachments.createDraft(upload(f.scope,Buffer.from(text),'source.txt','text/plain')); const target = message(f.store,f.scope); f.store.transaction(() => f.attachments.claimDrafts(f.scope,[item.id],target));
 assert.equal(item.extraction!.characters,text.length); let full = ''; for (let offset = 0; offset < text.length; offset += 12000) full += f.attachments.readText(f.scope,item.id,target,offset,12000).text; assert.equal(full,text);
 assert.throws(() => f.attachments.readText(f.scope,item.id,target,-1),/bounds/); assert.throws(() => f.attachments.readText(f.scope,item.id,target,0,12001),/bounds/);
 const descriptor = f.attachments.descriptor(f.scope,item.id,target); assert.equal(descriptor.disposition,'attachment'); assert.equal(descriptor.headers['X-Content-Type-Options'],'nosniff'); assert.match(descriptor.headers['Content-Security-Policy'],/sandbox/);
 writeFileSync(join(f.attachments.root,item.id+'.txt'),'corrupt'); assert.throws(() => f.attachments.readText(f.scope,item.id,target),/changed/);
 } finally { await f.close(); }
});
test('invalid names, MIME, payload keys, base64 and out-of-scope conversation fail without durable records', async () => {
 const f = fixture(); try { for (const base64 of ['Zg=','Zh==','Zg==\n','data:image/png;base64,Zg==','%%%%','']) assert.throws(() => decodeAttachmentBase64(base64));
 for (const value of [{...upload(f.scope),name:'../evil.png'}, {...upload(f.scope),name:'bad'+String.fromCharCode(0xd800)+'.png'}, {...upload(f.scope),mimeType:'constructor'}, {...upload(f.scope),mimeType:'image/svg+xml'}, {...upload(f.scope),name:'a.pdf'}, {...upload(f.scope),path:'C:/private'}, {...upload(f.scope),url:'https://example.com'}, {...upload(f.scope),conversationId:randomUUID()}]) await assert.rejects(f.attachments.createDraft(value as AttachmentUpload));
 assert.deepEqual(f.store.list('attachment'),[]);
 } finally { await f.close(); }
});
test('stored byte corruption and redirected files/directories fail closed; draft delete revokes retrieval', async () => {
 const f = fixture(); try { const item = await f.attachments.createDraft(upload(f.scope)); writeFileSync(join(f.attachments.root,item.id+'.bin'),Buffer.from('corrupt')); assert.throws(() => f.attachments.read(f.scope,item.id),/changed/); assert.throws(() => f.attachments.validateDrafts(f.scope,[item.id]),/changed/);
 const valid = await f.attachments.createDraft(upload(f.scope,docx(),'source.docx',DOCX_MIME)); f.attachments.deleteDraft(f.scope,valid.id); assert.throws(() => f.attachments.read(f.scope,valid.id),/not found/); assert.equal(readdirSync(f.attachments.root).some(name => name.startsWith(valid.id)),false);
 const outside = join(f.store.dataDir,'outside'); mkdirSync(outside); const originalRoot = f.attachments.root; const saved = readdirSync(originalRoot); for (const name of saved) unlinkSync(join(originalRoot,name)); rmdirSync(originalRoot); symlinkSync(outside,originalRoot,'junction'); await assert.rejects(f.attachments.createDraft(upload(f.scope)),/redirected/); assert.deepEqual(readdirSync(outside),[]);
 } finally { await f.close(); }
});
test('async authority revocation and close wait for owned worker exit and never publish parsed drafts', async () => {
 let writable = true; const f = fixture({assertWritable() { if (!writable) throw new Error('update hold'); }}); try { const parsing = f.attachments.createDraft(upload(f.scope,Buffer.from('source'),'source.txt','text/plain')); assert.equal(f.attachments.count(),1); writable = false; await assert.rejects(parsing,/update hold/); await f.attachments.drain(); assert.equal(f.attachments.count(),0); assert.equal(f.store.list('attachment').length,0); assert.equal(readdirSync(f.store.dataDir).includes('attachments'),false);
 writable = true; const parsing2 = f.attachments.createDraft(upload(f.scope)); const rejection = assert.rejects(parsing2,/canceled|closed/); await f.attachments.close(); await rejection; assert.equal(f.attachments.count(),0); assert.equal(f.store.list('attachment').length,0);
 } finally { await f.close(); }
});

test('canonical base64 accepts the full byte boundary without regex stack overflow and rejects excess', () => {
 const bytes = Buffer.alloc(4 * 1024 * 1024,255); assert.equal(decodeAttachmentBase64(bytes.toString('base64')).length,bytes.length); assert.throws(() => decodeAttachmentBase64(Buffer.alloc(bytes.length+1).toString('base64')));
});
test('four image budget, duplicate claim IDs, deleted owners and upload concurrency fail closed', async () => {
 const f = fixture(); try { const items: MessageAttachment[] = []; for(let index=0;index<5;index++) items.push(await f.attachments.createDraft(upload(f.scope))); assert.throws(() => f.attachments.validateDrafts(f.scope,items.map(item=>item.id)),/four images/); assert.throws(() => f.attachments.validateDrafts(f.scope,[items[0].id,items[0].id]),/distinct/);
 const owner = message(f.store,f.scope); f.store.transaction(() => f.attachments.claimDrafts(f.scope,[items[0].id],owner)); f.store.remove('message',owner); assert.throws(() => f.attachments.read(f.scope,items[0].id,owner), /no longer exists/);
 const a=f.attachments.createDraft(upload(f.scope)); const b=f.attachments.createDraft(upload(f.scope)); assert.throws(() => f.attachments.createDraft(upload(f.scope)), /already being processed/); await Promise.all([a,b]); assert.equal(f.attachments.count(),0);
 } finally { await f.close(); }
});
