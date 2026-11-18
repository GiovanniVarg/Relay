import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { AssignmentTarget } from './chat-assignments.js';

export class AssignmentError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = 'AssignmentError'; }
}
export type MentionToken = { start: number; end: number; target: AssignmentTarget };
type Node = { type: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
const excluded = new Set(['code', 'inlineCode', 'blockquote', 'link', 'linkReference', 'image', 'imageReference', 'html', 'definition']);

/** Only explicit, unescaped @Name: / @stableId: tokens in ordinary Markdown text invoke work. */
export function parseAssignmentMentions(content: string, targets: AssignmentTarget[]) {
  const tokens: MentionToken[] = [];
  const byId = new Map(targets.map(target => [target.kind === 'computer' ? `computer/${target.id}` : target.id, target]));
  const tree = unified().use(remarkParse).parse(content) as Node;
  // Inline HTML is represented as siblings; track paired/nested tags using only AST HTML nodes.
  const htmlRanges: [number, number][] = [], openTags: { name: string; start: number }[] = [];
  function collectHtml(node: Node) {
    if (node.type === 'html') {
      const start = node.position?.start.offset ?? 0, end = node.position?.end.offset ?? start;
      for (const match of content.slice(start, end).matchAll(/<\/?([A-Za-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/g)) {
        const name = match[1].toLowerCase(), offset = start + match.index!;
        if (match[0].startsWith('</')) {
          let index = openTags.length - 1;
          while (index >= 0 && openTags[index].name !== name) index--;
          if (index >= 0) { htmlRanges.push([openTags[index].start, offset + match[0].length]); openTags.splice(index); }
        } else if (!match[0].endsWith('/>') && !/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name)) openTags.push({ name, start: offset });
      }
    }
    node.children?.forEach(collectHtml);
  }
  collectHtml(tree);
  htmlRanges.push(...openTags.map(tag => [tag.start, content.length] as [number, number]));
  function visit(node: Node) {
    if (excluded.has(node.type)) return;
    if (node.type === 'text') {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const raw = content.slice(start, end);
      for (const match of raw.matchAll(/@([^@\r\n:]+):/g)) {
        const offset = start + match.index!;
        if (htmlRanges.some(([start, end]) => offset >= start && offset < end)) continue;
        let slashes = 0;
        for (let i = offset - 1; i >= 0 && content[i] === '\\'; i--) slashes++;
        if (slashes % 2) continue;
        const label = match[1].trim();
        let target = byId.get(label);
        if (!target) {
          const matches = targets.filter(item => item.name.toLowerCase() === label.toLowerCase());
          if (matches.length > 1) throw new AssignmentError(`Ambiguous assignment mention @${label}:; select a stable ID.`);
          target = matches[0];
        }
        if (!target) throw new AssignmentError(`Unknown assignment mention @${label}:`);
        tokens.push({ start: offset, end: offset + match[0].length, target });
      }
    } else node.children?.forEach(visit);
  }
  visit(tree);
  tokens.sort((a, b) => a.start - b.start);
  const unique = [...new Map(tokens.map(token => [`${token.target.kind}/${token.target.id}`, token.target])).values()];
  const bots = unique.filter(target => target.kind === 'bot');
  const computers = unique.filter(target => target.kind === 'computer');
  if (bots.length > 4) throw new AssignmentError('At most four bots can receive one assignment.');
  if (computers.length > 1) throw new AssignmentError('Choose one computer before assigning work.');
  let prompt = content;
  for (const token of [...tokens].reverse()) prompt = prompt.slice(0, token.start) + prompt.slice(token.end);
  // Every distinct bot receives this same instruction; mention position has no routing significance.
  return { bots, computers, prompt: prompt.trim(), tokens };
}
