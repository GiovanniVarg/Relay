import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {RoutingFeedback} from '../client/RoutingFeedback.js';
import type {RoutingObservation} from '../server/routing-insights.js';
test('operator feedback buttons do not impersonate agent or legacy votes and render source labels',()=>{
 const render=(row:Partial<RoutingObservation>)=>renderToStaticMarkup(createElement(RoutingFeedback,{row:{id:'fixture',model:'m',feedback:null,...row} as RoutingObservation,onFeedback:()=>{}}));
 const agent=render({feedback:'helpful',feedbackSource:'agent-recorded',agentFeedback:'helpful'});assert.match(agent,/Agent recorded: Helpful/);assert.equal((agent.match(/aria-pressed="false"/g)??[]).length,2);
 const legacy=render({feedback:'helpful'});assert.match(legacy,/Unverified feedback: Helpful/);assert.equal((legacy.match(/aria-pressed="false"/g)??[]).length,2);
 const direct=render({feedback:'unhelpful',feedbackSource:'direct-operator',operatorFeedback:'unhelpful',agentFeedback:'helpful'});assert.match(direct,/Direct operator feedback: Missed/);assert.match(direct,/Agent recorded: Helpful/);assert.match(direct,/aria-label="Mark m result unhelpful" aria-pressed="true"/);assert.match(direct,/aria-label="Mark m result helpful" aria-pressed="false"/);
});
