import {forwardRef,useId,useImperativeHandle,useLayoutEffect,useMemo,useRef,useState,type CSSProperties,type TextareaHTMLAttributes} from 'react';
import {createPortal} from 'react-dom';
import type {Agent} from '../shared/types';
import {Avatar} from './UI';
import {filterMentionAgents,getMentionTrigger,insertBotMention,mergeMentionTargets} from './bot-mentions';
import type {RegisteredComputer} from './background-assignments';
const noComputers:RegisteredComputer[]=[];
type Props=Omit<TextareaHTMLAttributes<HTMLTextAreaElement>,'value'> & {value:string;agents:Agent[];computers?:RegisteredComputer[];scopeKey:string;onMentionChange:(value:string)=>void;mentionSuffix?:string};
type Selection={value:string;start:number;end:number;scope:string};
const selectionKey=(s:Selection)=>JSON.stringify([s.scope,s.value,s.start,s.end]);
export const MentionTextarea=forwardRef<HTMLTextAreaElement,Props>(function MentionTextarea({value,agents,computers=noComputers,scopeKey,onMentionChange,mentionSuffix=': ',onChange,onFocus,onBlur,onSelect,onClick,onKeyUp,onKeyDownCapture,onCompositionStart,onCompositionEnd,disabled,readOnly,maxLength,...nativeProps},forwardedRef){
 const input=useRef<HTMLTextAreaElement>(null),picker=useRef<HTMLDivElement>(null),composing=useRef(false),previousScope=useRef(scopeKey),focusFrame=useRef<number|null>(null),id=useId();
 const [focused,setFocused]=useState(false),[selection,setSelection]=useState<Selection>({value,start:0,end:0,scope:scopeKey}),[dismissed,setDismissed]=useState<string|null>(null),[activeId,setActiveId]=useState<string|null>(null),[position,setPosition]=useState<CSSProperties|null>(null);
 useImperativeHandle(forwardedRef,()=>input.current!,[]);
 function readSelection(el:HTMLTextAreaElement):Selection{return {value:el.value,start:el.selectionStart,end:el.selectionEnd,scope:scopeKey};}
 function syncSelection(el:HTMLTextAreaElement){const next=readSelection(el);setDismissed(previous=>previous===selectionKey(next)?previous:null);setSelection(previous=>selectionKey(previous)===selectionKey(next)?previous:next);return next;}
 useLayoutEffect(()=>{const el=input.current;if(!el)return;const next=syncSelection(el);if(previousScope.current!==scopeKey){previousScope.current=scopeKey;if(focusFrame.current!=null){cancelAnimationFrame(focusFrame.current);focusFrame.current=null;}setDismissed(selectionKey(next));setActiveId(null);}},[value,scopeKey]);
 useLayoutEffect(()=>()=>{if(focusFrame.current!=null)cancelAnimationFrame(focusFrame.current);},[]);
 const mentionAgents=useMemo(()=>mergeMentionTargets(agents,computers),[agents,computers]);
 const key=selectionKey(selection),trigger=selection.value===value&&selection.scope===scopeKey?getMentionTrigger(value,selection.start,selection.end):null;
 const open=focused&&!disabled&&!readOnly&&!composing.current&&!!trigger&&dismissed!==key;
 const options=trigger?filterMentionAgents(mentionAgents,trigger.query):[],activeIndex=Math.max(0,options.findIndex(a=>a.id===activeId)),active=options[activeIndex];
 function choose(agentId:string){
  const el=input.current;if(!el||!open||!trigger||disabled||readOnly)return;
  const current=readSelection(el);if(selectionKey(current)!==key){syncSelection(el);return;}
  const currentTrigger=getMentionTrigger(current.value,current.start,current.end);if(!currentTrigger)return;
  const agent=filterMentionAgents(mentionAgents,currentTrigger.query).find(a=>a.id===agentId);if(!agent)return;
  const result=insertBotMention(current.value,currentTrigger,agent,mentionAgents,maxLength,mentionSuffix);if(!result)return;
  setDismissed(selectionKey({value:result.value,start:result.caret,end:result.caret,scope:scopeKey}));onMentionChange(result.value);
  if(focusFrame.current!=null)cancelAnimationFrame(focusFrame.current);
  focusFrame.current=requestAnimationFrame(()=>{focusFrame.current=null;const node=input.current;if(!node||node.value!==result.value||document.activeElement!==node)return;node.focus({preventScroll:true});node.setSelectionRange(result.caret,result.caret);setDismissed(selectionKey(syncSelection(node)));node.style.height='auto';node.style.height=Math.min(node.scrollHeight,160)+'px';});
 }
 useLayoutEffect(()=>{
  if(!open){setPosition(null);return;}
  let frame:number|null=null;const viewport=window.visualViewport;
  function update(){
   const el=input.current,menu=picker.current;if(!el||!menu)return;
   const rect=(el.closest('.composer')??el).getBoundingClientRect(),leftEdge=viewport?.offsetLeft??0,topEdge=viewport?.offsetTop??0,widthAvailable=viewport?.width??innerWidth,heightAvailable=viewport?.height??innerHeight;
   if(!el.getClientRects().length||rect.bottom<topEdge||rect.top>topEdge+heightAvailable){setPosition({position:'fixed',visibility:'hidden'});return;}
   const width=Math.max(1,Math.min(440,rect.width,widthAvailable-16)),maxHeight=Math.max(1,Math.min(320,heightAvailable-16,rect.top-topEdge-12));
   menu.style.width=`${width}px`;menu.style.maxHeight=`${maxHeight}px`;
   const height=menu.getBoundingClientRect().height;
   setPosition({position:'fixed',width,maxHeight,left:Math.max(leftEdge+8,Math.min(rect.left,leftEdge+widthAvailable-width-8)),top:Math.max(topEdge+8,rect.top-height-8),zIndex:60});
  }
  function schedule(){if(frame==null)frame=requestAnimationFrame(()=>{frame=null;update();});}
  update();window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);viewport?.addEventListener('resize',schedule);viewport?.addEventListener('scroll',schedule);
  const observer=new ResizeObserver(schedule);if(input.current)observer.observe(input.current.closest('.composer')??input.current);
  return()=>{if(frame!=null)cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);viewport?.removeEventListener('resize',schedule);viewport?.removeEventListener('scroll',schedule);};
 },[open,key,mentionAgents,options.length]);
 useLayoutEffect(()=>{if(open)picker.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'});},[open,activeIndex]);
 return <><textarea {...nativeProps} ref={input} value={value} disabled={disabled} readOnly={readOnly} maxLength={maxLength} aria-haspopup="listbox" aria-autocomplete="list" aria-controls={open?`${id}-list`:undefined} aria-activedescendant={open&&active?`${id}-option-${activeIndex}`:undefined}
  onChange={e=>{onChange?.(e);syncSelection(e.currentTarget);}}
  onFocus={e=>{setFocused(true);syncSelection(e.currentTarget);onFocus?.(e);}}
  onBlur={e=>{setFocused(false);onBlur?.(e);}}
  onSelect={e=>{syncSelection(e.currentTarget);onSelect?.(e);}}
  onClick={e=>{syncSelection(e.currentTarget);onClick?.(e);}}
  onKeyUp={e=>{syncSelection(e.currentTarget);onKeyUp?.(e);}}
  onCompositionStart={e=>{composing.current=true;setFocused(false);onCompositionStart?.(e);}}
  onCompositionEnd={e=>{composing.current=false;setFocused(document.activeElement===e.currentTarget);syncSelection(e.currentTarget);onCompositionEnd?.(e);}}
  onKeyDownCapture={e=>{
   const ime=composing.current||e.nativeEvent.isComposing||e.keyCode===229;if(ime&&e.key==="Enter"){e.stopPropagation();return;}let handled=false;
   if(open&&!ime&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
    if(e.key==='Escape'){setDismissed(key);handled=true;}
    else if(!e.shiftKey){
     if((e.key==='ArrowDown'||e.key==='ArrowUp')&&options.length){const delta=e.key==='ArrowDown'?1:-1;setActiveId(options[(activeIndex+delta+options.length)%options.length].id);handled=true;}
     else if(e.key==='Enter'||(e.key==='Tab'&&active)){if(active)choose(active.id);handled=true;}
    }
   }
   if(handled){e.preventDefault();e.stopPropagation();}else onKeyDownCapture?.(e);
  }}/>
  {open&&createPortal(<div ref={picker} className="bot-mention-picker" style={position??{position:'fixed',left:0,top:0,visibility:'hidden'}}>
   <div className="bot-mention-header">{computers.length?'Mention a bot or computer':'Mention a bot'}</div><div id={`${id}-list`} role="listbox" aria-label={computers.length?'Choose a bot or computer':'Choose a bot'}>
   {options.length?options.map((agent,index)=><button key={agent.id} id={`${id}-option-${index}`} type="button" role="option" tabIndex={-1} aria-selected={index===activeIndex} className="bot-mention-option" onPointerDown={e=>e.preventDefault()} onMouseDown={e=>e.preventDefault()} onPointerMove={()=>setActiveId(agent.id)} onClick={()=>choose(agent.id)}><Avatar agent={agent}/><span className="bot-mention-copy"><strong>{agent.name}</strong><small>{agent.role}</small></span></button>):<div className="bot-mention-empty">{computers.length?'No bots or computers found. Esc to close.':'No bots found. Esc to close.'}</div>}
   </div><div className="bot-mention-footer">↑↓ choose · Enter select · Esc close</div>
  </div>,document.body)}
 </>;
});