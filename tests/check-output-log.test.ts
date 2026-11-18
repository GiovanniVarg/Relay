import test from 'node:test';
import assert from 'node:assert/strict';
import {CheckOutputLog} from '../server/check-output-log.js';
test('failure details survive chunk boundaries, progress rollover and common credential redaction',()=>{
 const log=new CheckOutputLog();log.append('not ');log.append('ok 1 - named assertion\r\n  ---\r\n  error: expected approved source\n  authorization: Bearer syntheticBearerValue\n  api_key: syntheticApiValue\n  ...\n');
 for(let i=0;i<2000;i++)log.append('ok '+i+' - later successful progress '.repeat(8)+'\n');log.flush();const text=log.text();
 assert.ok(text.startsWith('RETAINED CHECK FAILURES'));assert.ok(text.includes('named assertion'));assert.ok(text.includes('expected approved source'));assert.ok(text.includes('[redacted]'));assert.ok(!text.includes('syntheticBearerValue'));assert.ok(!text.includes('syntheticApiValue'));assert.ok(text.length<=120000);
});
test('oversized lines and many failing blocks have explicit bounded diagnostic loss',()=>{
 const log=new CheckOutputLog();log.append('not ok 1 - oversized failure\n  ---\n  error: '+ 'x'.repeat(2000000));log.append('\n  ...\n');
 for(let i=2;i<=30;i++)log.append('not ok '+i+' - later failure\n  ---\n  error: later assertion\n  ...\n');
 log.append('ok 31 - recovery progress\n');log.flush();const text=log.text();assert.ok(text.length<=120000);assert.ok(text.includes('oversized failure'));assert.ok(text.includes('[failure diagnostic truncated]'));assert.ok(text.includes('Additional failure blocks omitted: 18'));assert.ok(text.endsWith('ok 31 - recovery progress\n'));
});
test('unterminated failure lines flush and ordinary output retains its existing tail bound',()=>{
 const log=new CheckOutputLog();log.append('p'.repeat(150000));assert.equal(log.text().length,120000);log.flush();log.append('\nnot ok 7 - final assertion without newline');log.flush();assert.ok(log.text().includes('not ok 7 - final assertion without newline'));assert.ok(log.text().length<=120000);
});
