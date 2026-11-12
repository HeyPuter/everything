// Threaded text: commands, flowing and editing across frames, ports, undo.
import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createText, createPath } from '../src/model/nodes.js';
import { layoutText } from '../src/model/text-layout.js';
import { threadFrames, headOf, sliceStory, appendStory } from '../src/features/type/thread-model.js';

// The test canvas measures every character 0.06 em wide.
const CHAR = { fontFamily: 'Approx Sans', fontWeight: 400, fontStyle: 'normal', fontSize: 40 };
const STORY = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');

let app;
let doc;

function add(node) {
  doc.transact('Add', () => doc.insert(node, app.editor.targetLayer().id));
  return doc.get(node.id);
}

function frame(x, y, text = '', extra = {}) {
  return add(createText(text, x, y, { kind: 'area', width: 80, height: 40, char: { ...CHAR }, ...extra }));
}

function rect(x, y, w, h) {
  const p = (px, py) => ({ x: px, y: py, ix: px, iy: py, ox: px, oy: py });
  return add(createPath([p(x, y), p(x + w, y), p(x + w, y + h), p(x, y + h)], true));
}

beforeEach(async () => {
  app = await bootAppWithFeatures();
  app.newDocument?.();
  if (!app.editor) await app.commands.run('file.new');
  doc = app.editor.doc;
});

describe('Type > Threaded Text', () => {
  it('Create threads selected area type and closed paths back to front', () => {
    const a = frame(0, 0, STORY);
    const r = rect(200, 0, 80, 40);
    const b = frame(400, 0, 'tail');
    app.editor.select([a.id, r.id, b.id]);
    app.commands.run('type.thread.create');
    const frames = threadFrames(doc, doc.get(a.id));
    expect(frames).toHaveLength(3);
    expect(doc.has(r.id)).toBe(false);
    expect(frames[1].kind).toBe('area');
    // The stories append: the head holds everything, followers hold nothing.
    expect(frames[0].text).toBe(`${STORY}\ntail`);
    expect(frames[1].text).toBe('');
    expect(frames[2].text).toBe('');
    // Text flows from frame to frame.
    const l0 = layoutText(frames[0]);
    const l1 = layoutText(frames[1]);
    expect(l1.lines.length).toBeGreaterThan(0);
    expect(l1.lines[0].start).toBe(l0.lines[l0.lines.length - 1].end);
    expect(headOf(doc, frames[2]).id).toBe(a.id);
    app.commands.run('edit.undo');
    expect(doc.get(a.id).threadNext).toBeUndefined();
    expect(doc.has(r.id)).toBe(true);
    expect(doc.get(b.id).text).toBe('tail');
  });

  it('Release Selection takes a frame out and keeps the story in the others', () => {
    const a = frame(0, 0, STORY);
    const b = frame(200, 0);
    const c = frame(400, 0);
    app.editor.select([a.id, b.id, c.id]);
    app.commands.run('type.thread.create');
    app.editor.select([a.id]);
    app.commands.run('type.thread.release');
    expect(doc.get(a.id).text).toBe('');
    expect(doc.get(a.id).threadNext).toBeUndefined();
    expect(doc.get(b.id).text).toBe(STORY);
    expect(threadFrames(doc, doc.get(c.id)).map((f) => f.id)).toEqual([b.id, c.id]);
  });

  it('Remove Threading leaves each frame with the text it showed', () => {
    const a = frame(0, 0, STORY);
    const b = frame(200, 0);
    app.editor.select([a.id, b.id]);
    app.commands.run('type.thread.create');
    const shown0 = layoutText(doc.get(a.id));
    const end0 = shown0.lines[shown0.lines.length - 1].end;
    app.commands.run('type.thread.remove');
    const na = doc.get(a.id);
    const nb = doc.get(b.id);
    expect(na.threadNext).toBeUndefined();
    expect(nb.threadPrev).toBeUndefined();
    expect(na.text).toBe(STORY.slice(0, end0));
    expect((na.text + nb.text).replace(/\s/g, '')).toBe(STORY.replace(/\s/g, ''));
  });

  it('typing in any frame edits the story and reflows the others; undo restores', () => {
    const a = frame(0, 0, STORY);
    const b = frame(200, 0);
    app.editor.select([a.id, b.id]);
    app.commands.run('type.thread.create');
    const before = layoutText(doc.get(b.id)).lines[0].start;
    app.setTool('type');
    // Editing the follower edits the head's story.
    const s = app.tool.editText(b.id);
    expect(s.id).toBe(a.id);
    s.setSelection(0, 0);
    s.insert('INSERTED ');
    expect(doc.get(a.id).text.startsWith('INSERTED ')).toBe(true);
    expect(doc.get(b.id).text).toBe('');
    expect(layoutText(doc.get(b.id)).lines[0].start).not.toBe(before);
    app.tool.endEditing();
    app.commands.run('edit.undo');
    expect(doc.get(a.id).text).toBe(STORY);
  });

  it('the caret moves into the next frame', () => {
    const a = frame(0, 0, STORY);
    const b = frame(200, 0);
    app.editor.select([a.id, b.id]);
    app.commands.run('type.thread.create');
    app.setTool('type');
    const s = app.tool.editText(a.id);
    const lb = layoutText(doc.get(b.id));
    const i = lb.lines[0].start + 2;
    s.setSelection(i, i);
    const lay = s.layout();
    expect(lay.composite).toBe(true);
    // The caret index maps to frame b, at b's position.
    const line = lay.lines.find((l) => i >= l.start && i <= l.end);
    expect(line.frame).toBe(1);
    expect(line.toLocal(line.xs[2], line.y).x).toBeGreaterThan(200);
  });

  it('deleting the first frame hands the story to the next', () => {
    const a = frame(0, 0, STORY);
    const b = frame(200, 0);
    const c = frame(400, 0);
    app.editor.select([a.id, b.id, c.id]);
    app.commands.run('type.thread.create');
    app.editor.select([a.id]);
    app.commands.run('edit.clear');
    expect(doc.has(a.id)).toBe(false);
    expect(doc.get(b.id).text).toBe(STORY);
    expect(doc.get(b.id).threadPrev).toBeUndefined();
    expect(threadFrames(doc, doc.get(b.id))).toHaveLength(2);
    app.commands.run('edit.undo');
    expect(doc.get(a.id).text).toBe(STORY);
    expect(threadFrames(doc, doc.get(a.id))).toHaveLength(3);
  });

  it('a port click loads the cursor; a click makes a linked frame of the same size', () => {
    const a = frame(10, 10, STORY);
    app.setTool('selection');
    app.editor.select([a.id]);
    const ed = app.editor;
    const lay = layoutText(doc.get(a.id));
    const out = ed.view.toScreen(lay.bounds.x + lay.bounds.w, lay.bounds.y + lay.bounds.h);
    const ev = (x, y) => {
      const d = ed.view.toDoc ? ed.view.toDoc(x, y) : { x, y };
      return { x: d.x, y: d.y, sx: x, sy: y, shift: false, alt: false, mod: false, button: 0 };
    };
    app.tool.onPointerDown(ev(out.x, out.y));
    expect(app.toolId).toBe('thread-link');
    const p = ed.view.toScreen(300, 300);
    app.tool.onPointerDown(ev(p.x, p.y));
    app.tool.onPointerUp(ev(p.x, p.y));
    expect(app.toolId).toBe('selection');
    const frames = threadFrames(doc, doc.get(a.id));
    expect(frames).toHaveLength(2);
    expect(frames[1].width).toBeCloseTo(80);
    expect(frames[1].x).toBeCloseTo(300);
    expect(layoutText(frames[1]).lines.length).toBeGreaterThan(0);
  });

  it('applies character styles of a selected follower to the story', () => {
    const a = frame(0, 0, STORY);
    const b = frame(200, 0);
    app.editor.select([a.id, b.id]);
    app.commands.run('type.thread.create');
    app.editor.select([b.id]);
    app.commands.run('type.sizeUp');
    expect(doc.get(a.id).char.fontSize).toBe(42);
  });
});

describe('story helpers', () => {
  it('slices and appends stories keeping styles', () => {
    const a = createText('Hello\nWorld', 0, 0, { char: { ...CHAR }, runs: [{ len: 5, fontWeight: 700 }], paras: [{ align: 'center' }, null] });
    const s = sliceStory(a, 3, 9);
    expect(s.text).toBe('lo\nWor');
    expect(s.runs[0]).toMatchObject({ len: 2, fontWeight: 700 });
    expect(s.paras[0]).toEqual({ align: 'center' });
    const b = createText('Tail', 0, 0, { char: { ...CHAR, fontSize: 20 } });
    const j = appendStory(a, b);
    expect(j.text).toBe('Hello\nWorld\nTail');
    expect(j.runs[j.runs.length - 1]).toMatchObject({ len: 4, fontSize: 20 });
  });
});

describe('Object > Text Wrap', () => {
  it('Make flows area type below around the object; Release and undo restore', () => {
    const t = frame(0, 0, STORY, { width: 400, height: 400 });
    const plain = layoutText(doc.get(t.id)).lines[0];
    const r = rect(-10, -10, 150, 80);
    app.editor.select([r.id]);
    app.commands.run('textWrap.make');
    expect(doc.get(r.id).textWrap).toEqual({ offset: 6, invert: false });
    const wrapped = layoutText(doc.get(t.id));
    // The first lines start right of the object plus its offset.
    expect(wrapped.lines[0].x).toBeGreaterThanOrEqual(146 - 0.01);
    expect(plain.x).toBeLessThan(1);
    // Moving the object re-flows the text.
    doc.transact('Move', () => doc.update(r.id, { anchors: doc.get(r.id).anchors.map((a) => ({ ...a, x: a.x + 1000, ix: a.ix + 1000, ox: a.ox + 1000 })) }));
    expect(layoutText(doc.get(t.id)).lines[0].x).toBeLessThan(1);
    app.commands.run('edit.undo');
    expect(layoutText(doc.get(t.id)).lines[0].x).toBeGreaterThanOrEqual(146 - 0.01);
    app.editor.select([r.id]);
    app.commands.run('textWrap.release');
    expect(doc.get(r.id).textWrap).toBeUndefined();
    expect(layoutText(doc.get(t.id)).lines[0].x).toBeLessThan(1);
  });

  it('objects below the text do not wrap it', () => {
    const r = rect(-10, -10, 150, 80);
    const t = frame(0, 0, STORY, { width: 400, height: 400 });
    app.editor.select([r.id]);
    app.commands.run('textWrap.make');
    expect(layoutText(doc.get(t.id)).lines[0].x).toBeLessThan(1);
  });
});

describe('styles on a threaded frame', () => {
  it('a paragraph style applied with only a later frame selected styles the story', async () => {
    const { applyStyle, newStyle, currentStyleState } = await import('../src/features/type/styles-panel.js');
    const { typeDefaults } = await import('../src/features/type/type-ops.js');
    const { paraAt } = await import('../src/model/text-runs.js');
    const a = frame(0, 0, STORY);
    const b = frame(400, 0, '');
    app.editor.select([a.id, b.id]);
    app.commands.run('type.thread.create');
    // A style made from the head, then applied with only the second frame selected.
    app.editor.select([a.id]);
    const id = newStyle(app, 'para', { name: 'Body', apply: false });
    const defaultsBefore = typeDefaults(app).para.paraStyle ?? null;
    app.editor.select([b.id]);
    applyStyle(app, 'para', id);
    expect(paraAt(doc.get(a.id), 0).paraStyle).toBe(id);
    expect(typeDefaults(app).para.paraStyle ?? null).toBe(defaultsBefore);
    expect(currentStyleState(app, 'para').id).toBe(id);
  });
});

describe('converting threaded frames', () => {
  it('Convert to Point Type leaves threaded frames alone, and placeholder text goes into the story', async () => {
    const a = frame(0, 0, STORY);
    const b = frame(400, 0, '');
    app.editor.select([a.id, b.id]);
    app.commands.run('type.thread.create');
    const before = doc.get(a.id);
    app.editor.select([a.id, b.id]);
    await app.commands.run('type.convertToPoint');
    expect(doc.get(a.id).kind).toBe('area');
    expect(doc.get(a.id).text).toBe(before.text);
    expect(threadFrames(doc, doc.get(a.id))).toHaveLength(2);
    // Fill with Placeholder Text with only the second frame selected fills the story, not the empty follower.
    doc.transact('Empty', () => doc.update(a.id, { text: '' }));
    app.editor.select([b.id]);
    await app.commands.run('type.loremIpsum');
    expect(doc.get(b.id).text).toBe('');
    // As much as fills both frames, no more.
    const lay = layoutText(doc.get(b.id));
    expect(doc.get(a.id).text.length).toBeGreaterThan(0);
    expect(lay.story.overflow).toBe(false);
    expect(lay.lines.length).toBeGreaterThan(0);
    expect(doc.get(a.id).text.split(' ').length).toBeLessThan(60);
    // While editing the story: the fill stops where the last frame is full.
    doc.transact('Empty', () => doc.update(a.id, { text: 'Start' }));
    app.setTool('type');
    const s = app.tool.editText(a.id);
    s.setSelection(5, 5);
    await app.commands.run('type.loremIpsum');
    expect(doc.get(a.id).text.length).toBeGreaterThan(5);
    expect(layoutText(doc.get(b.id)).story.overflow).toBe(false);
  });
});

describe('smart punctuation on a threaded frame', () => {
  it('with only a later frame selected, Smart Punctuation fixes the story', async () => {
    const { applySmartPunctuation } = await import('../src/features/type/smart-punctuation.js');
    const a = frame(0, 0, '"quoted" text');
    const b = frame(400, 0, '');
    app.editor.select([a.id, b.id]);
    app.commands.run('type.thread.create');
    app.editor.select([b.id]);
    applySmartPunctuation(app, { quotes: true }, 'selection');
    expect(doc.get(a.id).text).toBe('“quoted” text');
    expect(doc.get(b.id).text).toBe('');
  });
});

describe('Check Spelling on a threaded frame', () => {
  it('with only a later frame selected, Selected Text Objects checks the story', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { createSpeller, setSpeller } = await import('../src/features/type/spell-dict.js');
    const { openCheckSpelling } = await import('../src/features/type/spelling.js');
    const dir = path.resolve(import.meta.dirname, '../public/dictionaries');
    setSpeller(createSpeller({ aff: fs.readFileSync(path.join(dir, 'en-US.aff'), 'utf8'), dic: fs.readFileSync(path.join(dir, 'en-US.dic'), 'utf8') }));
    // Another object, first in the document, has a misspelling too: the dialog opens on the whole document
    // and shows it first, but switching to Selected Text Objects must check the selection, not that object.
    const other = frame(0, 400, 'another mispeled word');
    const a = frame(0, 0, 'the qick fox');
    const b = frame(400, 0, '');
    app.editor.select([a.id, b.id]);
    app.commands.run('type.thread.create');
    app.editor.select([b.id]);
    const done = openCheckSpelling(app);
    const dlg = await new Promise((resolve) => {
      const look = () => {
        const d = document.querySelector('dialog[open] #sp-scope');
        if (d && !/Loading/.test(document.querySelector('dialog[open] .sp-status').textContent)) resolve(d.closest('dialog'));
        else setTimeout(look, 5);
      };
      look();
    });
    const scope = dlg.querySelector('#sp-scope');
    expect(dlg.querySelector('.sp-status').textContent).toBe('Not in the dictionary: \u201cmispeled\u201d');
    expect(scope.querySelector('option[value=sel]').disabled).toBe(false);
    scope.value = 'sel';
    scope.dispatchEvent(new Event('change'));
    expect(dlg.querySelector('.sp-status').textContent).toBe('Not in the dictionary: “qick”');
    // Ignore: the other text object is not part of the selection.
    [...dlg.querySelectorAll('button')].find((x) => x.textContent === 'Ignore').click();
    expect(dlg.querySelector('.sp-status').textContent).toMatch(/complete/);
    expect(doc.get(other.id).text).toBe('another mispeled word');
    [...dlg.querySelectorAll('button')].find((x) => x.textContent === 'Done').click();
    await done;
    app.setTool('select');
  });
});
