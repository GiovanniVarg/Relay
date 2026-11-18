import { runProviderWorker } from '../../server/providers/provider-worker.js';
import {isOutcomeReconciliation} from '../../server/outcome-reconciliation.js';
// Explicit fixture injection. No provider executable or inference is used.
runProviderWorker({createAdapter:(id,_data,launcher)=>({id,inspect:async()=>({} as any),login:async()=>({message:''}),close:async()=>{},
 async stream(request,emit,signal){
  if(request.model==='report-marker')return {text:JSON.stringify({marked:isOutcomeReconciliation(request),hasTools:!!request.appTools,hasInteraction:!!request.interact}),actualModel:request.model};
  if(request.model==='callbacks'){
   const answer=await request.interact!({kind:'approval',title:'Fixture approval',description:'No external action'},signal);
   const result=await request.appTools!.call('fixture-call','relay_fixture',{accepted:answer.decision});
   return{text:JSON.stringify(result),actualModel:request.model};
  }
  const code="const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:true});console.log(JSON.stringify({pid:child.pid}));child.unref();";
  const root=launcher({file:process.execPath,args:[]},['-e',code],process.cwd(),process.env);
  let output='';root.stdout.on('data',chunk=>output+=chunk);root.stderr.resume();root.stdin.end();
  await new Promise<void>((done,reject)=>{root.once('close',()=>done());root.once('error',reject);});
  emit({type:'status',message:'fixture-descendant:'+JSON.parse(output).pid});
  if(request.model==='abort')await new Promise<void>((_done,reject)=>{if(signal.aborted)reject(Error('Run cancelled'));else signal.addEventListener('abort',()=>reject(Error('Run cancelled')),{once:true});});
  return{text:'genuine fixture result',actualModel:request.model};
 }
})}).then(()=>process.exit(0),()=>process.exit(1));
