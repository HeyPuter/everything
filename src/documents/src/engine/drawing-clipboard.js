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
 * Fields that load a file, picture or another program's data when the document is opened or its fields are
 * updated (ECMA-376 Part 1 §17.16.5.28 INCLUDEPICTURE, §17.16.5.29 INCLUDETEXT, §17.16.5.32 LINK, §17.16.5.13
 * DDE, §17.16.5.14 DDEAUTO; INCLUDE and IMPORT are Word's older names for them). A drawing pasted from another
 * page's clipboard HTML holding one would put that link into the user's saved file unseen.
 */
const EXTERNAL_FIELDS = new Set(['INCLUDEPICTURE', 'INCLUDETEXT', 'INCLUDE', 'IMPORT', 'LINK', 'DDE', 'DDEAUTO']);
/**
 * The first field in drawing XML that loads something from outside the document, by its name as written
 * (INCLUDEPICTURE…), or null. A complex field's instruction is the text of all its w:instrText (and
 * w:delInstrText) runs between its begin and separate marks, however they are split; a field named by
 * another field nested at its start is counted as one, since its name is only known once that field runs.
 */
export function externalField(root) {
  const nested = '\u0001', open = [];
  const check = instruction => {
    const name = /^\s*(\S+)/.exec(instruction)?.[1] || '';
    if (name.startsWith(nested)) return 'named by another field';
    return EXTERNAL_FIELDS.has(name.toUpperCase()) ? name : null;
  };
  for (const element of [root, ...root.getElementsByTagName('*')]) {
    if (element.namespaceURI !== W) continue;
    if (element.localName === 'fldSimple') { const found = check(element.getAttributeNS(W, 'instr') || ''); if (found) return found; }
    else if (element.localName === 'fldChar') {
      const type = element.getAttributeNS(W, 'fldCharType');
      if (type === 'begin') { if (open.length && !open.at(-1).done) open.at(-1).text += nested; open.push({ text: '', done: false }); }
      else if (type === 'separate' && open.length) open.at(-1).done = true;
      else if (type === 'end' && open.length) { const found = check(open.pop().text); if (found) return found; }
    } else if ((element.localName === 'instrText' || element.localName === 'delInstrText') && open.length && !open.at(-1).done) open.at(-1).text += element.textContent;
  }
  // A field left without its end still has its instruction.
  for (const field of open) { const found = check(field.text); if (found) return found; }
  return null;
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
  const field = externalField(root);
  if (field) throw new Error(`This drawing can’t be pasted: its text holds a field that can load a file or picture from elsewhere when the document is opened (${field}).`);
  const id = String(nextDrawingId(model));
  for (const docPr of doc.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'docPr')) { docPr.setAttribute('id', id); break; }
  const anchor = doc.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'anchor')[0];
  if (anchor) anchor.setAttribute('relativeHeight', String(nextDrawingOrder(model)));
  const fragment = await readDrawingFragment(new XMLSerializer().serializeToString(doc), { sourceParts: pkg.parts, assetId: freshDrawingAssetId(model) });
  return placeDrawing(editor, fragment, { revision });
}

/* ---------- Equations ---------- */

/**
 * A selected equation (one Office Math object, ECMA-376 Part 1 §22.1.2.77 oMath / §22.1.2.78 oMathPara) copies
 * as its Office Math XML beside its linear text, so a paste here inserts the equation again instead of its text.
 */
export const EQUATION_ATTRIBUTE = 'data-documents-equation';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const XMLNS = 'http://www.w3.org/2000/xmlns/';

/** The selected equation run's math ({ xml, text }), or null. */
export function selectedEquation(model) {
  const [start, end] = model.range;
  if (end !== start + 1) return null;
  let at = 0;
  for (const p of model.paragraphs) {
    for (const run of p.runs) { if (at === start && run.math && run.text.length === 1) return run.math; at += run.text.length; if (at > start) return null; }
    at += 1;
  }
  return null;
}

/** HTML carrying the selected equation for a paste here, or ''. */
export function equationHtml(model) {
  const math = selectedEquation(model);
  if (!math?.xml || math.xml.length > MAX_XML) return '';
  return `<span ${EQUATION_ATTRIBUTE}="${escape(JSON.stringify({ xml: math.xml, text: math.text || '' }))}">${escape(math.text || '')}</span>`;
}

/**
 * The equation a copy from this editor carries in its HTML ({ xml, text }), or null. The XML is written into the
 * saved document as it is, so it must be Office Math alone: an m:oMath or m:oMathPara whose elements and
 * attributes are all in the math or the WordprocessingML namespace, with no WordprocessingML element that
 * holds other content (a drawing, an object, a field, a note).
 */
export function htmlEquation(html) {
  if (typeof DOMParser === 'undefined' || !html || !html.includes(EQUATION_ATTRIBUTE)) return null;
  const node = new DOMParser().parseFromString(html, 'text/html').querySelector(`[${EQUATION_ATTRIBUTE}]`);
  let data;
  try { data = JSON.parse(node?.getAttribute(EQUATION_ATTRIBUTE) || 'null'); } catch { return null; }
  if (typeof data?.xml !== 'string' || data.xml.length > MAX_XML || typeof data.text !== 'string') return null;
  const doc = new DOMParser().parseFromString(data.xml, 'application/xml'), root = doc.documentElement;
  if (doc.getElementsByTagName('parsererror').length || root.namespaceURI !== M || !['oMath', 'oMathPara'].includes(root.localName)) return null;
  const RUN_CONTENT = new Set(['rPr', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'color', 'sz', 'szCs', 'u', 'strike', 'dstrike', 'highlight', 'shd', 'vertAlign', 'lang', 'caps', 'smallCaps', 'spacing', 'kern', 'w', 'position', 'vanish', 'rStyle', 'effect', 'em', 'emboss', 'imprint', 'outline', 'shadow', 'noProof', 'rtl', 'cs', 'specVanish', 'webHidden', 'eastAsianLayout', 'fitText', 'bdr', 't', 'br', 'tab', 'sym', 'ins', 'del', 'rPrChange', 'moveFrom', 'moveTo']);
  for (const element of [root, ...root.getElementsByTagName('*')]) {
    if (element.namespaceURI === W ? !RUN_CONTENT.has(element.localName) : element.namespaceURI !== M) return null;
    if ([...element.attributes].some(a => a.namespaceURI !== XMLNS && a.namespaceURI !== M && a.namespaceURI !== W && !(a.namespaceURI === 'http://www.w3.org/XML/1998/namespace' && a.localName === 'space'))) return null;
  }
  return { xml: new XMLSerializer().serializeToString(root), text: data.text.slice(0, 100000) };
}

/**
 * The equation as a paste at the selection puts it: a displayed equation (one m:oMath in an m:oMathPara) pasted
 * among the text of a paragraph goes in line, as Word pastes it, since a display equation is its paragraph's
 * only content.
 */
export function pastedEquation(model, equation) {
  const [start, end] = model.range, text = model.text, from = text.lastIndexOf('\n', start - 1) + 1, next = text.indexOf('\n', end), to = next < 0 ? text.length : next;
  if (!(text.slice(from, start) + text.slice(end, to)).trim()) return equation;
  const root = new DOMParser().parseFromString(equation.xml, 'application/xml').documentElement;
  const lines = [...root.children].filter(n => n.namespaceURI === M && n.localName === 'oMath');
  return root.localName === 'oMathPara' && lines.length === 1 ? { ...equation, xml: new XMLSerializer().serializeToString(lines[0]) } : equation;
}

/* ---------- Objects the clipboard cannot carry ---------- */

/** Marks a copy of a chart, diagram or drawing with pictures, whose text stand-in a paste here does not insert. */
export const UNCOPIED_ATTRIBUTE = 'data-documents-uncopied';
export const UNCUT_MESSAGE = 'This object can’t be cut and pasted yet. Drag it to move it, or press Delete to remove it.';
export const UNCOPIED_MESSAGE = 'This object can’t be copied and pasted yet. Drag it to move it.';
export const uncopiedHtml = text => `<span ${UNCOPIED_ATTRIBUTE}="1">${escape(text)}</span>`;
export const copiedUncopied = html => !!html && html.includes(UNCOPIED_ATTRIBUTE) && typeof DOMParser !== 'undefined' && !!new DOMParser().parseFromString(html, 'text/html').querySelector(`[${UNCOPIED_ATTRIBUTE}]`);
