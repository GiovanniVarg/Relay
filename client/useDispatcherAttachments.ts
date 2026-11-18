import {scopedSessionStorage as sessionStorage} from './controller-scope';
import {useEffect,useRef,useState} from 'react';
import {ATTACHMENT_LIMITS,type MessageAttachment} from '../shared/attachments';
import type {SecureCredentialApi} from './useSecureCredentialEntry';

const storageKey='relay.dispatcher.draft';
function savedDraft(){try{const id=sessionStorage.getItem(storageKey);if(id&&/^[a-zA-Z0-9_-]{1,100}$/.test(id))return id;}catch{}return crypto.randomUUID();}
function saveDraft(id:string){try{sessionStorage.setItem(storageKey,id);}catch{}}

/** Only the opaque owner is persisted in the browser; protected drafts remain recoverable on the host. */
export function useDispatcherAttachments(api:SecureCredentialApi,notice:(text:string)=>void){
 const [draftId,setDraftId]=useState(savedDraft),[items,setItems]=useState<MessageAttachment[]>([]),[uploading,setUploading]=useState(false);
 const owner=useRef(draftId),alive=useRef(true),locked=useRef(false),values=useRef(items),input=useRef<HTMLInputElement>(null),apiRef=useRef(api),noticeRef=useRef(notice);
 const consumed=useRef(new Set<string>());
 apiRef.current=api;noticeRef.current=notice;
 function replace(next:MessageAttachment[]){values.current=next;setItems(next);}
 function merge(found:MessageAttachment[]){replace([...new Map([...values.current,...found.filter(item=>!consumed.current.has(item.id))].map(item=>[item.id,item])).values()]);}
 const basePath='/dispatcher/drafts/'+encodeURIComponent(draftId)+'/attachments';
 useEffect(()=>{alive.current=true;saveDraft(draftId);const scope=draftId;let active=true;void apiRef.current<MessageAttachment[]>('/dispatcher/drafts/'+encodeURIComponent(scope)+'/attachments').then(found=>{if(active&&owner.current===scope&&Array.isArray(found))merge(found);}).catch(()=>{});return()=>{active=false;alive.current=false;};},[draftId]);
 async function upload(list:FileList|File[]|null){
  if(!list?.length||locked.current)return;
  locked.current=true;setUploading(true);const scope=owner.current,path='/dispatcher/drafts/'+encodeURIComponent(scope)+'/attachments';
  try{
   const files=Array.from(list);
   if(values.current.length+files.length>8)throw Error('Attach up to eight files per request.');
   if(values.current.filter(item=>item.kind==='image').length+files.filter(file=>file.type.startsWith('image/')).length>ATTACHMENT_LIMITS.images)throw Error('Attach up to '+ATTACHMENT_LIMITS.images+' images per request.');
   for(const file of files)if(file.size>ATTACHMENT_LIMITS.bytes)throw Error(file.name+' exceeds 4 MiB. Choose a smaller file.');
   for(const file of files){
    if(!alive.current||owner.current!==scope)return;
    const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('Could not read '+file.name));reader.readAsDataURL(file);});
    if(!alive.current||owner.current!==scope)return;
    const mimeType=file.type||(/\.txt$/i.test(file.name)?'text/plain':/\.docx$/i.test(file.name)?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':/\.pdf$/i.test(file.name)?'application/pdf':'');
    const item=await apiRef.current<MessageAttachment>(path,'POST',{name:file.name,mimeType,base64});
    if(alive.current&&owner.current===scope)merge([item]);
   }
  }catch(error){if(alive.current&&owner.current===scope){noticeRef.current('Could not attach file: '+(error instanceof Error?error.message:'Try again.'));try{const found=await apiRef.current<MessageAttachment[]>(path);if(alive.current&&owner.current===scope&&Array.isArray(found))merge(found);}catch{}}}
  finally{locked.current=false;if(alive.current){setUploading(false);if(input.current)input.current.value='';}}
 }
 async function remove(id:string){
  if(locked.current)return;locked.current=true;setUploading(true);const scope=owner.current;
  try{await apiRef.current('/dispatcher/drafts/'+encodeURIComponent(scope)+'/attachments/'+encodeURIComponent(id),'DELETE');if(alive.current&&owner.current===scope)replace(values.current.filter(item=>item.id!==id));}
  catch{if(alive.current&&owner.current===scope)noticeRef.current('Attachment could not be removed. Your draft is kept.');}
  finally{locked.current=false;if(alive.current)setUploading(false);}
 }
 function accepted(scope:string,ids:readonly string[]){
  if(owner.current!==scope)return;for(const id of ids)consumed.current.add(id);
  const remaining=values.current.filter(item=>!consumed.current.has(item.id));replace(remaining);
  // A delayed acceptance must not discard files staged after its request was sent.
  if(remaining.length||locked.current)return;const next=crypto.randomUUID();owner.current=next;setDraftId(next);saveDraft(next);
 }
 return {draftId,items,uploading,input,basePath,upload,remove,accepted,isUploading:()=>locked.current};
}
