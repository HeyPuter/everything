// Copying and pasting threaded area type.
import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createText } from '../src/model/nodes.js';
import { layoutText } from '../src/model/text-layout.js';
import { threadFrames, isThreaded } from '../src/features/type/thread-model.js';

// The test canvas measures every character 0.06 em wide.
const CHAR = { fontFamily: 'Approx Sans', fontWeight: 400, fontStyle: 'normal', fontSize: 40 };
const STORY = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');

let app;
let doc;

function frame(x, y, text = '') {
  const node = createText(text, x, y, { kind: 'area', width: 80, height: 40, char: { ...CHAR } });
  doc.transact('Add', () => doc.insert(node, app.editor.targetLayer().id));
  return node.id;
}

/** Three linked frames holding STORY; returns their ids, head first. */
function thread() {
  const ids = [frame(0, 0, STORY), frame(200, 0), frame(400, 0)];
  app.editor.select(ids);
  app.commands.run('type.thread.create');
  return ids;
}

/** The text a frame shows. */
function shown(id) {
  const lay = layoutText(doc.get(id));
  const head = threadFrames(doc, doc.get(id))[0];
  return lay.lines.length ? head.text.slice(lay.lines[0].start, lay.lines[lay.lines.length - 1].end).trim() : '';
}

beforeEach(async () => {
  app = await bootAppWithFeatures();
  app.newDocument();
  doc = app.editor.doc;
});

describe('copying threaded text', () => {
  it('pastes copies of linked frames linked to each other, with the story', async () => {
    const [a, b, c] = thread();
    app.editor.select([a, b, c]);
    await app.commands.run('edit.copy');
    await app.commands.run('edit.pasteInPlace');
    const copies = app.editor.topSelection();
    expect(copies).toHaveLength(3);
    const frames = threadFrames(doc, doc.get(copies[0]));
    expect(frames.map((f) => f.id)).toEqual(copies);
    expect(frames[0].text).toBe(STORY);
    for (let i = 0; i < 3; i++) expect(shown(copies[i])).toBe(shown([a, b, c][i]));
    // The originals are untouched.
    expect(threadFrames(doc, doc.get(a)).map((f) => f.id)).toEqual([a, b, c]);
    // Every paste is its own thread.
    await app.commands.run('edit.pasteInPlace');
    const again = app.editor.topSelection();
    expect(threadFrames(doc, doc.get(again[0])).map((f) => f.id)).toEqual(again);
    expect(threadFrames(doc, doc.get(copies[0])).map((f) => f.id)).toEqual(copies);
  });

  it('copies two of three frames as a thread of two, holding the text they showed', async () => {
    const [a, b, c] = thread();
    const second = shown(b);
    const third = shown(c);
    app.editor.select([b, c]);
    await app.commands.run('edit.copy');
    await app.commands.run('edit.pasteInPlace');
    const copies = app.editor.topSelection();
    expect(threadFrames(doc, doc.get(copies[0])).map((f) => f.id)).toEqual(copies);
    expect(shown(copies[0])).toBe(second);
    expect(shown(copies[1])).toBe(third);
    expect(doc.get(copies[0]).text.startsWith(second)).toBe(true);
  });

  it('copies one frame as unthreaded type holding the text it showed', async () => {
    const [a, b] = thread();
    const text = shown(b);
    expect(text.length).toBeGreaterThan(0);
    app.editor.select([b]);
    await app.commands.run('edit.copy');
    await app.commands.run('edit.pasteInPlace');
    const [copy] = app.editor.topSelection();
    expect(isThreaded(doc.get(copy))).toBe(false);
    expect(doc.get(copy).text.trim()).toBe(text);
    app.editor.select([a]);
    await app.commands.run('edit.copy');
    await app.commands.run('edit.pasteInPlace');
    const [head] = app.editor.topSelection();
    expect(isThreaded(doc.get(head))).toBe(false);
    expect(doc.get(head).text.trim()).toBe(shown(a));
  });

  it('Cut and paste keeps the cut frames linked and the rest of the thread intact', async () => {
    const [a, b, c] = thread();
    const first = shown(a);
    const rest = `${shown(b)} ${shown(c)}`;
    app.editor.select([b, c]);
    await app.commands.run('edit.cut');
    expect(doc.has(b)).toBe(false);
    expect(doc.get(a).text).toBe(STORY);
    await app.commands.run('edit.pasteInPlace');
    const copies = app.editor.topSelection();
    expect(threadFrames(doc, doc.get(copies[0])).map((f) => f.id)).toEqual(copies);
    expect(shown(a)).toBe(first);
    expect(`${shown(copies[0])} ${shown(copies[1])}`).toBe(rest);
  });

  it('pastes into another document linked', async () => {
    const ids = thread();
    app.editor.select(ids);
    await app.commands.run('edit.copy');
    app.newDocument();
    doc = app.editor.doc;
    await app.commands.run('edit.paste');
    const copies = app.editor.topSelection();
    expect(threadFrames(doc, doc.get(copies[0])).map((f) => f.id)).toEqual(copies);
    expect(doc.get(copies[0]).text).toBe(STORY);
  });
});
