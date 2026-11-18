import type {MessageAttachment} from '../shared/attachments';

/** The caller supplies a host-owned API route; attachment metadata is always rendered as text. */
export function AttachmentList({attachments,basePath,messageId,disabled=false,onRemove,label='Message attachments'}:{attachments:MessageAttachment[];basePath:string;messageId?:string;disabled?:boolean;onRemove?:(id:string)=>void|Promise<void>;label?:string}){
 return <div className="input-attachments" aria-label={label}>{attachments.map(item=>{
  const url=basePath.replace(/\/$/,'')+'/'+encodeURIComponent(item.id)+(messageId?'?messageId='+encodeURIComponent(messageId):'');
  return <span className="attachment-chip" key={item.id}><a href={url} target="_blank" rel="noreferrer">{item.kind==='image'&&<img src={url} alt=""/>}<span>{item.name}</span></a><small>{item.kind==='image'?'Image':item.extraction?.truncated?'Extracted text truncated':(item.extraction?.characters??0)+' characters extracted'}</small>{onRemove&&<button type="button" aria-label={'Remove attachment '+item.name} disabled={disabled} onClick={()=>void onRemove(item.id)}>×</button>}</span>;
 })}</div>;
}
