import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {RunUsage} from '../client/Usage.js';
import {normalizeUsage} from '../shared/provider-usage.js';
import type {Run} from '../shared/types.js';
test('compact and advanced run UI show whitelisted reported zero/unknown/source without raw provider fields',()=>{
 const meta={provider:'cursor' as const,accountKey:'opaque',source:'provider-response' as const,scope:'run' as const,observedAt:'2026-10-26T12:00:00Z'},usageObservation=normalizeUsage({inputTokens:0,rawProviderBody:'secret',credential:'secret'},meta),sessionUsage=normalizeUsage({chargedCents:0,inputTokens:20,outputTokens:3},{...meta,source:'cursor-sdk',scope:'agent',sessionId:'session'});
 const run={usageObservation,sessionUsage} as Run;
 for(const advanced of [true,false]){const html=renderToStaticMarkup(createElement(RunUsage,{run,advanced}));assert.match(html,/0 in/);assert.match(html,/unknown out/);assert.match(html,/Session snapshot/);assert.match(html,/historical 0¢/);assert.ok(!html.includes('secret'));assert.ok(!html.includes('opaque'));if(advanced){assert.match(html,/observed/);assert.match(html,/remaining allowance unknown/);}}
 assert.equal(renderToStaticMarkup(createElement(RunUsage,{run:undefined})), '');
});
