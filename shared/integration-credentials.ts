export const INTEGRATION_CREDENTIAL_PREFIX = 'relay-integration-credential:';
/** Non-secret host receiver identity, never taken from a credential submit body. */
export type IntegrationReceiver = Readonly<{agentId:string;agentName:string} & (
 {kind:'mcp';name:string;url:string} | {kind:'telegram';allowedUserId:number;enabled:boolean;url:string}
)>;
export function isIntegrationReceiver(value:unknown):value is IntegrationReceiver {
 if(!value||typeof value!=='object')return false;
 const v=value as Record<string,unknown>;
 if(typeof v.agentId!=='string'||!v.agentId.trim()||typeof v.agentName!=='string'||!v.agentName.trim()||typeof v.url!=='string')return false;
 try{const u=new URL(v.url);if(u.href!==v.url||u.username||u.password||u.hash||u.protocol!=='https:'&&!(u.protocol==='http:'&&(['localhost','127.0.0.1','[::1]','::1'].includes(u.hostname)||u.hostname.endsWith('.localhost'))))return false;for(const k of u.searchParams.keys())if(/token|key|secret|password|authorization|credential|signature/i.test(k))return false;}catch{return false;}
 return v.kind==='mcp'?typeof v.name==='string'&&!!v.name.trim():v.kind==='telegram'&&typeof v.allowedUserId==='number'&&Number.isSafeInteger(v.allowedUserId)&&v.allowedUserId>0&&typeof v.enabled==='boolean';
}
