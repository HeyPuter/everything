// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { DocxPackage } from '../src/engine/docx.js';
import { protectionGuard } from '../src/engine/protection.js';
import { docxWithFootnote } from './helpers/docx.js';

// Track Changes records changes in the body only: a header, footer or note keeps no tracked changes here (a file
// with them opens read-only). With tracking on but not locked, a change there is made, as it is in a story of a
// document without tracking, and the editor says once per visit that it was not tracked, rather than saying nothing.
// With tracking locked, the change is refused (protection.js).
let editor, host, notices, errors;
beforeEach(() => {
  const known = { fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy(known, { get: (target, name) => name in target ? target[name] : () => {}, set: () => true }));
  host = document.createElement('div'); document.body.append(host);
  notices = vi.fn(); errors = vi.fn();
});
afterEach(() => { editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

async function open(trackChanges) {
  const pkg = await DocxPackage.open(docxWithFootnote({ text: 'note words' }));
  editor = new CanvasEditor(host, { paragraphs: pkg.paragraphs, pageSettings: pkg.pageSettings, numbering: pkg.numbering, styles: pkg.styles, tables: pkg.tables, pageStories: pkg.pageStories, assets: pkg.assets, trackChanges, onNotice: notices, onError: errors });
  return Object.keys(editor.pageStories.stories).find(p => editor.pageStories.stories[p].kind === 'footnote');
}
const type = text => editor.execute(() => { editor.model.replace(text); return true; });

it('says once per visit that a change in a note is not tracked while Track Changes is on', async () => {
  const note = await open(true);
  editor.editStory(note); editor.model.select(0);
  type('Two '); type('more ');
  expect(editor.model.text).toBe('Two more note words');
  expect(notices).toHaveBeenCalledTimes(1);
  expect(notices.mock.calls[0][0]).toMatch(/headers, footers and notes aren’t tracked/);
  // Moving the caret in the note is no change.
  editor.model.select(3); editor.syncInput();
  expect(notices).toHaveBeenCalledTimes(1);
  // Body changes are tracked, and say nothing.
  editor.editStory(null); editor.model.select(0); type('Body ');
  expect(editor.session.body.revisions.map(r => r.type)).toEqual(['ins']);
  expect(notices).toHaveBeenCalledTimes(1);
  // Back in the note, the next change says it again.
  editor.editStory(note); editor.model.select(0); type('x');
  expect(notices).toHaveBeenCalledTimes(2);
  expect(errors).not.toHaveBeenCalled();
});

it('says nothing with Track Changes off', async () => {
  const note = await open(false);
  editor.editStory(note); editor.model.select(0); type('Two ');
  expect(editor.model.text).toBe('Two note words');
  expect(notices).not.toHaveBeenCalled();
});

it('refuses the change when tracking is locked, without the notice', async () => {
  const note = await open(true);
  editor.session.guard = protectionGuard({ enforcement: true, edit: 'trackedChanges' });
  editor.editStory(note); editor.model.select(0);
  expect(type('Two ')).toBe(false);
  expect(editor.model.text).toBe('note words');
  expect(errors.mock.calls[0][0].message).toMatch(/tracked/);
  expect(notices).not.toHaveBeenCalled();
});
