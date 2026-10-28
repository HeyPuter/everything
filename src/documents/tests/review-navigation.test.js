// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph } from '../src/engine/model.js';
import { createReview } from '../src/views/review.js';

let editor, host, review;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  host = document.createElement('div'); document.body.append(host);
});
afterEach(() => { review?.destroy(); editor?.destroy(); review = editor = null; document.body.replaceChildren(); vi.restoreAllMocks(); });

function open(texts) {
  editor = new CanvasEditor(host, { paragraphs: texts.map(text => paragraph(text)), comments: [] });
  review = createReview({ editor: () => editor, pkg: () => ({}), host: () => host, error: e => { throw e; }, author: () => 'Ada' });
  review.refresh(true);
  return editor;
}
const selected = () => { const [a, b] = editor.model.range; return editor.model.text.slice(a, b); };

it('Next and Previous Change visit the changes inside a reformatted paragraph and the paragraph\'s own change', () => {
  open(['First line.', 'Second line here.', 'Third line.']);
  review.commands.toggleTracking(true);
  editor.execute(() => { editor.model.select(19, 19); editor.model.replace('new '); });
  editor.execute(() => { editor.model.select(14, 14); editor.model.setParagraphFormat({ alignment: 'center' }); });
  expect(editor.model.revisions.map(r => r.type)).toEqual(['format', 'ins']);
  editor.model.select(0, 0);
  const forward = [];
  for (let i = 0; i < 3; i++) { review.commands.goChange(1); forward.push(selected()); }
  expect(forward).toEqual(['Second new line here.\n', 'new ', 'Second new line here.\n']);
  const back = [];
  for (let i = 0; i < 3; i++) { review.commands.goChange(-1); back.push(selected()); }
  expect(back).toEqual(['new ', 'Second new line here.\n', 'new ']);
});
