// @vitest-environment jsdom
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { DocxPackage } from '../src/engine/docx.js';
import { openDrawingText } from '../src/views/drawing-text.js';

// Text in a text box or shape is applied with its drawing, untracked: with Track Changes on, the dialog says so
// before anything is typed.
let editor, host, modal;
beforeEach(() => {
  const known = { fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy(known, { get: (target, name) => name in target ? target[name] : () => {}, set: () => true }));
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  host = document.createElement('div'); document.body.append(host);
});
afterEach(() => { modal?.close(); editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

async function dialog(trackChanges) {
  const pkg = await DocxPackage.open(new Uint8Array(readFileSync('tests/fixtures/drawing-text-pictures/control.docx')));
  editor = new CanvasEditor(host, { paragraphs: pkg.paragraphs, pageSettings: pkg.pageSettings, numbering: pkg.numbering, styles: pkg.styles, tables: pkg.tables, pageStories: pkg.pageStories, assets: pkg.assets, trackChanges });
  const image = editor.model.paragraphs.flatMap(p => p.runs).find(r => r.image).image;
  modal = openDrawingText({ engine: editor, pkg, image, frame: 0 });
  return document.querySelector('[role="dialog"]');
}

it('says drawing text is not tracked while Track Changes is on', async () => {
  expect((await dialog(true)).textContent).toContain('Track Changes is on, but changes to drawing text aren’t tracked.');
});

it('says nothing of tracking while it is off', async () => {
  expect((await dialog(false)).textContent).not.toContain('Track Changes');
});
