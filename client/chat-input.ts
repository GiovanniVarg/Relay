import {unified} from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import {toString} from 'mdast-util-to-string';

const previewParser=unified().use(remarkParse).use(remarkGfm);
type MarkdownNode={type:string;children?:MarkdownNode[]};
function previewText(node:MarkdownNode):string {
  if(node.type==='break')return ' ';
  if(node.children)return node.children.map(previewText).join(['root','blockquote','list','listItem','table','tableRow'].includes(node.type)?' ':'');
  return toString(node,{includeHtml:false});
}

/** Read only files supplied by the paste event; never request clipboard access. */
export function clipboardImages(clipboard: Pick<DataTransfer, 'files' | 'items'>): File[] {
  const supported = (file: File) => /^image\/(png|jpeg|webp)$/i.test(file.type);
  // A browser exposes the same clipboard file through both collections. Prefer files.
  const files = Array.from(clipboard.files).filter(supported);
  const candidates = files.length ? files : Array.from(clipboard.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => !!file && supported(file));
  const seen = new Set<string>();
  return candidates.filter(file => { const key = [file.name, file.type, file.size, file.lastModified].join(':'); if (seen.has(key)) return false; seen.add(key); return true; });
}

export function clipboardHasImages(clipboard: Pick<DataTransfer, 'files' | 'items'>): boolean {
  return Array.from(clipboard.files).some(file=>file.type.startsWith('image/')) || Array.from(clipboard.items).some(item=>item.kind==='file'&&item.type.startsWith('image/'));
}

export function replyExcerpt(message?: { content: string; attachments?: unknown[] }): string {
  if (!message) return 'Original message unavailable';
  return previewText(previewParser.parse(message.content)).replace(/\s+/g, ' ').trim().slice(0, 180) || (message.attachments?.length ? 'Attachment' : 'Message');
}

export const messageAnchor = (scope: string, id: string) => `message-${encodeURIComponent(scope)}-${encodeURIComponent(id)}`;
export function focusReplySource(scope: string, id: string): boolean {
  const source = document.getElementById(messageAnchor(scope, id));
  if (!source) return false;
  source.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  source.focus({ preventScroll: true });
  source.classList.remove('reply-source-highlight');
  void source.offsetWidth;
  source.classList.add('reply-source-highlight');
  return true;
}
