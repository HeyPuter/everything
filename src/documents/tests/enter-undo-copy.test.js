// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph } from '../src/engine/model.js';

// After Enter, the copy of the document the next command starts from (for Undo) was made while the browser
// was idle, one structuredClone of the whole document: 12 ms for a 161-page document and 56 ms for one with
// 150 tables, in one task, which a key pressed meanwhile waited for. Enter now makes it from its own copy, as
// a typed character does (typing-copies.js), copying only the paragraphs it replaced.
let editor, host, idle;
const runIdle = () => { const pending = idle; idle = []; for (const callback of pending) callback({ didTimeout: false, timeRemaining: () => 10 }); };
beforeEach(() => {
  idle = [];
  vi.stubGlobal('requestIdleCallback', callback => idle.push(callback));
  vi.stubGlobal('cancelIdleCallback', () => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto',
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  host = document.createElement('div'); document.body.append(host);
  editor = new CanvasEditor(host, { paragraphs: Array.from({ length: 40 }, (_, i) => paragraph(`Paragraph ${i} has some words in it.`)) });
});
afterEach(() => { editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const press = (key, options = {}) => editor.input.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true, ...options }));
const text = () => editor.model.text;

it.each([['Enter', {}], ['Shift+Enter', { shiftKey: true }]])('%s leaves the next command a copy of the document without copying all of it', (_, options) => {
  runIdle();
  const original = text(), at = original.indexOf(' has', original.indexOf('Paragraph 20'));
  editor.model.select(at); editor.syncInput();
  const clone = vi.spyOn(globalThis, 'structuredClone');
  press('Enter', options);
  expect(text()).not.toBe(original);
  const afterEnter = text();
  // The copy for the next command is ready at once, and nothing waits for the browser to be idle to make one.
  const prepared = editor.session.prepared;
  expect(prepared?.model).toBe(editor.model);
  expect(prepared.revision).toBe(editor.model.revision);
  expect(JSON.stringify(prepared.document)).toBe(JSON.stringify(editor.model.documentState()));
  expect(idle).toHaveLength(0);
  // Only the paragraphs Enter replaced were copied, not all 40.
  const copied = clone.mock.calls.filter(([value]) => value && typeof value === 'object' && 'runs' in value).length;
  expect(copied).toBeLessThanOrEqual(3);
  // The next command starts from that copy, and Undo takes each step back exactly.
  const snapshot = vi.spyOn(editor.model, 'snapshot');
  editor.model.select(editor.model.selection.focus); editor.execute(() => editor.model.replace('x'));
  expect(snapshot).not.toHaveBeenCalled();
  editor.undo(); expect(text()).toBe(afterEnter);
  editor.undo(); expect(text()).toBe(original);
  editor.redo(); expect(text()).toBe(afterEnter);
});

it('Enter on an empty list item, which changes the paragraph in place, still undoes exactly', () => {
  editor.model.select(text().length); editor.toggleList('bullet');
  editor.model.select(text().length); editor.syncInput();
  press('Enter');
  runIdle();
  const items = () => editor.model.paragraphs.map(p => !!p.list);
  const before = items();
  expect(before.at(-1)).toBe(true);
  press('Enter');
  expect(items().at(-1)).toBe(false);
  expect(JSON.stringify(editor.session.prepared?.document ?? null)).toBe(JSON.stringify(editor.model.documentState()));
  editor.model.select(text().length); editor.execute(() => editor.model.replace('x'));
  editor.undo(); editor.undo();
  expect(items()).toEqual(before);
});
