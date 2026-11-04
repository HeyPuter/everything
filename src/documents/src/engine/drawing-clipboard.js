import { drawingKind, materializeDrawing } from './drawing-format.js';
import { readDrawingFragment, placeDrawing, freshDrawingAssetId, nextDrawingId, nextDrawingOrder } from './inserted-drawings.js';

/**
 * Cut, Copy and Paste of a selected shape, text box or group of shapes within the editor. The copy carries the
 * drawing's `w:drawing` XML as saving would write it now (ECMA-376 Part 1 §20.4.2.3 anchor / §20.4.2.8 inline);
 * a paste reads it back as Insert commands read the drawings they make, as a new drawing at the caret with an
 * id and stacking level of its own. Only drawings that use no package parts copy this way (no picture fill,
 * chart, diagram or link): those parts cannot travel on the clipboard yet. Pictures copy as images
 * (clipboard-fragment.js); other applications get the drawing's plain-text stand-in.
 */
export const DRAWING_ATTRIBUTE = 'data-documents-drawing';
const COPIED = new Set(['shape', 'textBox', 'group']);
const MAX_XML = 4 * 1024 * 1024;
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const WP14 = 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing';
const escape = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The selected drawing's XML when a copy can carry it, else null. */
function copiedXml(editor) {
  const model = editor.model, image = model.selectedImage, pkg = editor.shapePackage?.();
  if (!image || !pkg?.parts || !COPIED.has(drawingKind(image)) || image.hyperlink) return null;
  let drawing, parts;
  try { ({ drawing, parts } = materializeDrawing(pkg, model, image)); } catch { return null; }
  if (parts.size) return null;
  // Identifiers that must be unique in a document (a paragraph's, a drawing's edit marks) are left for the
  // copy's reader to assign; a pasted copy that kept them would share them with the original.
  for (const element of [drawing, ...drawing.getElementsByTagName('*')]) for (const attribute of [...element.attributes]) {
    if ((attribute.namespaceURI === W14 && ['paraId', 'textId'].includes(attribute.localName)) || (attribute.namespaceURI === WP14 && ['anchorId', 'editId'].includes(attribute.localName))) element.removeAttributeNode(attribute);
  }
  const xml = standaloneXml(drawing);
  return xml.length <= MAX_XML ? xml : null;
}
function standaloneXml(drawing) {
  const copy = drawing.cloneNode(true), declared = new Map();
  for (const element of [copy, ...copy.getElementsByTagName('*')]) for (const node of [element, ...element.attributes]) {
    if (!node.prefix || !node.namespaceURI || node.namespaceURI === 'http://www.w3.org/2000/xmlns/' || node.prefix === 'xml') continue;
    if (!declared.has(node.prefix)) declared.set(node.prefix, node.namespaceURI);
  }
  for (const [prefix, uri] of declared) if (copy.lookupNamespaceURI(prefix) !== uri || !copy.hasAttributeNS('http://www.w3.org/2000/xmlns/', prefix)) copy.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${prefix}`, uri);
  return new XMLSerializer().serializeToString(copy);
}

/** Whether the selection is one drawing a copy carries (see above). */
export function copiesDrawing(editor) { return !!copiedXml(editor); }

/** HTML carrying the selected drawing for a paste here, or '' when the selection is not such a drawing. */
export function drawingHtml(editor, text = '') {
  const xml = copiedXml(editor);
  return xml ? `<div ${DRAWING_ATTRIBUTE}="${escape(JSON.stringify({ xml }))}">${escape(text)}</div>` : '';
}

/** The drawing XML a copy from this editor carries in its HTML, or null. */
export function htmlDrawing(html) {
  if (typeof DOMParser === 'undefined' || !html || !html.includes(DRAWING_ATTRIBUTE)) return null;
  const node = new DOMParser().parseFromString(html, 'text/html').querySelector(`[${DRAWING_ATTRIBUTE}]`);
  let data;
  try { data = JSON.parse(node?.getAttribute(DRAWING_ATTRIBUTE) || 'null'); } catch { return null; }
  const xml = typeof data?.xml === 'string' && data.xml.length <= MAX_XML ? data.xml : null;
  return xml ? { xml } : null;
}

/**
 * Paste a copied drawing at the caret (after a selected drawing, which it does not replace), in front of the
 * other drawings as a new one goes. Returns whether the document changed.
 */
export async function pasteDrawing(editor, { xml }) {
  const pkg = editor.shapePackage?.();
  if (!pkg) throw new Error('This drawing cannot be pasted here.');
  editor.finishComposition();
  if (editor.model.selectedImage) { editor.model.select(editor.model.range[1]); editor.syncInput(); }
  const model = editor.model, revision = editor.session.revision;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  // Only a drawing element, with no relationship (a part the clipboard does not carry).
  const root = doc.documentElement, related = [root, ...root.getElementsByTagName('*')].some(element => [...element.attributes].some(a => a.namespaceURI === R));
  if (doc.getElementsByTagName('parsererror').length || root.namespaceURI !== W || root.localName !== 'drawing' || related) throw new Error('The copied drawing could not be read.');
  const id = String(nextDrawingId(model));
  for (const docPr of doc.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'docPr')) { docPr.setAttribute('id', id); break; }
  const anchor = doc.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'anchor')[0];
  if (anchor) anchor.setAttribute('relativeHeight', String(nextDrawingOrder(model)));
  const fragment = await readDrawingFragment(new XMLSerializer().serializeToString(doc), { sourceParts: pkg.parts, assetId: freshDrawingAssetId(model) });
  return placeDrawing(editor, fragment, { revision });
}
