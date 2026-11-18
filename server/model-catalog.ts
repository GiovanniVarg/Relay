import {createHash} from 'node:crypto';
import type {ModelCatalogPage,ModelCatalogQuery,ProviderState} from '../shared/types.js';
import {HttpError} from './security.js';
import {enabledModels} from './router.js';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Complete cached catalog, never a paged routing allowlist. Cursor binds query and catalog scope. */
export function searchModelCatalog(states:ProviderState[],input:ModelCatalogQuery={},maxWireCharacters?:number):ModelCatalogPage {
 if(states.length!==1)throw new HttpError(404,'Choose one provider catalog');
 const state=states[0],limit=input.limit??50;
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new HttpError(400,'Catalog limit must be an integer from 1 to 100');
 if(typeof(input.query??'')!=='string'||(input.query?.length??0)>200||typeof(input.backendProviderId??'')!=='string'||(input.backendProviderId?.length??0)>200)throw new HttpError(400,'Invalid model search');
 if(input.enabledOnly!==undefined&&typeof input.enabledOnly!=='boolean')throw new HttpError(400,'enabledOnly must be boolean');
 const query=(input.query??'').trim().toLocaleLowerCase('en-US'),backend=input.backendProviderId??'';
 const revision=hash([state.id,...(state.accountId&&!state.isDefault&&!state.accountId.startsWith('default-')?[state.accountId,state.profileGeneration??null]:[]),state.connectionScope??null,state.models.map(({provenance,...model})=>({...model,provenance:provenance?{source:provenance.source,revision:provenance.revision}:undefined}))]);
 const source=input.enabledOnly?enabledModels(state):state.models,binding=hash([query,backend,!!input.enabledOnly,input.enabledOnly?[state.modelPreferences,state.billing.mode,source.map(model=>model.id)]:null]);
 const rows=source.filter(model=>(!backend||model.backendProviderId===backend)&&(!query||[model.id,model.name,model.description,model.backendProviderId,model.backendProviderName].filter(Boolean).join(' ').toLocaleLowerCase('en-US').includes(query))).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 let offset=0;
 if(input.cursor!==undefined){try{if(typeof input.cursor!=='string'||input.cursor.length>1024)throw Error();const value=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));if(value.revision!==revision)throw new HttpError(409,'Model catalog or connection changed; restart the search');if(value.binding!==binding||!Number.isSafeInteger(value.offset)||value.offset<0||value.offset>rows.length)throw Error();offset=value.offset;}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'Invalid model catalog cursor');}}
 const base={provider:state.id,...(state.accountId?{accountId:state.accountId}:{}),revision,observedAt:state.models.find(model=>model.provenance)?.provenance?.observedAt??null,total:rows.length,...(state.connectionScope?{connectionScope:state.connectionScope}:{})};
 const page=(items:typeof rows):ModelCatalogPage=>({...base,items,nextCursor:offset+items.length<rows.length?Buffer.from(JSON.stringify({revision,binding,offset:offset+items.length})).toString('base64url'):null,...(maxWireCharacters?{metadataSummary:true as const}:{})});
 const candidates=rows.slice(offset,offset+limit);if(maxWireCharacters===undefined)return page(candidates);
 const items:typeof rows=[];
 for(const row of candidates){
  const {id,name,verified,contextWindow,outputLimit,toolCalling,reasoning,local,inputModalities,inputModalitiesSource,imageModelBinding}=row;
  const summary={id,name:name.slice(0,256),verified,...(row.description?{description:row.description.slice(0,160)}:{}),...(row.backendProviderId?{backendProviderId:row.backendProviderId.slice(0,200)}:{}),...(row.backendProviderName?{backendProviderName:row.backendProviderName.slice(0,160)}:{}),contextWindow,outputLimit,toolCalling,reasoning,local,inputModalities,inputModalitiesSource,...(imageModelBinding?{imageModelBinding:{model:imageModelBinding.model.slice(0,200),contract:imageModelBinding.contract.slice(0,100)}}:{}),...(row.provenance?{provenance:{source:row.provenance.source.slice(0,100),observedAt:row.provenance.observedAt}}:{})};
  if(JSON.stringify(page([...items,summary])).length>maxWireCharacters){if(!items.length)throw new HttpError(413,'One model summary exceeds the tool catalog budget');break;}
  items.push(summary);
 }
 return page(items);
}
