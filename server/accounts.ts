import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {ACTIVE_PROVIDER_IDS,isActiveProviderId} from '../shared/types.js';
import type {AccountDescriptor,AccountRecord} from '../shared/accounts.js';
import {defaultAccountId,isAdditionalAccountId} from '../shared/accounts.js';
import type {Store} from './store.js';
import {HttpError,stringValue} from './security.js';
/** Metadata only: native credential files are never read or copied by the registry. */
export class AccountRegistry {
 constructor(private store:Store) {}
 list(includeRemoved=false):AccountRecord[]{const defaults=ACTIVE_PROVIDER_IDS.map(provider=>this.get(defaultAccountId(provider))!);const extra=this.store.list<AccountRecord>('provider-account').filter(row=>!row.isDefault&&(includeRemoved||!row.removedAt));return [...defaults,...extra];}
 get(id:string):AccountRecord|undefined {const provider=ACTIVE_PROVIDER_IDS.find(p=>id===defaultAccountId(p));if(provider)return {id,providerId:provider,name:provider==='openai'?'OpenAI':provider==='claude'?'Claude':provider==='cursor'?'Cursor':'OpenCode',isDefault:true,createdAt:'',profileGeneration:'legacy'};if(!isAdditionalAccountId(id))return;return this.store.get<AccountRecord>('provider-account',id);}
 create(input:{provider:unknown;name:unknown}):AccountRecord {if(!isActiveProviderId(input.provider)||!['openai','claude','cursor'].includes(input.provider))throw new HttpError(400,'Add an OpenAI, Claude or Cursor account');const name=stringValue(input.name,'Account name',100,1).trim();if(!name)throw new HttpError(400,'Account name is required');if(this.list().length>=24)throw new HttpError(400,'At most 24 active connections are supported');const row:AccountRecord={id:randomUUID(),providerId:input.provider,name,isDefault:false,createdAt:new Date().toISOString(),profileGeneration:randomUUID()};return this.store.put('provider-account',row);}
 remove(id:string):AccountRecord {const row=this.get(id);if(!row||row.removedAt)throw new HttpError(404,'Account not found');if(row.isDefault)throw new HttpError(400,'The default connection cannot be removed');return this.store.put('provider-account',{...row,removedAt:new Date().toISOString()});}
 directory(row:AccountRecord):string {if(row.isDefault)return this.store.dataDir;if(!isAdditionalAccountId(row.id))throw new HttpError(400,'Invalid private account identity');return join(this.store.dataDir,'accounts',row.id);}
 descriptor(row:AccountRecord):AccountDescriptor {if(row.isDefault||!['openai','claude','cursor'].includes(row.providerId))throw new HttpError(400,'Only additional subscription accounts have isolated profiles');return {accountId:row.id,providerId:row.providerId as AccountDescriptor['providerId'],isolated:true,profileGeneration:row.profileGeneration};}
}
