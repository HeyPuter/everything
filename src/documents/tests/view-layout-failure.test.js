// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { paragraph } from '../src/engine/model.js';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { readFileSync } from 'node:fs';
import { DocxPackage } from '../src/engine/docx.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { viewGeometry, viewPageStories } from '../src/engine/document-views.js';

// A screen view is laid out to the window's width. A document it cannot be laid out to (here, an
// indent wider than the window) failed to switch, but the editor kept the new view with the old
// layout: every later layout failed the same way, so the next keystroke threw and nothing was typed.
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

it('stays in the view it had when a screen view cannot lay the document out, and keeps editing', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {}, scale() {}, translate() {}, drawImage() {}, clearRect() {},
  });
  const host = document.createElement('div'); document.body.append(host);
  const errors = [];
  // A 4.9-inch indent fits the Letter page (6.5 inches of text) but not a 400-pixel window.
  const editor = new CanvasEditor(host, { paragraphs: [paragraph('Plain text'), paragraph('Indented quote', { format: { indentLeft: 7000 } })], onError: e => errors.push(e.message) });
  const printed = JSON.stringify(editor.layout.lines);
  expect(() => editor.setView({ kind: 'web', width: 400 })).toThrow(/no writing space/);
  expect(editor.view).toBeNull();
  expect(JSON.stringify(editor.layout.lines)).toBe(printed);
  editor.model.select(5);
  expect(editor.execute(() => editor.model.replace('typed '))).toBe(true);
  expect(errors).toEqual([]);
  expect(editor.model.text).toBe('Plaintyped  text\nIndented quote');
  // A window wide enough shows the view.
  expect(editor.setView({ kind: 'web', width: 900 })).toBe(true);
  expect(editor.view.kind).toBe('web');
  // And a narrower one later keeps the last width that fits.
  expect(() => editor.setView({ kind: 'web', width: 400 })).toThrow(/no writing space/);
  expect(editor.view).toEqual({ kind: 'web', width: 900 });
  expect(editor.execute(() => editor.model.replace('again '))).toBe(true);
  expect(editor.model.text).toContain('again');
  editor.destroy();
});

// A continuous section that restarts page numbering on a new paper size starts a new page when
// printed. A screen view lays every section out on one screen geometry, so the section continued
// the one before it, and restarting numbers there is not supported: the document could not be
// shown in Web Layout, Draft or Read Mode at any width. Screen views number no pages.
it('shows a page-number restart on a new paper size in every screen view', async () => {
  const pkg = await DocxPackage.open(new Uint8Array(readFileSync('tests/fixtures/continuous-numbering-recovery/paper-change.docx')));
  expect(pkg.readOnly).not.toBe(true);
  const measure = (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize, descent: style.fontSize * .25 });
  const text = layout => layout.lines.map(line => line.fragments.map(f => f.text).join('')).join('|');
  const printed = layoutDocument(pkg.paragraphs, measure, pageGeometry(pkg.pageSettings), pkg.numbering, pkg.tables, pkg.pageStories);
  for (const view of [{ kind: 'web', width: 900 }, { kind: 'draft', width: 900 }, { kind: 'read', width: 640, height: 800 }]) {
    const shown = layoutDocument(pkg.paragraphs, measure, pageGeometry(pkg.pageSettings), pkg.numbering, pkg.tables, viewPageStories(pkg.pageStories, view.kind), { viewGeometry: viewGeometry(view) });
    expect(text(shown).replace(/\|/g, '')).toBe(text(printed).replace(/\|/g, ''));
  }
});
