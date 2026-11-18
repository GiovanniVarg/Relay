import {useEffect,useId,useRef,useState} from 'react';
import {Mic} from 'lucide-react';
import {browserVoiceFactory,VoiceDictation,VOICE_DISCLOSURE,type VoiceFactory,type VoiceState} from './voice-dictation';
export interface VoiceInputProps { scopeKey:string; onTranscript(text:string):void; recognitionFactory?:VoiceFactory; language?:string; }
/** Integrate with an editable composer by appending final transcript text. No send callback exists. */
export function VoiceInput({scopeKey,onTranscript,recognitionFactory,language}:VoiceInputProps){
 const controller=useRef<VoiceDictation|undefined>(undefined),scope=useRef(scopeKey),transcript=useRef(onTranscript);scope.current=scopeKey;transcript.current=onTranscript;
 const[state,setState]=useState<VoiceState>(()=>({supported:Boolean(recognitionFactory??browserVoiceFactory()),phase:'idle',interim:'',message:''}));
 useEffect(()=>{const owner=scopeKey;const next=new VoiceDictation({factory:recognitionFactory??browserVoiceFactory(),language,onTranscript(text){if(scope.current===owner)transcript.current(text);},onChange(value){if(scope.current===owner)setState(value);}});controller.current=next;setState(next.state);return()=>{next.dispose();if(controller.current===next)controller.current=undefined;};},[scopeKey,recognitionFactory,language]);
 const active=state.phase==='listening'||state.phase==='stopping';
 const id=useId(),label=active?'Stop dictation':'Start dictation',message=state.message||(!state.supported?'Dictation is not available in this browser. Type your message instead.':''),status=[message,state.interim].filter(Boolean).join(' '),notice=state.supported&&!active&&!!message;
 return <div className="voice-input"><button type="button" className={`icon-button voice-toggle${active?' is-active':''}`} disabled={!state.supported||state.phase==='stopping'} aria-label={label} aria-describedby={id+'-disclosure '+id+'-status'} title={[label,VOICE_DISCLOSURE,status].filter(Boolean).join(' — ')} aria-pressed={active} onClick={()=>active?controller.current?.stop():controller.current?.start()}><Mic size={18} aria-hidden="true"/></button><span id={id+'-disclosure'} className="sr-only">{VOICE_DISCLOSURE}{!state.supported&&' '+message}</span><span id={id+'-status'} className={`voice-status${notice?' is-notice':''}`} role="status" aria-live="polite" title={status}>{!state.supported?'Dictation unavailable':status}</span></div>;
}
