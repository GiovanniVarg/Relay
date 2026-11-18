import { Reply, X } from 'lucide-react';
import {useMemo} from 'react';
import { replyExcerpt } from './chat-input';

export function MessageReply({ author, message, onJump, onCancel }: { author: string; message?: { content: string; attachments?: unknown[] }; onJump?: () => void; onCancel?: () => void }) {
  const excerpt=useMemo(()=>replyExcerpt(message),[message?.content,message?.attachments?.length]);
  const content = <><strong>{onCancel ? `Replying to ${author}` : author}</strong><span>{excerpt}</span></>;
  return <div className={`reply-quote ${onCancel ? 'composer-reply' : ''}`}>
    <Reply size={15} aria-hidden="true"/>
    {onJump ? <button type="button" className="reply-quote-content" onClick={onJump} aria-label={`View original message from ${author}`}>{content}</button> : <div className="reply-quote-content">{content}</div>}
    {onCancel && <button type="button" className="reply-cancel" aria-label="Cancel reply" title="Cancel reply" onClick={onCancel}><X size={16}/></button>}
  </div>;
}
