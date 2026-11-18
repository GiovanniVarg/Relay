import {useLayoutEffect,useState} from 'react';
import type {Appearance,ResolvedAppearance} from '../shared/types';
export const APPEARANCE_KEY='relay.appearance';
const query='(prefers-color-scheme: dark)';
export function normalizeAppearance(value:unknown):Appearance{return value==='light'||value==='dark'||value==='system'?value:'system';}
export function resolveAppearance(preference:Appearance,systemDark:boolean):ResolvedAppearance{return preference==='system'?(systemDark?'dark':'light'):preference;}
export function readCachedAppearance():Appearance{try{return normalizeAppearance(localStorage.getItem(APPEARANCE_KEY));}catch{return 'system';}}
export function currentAppearance():ResolvedAppearance{return typeof document!=='undefined'&&document.documentElement.dataset.theme==='dark'?'dark':'light';}
export function subscribeAppearance(listener:()=>void):()=>void{window.addEventListener('relay:appearance',listener);return()=>window.removeEventListener('relay:appearance',listener);}
export function applyAppearance(preference:Appearance):void{
 if(typeof document==='undefined')return;
 preference=normalizeAppearance(preference);
 const theme=resolveAppearance(preference,typeof matchMedia==='function'&&matchMedia(query).matches);
 document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()||(theme==='dark'?'#1c201e':'#f7f5ef'));
 try{localStorage.setItem(APPEARANCE_KEY,preference);}catch{}
 window.dispatchEvent(new Event('relay:appearance'));
}
export function useAppearance(preference:Appearance):ResolvedAppearance{
 const [theme,setTheme]=useState(currentAppearance);
 useLayoutEffect(()=>{
  const update=()=>setTheme(currentAppearance()),unsubscribe=subscribeAppearance(update);
  applyAppearance(preference);const media=window.matchMedia(query);
  const change=()=>{if(preference==='system')applyAppearance(preference);};media.addEventListener('change',change);
  return()=>{unsubscribe();media.removeEventListener('change',change);};
 },[preference]);
 return theme;
}
