import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {taskProgressFeed} from '../client/task-progress-feed.js';
import {TaskProgress} from '../client/TaskProgress.js';
import type {Task} from '../shared/tasks.js';
test('one progress feed coalesces ticks; rendering historical rows makes no network requests',async()=>{let calls=0,received=0,tick!:()=>void,release!:(tasks:Task[])=>void,stopped=0;const dispose=taskProgressFeed(()=>{calls++;return new Promise(done=>{release=done;});},()=>received++,callback=>{tick=callback;return()=>stopped++;});for(let n=0;n<100;n++){renderToStaticMarkup(createElement(TaskProgress,{}));tick();}assert.equal(calls,1);release([]);await new Promise(done=>setImmediate(done));assert.equal(received,1);tick();assert.equal(calls,2);dispose();release([]);await new Promise(done=>setImmediate(done));assert.equal(received,1);assert.equal(stopped,1);tick();assert.equal(calls,2);});
test('progress labels scope check evidence without claiming goal verification and expose unconfirmed stops',()=>{const task={status:'done',outcome:{verification:'checks_passed',summary:'Exact checks passed'}} as Task;const html=renderToStaticMarkup(createElement(TaskProgress,{task}));assert.match(html,/checks passed/);assert.doesNotMatch(html,/Goal verified/);const stopped=renderToStaticMarkup(createElement(TaskProgress,{task:{...task,status:'cancelled',recoveryRequired:true,error:'Native termination was not confirmed'}}));assert.match(stopped,/Stop unconfirmed/);assert.match(stopped,/Native termination was not confirmed/);});
