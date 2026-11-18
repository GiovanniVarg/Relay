export interface VoiceResult { readonly isFinal: boolean; readonly length: number; readonly [index: number]: {readonly transcript: string}; }
export interface VoiceEvent { readonly resultIndex: number; readonly results: {readonly length: number; readonly [index: number]: VoiceResult}; }
export interface VoiceRecognition {
 continuous: boolean; interimResults: boolean; lang: string;
 onresult: ((event: VoiceEvent) => void) | null; onerror: ((event: {error: string}) => void) | null; onend: (() => void) | null;
 start(): void; stop(): void; abort(): void;
}
export type VoiceFactory = () => VoiceRecognition;
export interface VoiceState { supported: boolean; phase: 'idle' | 'listening' | 'stopping' | 'error'; interim: string; message: string; }
export const VOICE_DISCLOSURE = 'Dictation may be processed by your browser’s speech service. Review and edit the text before sending.';
/** Detect capability only; construction/start happens exclusively after the user's action. */
export function browserVoiceFactory(target: unknown = typeof window === 'undefined' ? undefined : window): VoiceFactory | undefined {
 const browser = target as {SpeechRecognition?:new()=>VoiceRecognition;webkitSpeechRecognition?:new()=>VoiceRecognition}|undefined;
 const Constructor=browser?.SpeechRecognition??browser?.webkitSpeechRecognition;return typeof Constructor==='function'?()=>new Constructor():undefined;
}
const failure = (code: string) => code === 'not-allowed' || code === 'service-not-allowed' ? 'Microphone permission was denied. Allow dictation in your browser and try again.' : code === 'audio-capture' ? 'No microphone is available.' : code === 'no-speech' ? 'No speech was detected. Start dictation to try again.' : code === 'network' ? 'The browser speech service could not connect. Try again when it is available.' : 'Dictation stopped. Start again to retry.';
/** One explicitly started recognition session. Final text is an editable-draft callback, never a send action. */
export class VoiceDictation {
 private recognition?: VoiceRecognition; private live=false; private disposed=false; private generation=0; private finalized=new Set<number>(); private stopTimer?:ReturnType<typeof setTimeout>;
 state:VoiceState;
 constructor(private options:{factory?:VoiceFactory;onTranscript(text:string):void;onChange(state:VoiceState):void;language?:string;stopTimeoutMs?:number}){this.state={supported:Boolean(options.factory),phase:'idle',interim:'',message:options.factory?'':'Dictation is not available in this browser. Type your message instead.'};}
 private update(patch:Partial<VoiceState>):void{this.state={...this.state,...patch};this.options.onChange(this.state);}
 private release():void{clearTimeout(this.stopTimer);this.stopTimer=undefined;this.live=false;const recognition=this.recognition;this.recognition=undefined;if(recognition){recognition.onresult=null;recognition.onerror=null;recognition.onend=null;}}
 start():boolean{
  if(this.disposed||this.live)return false;if(!this.options.factory){this.update({supported:false,message:'Dictation is not available in this browser. Type your message instead.'});return false;}
  let recognition:VoiceRecognition;
  try{recognition=this.options.factory();}catch{this.update({phase:'error',message:'Dictation could not start in this browser.'});return false;}
  const generation=++this.generation;this.recognition=recognition;this.live=true;this.finalized.clear();recognition.continuous=true;recognition.interimResults=true;recognition.lang=this.options.language??'en-US';
  recognition.onresult=event=>{if(!this.live||this.disposed||this.recognition!==recognition||generation!==this.generation)return;let interim='';for(let index=event.resultIndex;index<event.results.length;index++){const result=event.results[index];const text=result?.[0]?.transcript;if(typeof text!=='string')continue;if(result.isFinal){if(!this.finalized.has(index)){this.finalized.add(index);if(text.trim())this.options.onTranscript(text.trim());}}else interim+=text;}this.update({interim});};
  recognition.onerror=event=>{if(!this.live||this.recognition!==recognition||generation!==this.generation)return;this.release();try{recognition.abort();}catch{}this.update({phase:'error',interim:'',message:failure(event.error)});};
  recognition.onend=()=>{if(!this.live||this.recognition!==recognition||generation!==this.generation)return;this.release();this.update({phase:'idle',interim:'',message:''});};
  this.update({phase:'listening',message:'Listening…',interim:''});
  try{recognition.start();return true;}catch{this.release();try{recognition.abort();}catch{}this.update({phase:'error',interim:'',message:'Dictation could not start. Check microphone permission and try again.'});return false;}
 }
 stop():void{if(!this.live||!this.recognition||this.state.phase==='stopping')return;const recognition=this.recognition;this.update({phase:'stopping',message:'Finishing dictation…'});try{recognition.stop();if(this.live&&this.recognition===recognition)this.stopTimer=setTimeout(()=>{if(!this.live||this.recognition!==recognition)return;this.release();try{recognition.abort();}catch{}this.update({phase:'idle',interim:'',message:'Dictation stopped before the browser finished. Start again if more text is needed.'});},this.options.stopTimeoutMs??3000);}catch{this.release();try{recognition.abort();}catch{}this.update({phase:'error',interim:'',message:'Dictation could not stop normally. Start again to retry.'});}}
 dispose():void{if(this.disposed)return;this.disposed=true;const recognition=this.recognition;this.release();if(recognition)try{recognition.abort();}catch{};}
}
