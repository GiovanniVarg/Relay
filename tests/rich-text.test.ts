import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DOMParser} from '@xmldom/xmldom';
import {RichText} from '../client/RichText.js';

async function render(content:string) {
  const html = renderToStaticMarkup(createElement(RichText, {content}));
  const document = new DOMParser().parseFromString(html, 'text/html');
  return {html, document, text: document.documentElement.textContent};
}

test('chat content renders headings, emphasis, nested lists and GFM tables as semantic elements', async () => {
  const {html, document} = await render('# Status\n\n**Ready** and *reviewed*.\n\n1. First\n   - Nested\n2. Second\n\n| Name | Result |\n| --- | --- |\n| Build | Passed |');
  assert.equal(document.getElementsByTagName('h1')[0].textContent, 'Status');
  assert.equal(document.getElementsByTagName('strong')[0].textContent, 'Ready');
  assert.equal(document.getElementsByTagName('em')[0].textContent, 'reviewed');
  assert.equal(document.getElementsByTagName('ol').length, 1);
  assert.equal(document.getElementsByTagName('ul').length, 1);
  assert.equal(document.getElementsByTagName('th')[0].textContent, 'Name');
  assert.equal(document.getElementsByTagName('td')[1].textContent, 'Passed');
  assert.doesNotMatch(html, /\*\*Ready\*\*|# Status|\| --- \|/);
});

test('plain URLs and explicit links become safe accessible new-tab links', async () => {
  const {document} = await render('Visit https://example.test/report?q=one&sort=two or www.example.test. [Guide](https://docs.example.test/guide "Reference") and [Mail](mailto:hello@example.test).');
  const links = Array.from(document.getElementsByTagName('a'));
  assert.deepEqual(links.map(link => link.getAttribute('href')), [
    'https://example.test/report?q=one&sort=two', 'http://www.example.test',
    'https://docs.example.test/guide', 'mailto:hello@example.test',
  ]);
  for (const link of links) {
    assert.equal(link.getAttribute('target'), '_blank');
    assert.match(link.getAttribute('rel')!, /\bnoopener\b/);
    assert.match(link.getAttribute('rel')!, /\bnoreferrer\b/);
    assert.match(link.textContent!, /opens in a new tab/);
  }
  assert.equal(links[2].getAttribute('title'), 'Reference');
});

test('code keeps Markdown, unsafe-looking HTML, URLs and whitespace literal', async () => {
  const source = '**literal**\n  <script>alert(1)</script>\nhttps://example.test\n';
  const {document} = await render('`**inline**`\n\n```html\n' + source + '```');
  const code = document.getElementsByTagName('code');
  assert.equal(code[0].textContent, '**inline**');
  assert.equal(document.getElementsByTagName('pre')[0].textContent, source);
  assert.equal(document.getElementsByTagName('script').length, 0);
  assert.equal(document.getElementsByTagName('a').length, 0);
});

test('raw HTML cannot create active elements or attributes', async () => {
  const {document, text} = await render('Before <img src="https://tracker.test/pixel" onerror="alert(1)"> after\n\n<script>alert(2)</script>\n\n<iframe src="https://tracker.test"></iframe>\n\n[Safe](https://example.test/ "&quot; onclick=&quot;alert(3)")');
  for (const tag of ['script', 'img', 'iframe', 'style', 'object', 'svg']) {
    assert.equal(document.getElementsByTagName(tag).length, 0, tag);
  }
  for (const element of Array.from(document.getElementsByTagName('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      assert.doesNotMatch(attribute.name, /^(?:on|src|srcdoc)/i);
    }
  }
  assert.match(text!, /Before.*after/s);
});

test('script, data, filesystem, relative and obfuscated link destinations have no navigation authority', async () => {
  const unsafe = ['javascript:alert%281%29', 'JaVaScRiPt:alert%281%29', 'java&#x73;cript:alert%281%29', 'java&#x09;script:alert%281%29', 'data:text/html,boom', 'vbscript:msgbox%281%29', 'file:///C:/secrets.txt', '//tracker.test/path', '/api/dangerous', 'relative/path', 'ftp://files.example.test', 'https:example.test'];
  for (const url of unsafe) {
    const {document, text} = await render(`[Keep label](${url})`);
    assert.equal(document.getElementsByTagName('a').length, 0, url);
    assert.match(text!, /Keep label/, url);
  }
});

test('Markdown images are opt-in links and never load remote tracking content', async () => {
  const {html, document, text} = await render('![Diagram](https://tracker.test/image.png) ![Blocked](data:image/svg+xml,evil)');
  assert.equal(document.getElementsByTagName('img').length, 0);
  assert.equal(document.getElementsByTagName('a').length, 1);
  assert.equal(document.getElementsByTagName('a')[0].getAttribute('href'), 'https://tracker.test/image.png');
  assert.match(text!, /Diagram/);
  assert.match(text!, /Blocked/);
  assert.doesNotMatch(html, /<(?:link|img|source)\b/i);
});

test('linked Markdown images keep one valid destination without nested anchors', async () => {
  const {document, text} = await render('[![Diagram](https://tracker.test/image.png)](https://example.test/report)');
  const links = document.getElementsByTagName('a');
  assert.equal(links.length, 1);
  assert.equal(links[0].getAttribute('href'), 'https://example.test/report');
  assert.match(text!, /Diagram/);
  assert.equal(document.getElementsByTagName('img').length, 0);
});

test('same-message footnotes keep their accessible local targets', async () => {
  const {document} = await render('A claim[^source].\n\n[^source]: A source.');
  const links = Array.from(document.getElementsByTagName('a'));
  const reference = links.find(link => link.hasAttribute('data-footnote-ref'));
  assert.ok(reference);
  assert.equal(reference.hasAttribute('target'), false);
  assert.ok(document.getElementById(reference.getAttribute('href')!.slice(1)));
  assert.ok(document.getElementById(reference.getAttribute('aria-describedby')!));
});

test('repeated footnote labels in separate messages target their own source', () => {
  const content = 'A claim[^source].\n\n[^source]: A source.';
  const html = renderToStaticMarkup(createElement('div', null,
    createElement(RichText, {content}), createElement(RichText, {content})));
  const document = new DOMParser().parseFromString(html, 'text/html');
  const references = Array.from(document.getElementsByTagName('a')).filter(link => link.hasAttribute('data-footnote-ref'));
  assert.equal(references.length, 2);
  assert.notEqual(references[0].getAttribute('href'), references[1].getAttribute('href'));
  for (const reference of references) {
    const target = document.getElementById(reference.getAttribute('href')!.slice(1));
    assert.ok(target);
    const backlink = target.getElementsByTagName('a')[0];
    assert.equal(backlink.getAttribute('href'), '#' + reference.getAttribute('id'));
  }
});

test('empty and streaming partial messages stay renderable without losing their text', async () => {
  assert.equal((await render('')).text, '');
  assert.match((await render('Starting **the')).text!, /Starting \*\*the/);
  assert.equal((await render('```ts\nconst next = "partial')).document.getElementsByTagName('code')[0].textContent, 'const next = "partial\n');
});
