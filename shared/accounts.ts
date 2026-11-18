import type {ActiveProviderId,ProviderConnection,ProviderState} from './types.js';
export type AccountProviderId = 'openai'|'claude'|'cursor';
export interface AccountDescriptor {accountId:string;providerId:AccountProviderId;isolated:true;profileGeneration:string;}
export interface AccountRecord {id:string;providerId:ActiveProviderId;name:string;isDefault:boolean;createdAt:string;profileGeneration:string;removedAt?:string;loginStartedAt?:string;loginAttemptId?:string;}
export interface AccountState extends ProviderState {accountId:string;accountName:string;isDefault:boolean;profileGeneration:string;duplicateAccountIds?:string[];warning?:string;}
export const defaultAccountId=(provider:string)=>'default-'+provider;
export const isAdditionalAccountId=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
/** An absent selection is always the legacy default, never the first matching account. */
export function accountMatches(state:Pick<ProviderConnection,'id'|'accountId'>,provider:string,accountId?:string):boolean{return state.id===provider&&(state.accountId??defaultAccountId(provider))===(accountId??defaultAccountId(provider));}
export const selectedAccount=(states:ProviderState[],provider:string,accountId?:string)=>states.find(state=>accountMatches(state,provider,accountId));
export function validAccountDescriptor(value:unknown,provider?:string):value is AccountDescriptor {const x=value as AccountDescriptor;return !!x&&typeof x==='object'&&x.isolated===true&&isAdditionalAccountId(x.accountId)&&isAdditionalAccountId(x.profileGeneration)&&['openai','claude','cursor'].includes(x.providerId)&&(!provider||x.providerId===provider);}
