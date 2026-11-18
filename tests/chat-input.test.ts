import test from 'node:test';
import assert from 'node:assert/strict';
import {clipboardImages,clipboardHasImages,messageAnchor,replyExcerpt} from '../client/chat-input.js';

function clipboard(files:File[],items:File[]=files){return {files,items:items.map(file=>({kind:'file',type:file.type,getAsFile:()=>file}))} as unknown as Pick<DataTransfer,'files'|'items'>;}
test('clipboard selection uses either browser representation once and preserves text paste',()=>{
  const image=new File(['pixels'],'image.png',{type:'image/png',lastModified:1});
  assert.deepEqual(clipboardImages(clipboard([image],[image])),[image]);
  assert.deepEqual(clipboardImages(clipboard([],[image,image])),[image]);
  assert.deepEqual(clipboardImages(clipboard([new File(['text'],'note.txt',{type:'text/plain'})])),[]);
  assert.equal(clipboardHasImages(clipboard([])),false);
  const gif=new File(['gif'],'animation.gif',{type:'image/gif'});
  assert.equal(clipboardHasImages(clipboard([],[gif])),true);
  assert.deepEqual(clipboardImages(clipboard([gif])),[]);
});
test('reply excerpt and source anchor are bounded literal context',()=>{
  assert.equal(replyExcerpt({content:'  first\n second  '}),'first second');
  assert.equal(replyExcerpt({content:'',attachments:[{}]}),'Attachment');
  assert.equal(replyExcerpt(),'Original message unavailable');
  assert.equal(replyExcerpt({content:'a'.repeat(500)}).length,180);
  assert.equal(messageAnchor('same/room','id #1'),'message-same%2Froom-id%20%231');
  assert.notEqual(messageAnchor('one','same'),messageAnchor('two','same'));
});
test('reply previews extract rendered Markdown text, image alt and code without link destinations',()=>{
  assert.equal(replyExcerpt({content:'## A clear answer\n\nA **useful** [reference](https://example.com/answer).\n\n- First\n- Second\n\n```ts\nconst ready = true;\n```'}),'A clear answer A useful reference. First Second const ready = true;');
  assert.equal(replyExcerpt({content:'![Diagram](https://example.com/tracking.png) and `inline code` with ~~old~~ new'}),'Diagram and inline code with old new');
  assert.equal(replyExcerpt({content:'One  \nTwo\n\n| Name | Value |\n| - | - |\n| A | B |'}),'One Two Name Value A B');
  assert.equal(replyExcerpt({content:'<script>ignored()</script>\n\nReadable'}),'Readable');
  assert.equal(replyExcerpt({content:'\\*literal\\* &amp; **bold**'}),'*literal* & bold');
});
