import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRoutingFixtures} from '../scripts/evaluate-routing-fixtures.js';
test('offline routing fixture evaluator checks labeled preference and safety/fallback invariants without model calls',async()=>{
 const report=await evaluateRoutingFixtures();assert.equal(report.kind,'deterministic-routing-fixture-evaluation');assert.equal(report.liveModelCalls,0);assert.ok(report.total>=10);assert.equal(report.failed,0,JSON.stringify(report.cases));assert.equal(report.passed,report.total);assert.equal(report.preferenceLabels.matched,report.preferenceLabels.total);assert.ok(report.preferenceLabels.total>0);assert.equal(report.coverage.rulesFallbacks,3);assert.equal(report.coverage.manualRoutes,1);assert.match(report.limitations,/semantic|real-world/);
});
