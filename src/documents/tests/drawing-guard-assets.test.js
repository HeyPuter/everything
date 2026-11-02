import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { pictureFragment } from '../src/engine/picture-insert.js';
import { StorySession } from '../src/engine/story-session.js';
import { protectionGuard } from '../src/engine/protection.js';
import { formatDrawing, drawingParts } from '../src/engine/drawing-format.js';
import { setTransform } from '../src/engine/drawing-xml.js';

// A picture edit that document protection refuses leaves the picture as it was, and showing.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; globalThis.createImageBitmap = async () => ({ width: 128, height: 128, close() { this.closed = true; } }); });
afterAll(() => { dom.window.close(); delete globalThis.createImageBitmap; });
const png = new Uint8Array(readFileSync('icon-128.png'));
const modelOf = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const images = m => m.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image));

it('keeps the picture\'s asset and bitmap when protection refuses a change to it', async () => {
  const created = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES), first = modelOf(created);
  const fragment = await pictureFragment(first, created.parts, { png, width: 914400, height: 914400, id: 1, name: 'Picture 1' });
  Object.assign(first.assets, fragment.assets); const { assetId, id, ...properties } = fragment.image; first.insertImage(assetId, properties);
  const pkg = await DocxPackage.open(new Uint8Array(await created.export(first.paragraphs, first.pageSettings, first.numbering, first.styles, first.tables, first.assets).arrayBuffer()));
  const session = new StorySession(modelOf(pkg));
  const errors = [];
  const editor = { session, images: new Map(), readOnly: false, get model() { return session.model; }, shapePackage: () => pkg, finishComposition() {}, focus() {}, onSelection() {},
    execute(action, onFailure) { try { session.run(() => action()); return true; } catch (e) { errors.push(e); onFailure?.(e); return false; } } };
  const image = images(editor.model)[0], bitmap = { width: 128, height: 128, close() { this.closed = true; } };
  editor.images.set(image.assetId, bitmap);
  // Comments only: changing the picture is refused.
  session.guard = protectionGuard({ enforcement: true, edit: 'comments' });
  const ok = await formatDrawing(editor, image, async drawing => setTransform(drawingParts(drawing).properties, { flipH: true }), { label: 'picture' });
  expect(ok).toBe(false); expect(errors).toHaveLength(1);
  expect(images(editor.model)[0]).toEqual(image);
  expect(editor.model.assets[image.assetId]).toBeTruthy();
  expect(editor.images.get(image.assetId)).toBe(bitmap);
  expect(bitmap.closed).toBeFalsy();
});
