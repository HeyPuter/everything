// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph } from '../src/engine/model.js';
import { createThesaurusPane } from '../src/views/thesaurus-pane.js';

let editor, host;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  host = document.createElement('div'); document.body.append(host);
  editor = new CanvasEditor(host, { paragraphs: [paragraph('A happy day')] });
});
afterEach(() => { editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

it.each([false, true])('inserts one synonym after another over the word, with Track Changes %s', track => {
  editor.model.trackChanges = track;
  const errors = [], pane = createThesaurusPane({ editor: () => editor, pkg: () => ({}), error: e => errors.push(e.message) });
  editor.model.select(4); pane.open();
  pane.insert('glad');
  const shown = () => editor.model.paragraphs[0].runs.filter(r => r.revision?.type !== 'del').map(r => r.text).join('');
  expect(shown()).toBe('A glad day');
  expect(editor.model.text.slice(...editor.model.range)).toBe('glad');
  pane.insert('joyful');
  expect(errors).toEqual([]);
  expect(shown()).toBe('A joyful day');
  expect(editor.model.text.slice(...editor.model.range)).toBe('joyful');
  pane.destroy();
});
