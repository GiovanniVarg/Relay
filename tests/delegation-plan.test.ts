import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../server/delegation/plan.js';

test('delegation plan requires one known worker assignment each and an acyclic dependency graph', () => {
  const valid = { assignments: [{ workerId: 'constructor', task: 'research', expectedResult: 'facts' }, { workerId: 'review', task: 'review', expectedResult: 'review', dependsOn: ['constructor'] }] };
  assert.deepEqual(parsePlan(JSON.stringify(valid), ['constructor', 'review']), { assignments: [{ ...valid.assignments[0], dependsOn: [] }, valid.assignments[1]] });
  for (const assignments of [
    [], [valid.assignments[0], valid.assignments[0]],
    [{ ...valid.assignments[0], workerId: 'foreign' }, valid.assignments[1]],
    [{ ...valid.assignments[0], dependsOn: ['review'] }, valid.assignments[1]],
    [{ ...valid.assignments[0], dependsOn: ['constructor'] }, valid.assignments[1]],
    [{ ...valid.assignments[0], provider: 'claude' }, valid.assignments[1]],
    [{ ...valid.assignments[0], task: '' }, valid.assignments[1]],
  ]) assert.throws(() => parsePlan(JSON.stringify({ assignments }), ['constructor', 'review']));
});

test('lead can ask a clarification without dispatch and malformed/extra plan fields fail closed', () => {
  assert.deepEqual(parsePlan('{"question":"Which project?"}', ['worker']), { question: 'Which project?' });
  const fence = String.fromCharCode(96).repeat(3);
  for (const raw of ['null', '[]', fence + 'json\\n{}\\n' + fence, '{"question":""}', '{"question":"Q","assignments":[]}', '{"question":"Q","grant":true}']) assert.throws(() => parsePlan(raw, ['worker']));
});
