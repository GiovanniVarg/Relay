import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {VoiceDictation,browserVoiceFactory,VOICE_DISCLOSURE,type VoiceRecognition,type VoiceEvent,type VoiceState} from '../client/voice-dictation.js';
import {VoiceInput} from '../client/voice-input.js';
class MockRecognition implements VoiceRecognition {
 continuous=false;interimResults=false;lang='';onresult:VoiceRecognition['onresult']=null;onerror:VoiceRecognition['onerror']=null;onend:VoiceRecognition['onend']=null;starts=0;stops=0;aborts=0;
 start(){this.starts++;}stop(){this.stops++;}abort(){this.aborts++;}
 result(text:string,final:boolean,index=0){const results={length:index+1,[index]:{isFinal:final,length:1,0:{transcript:text}}};this.onresult?.({resultIndex:index,results} as VoiceEvent);}
}
function fixture(factory?:()=>VoiceRecognition){const recognition=new MockRecognition(),text:string[]=[],states:VoiceState[]=[];let constructions=0;const dictation=new VoiceDictation({factory:factory??(()=>{constructions++;return recognition;}),onTranscript(value){text.push(value);},onChange(value){states.push(value);}});return{dictation,recognition,text,states,constructions:()=>constructions};}
test('dictation does not construct/start before explicit action; interim stays separate and final text enters only editable callback once',()=>{
 const f=fixture();assert.equal(f.constructions(),0);assert.equal(f.recognition.starts,0);assert.equal(f.dictation.start(),true);assert.equal(f.dictation.start(),false);assert.equal(f.constructions(),1);assert.equal(f.recognition.starts,1);assert.equal(f.recognition.continuous,true);assert.equal(f.recognition.interimResults,true);f.recognition.result('working',false);assert.deepEqual(f.text,[]);assert.equal(f.dictation.state.interim,'working');f.recognition.result(' final editable text ',true);f.recognition.result(' final editable text ',true);assert.deepEqual(f.text,['final editable text']);f.dictation.stop();assert.equal(f.recognition.stops,1);assert.equal(f.dictation.state.phase,'stopping');f.recognition.result('last words',true,1);assert.deepEqual(f.text,['final editable text','last words']);f.recognition.onend?.();assert.equal(f.dictation.state.phase,'idle');f.dictation.dispose();
});
test('scope change/unmount disposal aborts only owned recognizer and ignores already queued callbacks',()=>{
 const f=fixture();f.dictation.start();const queued=f.recognition.onresult!;f.dictation.dispose();f.dictation.dispose();assert.equal(f.recognition.aborts,1);queued({resultIndex:0,results:{length:1,0:{isFinal:true,length:1,0:{transcript:'late old conversation'}}}});assert.deepEqual(f.text,[]);assert.equal(f.dictation.start(),false);assert.equal(f.recognition.onresult,null);
});
test('unsupported, permission, service failure and thrown start are graceful and retry requires a new explicit action',()=>{
 const unsupported=new VoiceDictation({onTranscript(){assert.fail('must not emit');},onChange(){}});assert.equal(unsupported.start(),false);assert.match(unsupported.state.message,/not available/);assert.equal(browserVoiceFactory({}),undefined);
 const f=fixture();f.dictation.start();f.recognition.onerror?.({error:'not-allowed'});assert.match(f.dictation.state.message,/permission was denied/);assert.equal(f.recognition.aborts,1);assert.equal(f.recognition.starts,1);assert.equal(f.dictation.start(),true);f.recognition.onerror?.({error:'network'});assert.match(f.dictation.state.message,/could not connect/);f.dictation.dispose();
 const broken=fixture(()=>{const recognition=new MockRecognition();recognition.start=()=>{throw Error('synthetic start failure');};return recognition;});assert.equal(broken.dictation.start(),false);assert.equal(broken.dictation.state.phase,'error');broken.dictation.dispose();
});
test('browser feature detection supports prefixed API without opening microphone and standalone markup discloses browser processing',()=>{
 let constructions=0;const factory=browserVoiceFactory({webkitSpeechRecognition:class extends MockRecognition{constructor(){super();constructions++;}}});assert.equal(constructions,0);assert.ok(factory);factory!();assert.equal(constructions,1);const html=renderToStaticMarkup(createElement(VoiceInput,{scopeKey:'bot/conversation',recognitionFactory:()=>new MockRecognition(),onTranscript(){assert.fail('render cannot transcribe');}}));assert.match(html,/Start dictation/);assert.match(html,/speech service/);assert.match(html,/type="button"/);assert.match(html,/aria-live="polite"/);assert.equal(html.includes('Send message'),false);assert.ok(VOICE_DISCLOSURE.includes('Review and edit'));
});
test('queued callbacks from a previous start cannot transcribe into a retried recognition session',()=>{
 const f=fixture();f.dictation.start();const stale=f.recognition.onresult!;f.recognition.onerror?.({error:'no-speech'});f.dictation.start();stale({resultIndex:0,results:{length:1,0:{isFinal:true,length:1,0:{transcript:'old attempt'}}}});assert.deepEqual(f.text,[]);f.recognition.result('new attempt',true);assert.deepEqual(f.text,['new attempt']);f.dictation.dispose();
});
test('missing browser end after stop is bounded and releases owned capture without inventing a final transcript',async()=>{
 const recognition=new MockRecognition(),text:string[]=[];const dictation=new VoiceDictation({factory:()=>recognition,stopTimeoutMs:1,onTranscript(value){text.push(value);},onChange(){}});dictation.start();recognition.result('already delivered',true);recognition.result('unfinished',false,1);dictation.stop();assert.equal(dictation.state.phase,'stopping');await new Promise(resolve=>setTimeout(resolve,10));assert.equal(recognition.aborts,1);assert.equal(dictation.state.phase,'idle');assert.deepEqual(text,['already delivered']);assert.equal(dictation.state.interim,'');assert.match(dictation.state.message,/Start again/);assert.equal(dictation.start(),true);dictation.dispose();
});
test('normal end and disposal clear pending stop deadline',async()=>{
 const recognition=new MockRecognition();const dictation=new VoiceDictation({factory:()=>recognition,stopTimeoutMs:1,onTranscript(){},onChange(){}});dictation.start();dictation.stop();recognition.onend?.();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(recognition.aborts,0);dictation.start();dictation.stop();dictation.dispose();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(recognition.aborts,1);
});
