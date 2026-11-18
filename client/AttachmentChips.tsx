import type {MessageAttachment} from '../shared/attachments';
/** Caller supplies the owned chat surface URL; manifests contain no file paths or ownership IDs. */
export function AttachmentChips({attachments,basePath,onRemove,disabled=false}:{attachments:MessageAttachment[];basePath:string;onRemove?:(id:string)=>void;disabled?:boolean}){
 return <div className="input-attachments" aria-label="Message attachments">{attachments.map(item=><span className="attachment-chip" key={item.id}><a href={basePath+'/'+item.id} target="_blank" rel="noreferrer">{item.kind==='image'&&<img src={basePath+'/'+item.id} alt=""/>}<span>{item.name}</span></a><small>{item.kind==='image'?'Image':item.extraction?.truncated?'Extracted text truncated':(item.extraction?.characters??0)+' characters extracted'}</small>{onRemove&&<button type="button" aria-label={'Remove attachment '+item.name} disabled={disabled} onClick={()=>onRemove(item.id)}>×</button>}</span>)}</div>;
}
export function MessageAttachments({attachments,basePath}:{attachments?:MessageAttachment[];basePath:string}){
 return <>{attachments?.map(item=><div className="message-attachment" key={item.id}><a href={basePath+'/'+item.id} target="_blank" rel="noreferrer">{item.kind==='image'&&<img loading="lazy" src={basePath+'/'+item.id} alt={item.name}/>}<span>{item.name}</span></a>{item.extraction&&<small>{item.extraction.characters} characters extracted{item.extraction.truncated?' · truncated':''}</small>}</div>)}</>;
}
