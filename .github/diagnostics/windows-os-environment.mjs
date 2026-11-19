// Closed Windows OS-field allowlist. Never copy arbitrary CI, authentication, runtime-injection or provider variables.
export const WINDOWS_OS_FIELD_GROUPS=Object.freeze({
 system:['SYSTEMDRIVE','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','OS','ALLUSERSPROFILE','PROGRAMDATA','PUBLIC'],
 programs:['PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','COMMONPROGRAMFILES','COMMONPROGRAMFILES(X86)','COMMONPROGRAMW6432'],
 identity:['COMPUTERNAME','USERNAME','USERDOMAIN','USERDNSDOMAIN','USERDOMAIN_ROAMINGPROFILE','LOGONSERVER'],
 processor:['NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE','PROCESSOR_ARCHITEW6432','PROCESSOR_IDENTIFIER','PROCESSOR_LEVEL','PROCESSOR_REVISION'],
 profile:['USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','TEMP','TMP','PATH'],
});
const allowed=new Set(Object.values(WINDOWS_OS_FIELD_GROUPS).flat());
export function safeWindowsOsAdditions(raw,base={}){
 const present=new Set(Object.keys(base).map(key=>key.toUpperCase())),result={};
 for(const[key,value]of Object.entries(raw)){const name=key.toUpperCase();if(allowed.has(name)&&!present.has(name)&&typeof value==='string')result[name]=value;}
 return result;
}
export function selectWindowsOsAdditions(additions,keys){
 const wanted=new Set(keys.map(key=>key.toUpperCase())),result={};
 for(const[key,value]of Object.entries(additions)){const name=key.toUpperCase();if(!allowed.has(name))throw Error('Non-OS environment field refused.');if(wanted.has(name))result[name]=value;}
 return result;
}
// Caller first proves that all keys pass and no additions fail. A null probe means its case/time budget is exhausted.
export async function minimizePassingOsKeys(keys,probe){
 let passing=[...keys],granularity=2;
 while(passing.length>=2){
  let reduced=false;const size=Math.ceil(passing.length/granularity);
  for(let start=0;start<passing.length;start+=size){
   const complement=passing.filter((_,i)=>i<start||i>=start+size);if(!complement.length)continue;
   const result=await probe(complement);if(!result)return{keys:passing,oneMinimal:false,budgetLimited:true};
   if(result.verified){passing=complement;granularity=Math.max(2,granularity-1);reduced=true;break;}
  }
  if(reduced)continue;
  if(granularity>=passing.length)return{keys:passing,oneMinimal:true,budgetLimited:false};
  granularity=Math.min(passing.length,granularity*2);
 }
 return{keys:passing,oneMinimal:passing.length===1,budgetLimited:false};
}
