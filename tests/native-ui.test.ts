import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { RunInteractions } from '../client/Interactions.js';
import type { RunInteraction } from '../shared/types.js';

const { renderToString } = createRequire(import.meta.url)('react-dom/server') as { renderToString: (element: ReactNode) => string };
const questionIds = ['constructor', '__proto__', 'toString'];
const interaction: RunInteraction = {
  id: 'interaction-ui', runId: 'run-ui', provider: 'openai', status: 'pending', kind: 'question',
  title: 'Choose what happens next', description: 'Answer each provider question.',
  questions: questionIds.map(id => ({ id, question: `Question ${id}`, options: ['Keep', 'Change'] })),
};
const key = `${interaction.runId}:${interaction.id}`;

function renderAnswers(answers: Record<string, string[]>) {
  const state: Parameters<typeof RunInteractions>[0]['state'] = {
    entries: { [key]: interaction }, answers: { [key]: answers }, errors: {}, submitting: {},
    receive: () => {}, resolve: () => {}, finish: () => {}, reconcile: async () => {}, updateAnswers: () => {}, respond: async () => {},
  };
  return renderToString(createElement(RunInteractions, { runId: interaction.runId, state, returnFocus: () => {} }));
}
function questionOptions(html: string, questionId: string) {
  const question = html.split(`<legend>Question ${questionId}</legend>`)[1]?.split('</fieldset>')[0];
  assert.ok(question, `question ${questionId} is rendered`);
  const inputs = question.match(/<input[^>]*type="radio"[^>]*>/g) || [];
  assert.equal(inputs.length, 2, `question ${questionId} has both options`);
  return inputs;
}

test('native questions with Object prototype names render unanswered without crashing', () => {
  const html = renderAnswers({});
  for (const id of questionIds) for (const input of questionOptions(html, id)) assert.doesNotMatch(input, /checked=/);
  assert.match(html, /<button type="submit" class="primary" disabled=""/);
});

test('inherited answer arrays do not select or complete native questions', () => {
  const inherited = Object.fromEntries(questionIds.map(id => [id, ['Keep']]));
  const html = renderAnswers(Object.create(inherited) as Record<string, string[]>);
  for (const id of questionIds) for (const input of questionOptions(html, id)) assert.doesNotMatch(input, /checked=/);
  assert.match(html, /<button type="submit" class="primary" disabled=""/);
});

test('own answers for prototype-named native questions render selected and enable submission', () => {
  const html = renderAnswers(Object.fromEntries(questionIds.map((id, index) => [id, [index === 1 ? 'Change' : 'Keep']])));
  for (const [index, id] of questionIds.entries()) {
    const options = questionOptions(html, id);
    const selected = index === 1 ? 1 : 0;
    assert.match(options[selected], /checked=""/);
    assert.doesNotMatch(options[1 - selected], /checked=/);
  }
  assert.match(html, /<button type="submit" class="primary">/);
});

test('simultaneous direct questions show exact request prefixes for conversational replies', () => {
  const requests = [
    { ...interaction, id: 'direct-color', title: 'Choose color', questions: [{ id: 'color', question: 'Which color?' }] },
    { ...interaction, id: 'direct-size', title: 'Choose size', questions: [{ id: 'size', question: 'Which size?' }] },
  ];
  const state: Parameters<typeof RunInteractions>[0]['state'] = {
    entries: Object.fromEntries(requests.map(request => [`${request.runId}:${request.id}`, request])), answers: {}, errors: {}, submitting: {},
    receive: () => {}, resolve: () => {}, finish: () => {}, reconcile: async () => {}, updateAnswers: () => {}, respond: async () => {},
  };
  const html = renderToString(createElement(RunInteractions, { runId: interaction.runId, state, returnFocus: () => {} })).replace(/<!-- -->/g, '');
  for (const request of requests) assert.ok(html.includes(`<code>${request.id}: your answer</code>`), `request ${request.id} supplies its exact typed prefix`);
  assert.match(html, /Several requests are waiting/);
});
