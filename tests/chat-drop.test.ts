import test from 'node:test';
import assert from 'node:assert/strict';
import { dragHasFiles, paneKind, skippedNotice, splitDroppedFiles } from '../client/chat-drop.js';

test('only file drags are treated as attachment drops', () => {
  assert.equal(dragHasFiles(['Files']), true);
  assert.equal(dragHasFiles(['text/plain', 'Files']), true);
  assert.equal(dragHasFiles(['text/plain', 'text/uri-list']), false);
  assert.equal(dragHasFiles(null), false);
  assert.equal(dragHasFiles(undefined), false);
});

test('panes are classified without granting attachment authority', () => {
  assert.equal(paneKind(['conversation-pane']), 'direct');
  assert.equal(paneKind(['conversation-pane', 'group-conversation']), 'group');
  assert.equal(paneKind(['conversation-pane', 'dispatcher']), 'boss');
  assert.equal(paneKind(null), 'none');
});

test('dropped files are filtered to the types the attachment endpoint accepts', () => {
  const files = ['photo.PNG', 'shot.jpeg', 'pic.jpg', 'art.webp', 'notes.txt', 'paper.pdf', 'brief.docx', 'movie.mp4', 'archive.zip', 'folder'].map(name => new File(['x'], name));
  const { accepted, skipped } = splitDroppedFiles(files);
  assert.deepEqual(accepted.map(file => file.name), ['photo.PNG', 'shot.jpeg', 'pic.jpg', 'art.webp', 'notes.txt', 'paper.pdf', 'brief.docx']);
  assert.deepEqual(skipped.map(file => file.name), ['movie.mp4', 'archive.zip', 'folder']);
});

test('skipped files are reported plainly', () => {
  assert.equal(skippedNotice([]), '');
  assert.match(skippedNotice([new File(['x'], 'movie.mp4')]), /"movie\.mp4" was skipped/);
  assert.match(skippedNotice([new File(['x'], 'a.zip'), new File(['x'], 'b.zip')]), /2 files were skipped/);
});
