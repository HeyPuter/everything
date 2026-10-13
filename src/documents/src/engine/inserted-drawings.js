import { zipSync, strToU8 } from 'fflate';
import { decodeImages, validateImage, validateImageAssets } from './images.js';

/**
 * Drawings authored by Insert commands (pictures with SVG fallbacks, charts, diagrams, WordArt,
 * signature lines). Each is written as ordinary WordprocessingML DrawingML and read back through the
 * same reader opened documents use: the drawing is placed in a minimal package with the parts it
 * references and opened like any file, so what is painted is exactly what is saved. The parts it
 * brings (media, chart parts) travel on its asset as `packageParts`; the package writer adds them
 * while the drawing is in the document (see imageWriter in docx-images.js).
 */
export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  wpg: 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  asvg: 'http://schemas.microsoft.com/office/drawing/2016/SVG/main',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
};
export const REL_TYPES = {
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  chart: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
};
export const EMU_PER_INCH = 914400;
/** The extension URI that marks an SVG companion blip (MS-ODRAWXML §2.3.7). */
export const SVG_BLIP_URI = '{96DAC541-7B7A-43D3-8B79-37D633B846F1}';

const declarations = Object.entries(NS).map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`).join(' ');
// Line breaks and tabs are written as character references, so attribute values keep them.
export const xmlEscape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');

let counter = 0;
const token = () => `${Date.now().toString(36)}${(++counter).toString(36)}`;
/** A part path and relationship id that no existing part, asset or earlier insertion uses. */
export function freshPart(model, packageParts, folder, stem, extension) {
  let path; do path = `word/${folder}/${stem}-${token()}.${extension}`; while (packageParts?.[path] || model?.assets?.[path]);
  return { path, relId: `rIns${token()}` };
}
const images = model => model.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image));
/** The next drawing id (wp:docPr id) for this story, as the model assigns it on insertion. */
export const nextDrawingId = model => Math.max(0, ...images(model).map(image => image.id)) + 1;
export const nextDrawingOrder = model => Math.max(0, ...images(model).map(image => image.anchor?.order || 0)) + 1;

/** The `wp:anchor` or `wp:inline` frame around a graphic. anchor: the editor's floating anchor object. */
export function drawingFrame({ id, name, descr = '', width, height, anchor = null, graphic }) {
  const docPr = `<wp:docPr id="${id}" name="${xmlEscape(name)}"${descr ? ` descr="${xmlEscape(descr)}"` : ''}/>`, extent = `<wp:extent cx="${Math.round(width)}" cy="${Math.round(height)}"/>`;
  if (!anchor) return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">${extent}<wp:effectExtent l="0" t="0" r="0" b="0"/>${docPr}<wp:cNvGraphicFramePr/>${graphic}</wp:inline></w:drawing>`;
  const wrap = anchor.wrap === 'square' ? `<wp:wrapSquare wrapText="${anchor.wrapText || 'bothSides'}"/>` : anchor.wrap === 'topAndBottom' ? '<wp:wrapTopAndBottom/>' : '<wp:wrapNone/>';
  const position = (axis, from, offset, align) => `<wp:position${axis} relativeFrom="${from}">${align ? `<wp:align>${align}</wp:align>` : `<wp:posOffset>${Math.round(offset || 0)}</wp:posOffset>`}</wp:position${axis}>`;
  return `<w:drawing><wp:anchor distT="${anchor.distances?.T ?? 0}" distB="${anchor.distances?.B ?? 0}" distL="${anchor.distances?.L ?? 114300}" distR="${anchor.distances?.R ?? 114300}" simplePos="0" relativeHeight="${anchor.order ?? 1}" behindDoc="${anchor.behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1">`
    + `<wp:simplePos x="0" y="0"/>${position('H', anchor.horizontal || 'column', anchor.x, anchor.xAlign)}${position('V', anchor.vertical || 'paragraph', anchor.y, anchor.yAlign)}${extent}<wp:effectExtent l="0" t="0" r="0" b="0"/>${wrap}${docPr}<wp:cNvGraphicFramePr/>${graphic}</wp:anchor></w:drawing>`;
}

/** Parts that give drawing text the document's styles and theme: its styles part and theme, when present. */
function documentTextParts(sourceParts = {}) {
  const decode = bytes => typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  const rels = sourceParts['word/_rels/document.xml.rels'] ? decode(sourceParts['word/_rels/document.xml.rels']) : '';
  const target = type => rels.match(new RegExp(`<Relationship[^>]*Type="[^"]*/${type}"[^>]*Target="([^"]+)"`))?.[1] || rels.match(new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Type="[^"]*/${type}"`))?.[1];
  const part = name => name && !name.includes('..') && sourceParts[`word/${name.replace(/^\.\//, '')}`];
  return { styles: part(target('styles')), theme: part(target('theme')), themeName: target('theme') };
}

/**
 * Read one `w:drawing` (written without namespace declarations; the prefixes of NS are bound) with the
 * parts it references: [{ path, bytes, contentType, relId?, relType? }]. Returns { image, assets, readers }
 * where assets are every asset the drawing uses and the first asset carries the parts for saving.
 */
export async function readDrawingFragment(drawingXml, { parts = [], sourceParts = {}, assetId = null } = {}) {
  const { DocxPackage, createDocx } = await import('./docx.js');
  const files = { ...createDocx().parts }, decode = bytes => typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  let rels = decode(files['word/_rels/document.xml.rels']), types = decode(files['[Content_Types].xml']);
  const { styles, theme, themeName } = documentTextParts(sourceParts);
  if (styles) files['word/styles.xml'] = styles;
  if (theme && themeName) {
    files[`word/${themeName}`] = theme;
    rels = rels.replace('</Relationships>', `<Relationship Id="rTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="${themeName}"/></Relationships>`);
    types = types.replace('</Types>', `<Override PartName="/word/${themeName}" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`);
  }
  for (const part of parts) {
    files[part.path] = typeof part.bytes === 'string' ? strToU8(part.bytes) : part.bytes;
    if (part.relId) rels = rels.replace('</Relationships>', `<Relationship Id="${part.relId}" Type="${part.relType}" Target="${part.path.replace(/^word\//, '')}"/></Relationships>`);
    if (part.contentType) types = types.replace('</Types>', `<Override PartName="/${part.path}" ContentType="${part.contentType}"/></Types>`);
  }
  files['word/_rels/document.xml.rels'] = strToU8(rels); files['[Content_Types].xml'] = strToU8(types);
  files['word/document.xml'] = strToU8(`<w:document ${declarations}><w:body><w:p><w:r>${drawingXml}</w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  const opened = await DocxPackage.open(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]))));
  const image = images(opened)[0];
  if (!image || opened.readOnly) throw new Error('The drawing could not be created.');
  const assets = {};
  const collect = id => { if (id && opened.assets[id] && !assets[id]) assets[id] = opened.assets[id]; };
  collect(image.assetId); collect(image.fallbackAssetId);
  // A scene can reference picture media through its children; take every asset the package read.
  for (const [id, asset] of Object.entries(opened.assets)) if (!asset.scene || id === image.assetId) collect(id);
  // Scene assets are keyed by drawing id: give this one a name no other drawing in the session uses.
  let primary = image.assetId;
  if (assetId && assets[primary]?.scene) { assets[assetId] = assets[primary]; delete assets[primary]; primary = assetId; }
  const first = assets[primary];
  assets[primary] = { ...first, packageParts: parts.map(({ path, bytes, contentType, relId, relType }) => ({ path, bytes: typeof bytes === 'string' ? strToU8(bytes) : bytes, contentType, relId, relType })) };
  const readers = { readDrawingTextParagraph: opened.readDrawingTextParagraph, readDrawingTextBlocks: opened.readDrawingTextBlocks, readDrawingTextBox: opened.readDrawingTextBox };
  return { image: validateImage({ ...image, assetId: primary }), assets, readers };
}

let scenes = 0;
/** A drawing asset id that no drawing in this session uses. */
export function freshDrawingAssetId(model) { let id; do id = `drawing:inserted-${++scenes}`; while (model.assets[id]); return id; }

/**
 * Decode a fragment's assets and put the drawing in the document in one transaction: at the caret, or
 * in place of `replace` (an image of the current story) so undo restores the previous drawing exactly.
 */
export async function placeDrawing(editor, fragment, { replace = null, revision = editor.session.revision } = {}) {
  const { image, assets, readers } = fragment, model = editor.model;
  const pkg = editor.shapePackage?.();
  if (readers && pkg && !pkg.readDrawingTextBox) Object.assign(pkg, readers);
  validateImageAssets({ ...model.assets, ...assets });
  const bitmaps = await decodeImages(assets, model.styles.fontAlternatives, () => {});
  const release = () => { for (const bitmap of bitmaps.values()) bitmap.close?.(); };
  if (editor.destroyed || model !== editor.model || revision !== editor.session.revision || replace && !images(model).includes(replace)) {
    release(); throw new Error('The document changed while the drawing was prepared. Try again.');
  }
  for (const [id, asset] of Object.entries(assets)) { model.assets[id] = asset; editor.images.set(id, bitmaps.get(id)); }
  const { assetId, id: _id, ...properties } = image;
  const ok = editor.execute(() => {
    if (!replace) return editor.model.insertImage(assetId, properties);
    // The caller wrote the new drawing with the old one's id and frame, so it stays where it was.
    const next = { ...image, id: replace.id };
    editor.model.checkpoint();
    for (const p of editor.model.paragraphs) for (const run of p.runs) if (run.image === replace) run.image = next;
    editor.model.didChange();
    return true;
  });
  if (!ok) for (const id of Object.keys(assets)) { delete model.assets[id]; editor.images.get(id)?.close?.(); editor.images.delete(id); }
  editor.focus(); editor.onSelection?.();
  return ok;
}
