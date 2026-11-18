import { useRef, useState, type DragEvent } from 'react';
import { LoaderCircle, Trash2, Upload } from 'lucide-react';
import type { Agent } from '../shared/types';
import { Avatar } from './UI';
import { prepareAvatarImage } from './avatar-image';
import './avatar-photo.css';

/**
 * Thumbnail picker for the bot editor. `value` is undefined while unchanged, a data URL for a new photo, or null to remove it.
 */
export function AvatarPhotoField({ agent, color, value, onChange }: { agent: Agent; color: string; value: string | null | undefined; onChange: (value: string | null | undefined) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const current = value === undefined ? agent.avatar ?? null : value;
  const preview: Agent = { ...agent, color, avatar: current };
  async function take(list: FileList | File[] | null) {
    const file = list?.[0];
    if (!file || busy) return;
    setBusy(true); setMessage('');
    try { onChange(await prepareAvatarImage(file)); }
    catch (failure) { setMessage((failure as Error).message); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  return <fieldset className="avatar-photo-field"><legend>Thumbnail photo</legend>
    <div className={'avatar-photo-drop' + (dragging ? ' dragging' : '')}
      onDragEnter={event => { if (!hasFiles(event)) return; event.preventDefault(); setDragging(true); }}
      onDragOver={event => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={event => { if (!hasFiles(event)) return; event.preventDefault(); setDragging(false); void take(event.dataTransfer.files); }}>
      <Avatar agent={preview} large/>
      <div className="avatar-photo-text">
        <strong>{dragging ? 'Drop the image to use it' : 'Drag and drop an image here'}</strong>
        <small>PNG, JPEG or WebP. It is cropped to a square and shrunk automatically.{value !== undefined && ' Save changes to apply it.'}</small>
        <div className="avatar-photo-actions">
          <button type="button" className="secondary small" disabled={busy} onClick={() => input.current?.click()}>{busy ? <LoaderCircle size={13} className="spin"/> : <Upload size={13}/>} Choose image</button>
          {current && <button type="button" className="secondary small" disabled={busy} onClick={() => onChange(null)}><Trash2 size={13}/> Remove photo</button>}
          {value !== undefined && <button type="button" className="secondary small" disabled={busy} onClick={() => { setMessage(''); onChange(undefined); }}>Undo change</button>}
        </div>
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Thumbnail image file" onChange={event => void take(event.target.files)}/>
    </div>
    {message && <p className="form-error avatar-photo-status" role="alert">{message}</p>}
  </fieldset>;
}
