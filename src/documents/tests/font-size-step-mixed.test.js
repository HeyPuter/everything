// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { createWordCommands } from '../src/views/editor-commands.js';

const sizes = model => model.paragraphs.map(p => p.runs.map(r => [r.text, r.fontSize]));

let editor, host;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  host = document.createElement('div'); document.body.append(host);
  editor = new CanvasEditor(host, { paragraphs: [paragraph('small big'), paragraph('next')] });
});
afterEach(() => { editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

it('steps each size of a mixed selection from its own size in one undo step', () => {
  editor.model.select(6, 9); editor.setFontSize(20);
  editor.model.select(0, 14);
  expect(editor.model.runCommandFormatting.fontSize).toBe(null);
  const commands = createWordCommands({ editor: () => editor, pkg: () => ({}), error: e => { throw e; } });
  commands.growFont(1);
  expect(sizes(editor.model)).toEqual([[['small ', 14], ['big', 24]], [['next', 14]]]);
  commands.growFont(-1, 1);
  expect(sizes(editor.model)).toEqual([[['small ', 13], ['big', 23]], [['next', 13]]]);
  expect(editor.model.range).toEqual([0, 14]);
  editor.undo();
  expect(sizes(editor.model)).toEqual([[['small ', 14], ['big', 24]], [['next', 14]]]);
  editor.undo();
  expect(sizes(editor.model)).toEqual([[['small ', 12], ['big', 20]], [['next', 12]]]);
});

it('steps a mixed selection on the model alone as one history entry', () => {
  const model = new TextDocument([paragraph('one two three')]);
  model.select(4, 7); model.setFontSize(9);
  model.select(0, 13);
  const before = model.history.length;
  expect(model.stepFontSize(size => size * 2)).toBe(true);
  expect(sizes(model)).toEqual([[['one ', 24], ['two', 18], [' three', 24]]]);
  expect(model.history.length).toBe(before + 1);
  expect(model.range).toEqual([0, 13]);
  model.undo();
  expect(sizes(model)).toEqual([[['one ', 12], ['two', 9], [' three', 12]]]);
});
