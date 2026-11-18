import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { Agent } from '../shared/types';

const photoStyle: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit', display: 'block' };
export function Avatar({ agent, large = false }: { agent: Agent; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [agent.avatar]);
  const photo = typeof agent.avatar === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/.test(agent.avatar) && !failed ? agent.avatar : '';
  return <span aria-hidden="true" className={`avatar avatar-flat ${large ? 'large' : ''}`} style={{ '--avatar-color': /^#[0-9a-f]{3,8}$/i.test(agent.color) ? agent.color : '#657e70', ...(photo ? { position: 'relative', overflow: 'hidden' } : {}) } as React.CSSProperties}>{photo ? <img src={photo} alt="" style={photoStyle} onError={() => setFailed(true)} /> : <span>{agent.initials || agent.name.slice(0, 2)}</span>}</span>;
}
export function IconButton({ label, children, onClick, className = '', disabled = false }: { label: string; children: ReactNode; onClick: () => void; className?: string; disabled?: boolean }) {
  return <button type="button" title={label} aria-label={label} onClick={onClick} className={`icon-button ${className}`} disabled={disabled}>{children}</button>;
}
export function Modal({ title, children, close, wide = false, initialFocus = 'field' }: { title: string; children: ReactNode; close: () => void; wide?: boolean; initialFocus?: 'field' | 'dialog' }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    if (initialFocus === 'dialog') ref.current?.focus({ preventScroll: true });
    else {
      const firstField = Array.from(ref.current?.querySelectorAll<HTMLElement>('input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled)') || []).find(node => node.getClientRects().length > 0);
      (firstField || ref.current?.querySelector<HTMLElement>('button:not(:disabled)') || ref.current)?.focus();
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key === 'Tab') {
        const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled):not([type="hidden"]),textarea:not(:disabled),select:not(:disabled),a[href],summary') || []).filter(node => node.getClientRects().length > 0);
        if (!nodes.length) return;
        if (document.activeElement === ref.current) { event.preventDefault(); (event.shiftKey ? nodes.at(-1) : nodes[0])?.focus(); }
        else if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="modal-shade" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}><div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={`modal ${wide ? 'wide' : ''}`}><header><div className="modal-heading"><h2 id={titleId}>{title}</h2></div><IconButton label="Close dialog" onClick={close}><X size={18}/></IconButton></header>{children}</div></div>;
}


