import type { SecretVaultLike } from '../server/typesafe.js';
import { IntegrationCredentials } from '../server/integration-credentials.js';
import type { Store } from '../server/store.js';
export class SyntheticVault implements SecretVaultLike {
 values=new Map<string,string>();failSet=false;failGet=false;mismatch=false;failRemove=false;
 availability(){return {available:true,protection:'synthetic-test-only'};}
 async has(name:string){return this.values.has(name);}
 async get(name:string){if(this.failGet)throw Error('synthetic vault unavailable');return this.mismatch?'mismatch':this.values.get(name)??null;}
 async set(name:string,value:string,check?:()=>void){if(this.failSet)throw Error('synthetic write failed');check?.();this.values.set(name,value);}
 async remove(name:string){if(this.failRemove)throw Error('synthetic remove failed');this.values.delete(name);}
 close(){}
}
const credentials=new WeakMap<Store,IntegrationCredentials>();
export function testCredentials(store:Store) {let service=credentials.get(store);if(!service){service=new IntegrationCredentials(store,new SyntheticVault());credentials.set(store,service);}return service;}
