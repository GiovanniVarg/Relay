import {taskRequirements} from '../capabilities.js';
import type {CapabilityRequirementFields} from '../../shared/capabilities.js';
import { HttpError, only, stringValue } from '../security.js';

export interface Assignment extends CapabilityRequirementFields { workerId: string; task: string; expectedResult: string; dependsOn: string[]; }
export type Plan = { question: string } | { assignments: Assignment[] };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'The lead returned an invalid delegation plan');
  return value as Record<string, unknown>;
}
export function parsePlan(text: string, workerIds: string[]): Plan {
  if (text.length > 16000) throw new HttpError(400, 'The lead plan exceeds 16,000 characters');
  let raw: unknown; try { raw = JSON.parse(text); } catch { throw new HttpError(400, 'The lead did not return a valid JSON delegation plan'); }
  const body = object(raw);
  if (Object.hasOwn(body, 'question')) {
    only(body, ['question']); const question = stringValue(body.question, 'Clarifying question', 2000, 1).trim();
    if (!question) throw new HttpError(400, 'The clarifying question is empty');
    return { question };
  }
  only(body, ['assignments']);
  if (!Array.isArray(body.assignments) || !body.assignments.length || body.assignments.length > workerIds.length) throw new HttpError(400, 'The lead must assign one task to each worker it needs, using selected workers only');
  const known = new Set(workerIds); const seen = new Set<string>();
  const assignments = body.assignments.map(value => {
    const item = object(value); only(item, ['workerId', 'task', 'expectedResult', 'dependsOn','requiredCapabilities','requiredInputModalities']);
    const workerId = stringValue(item.workerId, 'Worker ID', 100, 1);
    if (!known.has(workerId) || seen.has(workerId)) throw new HttpError(400, 'The lead selected an unknown or duplicate worker');
    seen.add(workerId);
    const task = stringValue(item.task, 'Worker task', 8000, 1).trim();
    const expectedResult = stringValue(item.expectedResult, 'Expected result', 4000, 1).trim();
    if (!task || !expectedResult) throw new HttpError(400, 'Worker task and expected result must be nonempty');
    const deps = item.dependsOn ?? [];
    if (!Array.isArray(deps) || deps.length > workerIds.length || deps.some(id => typeof id !== 'string' || !known.has(id) || id === workerId) || new Set(deps).size !== deps.length) throw new HttpError(400, 'Worker dependencies are invalid');
    return { workerId, task, expectedResult, dependsOn: deps as string[],...taskRequirements(item) };
  });
  if (assignments.some(item => item.dependsOn.some(id => !seen.has(id)))) throw new HttpError(400, 'Worker dependencies must refer to assigned workers');
  const graph = new Map(assignments.map(item => [item.workerId, item.dependsOn])); const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new HttpError(400, 'Worker dependencies contain a cycle');
    if (visited.has(id)) return;
    visiting.add(id); for (const dep of graph.get(id) ?? []) visit(dep); visiting.delete(id); visited.add(id);
  };
  for (const worker of seen) visit(worker);
  return { assignments };
}
