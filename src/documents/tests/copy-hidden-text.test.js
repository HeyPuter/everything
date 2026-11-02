// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { paragraph } from '../src/engine/model.js';
import { revisionView } from '../src/engine/revisions.js';

let editor, host, errors;
const view = { ...revisionView, options: { ...revisionView.options } };
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  host = document.createElement('div'); document.body.append(host);
  errors = vi.fn();
  // "Alpha [beta ]new gamma secret end": "beta " deleted and "new " inserted by a reviewer, "secret " hidden text.
  const p = paragraph(''), base = p.runs[0];
  const del = { type: 'del', author: 'Ada', date: '2026-10-27T00:00:00Z' }, ins = { type: 'ins', author: 'Ada', date: '2026-10-27T00:00:00Z' };
  p.runs = [{ ...base, text: 'Alpha ' }, { ...base, text: 'beta ', revision: del }, { ...base, text: 'new ', revision: ins }, { ...base, text: 'gamma ' }, { ...base, text: 'secret ', vanish: true }, { ...base, text: 'end' }];
  editor = new CanvasEditor(host, { paragraphs: [p, paragraph('')], onError: errors });
  editor.focus();
});
afterEach(() => { Object.assign(revisionView, { ...view, options: { ...view.options } }); editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

const copied = () => { editor.model.select(0, 31); return editor.clipboardData(); };
const pastedBack = data => { editor.model.select(32); editor.pasteData(data.text, data.html); return editor.model.paragraphs[1].runs.map(r => r.text).join(''); };

it('copies what the view shows: deletions it hides and hidden text are left out', () => {
  revisionView.mode = 'simple'; editor.relayout();
  const data = copied();
  expect(data.text).toBe('Alpha new gamma end');
  // Pasted back (as its own formatted copy), the deleted and hidden words do not come back as ordinary text.
  expect(pastedBack(data)).toBe('Alpha new gamma end');
  expect(errors).not.toHaveBeenCalled();
});

it('in the Original view the insertion is what is hidden', () => {
  revisionView.mode = 'original'; editor.relayout();
  expect(copied().text).toBe('Alpha beta gamma end');
});

it('with all markup and hidden text shown, everything shown is copied', () => {
  revisionView.mode = 'all'; revisionView.showHidden = true; editor.relayout();
  const data = copied();
  expect(data.text).toBe('Alpha beta new gamma secret end');
  expect(pastedBack(data)).toBe('Alpha beta new gamma secret end');
});
