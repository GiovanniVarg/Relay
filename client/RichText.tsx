import {createContext, memo, useContext, useId, type ComponentPropsWithoutRef} from 'react';
import Markdown, {type Components} from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Treat every message as untrusted. Relative URLs could invoke the local Relay
// application, and Markdown images must never make background tracking requests.
function safeDestination(value: string | undefined): string | undefined {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return undefined;
  if (value.startsWith('#')) return value;
  if (!/^(?:https?:\/\/|mailto:)/i.test(value)) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname) return value;
    if (url.protocol === 'mailto:' && url.pathname) return value;
  } catch { /* Invalid destinations remain readable text. */ }
  return undefined;
}

const InsideLink = createContext(false);
const remarkPlugins = [remarkGfm];

function SafeLink({href, children, ...props}: ComponentPropsWithoutRef<'a'>) {
  const destination = safeDestination(href);
  if (!destination) return <>{children}</>;
  if (destination.startsWith('#')) return <a {...props} href={destination}><InsideLink value={true}>{children}</InsideLink></a>;
  return <a {...props} href={destination} target="_blank" rel="noopener noreferrer">
    <InsideLink value={true}>{children}</InsideLink><span className="rich-text-new-tab"> (opens in a new tab)</span>
  </a>;
}

function MarkdownImage({src, alt, title}: {src?: string; alt?: string; title?: string}) {
  const insideLink = useContext(InsideLink);
  const label = <span className="rich-text-image">Image: {alt || 'attachment'}</span>;
  return insideLink ? label : <SafeLink href={src} title={title}>{label}</SafeLink>;
}

const components: Components = {
  a: ({node, ...props}) => <SafeLink {...props}/>,
  img: ({src, alt, title}) => <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt} title={title}/>,
  table: ({children}) => <div className="rich-text-table" role="region" aria-label="Message table" tabIndex={0}>
    <table>{children}</table>
  </div>,
};

export const RichText = memo(function RichText({content}: {content: string}) {
  const id = useId();
  return <div className="rich-text">
    <Markdown remarkPlugins={remarkPlugins} remarkRehypeOptions={{clobberPrefix: `rich-text-${id}-`}} skipHtml urlTransform={value => safeDestination(value)} components={components}>
      {content}
    </Markdown>
  </div>;
});

export default RichText;
