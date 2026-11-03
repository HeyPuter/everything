// @vitest-environment jsdom
// Keys that come faster than the browser goes idle (jsdom has no requestIdleCallback, so it never is): each one
// still keeps an exact copy of the document for Undo, but copies only what it changed.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph } from '../src/engine/model.js';

let editor, host, errors;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    measureText: text => ({ width: [...text].length * 7 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  host = document.createElement('div'); document.body.append(host);
  errors = vi.fn();
});
afterEach(() => { editor?.destroy(); editor = null; document.body.replaceChildren(); vi.restoreAllMocks(); });

const sentence = i => `Paragraph ${i} keeps its words, wrapping across the width of the page now and then.`;
function open(count, change = () => {}) {
  const paragraphs = Array.from({ length: count }, (_, i) => {
    const p = paragraph(sentence(i));
    if (i % 3 === 0) p.runs.push({ ...p.runs[0], text: ' Bold words.', bold: true });
    change(p, i);
    return p;
  });
  editor = new CanvasEditor(host, { paragraphs, onError: errors });
  return editor;
}
const press = key => {
  if (key === '⌫') editor.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', cancelable: true }));
  else editor.input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: key }));
};
const caretIn = (index, offset = 8) => { editor.model.select(editor.model.paragraphOffset(index) + offset); editor.syncInput(); };
// Paragraphs handed to structuredClone: the copies Undo keeps, and the model's own copies of a paragraph it edits.
function countCopies() {
  const clone = globalThis.structuredClone, counts = [];
  const paragraphsIn = value => Array.isArray(value) ? value.filter(p => Array.isArray(p?.runs)).length
    : Array.isArray(value?.paragraphs) ? value.paragraphs.length : Array.isArray(value?.runs) ? 1 : 0;
  vi.spyOn(globalThis, 'structuredClone').mockImplementation(value => { counts[counts.length - 1] += paragraphsIn(value); return clone(value); });
  return { key: () => counts.push(0), counts };
}

it.each([[300], [1500]])('copies a few paragraphs per key typed quickly anywhere in %i paragraphs', count => {
  open(count);
  const copies = countCopies();
  // The first key copies the whole document, never copied while idle; the rest copy what changed.
  caretIn(0); press('a');
  for (const index of [0, count >> 1, count - 1]) {
    caretIn(index);
    for (const key of 'bcd efg⌫⌫hi jk') { copies.key(); press(key); }
  }
  expect(errors).not.toHaveBeenCalled();
  expect(Math.max(...copies.counts)).toBeLessThanOrEqual(4);
}, 120000);

const state = () => JSON.stringify({ document: editor.model.documentState(), selection: editor.model.selection });
/** Types `keys`, then undoes and redoes every step, comparing each with the document when that step began. */
function typeUndoRedo(keys, before = () => {}) {
  const steps = [], history = editor.session.history.length;
  for (const key of keys) {
    before(key);
    const at = state(), length = editor.session.history.length;
    press(key);
    if (editor.session.history.length > length) steps.push(at);
  }
  const end = state();
  expect(editor.session.history.length - history).toBe(steps.length);
  for (let i = steps.length - 1; i >= 0; i--) { editor.undo(); expect(state()).toBe(steps[i]); }
  for (let i = 1; i <= steps.length; i++) { editor.redo(); expect(state()).toBe(i < steps.length ? steps[i] : end); }
  return steps.length;
}

it.each([['start', 0], ['middle', 100], ['end', 199]])('undoes and redoes quick typing at the %s word by word', (_, index) => {
  open(200);
  caretIn(index);
  // A word is one step; Backspace after typing is another, as before.
  expect(typeUndoRedo('Quick brown fox⌫⌫x, jumps over.')).toBe(7);
  expect(errors).not.toHaveBeenCalled();
}, 120000);

it('undoes Backspace that took a list item’s numbering away in the middle of quick typing', () => {
  open(40);
  caretIn(10, 0); editor.execute(() => editor.model.toggleList('bullet'));
  expect(editor.model.paragraphs[10].list).toBeTruthy();
  caretIn(10, 5);
  // Backspace at the item's start changes its paragraph in place: the numbering goes, the text stays.
  const steps = typeUndoRedo('abc⌫xyz', key => { if (key === '⌫') caretIn(10, 0); });
  expect(steps).toBe(3);
  expect(editor.model.paragraphs[10].list).toBeFalsy();
  editor.undo(); editor.undo();
  expect(editor.model.paragraphs[10].list).toBeTruthy();
  expect(errors).not.toHaveBeenCalled();
}, 120000);

it('keeps what two paragraphs share shared in Undo, also after a key the document refused', () => {
  // An object two paragraphs hold, as a field's start and end hold one. structuredClone keeps it shared.
  const shared = { blurRadius: 0, distance: 0, direction: 0, scaleX: 0, scaleY: 0, skewX: 0, skewY: 0, alignment: 'none', color: '000000', alpha: 0 };
  open(30, (p, i) => { if (i === 2 || i === 9) p.runs[0].textShadow = shared; });
  const sharedIn = () => editor.model.paragraphs[2].runs.find(r => r.textShadow)?.textShadow === editor.model.paragraphs[9].runs[0].textShadow;
  expect(sharedIn()).toBe(true);
  caretIn(2, 20);
  press('a');
  // A key the document refuses puts back equal copies of every paragraph.
  editor.session.guard = (before, model) => { if (model.text.includes('aQ')) throw new Error('Refused.'); };
  press('Q');
  expect(errors).toHaveBeenCalledOnce();
  editor.session.guard = null;
  for (const key of 'bc d') press(key);
  expect(sharedIn()).toBe(true);
  editor.undo();
  expect(editor.model.paragraphs[2].runs.map(r => r.text).join('')).toContain('abc ');
  expect(sharedIn()).toBe(true);
  editor.undo(); editor.undo();
  expect(sharedIn()).toBe(true);
  expect(editor.model.paragraphs[2].runs.map(r => r.text).join('')).toBe(sentence(2));
}, 120000);
