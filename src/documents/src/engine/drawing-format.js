import { imageWriter, WP, A, PIC, R } from './docx-images.js';
import { parseXml } from './docx-xml.js';
import { readAnchor } from './docx-anchors.js';
import { relationshipPartPath } from './package-part-paths.js';
import { readDrawingFragment, placeDrawing, freshPart, freshDrawingAssetId, NS, REL_TYPES } from './inserted-drawings.js';
import { validateImage, rotationOutsets, imageExtents, normalizedRotation, CROP_SIDES } from './images.js';

/**
 * Formatting an existing picture, shape or group (Picture Format, Shape Format, Arrange). Every edit
 * is a change to the drawing's DrawingML: the drawing is first written out exactly as saving would
 * write it (so pending size, crop, wrap and position changes are included), the edit rewrites that XML,
 * and the result is read back through the same strict reader opened documents use. What is painted is
 * then exactly what is saved, the untouched parts of the drawing stay as authored, and the new drawing
 * replaces the old one in a single transaction, so undo restores it exactly.
 *
 * Package parts the drawing references (its pictures) travel with it; new media written by an edit
 * (a picture with its background removed, a compressed copy) is added on save while the drawing uses it.
 */
const W = NS.w;
const WPS = NS.wps, WPG = NS.wpg, C = NS.c;
const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const CONTENT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml', emf: 'image/x-emf', wmf: 'image/x-wmf', bmp: 'image/bmp' };
const decode = bytes => typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
const images = model => model.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image));

/** The kind of a drawing, from its graphic: picture, shape, textBox, group, chart, diagram or other. */
export function drawingKind(image) {
  if (!image) return null;
  if (image.kind === 'chart') return 'chart';
  if (!image.shell) return 'picture';
  const uri = image.shell.match(/graphicData[^>]*uri="([^"]+)"/)?.[1];
  if (uri === PIC) return 'picture';
  if (uri === WPG) return 'group';
  if (uri === DGM) return 'diagram';
  if (uri === C) return 'chart';
  if (uri === WPS) return /<(?:\w+:)?txbx[\s>]/.test(image.shell) ? 'textBox' : 'shape';
  return 'other';
}

/** The story part a drawing of the current model belongs to. */
export function drawingSourcePart(model, image) {
  return model.paragraphs.find(p => p.runs.some(r => r.image === image))?.pageStory || 'word/document.xml';
}

function contentTypeOf(parts, path) {
  const types = parseXml(parts['[Content_Types].xml']);
  const override = [...types.documentElement.children].find(n => n.localName === 'Override' && n.getAttribute('PartName') === `/${path}`);
  if (override) return override.getAttribute('ContentType');
  const extension = path.split('.').at(-1).toLowerCase();
  const fallback = [...types.documentElement.children].find(n => n.localName === 'Default' && n.getAttribute('Extension')?.toLowerCase() === extension);
  return fallback?.getAttribute('ContentType') || CONTENT_TYPES[extension] || 'application/octet-stream';
}

/**
 * Write a drawing as saving would and return its `w:drawing` element (in a scratch document) with the
 * package parts its relationships point at: { drawing, parts: Map(relId → { path, bytes, contentType,
 * relType, existing }) }. `existing` marks parts the package already has under that relationship.
 */
export function materializeDrawing(pkg, model, image) {
  const sourcePart = drawingSourcePart(model, image);
  const original = pkg.parts, parts = { ...original };
  const doc = parseXml(`<w:document xmlns:w="${W}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}" xmlns:r="${R}"/>`);
  const write = imageWriter(parts, [{ runs: [{ image }] }], model.assets, doc, sourcePart);
  const drawing = write(image);
  doc.documentElement.append(drawing);
  // A picture inserted in this session keeps its proportions by default; say so in the file it now has.
  if (!image.shell && image.aspectLocked !== false) {
    const nv = drawing.getElementsByTagNameNS(PIC, 'cNvPicPr')[0];
    if (nv && !nv.getElementsByTagNameNS(A, 'picLocks').length) { const locks = doc.createElementNS(A, 'a:picLocks'); locks.setAttribute('noChangeAspect', '1'); nv.append(locks); }
  }
  const relPath = relationshipPartPath(sourcePart);
  const rels = parts[relPath] ? parseXml(parts[relPath]) : null, originalRels = original[relPath] ? parseXml(original[relPath]) : null;
  const relation = (list, id) => [...(list?.documentElement.children || [])].find(n => n.getAttribute('Id') === id);
  const found = new Map();
  // Inserted drawings carry their parts on their assets until they are saved.
  const sessionParts = new Map();
  for (const id of [image.assetId, image.fallbackAssetId]) for (const part of model.assets[id]?.packageParts || []) if (part.relId) sessionParts.set(part.relId, part);
  for (const element of [drawing, ...drawing.getElementsByTagName('*')]) for (const attribute of [...element.attributes]) {
    if (attribute.namespaceURI !== R || found.has(attribute.value)) continue;
    const id = attribute.value;
    if (sessionParts.has(id)) { const part = sessionParts.get(id); found.set(id, { ...part, existing: false }); continue; }
    const rel = relation(rels, id);
    if (!rel) throw new Error('A relationship this drawing uses is missing.');
    if (rel.getAttribute('TargetMode') === 'External') { found.set(id, { external: true, relId: id, relType: rel.getAttribute('Type'), target: rel.getAttribute('Target') }); continue; }
    const target = rel.getAttribute('Target');
    let path;
    try { path = decodeURIComponent(new URL(target, `https://docx.invalid/${sourcePart}`).pathname).slice(1); } catch { throw new Error('A part this drawing uses has an invalid name.'); }
    if (!parts[path]) throw new Error('A part this drawing uses is missing.');
    const existing = !!relation(originalRels, id) && relation(originalRels, id).getAttribute('Target') === target && !!original[path];
    found.set(id, { path, bytes: parts[path], contentType: contentTypeOf(parts, path), relId: id, relType: rel.getAttribute('Type'), existing });
  }
  return { drawing, parts: found, sourcePart };
}

/** Bind every prefix the drawing uses on its root, so it serializes as a standalone fragment. */
function standalone(drawing) {
  const copy = drawing.cloneNode(true), declared = new Map();
  for (const element of [copy, ...copy.getElementsByTagName('*')]) for (const node of [element, ...element.attributes]) {
    if (!node.prefix || !node.namespaceURI || node.namespaceURI === XMLNS || node.prefix === 'xml') continue;
    if (!declared.has(node.prefix)) declared.set(node.prefix, node.namespaceURI);
  }
  for (const [prefix, uri] of declared) if (copy.lookupNamespaceURI(prefix) !== uri || !copy.hasAttributeNS(XMLNS, prefix)) copy.setAttributeNS(XMLNS, `xmlns:${prefix}`, uri);
  return new XMLSerializer().serializeToString(copy);
}

/**
 * Read a rewritten drawing for the current document. `added` are new parts the edit created
 * ([{ path, relId, bytes, contentType, relType }]). Returns a fragment for placeDrawing.
 */
export async function readFormattedDrawing(pkg, model, image, drawing, parts, added = []) {
  // Drawing hyperlinks are external relationships; take them off for the read and put them back after.
  const links = [...drawing.getElementsByTagNameNS(A, 'hlinkClick')];
  for (const link of links) if (parts.get(link.getAttributeNS(R, 'id'))?.external) link.remove();
  const used = new Set();
  for (const element of [drawing, ...drawing.getElementsByTagName('*')]) for (const attribute of [...element.attributes]) if (attribute.namespaceURI === R) used.add(attribute.value);
  if ([...used].some(id => parts.get(id)?.external)) throw new Error('This drawing links to an external file and cannot be reformatted.');
  const internal = [...parts.values()].filter(part => !part.external && used.has(part.relId));
  const supplied = [...internal, ...added.filter(part => used.has(part.relId))];
  const fragment = await readDrawingFragment(standalone(drawing), { parts: supplied, sourceParts: pkg.parts, assetId: freshDrawingAssetId(model) });
  // Parts the package already holds under the same relationship are kept as they are; only new parts are added on save.
  const keep = new Set(internal.filter(part => part.existing).map(part => part.relId));
  for (const asset of Object.values(fragment.assets)) if (asset.packageParts) asset.packageParts = asset.packageParts.filter(part => !keep.has(part.relId));
  const result = { ...fragment.image, id: image.id };
  if (image.hyperlink) Object.assign(result, { hyperlink: image.hyperlink, hyperlinkChanged: true });
  fragment.image = validateImage(result);
  return fragment;
}

/**
 * Rewrite the selected drawing. `edit(drawing, context)` changes the `w:drawing` element in place and
 * may call context.addPart(bytes, contentType, stem) for new media (returns its relationship id).
 * Returns whether the document changed; throws when the edit cannot be applied.
 */
export async function formatDrawing(editor, image, edit, { label = 'drawing' } = {}) {
  if (editor.readOnly) throw new Error('This document is read-only.');
  const pkg = editor.shapePackage?.();
  if (!pkg) throw new Error('Formatting is not available for this document.');
  editor.finishComposition?.();
  const model = editor.model, revision = editor.session.revision;
  if (!images(model).includes(image)) throw new Error(`Select the ${label} again.`);
  const { drawing, parts } = materializeDrawing(pkg, model, image);
  const added = [];
  const context = {
    parts,
    addPart(bytes, contentType, stem = 'canvas-edit') {
      const extension = Object.entries(CONTENT_TYPES).find(([, type]) => type === contentType)?.[0] || 'bin';
      const part = freshPart(model, pkg.parts, 'media', stem, extension);
      added.push({ ...part, bytes, contentType, relType: REL_TYPES.image });
      return part.relId;
    },
    partBytes(relId) { return parts.get(relId)?.bytes || added.find(part => part.relId === relId)?.bytes || null; },
    /** Let saving drop a package part this edit stops using, if nothing else in the document still uses it. */
    release(relId) { const part = parts.get(relId); if (part?.existing && part.path) (pkg.releasedMedia ||= new Set()).add(part.path); },
  };
  const before = new XMLSerializer().serializeToString(drawing);
  const result = await edit(drawing, context);
  if (result === false || new XMLSerializer().serializeToString(drawing) === before) return false;
  reserveRotatedBounds(drawing, image);
  const fragment = await readFormattedDrawing(pkg, model, image, drawing, parts, added);
  return placeDrawing(editor, fragment, { replace: image, revision });
}

/**
 * A picture's frame reserves room for its rotated bounds (wp:effectExtent), which the reader takes as saved.
 * An edit that turns or resizes the picture through its XML (the rotation handle, Rotate, Reset Picture,
 * Size and Position, a tilted picture style) reserves them anew, as the model does for its own edits:
 * what the new rotation needs plus whatever room the frame reserved beyond the old one's (a shadow, say).
 */
export function reserveRotatedBounds(drawing, image) {
  const { frame, picture, properties } = drawingParts(drawing);
  if (!picture || !frame) return;
  const extent = xml.child(frame, WP, 'extent'), transform = xml.child(properties, A, 'xfrm');
  const next = { ...image, width: Number(extent?.getAttribute('cx')), height: Number(extent?.getAttribute('cy')), rotation: normalizedRotation(Number(transform?.getAttribute('rot') || 0)) };
  delete next.effectExtent;
  if (!(next.width > 0 && next.height > 0)) return;
  if (next.width === image.width && next.height === image.height && next.rotation === normalizedRotation(image.rotation)) return;
  const oldRequired = rotationOutsets(image), nextRequired = rotationOutsets(next), oldExtent = imageExtents(image);
  let effect = xml.child(frame, WP, 'effectExtent');
  if (!effect) { effect = xml.make(frame.ownerDocument, WP, 'effectExtent'); extent.after(effect); }
  for (const [side, key] of CROP_SIDES.map((side, i) => [side, 'ltrb'[i]])) effect.setAttribute(key, String(nextRequired[side] + Math.max(0, oldExtent[side] - oldRequired[side])));
}

/** XML helpers for edits: children by namespace and name, and creating elements with a frame's prefixes. */
export const xml = {
  child: (node, ns, name) => [...(node?.children || [])].find(c => c.namespaceURI === ns && c.localName === name) || null,
  children: (node, ns, name) => [...(node?.children || [])].filter(c => c.namespaceURI === ns && (!name || c.localName === name)),
  make(doc, ns, name, attrs = {}) {
    const prefix = { [A]: 'a', [WP]: 'wp', [PIC]: 'pic', [WPS]: 'wps', [WPG]: 'wpg', [R]: 'r', [W]: 'w' }[ns] || '';
    const node = doc.createElementNS(ns, prefix ? `${prefix}:${name}` : name);
    for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) node.setAttribute(key, String(value));
    return node;
  },
};

/** The parts of a drawing's frame and graphic that edits address. */
export function drawingParts(drawing) {
  const frame = [...drawing.children].find(n => n.namespaceURI === WP && ['inline', 'anchor'].includes(n.localName));
  const docPr = xml.child(frame, WP, 'docPr');
  const data = xml.child(xml.child(frame, A, 'graphic'), A, 'graphicData');
  const root = data?.firstElementChild || null;
  const picture = root?.namespaceURI === PIC && root.localName === 'pic' ? root : null;
  const shape = root?.namespaceURI === WPS && root.localName === 'wsp' ? root : null;
  const group = root?.namespaceURI === WPG && root.localName === 'wgp' ? root : null;
  const properties = picture ? xml.child(picture, PIC, 'spPr') : shape ? xml.child(shape, WPS, 'spPr') : group ? xml.child(group, WPG, 'grpSpPr') : null;
  const blipFill = picture ? xml.child(picture, PIC, 'blipFill') : null;
  return { frame, docPr, data, root, picture, shape, group, properties, blipFill, blip: xml.child(blipFill, A, 'blip'), body: shape ? xml.child(shape, WPS, 'bodyPr') : null };
}

/** The floating anchor a rewritten frame reads as, or undefined for an inline frame (throws when unsupported). */
export function frameAnchor(drawing) {
  const { frame } = drawingParts(drawing);
  return frame?.localName === 'anchor' ? readAnchor(frame) : undefined;
}

export { NS, W, WPS, WPG, A, WP, PIC, R, REL };

/**
 * Decode several drawing fragments and run `transaction(model)` (which places their images) as one
 * editor transaction; the fragments' assets are registered only when it applies. Used where one
 * command replaces several drawings at once (Group, Ungroup).
 */
export async function applyDrawingFragments(editor, fragments, transaction, { revision = editor.session.revision } = {}) {
  const { decodeImages, validateImageAssets } = await import('./images.js');
  const model = editor.model, pkg = editor.shapePackage?.();
  const assets = Object.assign({}, ...fragments.map(f => f.assets));
  for (const fragment of fragments) if (fragment.readers && pkg && !pkg.readDrawingTextBox) Object.assign(pkg, fragment.readers);
  validateImageAssets({ ...model.assets, ...assets });
  const bitmaps = await decodeImages(assets, model.styles.fontAlternatives, () => {});
  const release = () => { for (const bitmap of bitmaps.values()) bitmap.close?.(); };
  if (editor.destroyed || model !== editor.model || revision !== editor.session.revision) { release(); throw new Error('The document changed while the drawings were prepared. Try again.'); }
  for (const [id, asset] of Object.entries(assets)) { model.assets[id] = asset; editor.images.set(id, bitmaps.get(id)); }
  let failure = null;
  const ok = editor.execute(() => transaction(model), e => { failure = e; }, undefined, true);
  if (!ok) { for (const id of Object.keys(assets)) { delete model.assets[id]; editor.images.get(id)?.close?.(); editor.images.delete(id); } if (failure) throw failure; }
  editor.focus(); editor.onSelection?.();
  return ok;
}
