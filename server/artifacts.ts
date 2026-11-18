import type {Task} from '../shared/tasks.js';
import type {Run} from '../shared/types.js';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Agent } from '../shared/types.js';
import type { Artifact, ArtifactInput } from '../shared/capabilities.js';
import { Store, id, now } from './store.js';
import { HttpError } from './security.js';

const MAX_BYTES = 25 * 1024 * 1024;
const within = (parent: string, child: string) => { const value = relative(parent, child); return !value || value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value); };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export class Artifacts {
  readonly root: string;
  constructor(readonly store: Store) { this.root = join(store.dataDir, 'artifacts'); }
  list(agentId?: string): Artifact[] { return this.store.list<Artifact>('artifact').filter(artifact => agentId === undefined || artifact.agentId === agentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(key: string): Artifact { const artifact = this.store.get<Artifact>('artifact', key); if (!artifact) throw new HttpError(404, 'Artifact not found'); return artifact; }
  private owner(agentId: string) { if (!this.store.get<Agent>('agent', agentId)) throw new HttpError(404, 'Bot not found'); }
  private name(value: string): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 160 || value !== basename(value) || /[\\/\x00-\x1f\x7f"<>:|?*]/.test(value) || value === '.' || value === '..') throw new HttpError(400, 'Artifact name must be a plain filename');
    return value.trim();
  }
  private async save(input: ArtifactInput, bytes: Buffer, source: Artifact['source'], mimeType: string, sourcePath?: string): Promise<Artifact> {
    this.owner(input.agentId); const name = this.name(input.name);
    if (bytes.length > MAX_BYTES) throw new HttpError(400, 'Artifact exceeds 25 MB');
    if (input.runId && !this.store.get('run', input.runId)) throw new HttpError(404, 'Source run not found');
    const run = input.runId ? this.store.get<{ agentId: string }>('run', input.runId) : undefined;
    if (run && run.agentId !== input.agentId) throw new HttpError(403, 'Artifact belongs to another bot');
    if (input.taskId) { const task = this.store.get<{ agentId: string }>('task', input.taskId); if (!task || task.agentId !== input.agentId) throw new HttpError(403, 'Artifact task belongs to another bot'); }
    await mkdir(this.root, { recursive: true }); const artifactId = id();
    await writeFile(join(this.root, artifactId), bytes, { flag: 'wx', mode: 0o600 });
    return this.store.put<Artifact>('artifact', { id: artifactId, agentId: input.agentId, runId: input.runId ?? null, taskId: input.taskId ?? null, name, mimeType, size: bytes.length, sha256: digest(bytes), createdAt: now(), source, ...(sourcePath ? { sourcePath } : {}), verification: 'captured' });
  }
  async text(input: ArtifactInput & { content: string }): Promise<Artifact> {
    if (typeof input.content !== 'string') throw new HttpError(400, 'Artifact content must be text');
    return this.save(input, Buffer.from(input.content, 'utf8'), 'text', 'text/plain; charset=utf-8');
  }
  /** Internal browser screenshot path only. Do not expose arbitrary MIME/binary input as an agent tool. */
  async bytes(input: ArtifactInput & { content: Buffer; mimeType?: string }): Promise<Artifact> {
    if (!Buffer.isBuffer(input.content)) throw new HttpError(400, 'Artifact content must be bytes');
    return this.save(input, input.content, 'browser', input.mimeType === 'image/png' ? 'image/png' : 'application/octet-stream');
  }
  async capture(input: ArtifactInput & { workspace: string; path: string }): Promise<Artifact> {
    this.owner(input.agentId);
    if (typeof input.workspace !== 'string' || !input.workspace || !isAbsolute(input.workspace) || typeof input.path !== 'string' || input.path.length > 4096 || input.path.includes('\0')) throw new HttpError(400, 'Artifact requires a valid bot workspace and path');
    const workspace = await realpath(input.workspace), source = await realpath(resolve(workspace, input.path));
    const data = await realpath(this.store.dataDir);
    if (!within(workspace, source) || within(data, source)) throw new HttpError(403, 'Artifact must be a file inside the bot workspace and outside Relay private data');
    const handle = await open(source, constants.O_RDONLY);
    let bytes: Buffer;
    try { const info = await handle.stat(); if (!info.isFile() || info.size > MAX_BYTES) throw new HttpError(400, 'Artifact must be a regular file up to 25 MB'); const chunks: Buffer[] = []; let total = 0; for (;;) { const chunk = Buffer.allocUnsafe(Math.min(65536, MAX_BYTES + 1 - total)); const result = await handle.read(chunk, 0, chunk.length, null); if (!result.bytesRead) break; total += result.bytesRead; if (total > MAX_BYTES) throw new HttpError(400, 'Artifact exceeds 25 MB'); chunks.push(chunk.subarray(0, result.bytesRead)); } bytes = Buffer.concat(chunks, total); }
    finally { await handle.close(); }
    if (await realpath(input.workspace) !== workspace || await realpath(resolve(workspace, input.path)) !== source) throw new HttpError(409, 'Artifact path changed during capture');
    return this.save(input, bytes, 'file', 'application/octet-stream', source);
  }
  async read(key: string): Promise<{ artifact: Artifact; bytes: Buffer }> {
    const artifact = this.get(key);
    if (!/^[a-zA-Z0-9-]+$/.test(artifact.id)) throw new HttpError(400, 'Invalid artifact identifier');
    const root = await realpath(this.root), target = await realpath(join(root, artifact.id));
    if (!within(root, target)) throw new HttpError(403, 'Artifact path is outside its library');
    if(!Number.isSafeInteger(artifact.size)||artifact.size<0||artifact.size>MAX_BYTES)throw new HttpError(409,'Artifact recorded size exceeds its integrity limit');
    const handle=await open(target,constants.O_RDONLY);let bytes:Buffer;
    try{const info=await handle.stat();if(!info.isFile()||info.size!==artifact.size||info.size>MAX_BYTES)throw new HttpError(409,'Artifact size integrity check failed');const chunks:Buffer[]=[];let total=0;for(;;){const chunk=Buffer.allocUnsafe(Math.min(65536,artifact.size+1-total));const result=await handle.read(chunk,0,chunk.length,null);if(!result.bytesRead)break;total+=result.bytesRead;if(total>artifact.size||total>MAX_BYTES)throw new HttpError(409,'Artifact size integrity check failed');chunks.push(chunk.subarray(0,result.bytesRead));}bytes=Buffer.concat(chunks,total);}finally{await handle.close();}
    if(await realpath(join(root,artifact.id))!==target)throw new HttpError(409,'Artifact path changed during integrity check');
    if (bytes.length !== artifact.size || digest(bytes) !== artifact.sha256) throw new HttpError(409, 'Artifact integrity check failed');
    return { artifact, bytes };
  }
  private workerTask(scope:{agentId:string;taskId:string},targetTaskId:string):Task {
    const parent=this.store.get<Task>('task',scope.taskId),target=this.store.get<Task>('task',targetTaskId);
    if(!parent||parent.agentId!==scope.agentId||!target)throw new HttpError(404,'Worker task not found in this task lineage');
    let current=target;const visited=new Set<string>();
    for(let depth=0;depth<64;depth++){
      if(current.id===parent.id)return target;
      if(visited.has(current.id)||!current.parentTaskId)break;visited.add(current.id);
      const ancestor=this.store.get<Task>('task',current.parentTaskId);
      if(!ancestor||!ancestor.childTaskIds.includes(current.id)||current.creatorAgentId!==ancestor.agentId)break;
      current=ancestor;
    }
    throw new HttpError(404,'Worker task not found in this task lineage');
  }
  private attributed(task:Task,artifact:Artifact):boolean {
    if(artifact.taskId!==task.id||artifact.agentId!==task.agentId||!artifact.runId||!task.runIds.includes(artifact.runId))return false;
    const run=this.store.get<Run>('run',artifact.runId);return !!run&&run.agentId===task.agentId&&run.conversationId===task.conversationId;
  }
  private publicArtifact(artifact:Artifact){const {sourcePath:_path,...metadata}=artifact;return metadata;}
  listWorkerArtifacts(scope:{agentId:string;taskId:string},targetTaskId:string,offset=0){
    if(!Number.isSafeInteger(offset)||offset<0)throw new HttpError(400,'Artifact offset must be a nonnegative integer');
    const task=this.workerTask(scope,targetTaskId),all=this.list(task.agentId).filter(artifact=>this.attributed(task,artifact));
    return {taskId:task.id,artifacts:all.slice(offset,offset+20).map(artifact=>this.publicArtifact(artifact)),offset,nextOffset:offset+20<all.length?offset+20:null,trust:'untrusted-worker-output' as const};
  }
  private workerArtifact(scope:{agentId:string;taskId:string},targetTaskId:string,key:string):Artifact{const task=this.workerTask(scope,targetTaskId),artifact=this.get(key);if(!this.attributed(task,artifact))throw new HttpError(404,'Worker artifact attribution not found');return artifact;}
  async readWorkerArtifact(scope:{agentId:string;taskId:string},targetTaskId:string,key:string,start=0,length=12000){
    if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(length)||length<1||length>12000)throw new HttpError(400,'Artifact text range is limited to 12,000 characters');
    this.workerArtifact(scope,targetTaskId,key);const {artifact,bytes}=await this.read(key);this.workerArtifact(scope,targetTaskId,key);
    const textual=artifact.source==='text'||/^text\//.test(artifact.mimeType)||/\.(txt|md|json|csv|tsv|log|html|css|js|ts|py|xml|yaml|yml)$/i.test(artifact.name);
    if(!textual)return{artifact:this.publicArtifact(artifact),content:null,start,end:start,truncated:false,textAvailable:false,reason:'This binary artifact has no text preview. Saved-byte integrity can be verified separately.',trust:'untrusted-worker-output' as const};
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new HttpError(400,'Artifact is not valid UTF-8 text; use saved-byte integrity verification');}
    const high=(code:number)=>code>=0xD800&&code<=0xDBFF,low=(code:number)=>code>=0xDC00&&code<=0xDFFF;
    start=Math.min(start,text.length);if(start>0&&low(text.charCodeAt(start))&&high(text.charCodeAt(start-1)))start--;
    let end=Math.min(text.length,start+length);if(end<text.length&&low(text.charCodeAt(end))&&high(text.charCodeAt(end-1)))end--;
    if(end===start&&end<text.length)throw new HttpError(400,'This Unicode character needs a text range length of at least 2');
    return{artifact:this.publicArtifact(artifact),content:text.slice(start,end),start,end,truncated:end<text.length,textAvailable:true,trust:'untrusted-worker-output' as const};
  }
  async verifyWorkerArtifact(scope:{agentId:string;taskId:string},targetTaskId:string,key:string){this.workerArtifact(scope,targetTaskId,key);const result=await this.verify(key);this.workerArtifact(scope,targetTaskId,key);return result;}
  async verify(key: string): Promise<{ artifactId: string; integrity: true; correctness: 'not_assessed'; sha256: string }> { const { artifact } = await this.read(key); return { artifactId: artifact.id, integrity: true, correctness: 'not_assessed', sha256: artifact.sha256 }; }
}
