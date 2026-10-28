// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { CanvasEditor } from '../src/engine/canvas-editor.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { pictureHtml, htmlPicture, copiesPicture } from '../src/engine/clipboard-fragment.js';

// U+FFFC is the document's placeholder for an object, not text another application (or a paste back
// here) should receive.
const OBJECT = '￼';
const mixed = () => paragraph('', { runs: [{ text: 'Page ' }, { text: OBJECT, field: { type: 'PAGE', cachedText: '7' } }, { text: ' sum ' }, { text: OBJECT, math: { xml: '<m:oMath/>', text: 'x+1' } }, { text: ' stray' }, { text: OBJECT }, { text: '.' }] });

it('copies fields as their results, equations as their text and drops bare object characters', () => {
  const d = new TextDocument([mixed()]);
  d.select(0, d.text.length);
  expect(d.clipboardText()).toBe('Page 7 sum x+1 stray.');
  // A note reference copies as whatever its caller says it shows.
  const note = new TextDocument([paragraph('', { runs: [{ text: 'Claim' }, { text: OBJECT, noteMark: { kind: 'footnoteReference', id: '1', text: OBJECT, display: '' } }] })]);
  note.select(0, 6);
  expect(note.clipboardText()).toBe('Claim');
  expect(note.clipboardText((run, at) => run.noteMark && at === 5 ? '1' : '?')).toBe('Claim1');
});

it('copies a table in a selection as one line per row with a tab between cells', () => {
  const d = new TextDocument([paragraph('Before')]);
  d.select(6); d.insertTable(2, 3);
  for (const [i, text] of ['a1', 'b1', 'c1', 'a2', 'b2', 'c2'].entries()) { if (i) d.moveCell(1); d.replace(text); }
  // A second paragraph in a cell stays on its own line, as in other word processors.
  d.select(d.text.indexOf('b2') + 2); d.insertParagraph(); d.replace('more');
  d.select(d.text.length); d.replace('After');
  d.select(0, d.text.length);
  expect(d.clipboardText()).toBe('Before\na1\tb1\tc1\na2\tb2\nmore\tc2\nAfter');
});

let editor;
afterEach(() => { editor?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });

it('pastes text without object characters, and a picture that came with only one', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {},
  });
  const host = document.createElement('div'); document.body.append(host);
  editor = new CanvasEditor(host, { paragraphs: [paragraph('Start')] });
  editor.model.select(5);
  const paste = (text, files = []) => { const event = new Event('paste', { bubbles: true, cancelable: true }); event.clipboardData = { getData: type => type === 'text/plain' ? text : '', files }; editor.input.dispatchEvent(event); };
  paste(` claim${OBJECT} here`);
  expect(editor.model.text).toBe('Start claim here');
  const inserted = vi.spyOn(editor, 'insertImageFile').mockResolvedValue(true);
  const picture = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
  paste(OBJECT, [picture]);
  expect(inserted).toHaveBeenCalledWith(picture);
  expect(editor.model.text).toBe('Start claim here');
});

it('copies a selected picture as the picture, which a paste here inserts at its size', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 255]);
  const d = new TextDocument([paragraph('', { runs: [{ text: 'A' }, { text: OBJECT, image: { assetId: 'p1', id: 1, name: 'Picture 1', alt: 'A "logo"', width: 457200, height: 228600 } }] })]);
  d.assets = { p1: { bytes, mime: 'image/png' } };
  d.select(0, 2);
  expect(copiesPicture(d)).toBe(false); expect(pictureHtml(d)).toBe('');
  d.select(1, 2);
  const html = pictureHtml(d);
  expect(html).toMatch(/^<img src="data:image\/png;base64,[^"]+" alt="A &quot;logo&quot;" width="48" height="24" data-documents-picture=/);
  const picture = htmlPicture(html);
  expect(picture).toMatchObject({ alt: 'A "logo"', width: 457200, height: 228600 });
  expect(picture.file.type).toBe('image/png');
  const read = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(new Uint8Array(reader.result)); reader.readAsArrayBuffer(picture.file); });
  expect(read).toEqual(bytes);
  // A cropped, flipped and turned picture: other applications get the whole image at its own size, a paste
  // here its frame, crop, flip and rotation; a crop that cannot be applied is left out.
  Object.assign(d.paragraphs[0].runs[1].image, { crop: { left: 0, top: 10000, right: 0, bottom: 0 }, flipV: true, rotation: 5400000 });
  const cropped = pictureHtml(d);
  expect(cropped).not.toMatch(/ width=/);
  expect(htmlPicture(cropped)).toMatchObject({ width: 457200, height: 228600, crop: { left: 0, top: 10000, right: 0, bottom: 0 }, flipV: true, rotation: 5400000 });
  const junk = cropped.replace(/data-documents-picture="[^"]*"/, `data-documents-picture="${JSON.stringify({ width: 9525, height: 9525, crop: { left: 60000, right: 60000 }, flipH: 'yes', rotation: -1 }).replace(/"/g, '&quot;')}"`);
  expect(htmlPicture(junk)).toEqual({ file: expect.any(File), alt: '', width: 9525, height: 9525 });
  // Another application's picture HTML is not taken for one of ours.
  expect(htmlPicture('<img src="data:image/png;base64,iVBORw0KGgo=">')).toBe(null);
  // Charts and drawings are not copied as pictures.
  d.paragraphs[0].runs[1].image = { ...d.paragraphs[0].runs[1].image, kind: 'chart' };
  expect(copiesPicture(d)).toBe(false);
});
