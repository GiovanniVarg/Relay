import test from 'node:test';
import assert from 'node:assert/strict';
import type {Agent} from '../shared/types';
import {getMentionTrigger,filterMentionAgents,insertBotMention,mentionToken,resolveMentionAgent} from '../client/bot-mentions';
const bot=(id:string,name:string,role='Builder')=>({id,name,role} as Agent),a=bot('a','Billy Bob'),b=bot('b','Mira','Reviewer'),agents=[a,b];
test('mention trigger requires collapsed caret and a standalone at-sign, including multiword queries',()=>{
 for(const value of ['mail@example.com','https://a.test/@bob','@bob: task','hi @a\nnext','@@bob'])assert.equal(getMentionTrigger(value,value.length,value.length),null,value);
 assert.deepEqual(getMentionTrigger('hey @Billy B',12,12),{start:4,end:12,query:'Billy B'});
 assert.equal(getMentionTrigger('@Mira',2,5),null);assert.equal(getMentionTrigger('@x',-1,-1),null);assert.equal(getMentionTrigger('@'+'a'.repeat(81),82,82),null);
 assert.deepEqual(getMentionTrigger('@',1,1),{start:0,end:1,query:''});
});
test('picker lists every bot and filters names and roles case-insensitively without changing roster order',()=>{
 assert.deepEqual(filterMentionAgents(agents,''),agents);assert.deepEqual(filterMentionAgents(agents,'BILLY B'),[a]);assert.deepEqual(filterMentionAgents(agents,'review'),[b]);assert.deepEqual(filterMentionAgents(agents,'missing'),[]);
});
test('insertion preserves surrounding draft, suffix and caret, completes names and consumes existing delimiter',()=>{
 for(const [value,caret,expected] of [['ask @bi please',7,'ask @Billy Bob: please'],['@Billy Bob: task',3,'@Billy Bob: task'],['@mi: task',3,'@Billy Bob: task']] as const){const t=getMentionTrigger(value,caret,caret)!;const next=insertBotMention(value,t,a,agents);assert.equal(next?.value,expected);assert.equal(next?.caret,(expected.startsWith('ask')?4:0)+'@Billy Bob: '.length);}
 const t=getMentionTrigger('@mi',3,3)!;assert.equal(insertBotMention('@mi',t,b,agents,4),null);assert.equal(insertBotMention('@mi',t,b,agents,16000,'')?.value,'@Mira');
});
test('duplicate or delimiter-bearing names insert stable IDs so Boss cannot silently misassign',()=>{
 const upper=bot('upper','BOB'),lower=bot('lower','bob');assert.equal(mentionToken(upper,[upper,lower]),'@upper: ');assert.equal(mentionToken(lower,[upper,lower]),'@lower: ');assert.equal(mentionToken(bot('unsafe','A: B'),agents),'@unsafe: ');assert.equal(mentionToken(b,agents),'@Mira: ');
});
test('ID/name collisions resolve an exact stable ID and never choose an ambiguous display name',()=>{
 const x=bot('id-x','X'),y=bot('id-y','id-x'),z=bot('id-z','id-y'),roster=[x,y,z];
 assert.equal(mentionToken(y,roster),'@id-y: ');assert.equal(resolveMentionAgent(roster,'id-y')?.id,'id-y');
 const upper=bot('u','BOB'),lower=bot('l','bob');assert.equal(resolveMentionAgent([upper,lower],'BOB'),null);assert.equal(resolveMentionAgent([upper,lower],'l')?.id,'l');
});