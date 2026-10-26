import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, W } from '../src/engine/docx.js';
import { WP, A, PIC, R } from '../src/engine/docx-images.js';
import { TextDocument, boundaries, paragraph, paragraphText } from '../src/engine/model.js';
import { imageInfo, OBJECT, EMU_PER_INCH, EMU_PER_PX } from '../src/engine/images.js';
import { layoutDocument, caretRect, hitTest, imageAtPoint, selectionRects } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('public/fixtures/inline-images.docx');
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer());
const pictures = doc => doc.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image));
const measure = (text, style) => ({ width: [...text].length * style.fontSize * 2 / 3, ascent: style.fontSize * 1.1, descent: style.fontSize / 3 });
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
const change = (mutate, path = 'word/document.xml') => {
  const parts = unzipSync(source), xml = new DOMParser().parseFromString(strFromU8(parts[path]), 'application/xml');
  mutate(xml, parts); parts[path] = strToU8(new XMLSerializer().serializeToString(xml)); return zipSync(parts);
};
const node = (xml, ns, name) => xml.getElementsByTagNameNS(ns, name)[0];
function pictureGeometry(result) {
  for (const line of [...result.lines, ...result.repeatedLines]) for (const f of line.fragments.filter(f => f.image)) {
    expect(f.width).toBeCloseTo(f.image.width / EMU_PER_PX); expect(f.ascent).toBeCloseTo(f.image.height / EMU_PER_PX);
    expect(line.baseline - f.ascent).toBeGreaterThanOrEqual(line.y - 1e-6); expect(line.baseline).toBeLessThanOrEqual(line.y + line.height + 1e-6);
    expect(imageAtPoint(result, line.page, f.x + f.width / 2, line.baseline - f.ascent / 2)).toBe(f);
    expect(hitTest(result, line.page, f.x, line.baseline - f.ascent / 2)).toBe(f.start);
    expect(hitTest(result, line.page, f.x + f.width, line.baseline - f.ascent / 2)).toBe(f.end);
    expect(caretRect(result, f.start, 'forward', line.page).page).toBe(line.page);
    expect(selectionRects(result, f.start, f.end).some(r => r.page === line.page && r.width >= f.width - 1e-6)).toBe(true);
    const box = result.cells.find(c => c.id === line.cellId && c.page === line.page);
    if (box) { expect(f.x).toBeGreaterThanOrEqual(box.x); expect(f.x + f.width).toBeLessThanOrEqual(box.x + box.width + 1e-6); }
  }
}

it('reads independent inline pictures, reuses binary assets and preserves every no-edit package entry', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  expect(pictures(doc)).toHaveLength(6); expect(doc.text.match(/\ufffc/g)).toHaveLength(6); expect(Object.keys(pkg.assets)).toHaveLength(2);
  expect(pictures(doc)[0]).toMatchObject({ width: EMU_PER_INCH * 1.25, height: EMU_PER_INCH * .625, alt: 'Blue and orange panels', aspectLocked: true });
  for (const asset of Object.values(pkg.assets)) expect(imageInfo(asset.bytes)).toEqual({ mime: 'image/png', width: 64, height: 32 });
  const out = unzipSync(await save(pkg, doc)); for (const [name, bytes] of Object.entries(pkg.parts)) expect(Buffer.from(out[name]).equals(Buffer.from(bytes)), name).toBe(true);
});

it('lays pictures out as unbreakable baseline objects in flowing text, AutoFit cells and repeated headers', async () => {
  const doc = model(await DocxPackage.open(source)), result = layout(doc); pictureGeometry(result);
  expect(result.pageCount).toBeGreaterThan(2); expect(result.repeatedLines.some(l => l.fragments.some(f => f.image))).toBe(true);
  const first = pictures(doc)[0], line = result.lines.find(l => l.fragments.some(f => f.image === first));
  const f = line.fragments.find(f => f.image); expect(line.fragments.map(f => f.text).join('')).toBe(`Before ${OBJECT} after.`);
  // The independent inline-object-advance reference controls establish that automatic
  // leading multiplies text metrics, not the object's natural height.
  const textMetrics = measure('', { fontSize: 11 });
  expect(line.height).toBeCloseTo(f.ascent + textMetrics.descent + (textMetrics.ascent + textMetrics.descent) * .5);
  expect(f.x).toBeCloseTo(result.page.left + measure('Before ', { fontSize: 11 }).width); // distL does not add inline padding.
  expect(result.tableWidths[doc.tables[1].id][0]).toBeGreaterThanOrEqual(2 * 96 + 14.4 - 1e-6);
});

it('edits around an atomic picture, preserves it across paragraph splits, and deletes/undoes/redoes it without copying it into typed text', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), start = doc.text.indexOf(OBJECT), original = doc.snapshot();
  doc.select(start); doc.replace('A'); doc.select(start + 2); doc.replace('Z'); expect(pictures(doc)).toHaveLength(6);
  expect(doc.text).toContain(`Before A${OBJECT}Z after.`); expect(doc.paragraphs.flatMap(p => p.runs).filter(r => r.image).every(r => r.text === OBJECT)).toBe(true);
  doc.select(start + 1); doc.insertParagraph(); expect(pictures(doc)).toHaveLength(6); pictureGeometry(layout(doc));
  const at = doc.text.indexOf(OBJECT); doc.select(at + 1); doc.delete(-1); expect(pictures(doc)).toHaveLength(5);
  doc.undo(); expect(pictures(doc)).toHaveLength(6); doc.redo(); expect(pictures(doc)).toHaveLength(5);
  const reopened = model(await DocxPackage.open(await save(pkg, doc))); expect(reopened.text).toBe(doc.text); expect(pictures(reopened)).toHaveLength(5);
  while (doc.history.length) doc.undo(); expect(doc.snapshot()).toEqual({ ...original, selection: { anchor: start, focus: start } });
  const out = unzipSync(await save(pkg, doc)); for (const [name, bytes] of Object.entries(pkg.parts)) expect(Buffer.from(out[name]).equals(Buffer.from(bytes)), name).toBe(true);
  expect(boundaries(`${OBJECT}\u0301${OBJECT}Á😀`)).toEqual([0, 1, 2, 3, 5, 7]);
});

it('resizes and describes an image without changing its media, relationship, source distances or inherited text formatting', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), at = doc.text.indexOf(OBJECT); doc.select(at, at + 1);
  const before = doc.snapshot(); expect(doc.setImageProperties({ width: EMU_PER_INCH, height: EMU_PER_INCH / 2, alt: 'Two color panels revised' })).toBe(true);
  expect(doc.setImageProperties({ alt: 'Two color panels revised' })).toBe(false);
  expect(() => doc.setImageProperties({ width: EMU_PER_INCH * 2 })).toThrow(/aspect ratio/);
  doc.setRunFormat({ fontSize: 18 }); expect(doc.selectedImage.width).toBe(EMU_PER_INCH); pictureGeometry(layout(doc));
  const bytes = await save(pkg, doc), out = unzipSync(bytes), reopened = model(await DocxPackage.open(bytes));
  expect(pictures(reopened)[0]).toMatchObject({ width: EMU_PER_INCH, height: EMU_PER_INCH / 2, alt: 'Two color panels revised' });
  const xml = new DOMParser().parseFromString(strFromU8(out['word/document.xml']), 'application/xml');
  expect(node(xml, WP, 'inline').getAttribute('distL')).toBe('914400'); expect(node(xml, A, 'ext').getAttribute('cx')).toBe(String(EMU_PER_INCH));
  for (const [name, value] of Object.entries(pkg.parts)) if (name !== 'word/document.xml') expect(Buffer.from(out[name]).equals(Buffer.from(value)), name).toBe(true);
  doc.undo(); doc.undo(); expect(doc.snapshot()).toEqual(before); doc.redo(); expect(doc.selectedImage.alt).toBe('Two color panels revised');
});

it('saves alt text with a pasted line break or control character as readable XML', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), at = doc.text.indexOf(OBJECT); doc.select(at, at + 1);
  // A line break copied from a document arrives as a vertical tab, which XML 1.0 cannot hold.
  expect(doc.setImageProperties({ alt: 'Two panels\u000bside by side\u0001' })).toBe(true);
  expect(doc.selectedImage.alt).toBe('Two panels\nside by side');
  const bytes = await save(pkg, doc);
  expect(strFromU8(unzipSync(bytes)['word/document.xml'])).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  expect(pictures(model(await DocxPackage.open(bytes)))[0].alt).toBe('Two panels\nside by side');
});

it('authors picture runs, allocates unique drawing/media relationships and reuses a source asset without duplicating its binary', async () => {
  const sourcePkg = await DocxPackage.open(source), bytes = Object.values(sourcePkg.assets)[0].bytes;
  const pkg = createDocx([paragraph('New image ')]), doc = model(pkg); doc.assets.new = { bytes, mime: 'image/png' };
  doc.select(doc.text.length); doc.insertImage('new', { width: EMU_PER_INCH, height: EMU_PER_INCH / 2, alt: 'New panels' }); const first = doc.selectedImage.id;
  doc.select(doc.text.length); doc.insertImage('new', { width: EMU_PER_INCH / 2, height: EMU_PER_INCH / 4 }); expect(doc.selectedImage.id).not.toBe(first);
  const out = unzipSync(await save(pkg, doc)); expect(Object.keys(out).filter(k => k.startsWith('word/media/'))).toHaveLength(1);
  const reopened = model(await DocxPackage.open(await save(pkg, doc))); expect(reopened.text).toBe(doc.text); expect(pictures(reopened).map(i => i.alt)).toEqual(['New panels', '']); pictureGeometry(layout(reopened));
  const imported = model(sourcePkg), oldParts = Object.keys(sourcePkg.parts); imported.select(0); imported.insertImage(pictures(imported)[0].assetId, { width: EMU_PER_INCH, height: EMU_PER_INCH / 2 });
  const reused = unzipSync(await save(sourcePkg, imported)); expect(Object.keys(reused)).toEqual(oldParts); expect(pictures(model(await DocxPackage.open(zipSync(reused))))).toHaveLength(7);
});

it('inserts a picture across cell boundaries without leaving an unbound object marker', async () => {
  const pkg = await DocxPackage.open(readFileSync('public/fixtures/tables.docx')), doc = model(pkg);
  doc.assets.new = { bytes: readFileSync('tests/fixtures/picture-controls/replacement.png'), mime: 'image/png' };
  doc.select(doc.text.indexOf('Product') + 3, doc.text.indexOf('Alpha') + 2); const before = doc.snapshot();
  doc.insertImage('new', { width: EMU_PER_INCH, height: EMU_PER_INCH / 4 });
  expect(doc.selectedImage.assetId).toBe('new'); expect(pictures(doc)).toHaveLength(1);
  const reopened = model(await DocxPackage.open(await save(pkg, doc)));
  expect(reopened.text).toBe(doc.text); expect(pictures(reopened)).toHaveLength(1);
  expect(reopened.tables[0].rows.map(r => r.cells.length)).toEqual(before.tables[0].rows.map(r => r.cells.length));
  doc.undo(); expect(doc.snapshot()).toEqual(before);
});

it('responds to inherited line spacing and page changes while keeping image dimensions and source positions stable', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), sizes = pictures(doc).map(i => [i.width, i.height]), initial = layout(doc);
  doc.editParagraphStyle('CanvasPictureText', { paragraph: { lineSpacing: 2 } }); const after = layout(doc); pictureGeometry(after);
  expect(after.lines.find(l => l.fragments.some(f => f.image?.id === pictures(doc)[0].id)).height).toBeGreaterThan(initial.lines.find(l => l.fragments.some(f => f.image?.id === pictures(doc)[0].id)).height);
  expect(pictures(doc).map(i => [i.width, i.height])).toEqual(sizes); doc.undo(); expect(layout(doc)).toEqual(initial);
  doc.select(doc.text.indexOf(OBJECT), doc.text.indexOf(OBJECT) + 1); doc.setImageProperties({ width: EMU_PER_INCH * 6, height: EMU_PER_INCH * 3 });
  // Native oversized-inline controls preserve authored width and also permit
  // tall authored extents on a fresh page; page changes must retain
  // their dimensions and document positions rather than reject the document.
  expect(() => layout(doc)).not.toThrow();
  doc.setPageSettings({ height: 4320 });
  const shorter = layout(doc), originalPosition = doc.text.indexOf(OBJECT);
  const line = shorter.lines.find(l => l.fragments.some(f => f.start === originalPosition && f.image));
  expect(line.oversizedInlineHeight).toBe(true);
  const fragment = line.fragments.find(f => f.start === originalPosition && f.image);
  expect(fragment.width).toBe(6 * 96); expect(fragment.ascent).toBe(3 * 96);
  expect(pictures(doc)[0].width).toBe(EMU_PER_INCH * 6);
  expect(pictures(doc)[0].height).toBe(EMU_PER_INCH * 3);
  doc.undo(); doc.undo(); expect(layout(doc)).toEqual(initial);
});

it('clips oversized pictures in exact-height lines and limits pointer selection to their visible rectangle', async () => {
  const doc = model(await DocxPackage.open(source)), at = doc.text.indexOf(OBJECT); doc.select(at, at + 1);
  doc.setParagraphFormat({ lineRule: 'exact', lineSpacing: 12 }); const result = layout(doc), line = result.lines.find(l => l.fragments.some(f => f.image?.id === doc.selectedImage.id));
  const image = line.fragments.find(f => f.image), x = image.x + image.width / 2;
  expect(line.height).toBe(16); expect(line.baseline - image.ascent).toBeLessThan(line.y);
  expect(imageAtPoint(result, line.page, x, line.y - 1)?.image.id).not.toBe(image.image.id);
  expect(imageAtPoint(result, line.page, x, line.y + 1)).toBe(image);
  const caret = caretRect(result, at, 'forward', line.page); expect(caret.y).toBeGreaterThanOrEqual(line.y); expect(caret.y + caret.height).toBeLessThanOrEqual(line.y + line.height);
});

it('rejects unsupported drawing forms, transforms, broken relationships, invalid IDs and unsafe raster formats before editable import', async () => {
  for (const [label, mutate, path] of [
    ['anchor', xml => { const inline = node(xml, WP, 'inline'); inline.replaceWith(xml.createElementNS(WP, 'wp:anchor')); }],
    ['empty crop', xml => { const rect = xml.createElementNS(A, 'a:srcRect'); rect.setAttribute('l', '100000'); node(xml, PIC, 'blipFill').append(rect); }],
    ['invalid rotation', xml => node(xml, A, 'xfrm').setAttribute('rot', 'not-an-angle')],
    ['unsupported effect', xml => { const alpha = xml.createElementNS(A, 'a:alphaBiLevel'); alpha.setAttribute('thresh', '50000'); node(xml, A, 'blip').append(alpha); }],
    ['unknown preset', xml => node(xml, A, 'prstGeom').setAttribute('prst', 'notAPreset')],
    ['duplicate ID', xml => xml.getElementsByTagNameNS(WP, 'docPr')[1].setAttribute('id', node(xml, WP, 'docPr').getAttribute('id'))],
    ['missing dimensions', xml => node(xml, WP, 'extent').removeAttribute('cx')],
    ['missing relationship', xml => node(xml, A, 'blip').setAttributeNS(R, 'r:embed', 'missing')],
    ['linked image', xml => node(xml, A, 'blip').setAttributeNS(R, 'r:link', 'external')],
    ['external image', xml => { const rel = [...xml.documentElement.children].find(n => n.getAttribute('Type').endsWith('/image')); rel.setAttribute('TargetMode', 'External'); rel.setAttribute('Target', 'https://example.com/image.png'); }, 'word/_rels/document.xml.rels'],
    ['wrong content type', xml => [...xml.documentElement.children].find(n => n.getAttribute('Extension') === 'png').setAttribute('ContentType', 'image/svg+xml'), '[Content_Types].xml'],
    ['missing asset', (xml, parts) => { delete parts['word/media/image1.png']; }],
  ]) await expect(DocxPackage.open(change(mutate, path))).rejects.toThrow(/pictures/);
  expect(() => imageInfo(new Uint8Array([1, 2, 3]))).toThrow(/PNG, JPEG, GIF or TIFF/);
  const asset = new Uint8Array(Object.values((await DocxPackage.open(source)).assets)[0].bytes); new DataView(asset.buffer).setUint32(16, 10000);
  expect(() => imageInfo(asset)).toThrow(/8,192/);
});

it('opens GIF pictures for editing, keeps their bytes, and saves a new GIF picture as a GIF part', async () => {
  // A 1×1 GIF89a, as web graphics pasted into documents are stored.
  const gif = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));
  expect(imageInfo(gif)).toEqual({ mime: 'image/gif', width: 1, height: 1 });
  const parts = unzipSync(source);
  delete parts['word/media/image2.png']; parts['word/media/image2.gif'] = gif;
  parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace('Target="media/image2.png"', 'Target="media/image2.gif"'));
  parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('<Default ', '<Default Extension="gif" ContentType="image/gif"/><Default '));
  const pkg = await DocxPackage.open(zipSync(parts), { bestEffort: true });
  expect(pkg.readOnly).not.toBe(true);
  expect(pkg.assets['word/media/image2.gif']).toMatchObject({ mime: 'image/gif' });
  const doc = model(pkg);
  doc.select(0); doc.replace('Edited ');
  doc.assets.newGif = { bytes: gif, mime: 'image/gif' };
  doc.select(doc.text.length); doc.insertImage('newGif', { width: EMU_PER_INCH, height: EMU_PER_INCH });
  const saved = unzipSync(await save(pkg, doc));
  expect(saved['word/media/image2.gif']).toEqual(gif);
  const added = Object.keys(saved).filter(name => /^word\/media\/canvas-image\d+\.gif$/.test(name));
  expect(added).toHaveLength(1); expect(saved[added[0]]).toEqual(gif);
  expect(strFromU8(saved['[Content_Types].xml'])).toContain(`PartName="/${added[0]}" ContentType="image/gif"`);
  const reopened = await DocxPackage.open(zipSync(saved));
  expect(reopened.readOnly).not.toBe(true);
  expect(Object.values(reopened.assets).filter(asset => asset.mime === 'image/gif')).toHaveLength(2);
});
