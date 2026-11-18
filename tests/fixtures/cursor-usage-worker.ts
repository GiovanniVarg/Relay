import {runCursorOperation,finishCursorWorker,CURSOR_CONNECTOR_KEY_NAME,type CursorSdk,type CursorOperation} from '../../server/providers/cursor-worker.js';
let disposed=false,disposing=false,resolveUsage:((value:unknown)=>void)|undefined;
const mode=process.argv[2],event=(type:string)=>process.stdout.write(JSON.stringify({type})+'\n');
const sdk={JsonlLocalAgentStore:class{},FileCredentialStore:class{async load(){return {apiKey:'synthetic',backendUrl:'https://api2.cursor.sh'};}},Cursor:{me:async()=>({userId:1,userEmail:'fixture',apiKeyName:CURSOR_CONNECTOR_KEY_NAME}),models:{list:async()=>[{id:'m',displayName:'m'}]}},Agent:{create:async()=>({agentId:'session',getUsage:async()=>{
 if(disposing)throw Error('Usage was entered after disposal started');
 event('usage-started');
 if(mode)return new Promise(resolve=>{resolveUsage=resolve;});
 setInterval(()=>{},1000);return new Promise(()=>{});
},send:async()=>({status:'finished',async *stream(){yield {type:'assistant',message:{content:[{type:'text',text:'Done'}]}};},wait:async()=>({status:'finished',result:'Done',usage:{inputTokens:0,outputTokens:1}})}),async [Symbol.asyncDispose](){
 disposing=true;event('cleanup-started');
 resolveUsage?.({usage:{inputTokens:0,outputTokens:1,cacheReadTokens:0}});
 if(mode==='cleanup-error')throw Error('Synthetic cleanup failed');
 if(mode)await new Promise(resolve=>setTimeout(resolve,2700));
 disposed=true;event('cleanup-finished');
}})}} as unknown as CursorSdk;
let operation:CursorOperation={operation:'stream',request:{runId:'run-client-label',conversationId:'fixture',model:'m',instructions:'',history:[{role:'user',content:'Fixture'}],maxSeconds:5,expectedAccount:{accountLabel:'fixture',plan:''}}};
if(mode){let input='';for await(const chunk of process.stdin)input+=chunk;operation=JSON.parse(input) as CursorOperation;}
await runCursorOperation(operation,sdk,event=>process.stdout.write(JSON.stringify(event)+'\n'),new AbortController().signal);
if(!disposed)throw Error('Required disposal did not complete');
process.stdout.write(JSON.stringify({type:'cleanup-complete'})+'\n');
await finishCursorWorker(operation);
