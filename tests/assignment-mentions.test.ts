import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAssignmentMentions } from '../shared/assignment-mentions.js';
import type { AssignmentTarget } from '../shared/chat-assignments.js';

const targets: AssignmentTarget[] = [
  { kind: 'bot', id: '11111111-1111-4111-8111-111111111111', name: 'Build Bot', role: 'builder' },
  { kind: 'bot', id: '22222222-2222-4222-8222-222222222222', name: 'Review', role: 'reviewer' },
  { kind: 'computer', id: 'desktop', name: 'My Desktop', role: 'computer' },
];
test('explicit mentions anywhere resolve case-insensitive multiword names and stable IDs', () => {
  const content = 'Please @bUiLd BoT: implement this; @22222222-2222-4222-8222-222222222222: review on @computer/desktop:.';
  const result = parseAssignmentMentions(content, targets);
  assert.equal(result.bots.length, 2);
  assert.equal(result.computers[0].id, 'desktop');
  assert.equal(result.prompt, 'Please  implement this;  review on .');
  assert.equal(content.slice(result.tokens[0].start, result.tokens[0].end), '@bUiLd BoT:');
});
test('repeated bot tokens yield one assignment and plain @Name does not invoke', () => {
  const result = parseAssignmentMentions('@Review: @Review: inspect @Build Bot', targets);
  assert.equal(result.bots.length, 1);
  assert.equal(result.tokens.length, 2);
});
test('Markdown code, quotes, links, images, HTML, and escaped at signs never invoke', () => {
  const content = ['`@Review:`', '```md\n@Review:\n```', '> @Review:',
    '[@Review:](https://example.test)', '![ @Review: ](x.png)', '<b>@Review:</b>', '<b><b>@Review:</b>@Review:</b>', '\\@Review:', '@Review'].join('\n\n');
  assert.equal(parseAssignmentMentions(content, targets).tokens.length, 0);
});
test('unknown names and collisions fail clearly; stable IDs win', () => {
  assert.throws(() => parseAssignmentMentions('@Unknown: do work', targets), /Unknown assignment mention/);
  const collision = [...targets, { ...targets[0], id: 'other', name: 'Review' }];
  assert.throws(() => parseAssignmentMentions('@Review: work', collision), /Ambiguous assignment mention/);
  assert.equal(parseAssignmentMentions(`@${targets[1].id}: work`, collision).bots[0].id, targets[1].id);
});
test('multiple computers and more than four distinct bots fail before admission', () => {
  const more = [...targets, { ...targets[2], id: 'laptop', name: 'Laptop' }];
  assert.throws(() => parseAssignmentMentions('@computer/desktop: @computer/laptop: work', more), /Choose one computer/);
  const bots = Array.from({ length: 5 }, (_, i) => ({ ...targets[0], id: `b${i}`, name: `Bot ${i}` }));
  assert.throws(() => parseAssignmentMentions(bots.map(bot => `@${bot.id}:`).join(' ') + ' work', bots), /At most four/);
});
