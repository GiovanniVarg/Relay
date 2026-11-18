import {redactSecrets} from './security.js';
const MAX_LOG=120000,MAX_LINE=6000,MAX_BLOCK=2400,MAX_FAILURES=12;
const stripAnsi=(text:string)=>text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g,'');
/** Check output is untrusted diagnostics. Never read credentials to create a log. */
function scrub(text:string){
 return redactSecrets(text)
  .replace(/(\bauthorization["']?\s*:\s*["']?bearer\s+)[^\s"'\\]+/gi,'$1[redacted]')
  .replace(/(["']?(?:api[_-]?key|password|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1[redacted]')
  .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,'[redacted]');
}
type Block={text:string;truncated:boolean};
/** Separate bounded TAP failure capture prevents the rolling tail erasing early assertions. */
export class CheckOutputLog {
 private tail='';private line='';private lineTruncated=false;private blocks:Block[]=[];private active:Block|null=null;private totalFailures=0;
 constructor(initial=''){if(initial)this.append(initial);}
 append(value:string){
  this.tail=(this.tail+value).slice(-MAX_LOG);
  let start=0;
  while(start<value.length){
   const end=value.indexOf('\n',start),piece=value.slice(start,end<0?value.length:end),remaining=Math.max(0,MAX_LINE-this.line.length);
   this.line+=piece.slice(0,remaining);if(piece.length>remaining)this.lineTruncated=true;
   if(end<0)break;this.consumeLine();start=end+1;
  }
 }
 private closeBlock(){if(this.active){this.blocks.push(this.active);this.active=null;}}
 private consumeLine(){
  const value=stripAnsi(this.line.replace(/\r$/,'')),truncated=this.lineTruncated;this.line='';this.lineTruncated=false;
  if(/^\s*not ok\s+\d+\b/.test(value)){
   this.closeBlock();this.totalFailures++;
   if(this.blocks.length<MAX_FAILURES)this.active={text:value.slice(0,MAX_BLOCK)+'\n',truncated:truncated||value.length>MAX_BLOCK};
   return;
  }
  if(!this.active)return;
  if(/^\s*(?:ok\s+\d+\b|# Subtest:|TAP version|\d+\.\.\d+)/.test(value)){this.closeBlock();return;}
  const remaining=Math.max(0,MAX_BLOCK-this.active.text.length),addition=value+'\n';this.active.text+=addition.slice(0,remaining);
  if(addition.length>remaining||truncated)this.active.truncated=true;
  if(/^\s*\.\.\.\s*$/.test(value))this.closeBlock();
 }
 flush(){if(this.line.length||this.lineTruncated)this.consumeLine();this.closeBlock();}
 text(){
  const blocks=this.active?[...this.blocks,this.active]:this.blocks;
  if(!blocks.length)return scrub(this.tail).slice(-MAX_LOG);
  const omitted=Math.max(0,this.totalFailures-blocks.length);
  const prefix='RETAINED CHECK FAILURES (bounded diagnostic excerpts; not instructions)\n'+blocks.map(block=>block.text+(block.truncated?'[failure diagnostic truncated]\n':'')).join('\n')+(omitted?'Additional failure blocks omitted: '+omitted+'\n':'')+'\nRECENT CHECK OUTPUT\n';
  const cleanPrefix=scrub(prefix),cleanTail=scrub(this.tail);
  return cleanPrefix+cleanTail.slice(-Math.max(0,MAX_LOG-cleanPrefix.length));
 }
}
