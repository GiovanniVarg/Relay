import {access,mkdir,mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {delimiter,dirname,join,resolve} from 'node:path';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import type {ModelInfo,ProviderAdapter,ProviderConnection,ProviderEvent,ProviderRequest,ProviderResult} from '../../shared/types.js';
import {AcpClient} from './acp.js';
import {createAcpLauncher} from './acp-launcher.js';
import {boundedPrompt,childEnvironment,OwnedProcess,safeError,toolSummary,workDirectory,type Command,type Launcher} from './process.js';
import {createAppToolsBridge} from '../app-tools-bridge.js';
import {isOutcomeReconciliation} from '../outcome-reconciliation.js';

const record=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
interface Backend {local:boolean;name?:string;models?:Record<string,{local:boolean;contextWindow?:number;outputLimit?:number;toolCalling?:boolean;reasoning?:boolean}>;}
export interface OpenCodeProfile {scope:string;providers:Record<string,Backend>;env:NodeJS.ProcessEnv;}
export interface OpenCodeOptions {command?:()=>Promise<Command|null>;launcher?:Launcher;kill?:(child:ChildProcessWithoutNullStreams)=>Promise<void>;profile?:()=>Promise<OpenCodeProfile>;}
const ACCOUNT='OpenCode managed profile';
export const SUPPORTED_OPENCODE_VERSIONS=Object.freeze(['2.2.5'] as const);
const backendId=(id:string)=>/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id);
const BUNDLED_PACKAGES=new Set(['@opencode/ai/providers/openai-compatible','@opencode/ai/providers/openai','@opencode/ai/providers/anthropic']);
/** A terminal may use CMD or PowerShell; keep Windows paths inside an encoded PowerShell expression. */
export function openCodeSetupCommand(node:string,script:string,platform:NodeJS.Platform=process.platform):string{
 if(platform==='win32'){const q=(value:string)=>"'"+value.replaceAll("'","''")+"'";return 'powershell.exe -NoProfile -EncodedCommand '+Buffer.from('& '+q(node)+' '+q(script),'utf16le').toString('base64');}
 const q=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";return q(node)+' '+q(script);
}
const exists=(path:string)=>access(path).then(()=>true,()=>false);
/** Shell shims are not executable authority. Resolve native binaries or the official Node wrapper. */
export async function findOpenCodeCommand(dataDir:string):Promise<Command|null>{
 for(const file of [join(dataDir,'tools','opencode','opencode.exe'),join(dataDir,'tools','opencode','bin','opencode.exe'),...((process.env.PATH??process.env.Path??'').split(delimiter).filter(Boolean).map(path=>join(resolve(path.replace(/^"|"$/g,'')),process.platform==='win32'?'opencode.exe':'opencode')))])if(await exists(file))return{file,args:[]};
 return null;
}
/** All native credentials/configuration remain in Relay's private profile. No ambient API key is inherited. */
export function openCodeEnvironment(home:string,source:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
 const base=Object.fromEntries(Object.entries(childEnvironment(source)).map(([key,value])=>[key.toUpperCase(),value]));
 return {...base,HOME:home,USERPROFILE:home,...(process.platform==='win32'?{HOMEDRIVE:home.slice(0,2),HOMEPATH:home.slice(2)}:{}),APPDATA:join(home,'AppData','Roaming'),LOCALAPPDATA:join(home,'AppData','Local'),PROGRAMDATA:join(home,'ProgramData'),OPENCODE_TEST_HOME:home,OPENCODE_CONFIG_DIR:join(home,'.config','opencode'),OPENCODE_DB:join(home,'.local','share','opencode','opencode.db'),OPENCODE_CONFIG_PROJECT_DISABLE:'1',OPENCODE_FLAGS:'-schedules',OPENCODE_DISABLE_CLAUDE_CODE:'1',OPENCODE_FILEWATCHER_DISABLE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_CONFIG_CONTENT:JSON.stringify({warming:false,permissions:[{action:'*',resource:'*',effect:'ask'},{action:'subagent',resource:'*',effect:'deny'},{action:'skill',resource:'*',effect:'deny'},{action:'websearch',resource:'*',effect:'deny'},{action:'question',resource:'*',effect:'deny'},{action:'experimental_image_generate',resource:'*',effect:'deny'},{action:'schedule_create',resource:'*',effect:'deny'},{action:'schedule_resume',resource:'*',effect:'deny'}],agents:{build:{permissions:[{action:'*',resource:'*',effect:'ask'},{action:'subagent',resource:'*',effect:'deny'},{action:'skill',resource:'*',effect:'deny'},{action:'websearch',resource:'*',effect:'deny'},{action:'question',resource:'*',effect:'deny'}]},title:{disabled:true},summary:{disabled:true},compaction:{disabled:true}},policies:[{action:'tool.use',resource:'skill:*',effect:'deny'},{action:'tool.use',resource:'experimental_image_generate:*',effect:'deny'},{action:'tool.use',resource:'schedule_create:*',effect:'deny'},{action:'tool.use',resource:'schedule_resume:*',effect:'deny'},{action:'websearch.use',resource:'*',effect:'deny'},{action:'tool.use',resource:'subagent:*',effect:'deny'},{action:'skill.use',resource:'*',effect:'deny'}]}),XDG_CONFIG_HOME:join(home,'.config'),XDG_DATA_HOME:join(home,'.local','share'),XDG_CACHE_HOME:join(home,'.cache'),XDG_STATE_HOME:join(home,'.local','state'),TEMP:join(home,'tmp'),TMP:join(home,'tmp'),TMPDIR:join(home,'tmp'),NO_BROWSER:'true'};
}
/** Restricts the same captured profile; OpenCode 2.2.5 still advertises its denied skill tool. */
export function openCodeReportingEnvironment(source:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
 let overlay:Record<string,any>;try{overlay=JSON.parse(source.OPENCODE_CONFIG_CONTENT??'{}');}catch{throw Error('OpenCode host policy is invalid');}
 const denied=[{action:'*',resource:'*',effect:'deny'},{action:'skill',resource:'*',effect:'deny'}];
 return {...source,OPENCODE_CONFIG_CONTENT:JSON.stringify({...overlay,mcp:undefined,permissions:denied,agents:{...overlay.agents,build:{...overlay.agents?.build,permissions:denied}},policies:[...(overlay.policies??[]),{action:'tool.use',resource:'*',effect:'deny'},{action:'skill.use',resource:'*',effect:'deny'}]})};
}
async function bytes(path:string):Promise<Buffer>{try{const info=await stat(path);if(!info.isFile()||info.size>4*1024*1024)throw Error('OpenCode private configuration is too large');return await readFile(path);}catch(error:any){if(error?.code==='ENOENT')return Buffer.alloc(0);throw error;}}
export async function openCodeProfile(dataDir:string):Promise<OpenCodeProfile>{
 const home=resolve(dataDir,'opencode','home'),configPath=join(home,'.config','opencode','opencode.json'),configBytes=await bytes(configPath),authBytes=await bytes(join(home,'.local','share','opencode','auth.json')),databasePath=join(home,'.local','share','opencode','opencode.db');
 for(const path of [join(home,'.config','opencode','opencode.jsonc'),join(home,'ProgramData','opencode','opencode.json'),join(home,'ProgramData','opencode','opencode.jsonc')])if(await exists(path))throw Error('OpenCode requires one captured private opencode.json; additional JSONC or system configuration layers are unsupported');
 for(const path of [join(home,'.agents'),join(home,'.claude'),...['AGENTS.md','CLAUDE.md','agents','agent','commands','command','plugins','plugin','skills','skill','node_modules'].map(name=>join(home,'.config','opencode',name))])if(await exists(path))throw Error('OpenCode supplementary instruction, skill, command and executable configuration directories are unsupported in this captured profile');
 let legacyAuth:Record<string,any>={};if(authBytes.length){try{legacyAuth=JSON.parse(authBytes.toString('utf8'));}catch{throw Error('OpenCode private native credential store is invalid');}if(!record(legacyAuth))throw Error('OpenCode private native credential store is invalid');for(const [id,value] of Object.entries(legacyAuth))if(!backendId(id)||id==='opencode'||id==='opencode-go'||!record(value)||!['api','oauth'].includes(value.type))throw Error('OpenCode remote or external legacy credentials are unsupported');}
 let config:Record<string,any>={};if(configBytes.length){try{config=JSON.parse(configBytes.toString('utf8'));}catch{throw Error('OpenCode private opencode.json must be valid JSON');}if(!record(config))throw Error('OpenCode configuration must be an object');}
 const dataOnly=new Set(['$schema','model','provider','providers']);if(Object.keys(config).some(key=>!dataOnly.has(key)))throw Error('OpenCode captured profile accepts provider/model data only; policies, permissions, agents, MCP, plugins and other executable configuration are host-owned');
 const validatePackages=(value:unknown)=>{if(Array.isArray(value)){value.forEach(validatePackages);return;}if(!record(value))return;for(const [key,item] of Object.entries(value)){if(['npm','package'].includes(key)&&(!BUNDLED_PACKAGES.has(item)))throw Error('OpenCode package overrides must name an audited bundled provider; npm installs and file/remote code imports are disabled');validatePackages(item);}};validatePackages(config);
 if(/\{(?:env|file):/i.test(configBytes.toString('utf8'))||config.plugin!==undefined||config.plugins!==undefined||config.wellknown!==undefined)throw Error('OpenCode dynamic configuration, external file/environment references and plugins are unsupported in this captured profile');
 if(config.provider!==undefined&&config.providers!==undefined)throw Error('OpenCode captured configuration must use either legacy provider or canonical providers, without mixed routing layers');
 const providers:Record<string,Backend>=Object.create(null);
 const loopback=(value:unknown)=>{try{if(typeof value!=='string')return false;const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.username&&!url.password;}catch{return false;}};
 for(const [id,entry] of Object.entries({...record(config.provider)?config.provider:{},...record(config.providers)?config.providers:{}})){if(!backendId(id)||!record(entry))throw Error('OpenCode backend IDs must be concrete provider IDs without policy wildcards');const endpoint=record(config.providers)?entry.settings?.baseURL:entry.api??entry.options?.baseURL,models:NonNullable<Backend['models']>=Object.create(null);
  for(const [modelId,value] of Object.entries(record(entry.models)?entry.models:{})){if(!record(value))continue;const modelEndpoint=record(config.providers)?value.settings?.baseURL??endpoint:value.provider?.api??value.options?.baseURL??endpoint,limit=value.limit;
   models[modelId]={local:loopback(modelEndpoint),...(Number.isSafeInteger(limit?.context)&&limit.context>0?{contextWindow:limit.context}:{}),...(Number.isSafeInteger(limit?.output)&&limit.output>0?{outputLimit:limit.output}:{}),...(typeof value.tool_call==='boolean'?{toolCalling:value.tool_call}:typeof value.capabilities?.tools==='boolean'?{toolCalling:value.capabilities.tools}:{}),...(typeof value.reasoning==='boolean'?{reasoning:value.reasoning}:typeof value.capabilities?.reasoning?.supported==='boolean'?{reasoning:value.capabilities.reasoning.supported}:{})};
   const variants=Array.isArray(value.variants)?value.variants.map((variant:any)=>[variant.id,variant]):Object.entries(record(value.variants)?value.variants:{});
   for(const [variantId,variant] of variants)if(typeof variantId==='string'&&record(variant)){const variantEndpoint=variant.settings?.baseURL??variant.options?.baseURL??variant.baseURL??modelEndpoint;for(const separator of ['#','/'])if(!Object.hasOwn(entry.models,modelId+separator+variantId))models[modelId+separator+variantId]={...models[modelId],local:loopback(variantEndpoint)};}
  }
  providers[id]={local:loopback(endpoint),models,...(typeof entry.name==='string'?{name:entry.name.slice(0,200)}:{})};
 }
 // Native credentials are opaque. Only provider IDs, never credential contents, enter metadata.
 let credentials:Record<string,any>[]=[];let database:DatabaseSync|undefined;
 if(await exists(databasePath)){try{database=new DatabaseSync(databasePath,{readOnly:true});database.exec('BEGIN');if(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kv'").get()){const source=(()=>{const size=database!.prepare("SELECT length(CAST(value AS BLOB)) AS bytes FROM kv WHERE key='wellknown:sources'").get();if(Number(size?.bytes??0)>8192)throw Error('Remote source metadata exceeds the inspection bound');return database!.prepare("SELECT value FROM kv WHERE key='wellknown:sources'").get();})();if(source&&source.value!=='[]')throw Error('Unsupported remote native configuration sources');}if(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='credential'").get()){const bounds=database.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(id AS BLOB))+COALESCE(length(CAST(integration_id AS BLOB)),0)+length(CAST(label AS BLOB))+length(CAST(value AS BLOB))+8),0) AS bytes FROM credential').get();if(Number(bounds?.count??0)>1000||Number(bounds?.bytes??0)>4*1024*1024)throw Error('OpenCode credential scope exceeds the inspection bound');credentials=database.prepare('SELECT id,integration_id,label,value,active FROM credential ORDER BY id LIMIT 1001').all();if(credentials.length>1000||Buffer.byteLength(JSON.stringify(credentials))>4*1024*1024)throw Error('OpenCode credential scope exceeds the inspection bound');for(const row of credentials){let value:any;try{value=JSON.parse(String(row.value));}catch{throw Error('Unsupported native credential');}if(typeof row.integration_id!=='string'||!backendId(row.integration_id)||row.integration_id==='opencode'||row.integration_id==='opencode-go'||!['key','oauth'].includes(value?.type))throw Error('Native credential supplies unsupported remote or external configuration');if(typeof row.integration_id==='string'&&backendId(row.integration_id))providers[row.integration_id]??={local:false};}}database.exec('COMMIT');}catch{throw Error('OpenCode native credential scope cannot be inspected safely or includes unsupported remote configuration');}finally{database?.close();}}
 else for(const id of Object.keys(legacyAuth))if(backendId(id))providers[id]??={local:false};
 const env=openCodeEnvironment(home);return {scope:createHash('sha256').update('relay-opencode-profile/v2\0').update(configBytes).update('\0').update(authBytes).update('\0').update(JSON.stringify(credentials)).update('\0').update(env.OPENCODE_CONFIG_CONTENT!).update(env.OPENCODE_FLAGS??'').digest('hex'),providers,env};
}
function modelOption(session:any):any {return Array.isArray(session?.configOptions)?session.configOptions.find((option:any)=>record(option)&&(option.category==='model'||option.id==='model')&&Array.isArray(option.options)):undefined;}
/** Normalize only advertised IDs. Backend-qualified IDs and optional variants are never guessed. */
export function openCodeCatalog(session:any,providers:Record<string,Backend>={}):ModelInfo[]{
 const option=modelOption(session),modern=!!option,values:any[]=[];
 const flatten=(items:any[],group?:string)=>{for(const item of items){if(!record(item))throw Error('OpenCode returned an invalid model catalog');if(Array.isArray(item.options))flatten(item.options,typeof item.group==='string'?item.group:group);else values.push({...item,group});}};
 if(modern)flatten(option.options);else if(Array.isArray(session?.models?.availableModels))values.push(...session.models.availableModels);else throw Error('OpenCode did not advertise a model selection contract');
 if(values.length>20000)throw Error('OpenCode model catalog exceeds the discovery bound');
 const seen=new Set<string>(),observedAt=new Date().toISOString();
 return values.map(value=>{const id=modern?value.value:value.modelId;if(typeof id!=='string'||id.length>512||!id.includes('/')||id.startsWith('/')||id.endsWith('/')||/[\u0000-\u001f]/.test(id)||seen.has(id))throw Error('OpenCode model IDs must be unique exact provider/model IDs');seen.add(id);const at=id.indexOf('/'),backendProviderId=id.slice(0,at),backend=Object.hasOwn(providers,backendProviderId)?providers[backendProviderId]:undefined;
  const metadata=backend?.models?.[id.slice(at+1)];return {id,name:typeof value.name==='string'?value.name.slice(0,512):id,verified:false,backendProviderId,nativeModelId:id.slice(at+1),...(backend?.name||value.group?{backendProviderName:backend?.name??value.group}:{}),...(metadata??{local:backend?.local===true&&!/[#/]/.test(id.slice(at+1))}),provenance:{source:(modern?'opencode:acp-config-options':'opencode:acp-legacy-models')+(metadata?'+private-native-config':''),observedAt},...(typeof value.description==='string'?{description:value.description.slice(0,1000)}:{})};
 });
}
export class OpenCodeAdapter implements ProviderAdapter {
 readonly id='opencode' as const;private jobs=new Set<{revoke():void;close():Promise<void>}>();private closing=false;
 constructor(private dataDir:string,private options:OpenCodeOptions={}){}
 private command(){return this.options.command?.()??findOpenCodeCommand(this.dataDir);}
 private profile(){return this.options.profile?.()??openCodeProfile(this.dataDir);}
 private async open(request?:ProviderRequest,emit:(event:ProviderEvent)=>void=()=>{},signal=new AbortController().signal){
  const command=await this.command();if(!command)throw Error('Install the official OpenCode CLI to use this connection');
  const reporting=!!request&&isOutcomeReconciliation(request);
  const profile=await this.profile(),root=resolve(this.dataDir,'opencode','operations');await mkdir(root,{recursive:true,mode:0o700});const directory=await mkdtemp(join(root,'acp-')),cwd=request&&!reporting?await workDirectory(request):join(directory,'workspace');if(!request||reporting)await mkdir(cwd,{mode:0o700});
  let job:OwnedProcess|undefined,client:AcpClient|undefined,bridge:Awaited<ReturnType<typeof createAppToolsBridge>>|undefined,sessionId='',text='',admitted=false,revoked=false,selected='';const lifetime=new AbortController(),combined=AbortSignal.any([signal,lifetime.signal]);
  const revoke=()=>{admitted=false;revoked=true;lifetime.abort();bridge?.revoke();};
  const ownership=this.options.launcher?undefined:createAcpLauncher(directory,'opencode');
  const state={revoke,close:async()=>{revoke();client?.close();let proved=!job;try{if(job){await job.stop();await ownership?.prove(job.child);proved=true;}}finally{await bridge?.close();this.jobs.delete(state);if(proved)await rm(directory,{recursive:true,force:true});}}};this.jobs.add(state);
  try{
   if(request?.appTools)bridge=await createAppToolsBridge({definitions:request.appTools.definitions,call:(...args)=>{if(!admitted||revoked||combined.aborted)throw Error('OpenCode app tool authority expired');return request.appTools!.call(...args);}},combined,directory);
   client=new AcpClient(value=>job!.write(value),(method,params)=>{
    if(method!=='session/update'||params?.sessionId!==sessionId||!sessionId)return;const update=params.update;
    if(update?.sessionUpdate==='agent_message_chunk'){if(!admitted||revoked)throw Error('OpenCode emitted text outside the active prompt');if(update.content?.type!=='text'||typeof update.content.text!=='string')throw Error('OpenCode returned unsupported output content');text+=update.content.text;if(text.length>2*1024*1024)throw Error('OpenCode response exceeds the safety limit');emit({type:'delta',text:update.content.text});}
    else if(update?.sessionUpdate==='tool_call'||update?.sessionUpdate==='tool_call_update'){if(reporting)throw Error('OpenCode outcome reporting attempted a disabled native tool');if(!admitted||revoked)throw Error('OpenCode native tool outside the active prompt');emit({type:'tool',name:toolSummary(update.title??update.kind??'OpenCode native tool'),summary:toolSummary(update.rawInput??update.status??'')});}
    else if(update?.sessionUpdate==='current_model_update'&&request&&update.currentModelId!==request.model)throw Error('OpenCode changed the selected model');
    else if(update?.sessionUpdate==='config_option_update'&&request){const current=modelOption(update);if(current&&current.currentValue!==request.model)throw Error('OpenCode changed the selected model');}
   },revoke,async params=>{
    if(reporting)throw Error('OpenCode outcome reporting cannot request native permissions');
    if(!admitted||revoked||combined.aborted)return{outcome:{outcome:'cancelled'}};
    if(!record(params)||params.sessionId!==sessionId||!record(params.toolCall)||typeof params.toolCall.toolCallId!=='string'||!params.toolCall.toolCallId||params.toolCall.toolCallId.length>200||!Array.isArray(params.options)||params.options.length>32)throw Error('OpenCode native approval session or options are invalid');
    const options=params.options;if(options.some((o:any)=>!record(o)||typeof o.optionId!=='string'||o.optionId.length>200)||new Set(options.map((o:any)=>o.optionId)).size!==options.length)throw Error('OpenCode native approval options are invalid');
    const allows=options.filter((o:any)=>o.kind==='allow_once'),denies=options.filter((o:any)=>o.kind==='reject_once');if(allows.length!==1||denies.length!==1)throw Error('OpenCode must offer unambiguous one-call permission choices');
    const details=JSON.stringify(params.toolCall.rawInput??{});if(details.length>80000)throw Error('OpenCode permission input is too large');
    const answer=await request!.interact!({kind:'approval',title:'OpenCode: '+toolSummary(params.toolCall.title??'Native tool'),description:'Allow this native tool call once?',details},combined);
    if(revoked||combined.aborted)return{outcome:{outcome:'cancelled'}};if(!answer||!['allow','deny'].includes(answer.decision))throw Error('Invalid host permission answer');return{outcome:{outcome:'selected',optionId:(answer.decision==='allow'?allows:denies)[0].optionId}};
   });
   const env={...profile.env};
   if(reporting)Object.assign(env,openCodeReportingEnvironment(env));
   if(request){const backend=request.model.slice(0,request.model.indexOf('/'));if(!backendId(backend))throw Error('OpenCode selected backend is not a concrete policy scope');let overlay:Record<string,any>={};try{overlay=JSON.parse(env.OPENCODE_CONFIG_CONTENT??'{}');}catch{throw Error('OpenCode host policy is invalid');}env.OPENCODE_CONFIG_CONTENT=JSON.stringify({...overlay,...(bridge?{mcp:{servers:{relay_app:{type:'local',command:[bridge.mcpConfig.mcpServers.relay_app.command,...bridge.mcpConfig.mcpServers.relay_app.args],environment:{},timeout:{startup:15000,catalog:15000},codemode:true}}}}:{}),policies:[...(overlay.policies??[]),{action:'provider.use',resource:'*',effect:'deny'},{action:'provider.use',resource:backend,effect:'allow'},{action:'mcp.use',resource:'*',effect:'deny'},...(bridge?[{action:'mcp.use',resource:'relay_app',effect:'allow'}]:[])]});}
   job=new OwnedProcess(command,['acp'],cwd,env,request?.maxSeconds??25,value=>client!.accept(value),signal,this.options.launcher??ownership?.launcher,this.options.kill??ownership?.kill,'jsonl',{total:32*1024*1024,line:16*1024*1024,mode:'streaming',inputQueueBytes:2*1024*1024});
   void job.finished.then(()=>{revoke();client!.close();},error=>{revoke();client!.close(error);});
   const initialized=await client.call('initialize',{protocolVersion:1,clientInfo:{name:'Relay-'+randomUUID(),version:'0.8.5'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
   if(initialized.protocolVersion!==1)throw Error('Unsupported OpenCode ACP protocol version');
   if(!(SUPPORTED_OPENCODE_VERSIONS as readonly string[]).includes(String(initialized.agentInfo?.version??'')))throw Error('Relay native OpenCode requires verified version 2.2.5; other versions must pass the native contract suite before inference');
   const session=await client.call('session/new',{cwd,mcpServers:[]});
   if(bridge&&!this.options.profile){
    let timer:NodeJS.Timeout|undefined;let abort!:()=>void;
    try{await Promise.race([bridge.ready,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('OpenCode did not initialize the private Relay MCP facade before the readiness deadline')),18000);abort=()=>reject(Error('OpenCode MCP readiness cancelled'));combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort();})]);}
    finally{clearTimeout(timer);combined.removeEventListener('abort',abort);}
   }
   if(typeof session.sessionId!=='string'||!session.sessionId||session.sessionId.length>200)throw Error('OpenCode returned an invalid session');sessionId=session.sessionId;
   const models=openCodeCatalog(session,profile.providers),option=modelOption(session);
   if(request){
    if(!models.some(model=>model.id===request.model)||!Object.hasOwn(profile.providers,request.model.slice(0,request.model.indexOf('/'))))throw Error('OpenCode selected model backend is not deliberately configured');
    if(option){const result=await client.call('session/set_config_option',{sessionId,configId:option.id,value:request.model});if(modelOption(result)?.currentValue!==request.model)throw Error('OpenCode did not confirm the selected model');selected=request.model;}
    else throw Error('OpenCode native execution requires the verified modern model configuration acknowledgement');
   }
   return {profile,models,sessionId,selected,client,state,get text(){return text;},admit(){if(revoked||combined.aborted)throw Error('OpenCode prompt authority expired');admitted=true;}};
  }catch(error){await state.close();throw error;}
 }
 async inspect():Promise<ProviderConnection>{
  const base:ProviderConnection={id:this.id,installed:false,authenticated:false,authMode:'unknown',accountLabel:'',plan:'',models:[],nativeAgentOnly:true};
  if(!await this.command())return{...base,inferenceAvailable:false,error:'OpenCode connector missing. Install official OpenCode 2.2.5, then use OpenCode setup in Relay’s terminal. No global profile is imported.'};
  base.installed=true;let opened:Awaited<ReturnType<OpenCodeAdapter['open']>>|undefined;
  try{opened=await this.open();const current=await this.profile();if(current.scope!==opened.profile.scope)throw Error('OpenCode configuration or credentials changed during discovery; refresh again');const configured=Object.keys(current.providers).length>0;return{...base,models:opened.models,connectionScope:current.scope,authenticated:configured,authMode:configured?'managed':'unknown',accountLabel:configured?ACCOUNT:'',inferenceAvailable:configured,...(!configured?{error:'Configure a backend or complete native authentication in Relay’s private OpenCode terminal profile. Catalog discovery grants no access or billing approval.'}:{})};}
  catch(error){return{...base,inferenceAvailable:false,error:safeError(error)};}finally{await opened?.state.close();}
 }
 async login(){
  if(this.jobs.size)throw Error('Wait for active OpenCode operations before connecting');const command=await this.command();if(!command)return{message:'Install official OpenCode 2.2.5 using its published installation instructions in Relay’s terminal, then refresh this connection. Relay does not install or authenticate globally.',url:'https://opencode.ai/v2/docs/'};
  const home=resolve(this.dataDir,'opencode','home');await mkdir(home,{recursive:true,mode:0o700});const script=join(home,'relay-native-login.mjs'),env=openCodeEnvironment(home);
  await writeFile(script,"import {spawn} from 'node:child_process';\nconst child=spawn("+JSON.stringify(command.file)+","+JSON.stringify([...command.args,'auth','login'])+",{cwd:"+JSON.stringify(home)+",env:"+JSON.stringify(env)+",stdio:'inherit',shell:false,windowsHide:false});\nchild.on('error',()=>{console.error('OpenCode native login could not start');process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});\n",{mode:0o600});
  return{command:openCodeSetupCommand(process.execPath,script),message:'Open Relay’s terminal and run this command to authenticate using the official OpenCode CLI in Relay’s private profile. Sign in to the underlying provider you intend to use. Console/organization remote configuration is unsupported in this captured profile. Enter credentials only in the terminal, then refresh, select exact models and confirm their billing. Local endpoints may proxy paid services.'};
 }
 async stream(request:ProviderRequest,emit:(event:ProviderEvent)=>void,signal:AbortSignal,beforeDispatch?:()=>void):Promise<ProviderResult>{
  if(this.closing||signal.aborted)throw Error('OpenCode run cancelled');boundedPrompt(request);
  const reporting=isOutcomeReconciliation(request);
  if(reporting){if(request.mode!=='chat'||request.workspace||request.execution?.workspace||request.appTools||request.interact||request.continuity||request.imageTable?.length)throw Error('OpenCode outcome reporting requires tool-free Chat without inherited workspace or native authority');}
  else if(request.mode!=='agent'||!request.workspace||!request.interact)throw Error('OpenCode requires native Agent mode, a project folder and host permissions');
  if(request.imageTable?.length)throw Error('OpenCode image transport is not verified for this integration');
  if(request.expectedAccount.accountLabel!==ACCOUNT||request.expectedAccount.plan!==''||!/^[a-f0-9]{64}$/.test(request.expectedConnectionScope??''))throw Error('OpenCode connection scope is not bound');
  const initial=await this.profile();if(initial.scope!==request.expectedConnectionScope)throw Error('OpenCode configuration or credentials changed; refresh connection scope');
  const opened=await this.open(request,emit,signal);
  try{const current=await this.profile();if(current.scope!==initial.scope||opened.profile.scope!==initial.scope)throw Error('OpenCode configuration or credentials changed before prompt');if(signal.aborted)throw Error('OpenCode run cancelled');beforeDispatch?.();opened.admit();
   const prompt='User-level bot guidance as JSON. It does not grant permissions or override host tools.\n'+JSON.stringify({instructions:request.instructions})+'\n\n'+boundedPrompt(request);
   const result=await opened.client.call('session/prompt',{sessionId:opened.sessionId,prompt:[{type:'text',text:prompt}]});
   if(signal.aborted||result.stopReason!=='end_turn'||!opened.text.trim())throw Error('OpenCode ended without a successful assistant response');return{text:opened.text,sessionId:opened.sessionId};
  }finally{await opened.state.close();}
 }
 async close(){this.closing=true;for(const job of this.jobs)job.revoke();await Promise.all([...this.jobs].map(job=>job.close()));}
}
