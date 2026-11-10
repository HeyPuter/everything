// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { DocxPackage } from '../src/engine/docx.js';
import { paragraph } from '../src/engine/model.js';
import { revisionView } from '../src/engine/revisions.js';
import { wordCountStatistics, statusWordCount } from '../src/views/word-count.js';
import { docxWithFootnote } from './helpers/docx.js';

// The status bar's count and the Word Count dialog's count the same words for the same scope, and both count what
// the view shows: tracked deletions that Simple Markup, No Markup or balloons take out of the text are not counted,
// as desktop word processors count them.
let editor, host;
const mode = revisionView.mode, balloons = revisionView.options.balloons;
beforeEach(() => {
  // Any other drawing call does nothing: the counts, not the pixels, are under test.
  const known = { fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy(known, { get: (target, name) => name in target ? target[name] : () => {}, set: () => true }));
  host = document.createElement('div'); document.body.append(host);
});
afterEach(() => { revisionView.mode = mode; revisionView.options.balloons = balloons; editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

const open = pkg => (editor = new CanvasEditor(host, { paragraphs: pkg.paragraphs, pageSettings: pkg.pageSettings, numbering: pkg.numbering, styles: pkg.styles, tables: pkg.tables, pageStories: pkg.pageStories, assets: pkg.assets, trackChanges: false }));
function tracked() {
  // "one two three four", with "three " deleted and "new " inserted by Track Changes.
  const p = paragraph('');
  const by = { author: 'Author', date: '2026-10-27T00:00:00Z' };
  p.runs = [{ ...p.runs[0], text: 'one two ' }, { ...p.runs[0], text: 'three ', revision: { type: 'del', ...by } }, { ...p.runs[0], text: 'new ', revision: { type: 'ins', ...by } }, { ...p.runs[0], text: 'four' }];
  return (editor = new CanvasEditor(host, { paragraphs: [p], trackChanges: true }));
}

it.each([['all', 5], ['simple', 4], ['none', 4], ['original', 4]])('in %s markup counts %i words, in the status bar and the dialog', (view, words) => {
  tracked();
  revisionView.mode = view; editor.relayout();
  expect(wordCountStatistics(editor).words).toBe(words);
  expect(statusWordCount(editor).total).toBe(words);
  // A selection across the deletion counts the words shown in it.
  editor.model.select(4, 18);
  expect(wordCountStatistics(editor).words).toBe(statusWordCount(editor).chosen);
  expect(statusWordCount(editor).chosen).toBe(view === 'all' ? 3 : view === 'original' ? 2 : 2);
});

it('leaves out deletions shown in balloons', () => {
  tracked();
  revisionView.options.balloons = 'balloons'; editor.relayout();
  expect(wordCountStatistics(editor).words).toBe(4);
  expect(statusWordCount(editor).total).toBe(4);
});

it('counts the notes in the status bar too, as the dialog does with its box checked', async () => {
  const pkg = await DocxPackage.open(docxWithFootnote({ text: 'three note words' }));
  open(pkg);
  expect(wordCountStatistics(editor, { includeNotes: true }).words).toBe(5);
  expect(statusWordCount(editor, { includeNotes: true }).total).toBe(5);
  expect(wordCountStatistics(editor, { includeNotes: false }).words).toBe(2);
  expect(statusWordCount(editor, { includeNotes: false }).total).toBe(2);
});

it('counts a selection in a note against the whole document, in the status bar and the dialog', async () => {
  const pkg = await DocxPackage.open(docxWithFootnote({ text: 'three note words' }));
  open(pkg);
  const path = Object.keys(editor.pageStories.stories).find(p => editor.pageStories.stories[p].kind === 'footnote');
  editor.editStory(path);
  editor.model.select(0, 10);
  expect(wordCountStatistics(editor, { includeNotes: true })).toMatchObject({ selected: false, words: 5 });
  expect(statusWordCount(editor, { includeNotes: true })).toMatchObject({ chosen: 2, total: 5 });
});

it('counts the text of the drawings in the document, not of text an edit replaced', async () => {
  const pkg = await DocxPackage.open(new Uint8Array(readFileSync('tests/fixtures/drawing-text-pictures/control.docx')));
  open(pkg);
  const counted = wordCountStatistics(editor, { includeNotes: true }).words;
  expect(statusWordCount(editor, { includeNotes: true }).total).toBe(counted);
  // A drawing whose text was edited keeps its earlier version among the document's assets until it is saved.
  const image = editor.model.paragraphs.flatMap(p => p.runs).find(r => r.image).image;
  const frame = pkg.drawingTextFrames(image)[0];
  const { TextDocument } = await import('../src/engine/model.js');
  const draft = new TextDocument(frame.paragraphs, undefined, pkg.numbering, pkg.styles, frame.tables, pkg.assets);
  draft.select(0); draft.replace('Two more ');
  const prepared = pkg.prepareDrawingTextEdit(image, 0, draft.paragraphs, editor.model.assets, editor.model.styles, editor.model.numbering, draft.tables);
  editor.model.assets.edited = prepared.asset;
  let at = 0; for (const p of editor.model.paragraphs) { const i = p.runs.findIndex(r => r.image === image); if (i >= 0) { at += p.runs.slice(0, i).reduce((n, r) => n + r.text.length, 0); break; } at += p.runs.reduce((n, r) => n + r.text.length, 0) + 1; }
  editor.model.select(at, at + 1);
  editor.execute(() => editor.model.replaceDrawingText(image, 'edited', prepared.shell));
  editor.model.select(0);
  expect(wordCountStatistics(editor, { includeNotes: true }).words).toBe(counted + 2);
  expect(statusWordCount(editor, { includeNotes: true }).total).toBe(counted + 2);
});
