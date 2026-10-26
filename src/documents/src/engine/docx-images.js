import {readRecalculatedDiagram} from './docx-diagram-layout.js';
import { EMF_MIME, isEmf, emfInfo } from './emf-images.js';
import { WMF_MIME, isWmf, wmfInfo } from './wmf-images.js';
import { svgInfo } from './svg-images.js';
import { WPG, WPS, alternateBranch, serializeFragment } from './docx-compatibility.js';
import { readShapeScene, readShapeGeometry, readDrawingOutline } from './docx-shapes.js';
import { outlinePadding } from './drawing-line-ends.js';
import { pictureOutlineScene } from './picture-outline.js';
import { readPictureBackingFill } from './picture-backing-fill.js';
import { drawingStyleReader, drawingEffectColor } from './docx-drawing-style.js';
import { readDrawingMetadata, readDrawingCreationId } from './docx-drawing-metadata.js';
import { readDrawingHyperlink, drawingHyperlinkWriter } from './docx-drawing-hyperlinks.js';
import { readShapeExtensions } from './docx-shape-extensions.js';
import { parseXml } from './docx-xml.js';
import { UnsupportedDocumentError } from './errors.js';
import { imageInfo, validateImage, normalizeCrop, normalizedRotation, imageExtents, CROP_SIDES } from './images.js';
import { strToU8 } from 'fflate';
import { C, readChart } from './docx-charts.js';
import { readAnchor } from './docx-anchors.js';
import { readPicture3d } from './docx-picture-3d.js';
import { readPictureShadow } from './docx-picture-shadow.js';
import { readDrawingEffects } from './docx-drawing-effects.js';
import { pictureResolution } from './picture-resolution.js';
import { readPictureTile } from './picture-tiles.js';
import { DGM, readDiagramDrawing } from './docx-diagram-drawing.js';
import { relationshipPartPath, relativePartTarget } from './package-part-paths.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
export const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
export const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const A14 = 'http://schemas.microsoft.com/office/drawing/2010/main';
const WP14 = 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
export const ASVG = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main';
const SVG_EXTENSION = '{96dac541-7b7a-43d3-8b79-37d633b846f1}';
const LOCAL_DPI = '{28a0092b-c50c-407e-a947-70e740481c1c}';
const serialize = n => new XMLSerializer().serializeToString(n);
const children = n => n ? [...n.children] : [];
const child = (n, ns, name) => children(n).find(c => c.namespaceURI === ns && c.localName === name);
const fail = why => { throw new UnsupportedDocumentError(`pictures with ${why}`); };
function check(n, ns, names) {
  const seen = new Set();
  for (const c of children(n)) {
    if (c.namespaceURI !== ns || !names.includes(c.localName) || seen.has(c.localName)) fail(`unsupported or duplicate ${c.localName}`);
    seen.add(c.localName);
  }
}
// Some producers append a PresentationML-style nvPr to pic:nvPicPr, outside
// CT_PictureNonVisual (§20.2.2.4). It has no WordprocessingML meaning, so it is
// retained uninterpreted in the drawing shell, unless it references package parts.
const PML = 'http://schemas.openxmlformats.org/presentationml/2006/main';
function nonvisualPicture(nv) {
  const extra = children(nv).filter(c => [PIC, PML].includes(c.namespaceURI) && c.localName === 'nvPr');
  if (!extra.length) return nv;
  if (extra.length > 1 || children(nv).at(-1) !== extra[0]) fail('unsupported or duplicate nvPr');
  if ([extra[0], ...extra[0].getElementsByTagName('*')].some(n => [...n.attributes].some(a => a.namespaceURI === R))) fail('related parts in non-visual properties');
  const copy = nv.cloneNode(true); copy.lastElementChild.remove();
  return copy;
}
function integer(n, name, required = false) {
  const value = n?.getAttribute(name);
  if (value === null || value === undefined) { if (required) fail(`missing ${name}`); return 0; }
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail(`invalid ${name}`);
  return Number(value);
}
function zeroOrigin(n) {
  check(n, A, []);
  for (const a of [...(n?.attributes || [])]) if (!a.namespaceURI && !['x', 'y'].includes(a.localName)) fail(`unsupported origin ${a.localName}`);
  if (n) for (const axis of ['x', 'y']) if (!/^[+-]?0+$/.test(n.getAttribute(axis)?.trim() || '')) fail(`unsupported or invalid origin ${axis}`);
}
function boolean(n, name) {
  const value = n?.getAttribute(name)?.trim();
  if (value === undefined || value === null) return false;
  if (!['0', '1', 'false', 'true'].includes(value)) fail(`invalid ${name}`);
  return value === '1' || value === 'true';
}
function pictureTransform(n) {
  for (const a of [...(n?.attributes || [])]) {
    if (a.namespaceURI || ['flipH', 'flipV', 'rot'].includes(a.localName)) continue;
    fail(`unsupported transform ${a.localName}`);
  }
  const angle = n?.getAttribute('rot')?.trim() ?? '0', value = Number(angle);
  if (!/^[+-]?\d+$/.test(angle) || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) fail('invalid rotation angle');
  return { flipH: boolean(n, 'flipH'), flipV: boolean(n, 'flipV'), rotation: normalizedRotation(value) };
}
function locks(n) {
  for (const name of ['noChangeAspect', 'noChangeArrowheads']) if (n?.hasAttribute(name) && !['0', '1', 'true', 'false', 'on', 'off'].includes(n.getAttribute(name))) fail(`invalid ${name} lock`);
  // The editor has no arrowhead mutation; retaining this lock enforces it.
  for (const a of [...(n?.attributes || [])]) if (!a.namespaceURI && !['noChangeAspect', 'noChangeArrowheads'].includes(a.localName) && !['0', 'false', 'off'].includes(a.value)) fail(`editing lock ${a.localName}`);
  check(n, A, []);
}

function readCrop(rect) {
  check(rect, A, []);
  for (const a of [...(rect?.attributes || [])]) if (!a.namespaceURI && !['l', 't', 'r', 'b'].includes(a.localName)) fail(`unsupported source rectangle ${a.localName}`);
  const crop = {};
  for (const side of CROP_SIDES) {
    const value = rect?.getAttribute(side[0])?.trim() ?? '0';
    if (!/^[+-]?\d+$/.test(value) && !/^-?\d+(\.\d+)?%$/.test(value)) fail('invalid crop percentage');
    if ((value.match(/\.(\d+)%$/)?.[1].replace(/0+$/, '').length || 0) > 3) fail('crop precision finer than 0.001%');
    const number = value.endsWith('%') ? Number(value.slice(0, -1)) * 1000 : Number(value);
    crop[side] = Math.round(number);
  }
  try { return normalizeCrop(crop); } catch (e) { fail(e.message); }
}

function blipExtensions(blip, readSchemeColor) {
  if (blip.hasAttribute('cstate') && !['email', 'screen', 'print', 'hqprint', 'none'].includes(blip.getAttribute('cstate').trim())) fail('invalid image compression preference');
  let opacity = 1, extensionLists = 0, colorChanges = 0;
  const duotone = [];
  for (const effect of children(blip)) {
    if (effect.namespaceURI !== A) fail('unsupported picture effect');
    if (effect.localName === 'extLst') { if (++extensionLists > 1) fail('duplicate image extensions'); continue; }
    if (effect.localName === 'clrChange' && !extensionLists) {
      const nodes = children(effect), names = ['clrFrom', 'clrTo'];
      if (nodes.length !== 2 || nodes.some((n, i) => n.namespaceURI !== A || n.localName !== names[i]) ||
          [...effect.attributes].some(a => a.namespaceURI !== XMLNS && (a.namespaceURI || a.localName !== 'useA')) ||
          [...effect.childNodes].some(n => [3, 4].includes(n.nodeType) && n.textContent.trim())) fail('invalid color change');
      const useA = effect.getAttribute('useA')?.trim() ?? 'true';
      if (!['true', 'false', '1', '0'].includes(useA)) fail('invalid color change alpha flag');
      const colors = nodes.map(n => {
        if (children(n).length !== 1 || [...n.attributes].some(a => a.namespaceURI !== XMLNS) ||
            n.textContent.trim()) fail('invalid color change color');
        return drawingEffectColor(children(n)[0], readSchemeColor);
      });
      // Color changes run in their own source order, before grayscale,
      // duotone/luminance and the picture-wide alpha modifier. Keep source XML.
      duotone.splice(colorChanges++, 0, { type: 'colorChange', from: colors[0], to: colors[1], useAlpha: ['true', '1'].includes(useA) });
      continue;
    }
    if (effect.localName === 'grayscl' && !extensionLists) {
      if (children(effect).length || [...effect.attributes].some(a => a.namespaceURI !== XMLNS) || [...effect.childNodes].some(n => [3, 4].includes(n.nodeType) && n.textContent.trim())) fail('invalid grayscale effect');
      // Luminance conversion matches black-to-white duotone. Reuse the
      // ordered color pipeline; keep the original effect XML in the drawing.
      duotone.push(['000000', 'FFFFFF']);
      continue;
    }
    if (effect.localName === 'duotone' && !extensionLists) {
      if (children(effect).length !== 2 || [...effect.attributes].some(a => a.namespaceURI !== XMLNS) || [...effect.childNodes].some(n => [3, 4].includes(n.nodeType) && n.textContent.trim())) fail('invalid duotone colors');
      duotone.push(children(effect).map(color => drawingEffectColor(color, readSchemeColor).rgb));
      continue;
    }
    if (effect.localName === 'biLevel' && !extensionLists) {
      // §20.1.8.11: pixels at or above the luminance threshold become white, the rest black.
      if (children(effect).length || [...effect.childNodes].some(n => [3, 4].includes(n.nodeType) && n.textContent.trim()) || [...effect.attributes].some(a => a.namespaceURI !== XMLNS && (a.namespaceURI || a.localName !== 'thresh'))) fail('invalid black and white effect');
      const raw = effect.getAttribute('thresh')?.trim() ?? '';
      const value = /^\d+$/.test(raw) ? Number(raw) / 100000 : /^\d+(?:\.\d+)?%$/.test(raw) ? parseFloat(raw) / 100 : NaN;
      if (!Number.isFinite(value) || value < 0 || value > 1) fail('invalid black and white threshold');
      duotone.push({ type: 'biLevel', threshold: value });
      continue;
    }
    if (effect.localName === 'lum' && !extensionLists) {
      if (children(effect).length || [...effect.childNodes].some(n => [3, 4].includes(n.nodeType) && n.textContent.trim()) || [...effect.attributes].some(a => a.namespaceURI !== XMLNS && (a.namespaceURI || !['bright', 'contrast'].includes(a.localName)))) fail('invalid luminance effect');
      const percent = name => {
        const raw = effect.getAttribute(name) ?? '0';
        if (!/^[+-]?\d+$/.test(raw) && !/^[+-]?\d+(?:\.\d+)?%$/.test(raw)) fail('invalid luminance percentage');
        const value = raw.endsWith('%') ? parseFloat(raw) / 100 : Number(raw) / 100000;
        if (!Number.isFinite(value) || value < -1 || value > 1) fail('invalid luminance percentage');
        return value;
      };
      duotone.push({ type: 'luminance', brightness: percent('bright'), contrast: percent('contrast') });
      continue;
    }
    if (effect.localName !== 'alphaModFix' || extensionLists) fail(`unsupported ${effect.localName}`);
    check(effect, A, []);
    if ([...effect.attributes].some(a => a.namespaceURI !== XMLNS && (a.namespaceURI || a.localName !== 'amt'))) fail('invalid picture alpha attributes');
    const raw = effect.hasAttribute('amt') ? effect.getAttribute('amt').trim() : '100000';
    const percent = /^\d+(?:\.\d+)?%$/.test(raw);
    const value = percent ? Number(raw.slice(0, -1)) / 100 : Number(raw) / 100000;
    if ((!percent && (!/^[+]?\d+$/.test(raw) || Number(raw) > 2147483647)) || !Number.isFinite(value)) fail('invalid picture alpha amount');
    // Each modifier is clamped, then the effects compose in source order.
    opacity *= Math.min(1, value);
  }
  const list = child(blip, A, 'extLst'), seen = new Set(); let svg;
  for (const ext of children(list)) {
    const uri = ext.getAttribute('uri')?.toLowerCase();
    if (ext.namespaceURI !== A || ext.localName !== 'ext' || seen.has(uri)) fail('unsupported or duplicate image extension');
    seen.add(uri);
    if (uri === '{beba8eae-bf5a-486c-a8c5-ecc9f3942e4b}') {
      // MS-ODRAWXML §3.3: the main BLIP already contains the processed image.
      // Keep the original layer/effect metadata for other consumers; do not apply it twice.
      check(ext, A14, ['imgProps']);
      const props = child(ext, A14, 'imgProps'); if (!props) fail('missing saved picture properties');
      check(props, A14, ['imgLayer']);
      if (!child(props, A14, 'imgLayer')) fail('missing original picture layer');
      continue;
    }
    if (uri === SVG_EXTENSION) {
      check(ext, ASVG, ['svgBlip']); svg = child(ext, ASVG, 'svgBlip');
      if (!svg || !svg.getAttributeNS(R, 'embed') || svg.hasAttributeNS(R, 'link')) fail('missing or linked SVG');
      check(svg, ASVG, []);
      for (const a of svg.attributes) if (a.namespaceURI !== XMLNS && !(a.namespaceURI === R && a.localName === 'embed')) fail('unsupported SVG reference attribute');
      continue;
    }
    if (readDrawingCreationId(ext)) continue;
    if (uri !== LOCAL_DPI) fail('unsupported image extension');
    check(ext, A14, ['useLocalDpi']);
    const dpi = child(ext, A14, 'useLocalDpi'); if (!dpi) fail('missing local DPI flag');
    check(dpi, A14, []);
    for (const a of [...dpi.attributes]) if (!a.namespaceURI && (a.localName !== 'val' || !['0', '1', 'false', 'true'].includes(a.value.trim()))) fail('invalid local DPI flag');
  }
  return { svg, opacity, duotone };
}

// Zero relative-size placeholders retain the standard extent. Positive sizes
// are resolved against the physical page after pagination, not the story box.
function readRelativeSize(node, anchor) {
  if (node.namespaceURI !== WP14 || !['sizeRelH', 'sizeRelV'].includes(node.localName)) return false;
  let ignorable = false;
  for (let at = node; at?.nodeType === 1; at = at.parentElement) {
    if ((at.getAttributeNS(MC, 'Ignorable') || '').trim().split(/\s+/).some(p => p && at.lookupNamespaceURI(p) === WP14)) ignorable = true;
  }
  const horizontal = node.localName === 'sizeRelH', value = child(node, WP14, horizontal ? 'pctWidth' : 'pctHeight');
  const base = node.getAttribute('relativeFrom');
  if (!ignorable || !['page', 'margin', 'insideMargin', 'outsideMargin', ...(horizontal ? ['leftMargin', 'rightMargin'] : ['topMargin', 'bottomMargin'])].includes(base) ||
      [...node.attributes].some(a => !a.namespaceURI && a.localName !== 'relativeFrom') || children(node).length !== 1 || !value || children(value).length || value.attributes.length) return false;
  const raw = value.textContent.trim();
  if (/^[+]?0+(?:\.0+)?%?$/.test(raw)) return true;
  if (!/^[+]?\d+$/.test(raw) && !/^[+]?(?:\d+(?:\.\d+)?|\.\d+)%$/.test(raw)) return false;
  const percentage = raw.endsWith('%') ? Number(raw.slice(0, -1)) * 1000 : Number(raw);
  if (!Number.isSafeInteger(percentage) || percentage > 2147483647) return false;
  if (percentage === 0) return true;
  if (anchor.wrap !== 'none' || !['page', 'margin'].includes(base)) return false;
  (anchor.relativeSize ||= {})[horizontal ? 'width' : 'height'] = { base, percentage };
  return true;
}

// Serialized source fragments can acquire generated relationship prefixes.
// Bind one document-wide prefix before serializing the assembled body, so a DOM
// serializer cannot reuse a prefix declared only on a preceding sibling.
export function bindImageNamespaces(doc) {
  const blips = [...doc.getElementsByTagNameNS(A, 'blip'), ...doc.getElementsByTagNameNS(C, 'chart'), ...doc.getElementsByTagNameNS(ASVG, 'svgBlip')]; if (!blips.length) return;
  let prefix = 'r'; while (doc.documentElement.lookupNamespaceURI(prefix) && doc.documentElement.lookupNamespaceURI(prefix) !== R) prefix += 'Image';
  doc.documentElement.setAttributeNS(XMLNS, `xmlns:${prefix}`, R);
  for (const blip of blips) {
    const name = blip.namespaceURI === C ? 'id' : 'embed';
    const id = blip.getAttributeNS(R, name); if (id === null) continue;
    blip.removeAttributeNS(R, name); blip.setAttributeNS(R, `${prefix}:${name}`, id);
  }
}

/** Read a rectangular picture or retained drawing; never follow external links. */
export function imageReader(parts, assets, readParagraph, readSchemeColor, readShapeFont, sourcePart = 'word/document.xml', { preview = false, readTextBlocks, compatibilityMode = 12 } = {}) {
  const readDrawingStyle = drawingStyleReader(parts, readSchemeColor);
  const relPath = sourcePart.replace(/([^/]+)$/, '_rels/$1.rels');
  const rels = parts[relPath] ? parseXml(parts[relPath]) : null;
  const drawingAssetId = id => sourcePart === 'word/document.xml' ? `drawing:${id}` : `${sourcePart}:drawing:${id}`;
  const types = parseXml(parts['[Content_Types].xml']), usedIds = new Set();
  let nestedReader, nestedId = 0;
  const readNestedPicture = (pic, t) => {
    const doc = parseXml(`<w:drawing xmlns:w="${W}" xmlns:wp="${WP}" xmlns:a="${A}"><wp:inline><wp:extent cx="${t.width}" cy="${t.height}"/><wp:docPr id="${++nestedId}" name="Group picture"/><a:graphic><a:graphicData uri="${PIC}"/></a:graphic></wp:inline></w:drawing>`);
    const copy = doc.importNode(pic, true);
    // The parent scene validates and retains the original custom path. This
    // synthetic input resolves only its texture through the normal image gates.
    const shape = child(copy, PIC, 'spPr');
    // The parent validates and paints the outline, including its saved paths.
    // This synthetic standalone input resolves only the picture texture.
    child(shape, A, 'ln')?.remove();
    // The parent validates and paints its backing fill independently of texture.
    child(shape, A, 'solidFill')?.remove();
    // The containing scene validates and composites picture effects together
    // with its clipping path, backing fill and outline.
    child(shape, A, 'effectLst')?.remove();
    const preset = child(shape, A, 'prstGeom');
    const custom = child(shape, A, 'custGeom') || (preset && preset.getAttribute('prst') !== 'rect' ? preset : null);
    if (custom) {
      const rect = doc.createElementNS(A, 'a:prstGeom'); rect.setAttribute('prst', 'rect');
      rect.append(doc.createElementNS(A, 'a:avLst')); custom.replaceWith(rect);
    }
    // The parent also owns the validated rotation and its expanded scene bounds.
    // A synthetic inline wrapper has no meaningful saved effectExtent to check.
    child(child(copy, PIC, 'spPr'), A, 'xfrm').removeAttribute('rot');
    const off = copy.getElementsByTagNameNS(A, 'off')[0]; off.setAttribute('x', '0'); off.setAttribute('y', '0');
    doc.getElementsByTagNameNS(A, 'graphicData')[0].append(copy);
    nestedReader ||= imageReader(parts, assets, undefined, readSchemeColor, undefined, sourcePart);
    const result = nestedReader(doc.documentElement);
    if (result.retainedDrawing) fail('grouped 3D pictures');
    if (t.pictureRotation && !result.rotateWithShape) fail('grouped pictures with nonrotating fills');
    return result;
  };
  const readShapeFill = (fill, t) => {
    check(fill, A, ['blip', 'srcRect', 'stretch', 'tile']);
    for (const attr of [...fill.attributes]) if (!attr.namespaceURI && !['dpi', 'rotWithShape'].includes(attr.localName)) fail(`unsupported picture fill ${attr.localName}`);
    if (fill.hasAttribute('dpi') && (!/^\d+$/.test(fill.getAttribute('dpi')) || Number(fill.getAttribute('dpi')) > 4294967295)) fail('invalid picture fill DPI');
    const stretch = child(fill, A, 'stretch'), tileElement = child(fill, A, 'tile');
    if (!!stretch === !!tileElement) fail('missing or conflicting shape picture fill modes');
    let tile;
    if (tileElement) { try { tile = readPictureTile(tileElement); } catch (e) { fail(e.message); } }
    check(stretch, A, ['fillRect']);
    const destination = readCrop(child(stretch, A, 'fillRect'));
    // Reuse the picture relationship/format/crop gates without changing the
    // retained shape XML. Only this synthetic reader input has a full fillRect.
    const doc = parseXml(`<pic:pic xmlns:pic="${PIC}" xmlns:a="${A}"><pic:nvPicPr><pic:cNvPr id="0" name="Shape fill"/><pic:cNvPicPr/></pic:nvPicPr><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${t.width}" cy="${t.height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`);
    const copy = doc.createElementNS(PIC, 'pic:blipFill');
    for (const attr of [...fill.attributes]) copy.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
    for (const node of children(fill)) copy.append(doc.importNode(node, true));
    if (tile) {
      child(copy, A, 'tile').remove();
      const replacement = doc.createElementNS(A, 'a:stretch');
      replacement.append(doc.createElementNS(A, 'a:fillRect')); copy.append(replacement);
    }
    const rect = child(child(copy, A, 'stretch'), A, 'fillRect');
    for (const attr of [...(rect?.attributes || [])]) if (!attr.namespaceURI) rect.removeAttribute(attr.name);
    doc.documentElement.insertBefore(copy, child(doc.documentElement, PIC, 'spPr'));
    const image = readNestedPicture(doc.documentElement, t);
    if (tile) {
      if (t.shapeRotation && !image.rotateWithShape) fail('nonrotating tiled fills on rotated shapes');
      const asset = assets[image.assetId];
      if (!['image/png', 'image/jpeg'].includes(asset?.mime)) fail('tiled vector picture fills');
      const pixels = imageInfo(asset.bytes), resolution = pictureResolution(asset.bytes);
      return { image, tile: { ...tile, width: pixels.width * 914400 / resolution.x, height: pixels.height * 914400 / resolution.y } };
    }
    return { image, destination };
  };
  return drawing => {
    check(drawing, WP, ['inline', 'anchor']);
    if (children(drawing).length !== 1) fail('missing or conflicting drawing positioning');
    const inline = child(drawing, WP, 'inline') || child(drawing, WP, 'anchor');
    const anchor = inline.localName === 'anchor' ? readAnchor(inline) : undefined;
    // wp:inline distances are retained but have no effect on inline layout (§20.4.2.8).
    for (const name of ['distT', 'distB', 'distL', 'distR']) integer(inline, name);
    const allowed = new Set(['extent', 'effectExtent', 'docPr', 'cNvGraphicFramePr']);
    if (anchor) for (const name of ['simplePos', 'positionH', 'positionV', 'wrapSquare', 'wrapTight', 'wrapThrough', 'wrapTopAndBottom', 'wrapNone']) allowed.add(name);
    const positionChildren = nodes => nodes.flatMap(c => {
      if (c.namespaceURI !== MC || c.localName !== 'AlternateContent') return [c];
      const selected = positionChildren(children(alternateBranch(c)));
      if (selected.some(n => n.namespaceURI !== WP || !['positionH', 'positionV'].includes(n.localName))) fail('unsupported alternate inline properties');
      return selected;
    });
    const inlineChildren = positionChildren(children(inline));
    for (const c of inlineChildren) if (!(c.namespaceURI === WP && allowed.has(c.localName)) && !(c.namespaceURI === A && c.localName === 'graphic') && !(anchor && readRelativeSize(c, anchor))) fail(`unsupported inline ${c.localName}`);
    if (new Set(inlineChildren.map(c => c.localName)).size !== inlineChildren.length) fail('duplicate inline properties');
    const extent = child(inline, WP, 'extent'), properties = child(inline, WP, 'docPr');
    const width = integer(extent, 'cx', true), height = integer(extent, 'cy', true), id = integer(properties, 'id', true);
    if (id > 4294967295 || usedIds.has(id)) fail('invalid or duplicate drawing IDs'); usedIds.add(id);
    if (!properties.hasAttribute('name')) fail('missing drawing name');
    // §20.4.2.5: a hidden drawing keeps its place in the story (and its XML) but is not shown.
    const hiddenValue = properties.getAttribute('hidden')?.trim();
    if (hiddenValue != null && !['0', '1', 'false', 'true', 'on', 'off'].includes(hiddenValue)) fail('invalid hidden flags');
    const hidden = ['1', 'true', 'on'].includes(hiddenValue) ? { hidden: true } : {};
    const metadata = readDrawingMetadata(properties, node => readDrawingHyperlink(node, rels));
    const effects = child(inline, WP, 'effectExtent'); check(effects, WP, []);
    for (const a of [...(effects?.attributes || [])]) if (!a.namespaceURI && !['l', 't', 'r', 'b'].includes(a.localName)) fail('unsupported extra extent');
    const effectExtent = Object.fromEntries(CROP_SIDES.map(side => [side, effects ? integer(effects, side[0], true) : 0]));
    const frame = child(inline, WP, 'cNvGraphicFramePr'); check(frame, A, ['graphicFrameLocks']); locks(child(frame, A, 'graphicFrameLocks'));
    const graphic = child(inline, A, 'graphic'); check(graphic, A, ['graphicData']);
    const data = child(graphic, A, 'graphicData');
    if ([WPG, WPS, DGM].includes(data?.getAttribute('uri'))) {
      if (!readParagraph || children(data).length !== 1) fail('invalid grouped drawing');
      const diagram = data.getAttribute('uri') === DGM;
      let root = children(data)[0];
      if (diagram) {
        if (root.namespaceURI !== DGM || root.localName !== 'relIds') fail('mismatched diagram reference');
        try { root = readRecalculatedDiagram(parts, rels, types, root, sourcePart, width, height); }
        catch (error) { if (!preview || !(error instanceof UnsupportedDocumentError)) throw error; root = readDiagramDrawing(parts, rels, types, root, sourcePart, width, height); }
      } else if (root.namespaceURI !== data.getAttribute('uri') || root.localName !== (root.namespaceURI === WPG ? 'wgp' : 'wsp')) fail('mismatched drawing namespace');
      const scene = readShapeScene(root, readNestedPicture, readParagraph, readShapeFill, readSchemeColor, readShapeFont, readDrawingStyle, { preview, readTextBlocks, frame: { width, height } });
      const flatLine = scene.type === 'shape' && (!scene.width || !scene.height)
        ? { rotation: scene.lineRotation || 0, flipH: !!scene.flipH, flipV: !!scene.flipV, strokeWidth: scene.outline?.width || 0 } : undefined;
      if (flatLine && (scene.outline?.headEnd || scene.outline?.tailEnd)) {
        flatLine.markerPen = scene.outline.declaredWidth ?? scene.outline.width;
        if (scene.outline.headEnd) flatLine.headEnd = scene.outline.headEnd;
        if (scene.outline.tailEnd) flatLine.tailEnd = scene.outline.tailEnd;
      }
      if (flatLine && !scene.width && !scene.height && !scene.text && scene.paths.every(path => !path.points.length)) {
        flatLine.empty = true; flatLine.strokeWidth = 0;
      }
      if (flatLine && ((!width !== !scene.width) || (!height !== !scene.height))) fail('mismatched flat line frame');
      const maxPen = node => (node.children || []).reduce((width,child)=>Math.max(width,maxPen(child)),
        node.outline?.headEnd || node.outline?.tailEnd ? Math.ceil(2*outlinePadding(node.outline,false)) : node.outline?.width || 0);
      const flatGroup = scene.type === 'group' && (!width || !height)
        ? { rotation: scene.groupRotation || 0, flipH: !!scene.flipH, flipV: !!scene.flipV, strokeWidth: maxPen(scene) } : undefined;
      if (flatGroup && ((!width !== !scene.width) || (!height !== !scene.height))) fail('mismatched flat group frame');
      const assetId = drawingAssetId(id);
      if (assets[assetId]) fail('duplicate drawing asset');
      // Keep the physical frame exact. The decoder rounds bitmap bounds only;
      // rounding here would introduce anisotropic scaling before rotation.
      assets[assetId] = { scene, width: width / 9525, height: height / 9525, ...(anchor?.relativeSize ? {relativeFrame:true} : {}) };
      const frameRotation = compatibilityMode >= 14 && !anchor && !flatLine && !flatGroup ? scene.shapeRotation || scene.groupRotation || scene.lineRotation || 0 : 0;
      return validateImage({ kind: 'drawing', retainedDrawing: true, assetId, width, height, ...(frameRotation ? { frameRotation } : {}), ...(flatLine ? { flatLine } : {}), ...(flatGroup ? { flatGroup } : {}), effectExtent, ...metadata, ...hidden, ...(anchor ? { anchor } : {}), id, name: properties.getAttribute('name'), alt: properties.getAttribute('descr') || '', shell: serializeFragment(drawing) });
    }
    if (data?.getAttribute('uri') === C) {
      if (sourcePart !== 'word/document.xml') fail('charts in headers or footers');
      if (anchor) fail('floating charts');
      check(data, C, ['chart']); const reference = child(data, C, 'chart'); if (!reference) fail('missing chart reference');
      const { path, relId, chart } = readChart(parts, reference, readSchemeColor, readShapeFont);
      // A detached drawing/paragraph loses ancestor relationship bindings.
      // Bind this attribute locally so XMLSerializer cannot invent a prefix
      // that collides with the chart element's prefix (e.g. ns1).
      const attribute = reference.getAttributeNodeNS(R, 'id');
      reference.setAttributeNS(XMLNS, `xmlns:${attribute.prefix}`, R);
      const result = validateImage({ kind: 'chart', assetId: path, relId, width, height, effectExtent, ...metadata, ...hidden, id, name: properties.getAttribute('name'), alt: properties.getAttribute('descr') || '', shell: serializeFragment(drawing) });
      assets[path] ||= { chart, width: Math.ceil(width / 9525), height: Math.ceil(height / 9525) };
      return result;
    }
    if (data?.getAttribute('uri') !== PIC) fail('non-picture DrawingML'); check(data, PIC, ['pic']);
    const pic = child(data, PIC, 'pic'); if (!pic) fail('missing picture'); check(pic, PIC, ['nvPicPr', 'blipFill', 'spPr']);
    const nv = child(pic, PIC, 'nvPicPr'); check(nonvisualPicture(nv), PIC, ['cNvPr', 'cNvPicPr']);
    const nvPr = child(nv, PIC, 'cNvPr'), nvPic = child(nv, PIC, 'cNvPicPr');
    if (!nvPr || !nvPic || !nvPr.hasAttribute('name')) fail('missing non-visual picture properties');
    // Inner-picture links are retained, but only wp:docPr links are active.
    integer(nvPr, 'id', true); readDrawingMetadata(nvPr, node => readDrawingHyperlink(node, rels, { inactive: true })); check(nvPic, A, ['picLocks']); locks(child(nvPic, A, 'picLocks'));
    const pictureHidden = nvPr.getAttribute('hidden')?.trim();
    if (pictureHidden != null && !['0', '1', 'false', 'true', 'on', 'off'].includes(pictureHidden)) fail('invalid hidden picture flags');
    if (['1', 'true', 'on'].includes(pictureHidden)) hidden.hidden = true;
    const fill = child(pic, PIC, 'blipFill'); check(fill, A, ['blip', 'srcRect', 'stretch']);
    const rotateWithShape = !fill?.hasAttribute('rotWithShape') || boolean(fill, 'rotWithShape');
    const blip = child(fill, A, 'blip'), stretch = child(fill, A, 'stretch');
    if (!blip || !stretch || blip.hasAttributeNS(R, 'link')) fail('linked images or non-stretched fills');
    const { svg, opacity, duotone } = blipExtensions(blip, readSchemeColor); const crop = readCrop(child(fill, A, 'srcRect'));
    check(stretch, A, ['fillRect']);
    if (Object.values(readCrop(child(stretch, A, 'fillRect'))).some(Boolean)) fail('nonzero destination fill offsets');
    const shape = child(pic, PIC, 'spPr'); if (!shape) fail('missing shape properties');
    if (shape.hasAttribute('bwMode') && !['auto', 'clr'].includes(shape.getAttribute('bwMode'))) fail('black-and-white transforms');
    check(shape, A, ['xfrm', 'prstGeom', 'custGeom', 'effectLst', 'noFill', 'solidFill', 'ln', 'extLst', 'scene3d', 'sp3d']); check(child(shape, A, 'noFill'), A, []);
    const shadow = readPictureShadow(shape, readSchemeColor, true);
    const drawingEffects = readDrawingEffects(shape, readSchemeColor);
    const backingFill = readPictureBackingFill(shape, readSchemeColor);
    const threeD = readPicture3d(shape, readSchemeColor);
    readShapeExtensions(shape);
    const outline = threeD ? null : readDrawingOutline(shape, readSchemeColor, { preview });
    const transform = child(shape, A, 'xfrm'), flips = pictureTransform(transform); check(transform, A, ['off', 'ext']); zeroOrigin(child(transform, A, 'off'));
    const inner = child(transform, A, 'ext'); if (inner) { if (!integer(inner, 'cx', true) || !integer(inner, 'cy', true)) fail('empty inner extents'); }
    if (flips.rotation && inner && (integer(inner, 'cx') !== width || integer(inner, 'cy') !== height)) fail('rotated pictures with differing inline and shape dimensions');
    const geom = child(shape, A, 'prstGeom');
    if (shadow?.obscured && (child(shape, A, 'custGeom') || threeD?.turn)) fail('shadow obscuration with custom or projected geometry');
    const shadowProperties = { ...(shadow ? { shadow, shadowGeometry: geom?.getAttribute('prst') || 'rect' } : {}), ...(drawingEffects ? { effects: drawingEffects } : {}) };
    // Preset geometry other than a rectangle clips the picture (§20.1.9.18); its outline follows the preset.
    const clipped = child(shape, A, 'custGeom') || !threeD && geom && geom.getAttribute('prst') !== 'rect';
    let clipPaths = null;
    if (clipped) {
      try { clipPaths = readShapeGeometry(shape, { width: inner ? integer(inner, 'cx') : width, height: inner ? integer(inner, 'cy') : height }, { preview }).paths; }
      catch (e) { if (e instanceof UnsupportedDocumentError) fail(`unsupported geometry (${e.message})`); throw e; }
    }
    if (threeD || geom?.getAttribute('prst') === 'rect') { check(geom, A, ['avLst']); check(child(geom, A, 'avLst'), A, []); }
    const readAsset = (reference, vector = false) => {
      const relId = reference.getAttributeNS(R, 'embed'), matches = [...(rels?.getElementsByTagNameNS(REL, 'Relationship') || [])].filter(n => n.getAttribute('Id') === relId);
      if (!relId || matches.length !== 1) fail('missing or ambiguous image relationships');
      const rel = matches[0]; if (rel.getAttribute('Type') !== `${R}/image` || rel.hasAttribute('TargetMode') && rel.getAttribute('TargetMode') !== 'Internal') fail('external or non-image relationships');
      let url, path;
      try { url = new URL(rel.getAttribute('Target'), `https://docx.invalid/${sourcePart}`); path = decodeURIComponent(url.pathname).slice(1); } catch { fail('invalid image targets'); }
      if (url.origin !== 'https://docx.invalid' || url.search || url.hash || !parts[path]) fail('missing or external image parts');
      const bytes = parts[path],wmfViewport={width:width/9525,height:height/9525}; let info;
      try { info = vector ? svgInfo(bytes) : isEmf(bytes) ? emfInfo(bytes,{inspectText:opacity!==1}) : isWmf(bytes) ? wmfInfo(bytes,wmfViewport) : imageInfo(bytes); } catch (e) { fail(e.message); }
      const override = [...types.getElementsByTagNameNS('*', 'Override')].find(n => n.getAttribute('PartName') === `/${path}`);
      const fallback = [...types.getElementsByTagNameNS('*', 'Default')].find(n => n.getAttribute('Extension')?.toLowerCase() === path.split('.').at(-1).toLowerCase());
      const declared = (override || fallback)?.getAttribute('ContentType');
      const extensionMime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[path.split('.').at(-1).toLowerCase()];
      // Existing documents carry PNG/JPEG payloads saved under the other format's
      // part name and matching declaration. Decode the validated payload while
      // preserving its original package bytes and content-type metadata.
      // This does not permit missing declarations, vector/raster mismatches,
      // or a declaration that contradicts both the payload and part extension.
      const namedRaster = !!extensionMime && declared === extensionMime && ['image/png', 'image/jpeg'].includes(info.mime);
      const extension=path.split('.').at(-1).toLowerCase();
      const namedMetafile=[EMF_MIME,WMF_MIME].includes(info.mime)&&['wmf','emf'].includes(extension)&&[`image/${extension}`,`image/x-${extension}`].includes(declared);
      if (!namedRaster && !namedMetafile && !(info.mime === EMF_MIME ? [EMF_MIME, 'image/x-emf'] : info.mime === WMF_MIME ? [WMF_MIME, 'image/x-wmf'] : [info.mime]).includes(declared)) fail('incorrect image content types');
      assets[path] ||= { bytes, mime: info.mime, ...(info.mime===WMF_MIME?{wmfViewport}:{}) };
      return { path, relId, ...(info.hasTextRecord?{hasTextRecord:true}:{}) };
    };
    const raster = readAsset(blip), vector = svg ? readAsset(svg, true) : null;
    const { path: sourcePath, relId, hasTextRecord } = vector || raster;
    // A media part can be reused with different effects. Keep its bytes and
    // relationships immutable, and give each resolved effect chain its own
    // session bitmap identity, shared by matching picture occurrences.
    const effectPath = duotone.length ? `duotone:${sourcePath}:${JSON.stringify(duotone)}` : sourcePath;
    if (duotone.length) assets[effectPath] ||= { ...assets[sourcePath], ...(duotone.some(e => !Array.isArray(e)) ? { pictureEffects: duotone } : { duotone }) };
    // Text-bearing EMFs are rasterized with drawing opacity as well as color
    // effects. Preserve separate opaque/opacity instances of reused media;
    // the actual opacity remains a paint property, applied exactly once.
    const path = opacity!==1&&hasTextRecord ? `opacity:${effectPath}` : effectPath;
    if(path!==effectPath)assets[path] ||= {...assets[effectPath],metafileOpacity:true};
    const aspectLocked = [child(frame, A, 'graphicFrameLocks'), child(nvPic, A, 'picLocks')].some(n => ['1', 'true', 'on'].includes(n?.getAttribute('noChangeAspect')));
    // Ordinary floating pictures retain crop/reflections on the image itself;
    // custom geometry below retains them inside its clipped picture scene.
    const result = { assetId: path, ...hidden, ...(opacity !== 1 ? { opacity } : {}), ...(anchor?.relativeSize ? { retainedDrawing: true, relativeSizeFit: true } : {}), ...(vector ? { fallbackAssetId: raster.path, fallbackRelId: raster.relId } : {}), width, height, crop, effectExtent, rotateWithShape, ...flips, ...metadata, ...(anchor ? { anchor } : {}), id, name: properties.getAttribute('name'), alt: properties.getAttribute('descr') || '', aspectLocked, relId, shell: serializeFragment(drawing) };
    if (clipPaths || outline || (backingFill || shadow || drawingEffects) && !threeD) {
      // The scene paints the unrotated frame; the page rotates it like any picture (image.rotation).
      if (threeD || !rotateWithShape) fail('custom picture geometry with 3D or nonrotating fills');
      const assetId = drawingAssetId(id);
      if (assets[assetId]) fail('duplicate drawing asset');
      const picture = { type: 'picture', width, height, ...(clipPaths ? { clipPaths } : {}), image: { assetId: path, crop, ...flips, ...(opacity !== 1 ? { opacity } : {}) } };
      assets[assetId] = { scene: pictureOutlineScene(picture, outline || backingFill ? readShapeGeometry(shape, { width, height }, { preview }).paths : [], outline, backingFill), width: width / 9525, height: height / 9525, ...shadowProperties };
      delete result.opacity; delete result.flipH; delete result.flipV; delete result.crop;
      try { return validateImage({ ...result, kind: 'drawing', retainedDrawing: true, assetId }); } catch (e) { fail(e.message); }
    }
    if (threeD) {
      if (flips.flipH || flips.flipV || flips.rotation || !rotateWithShape) fail('transformed 3D picture frames');
      const assetId = drawingAssetId(id);
      if (assets[assetId]) fail('duplicate drawing asset');
      // The inner aspect ratio fits inside the outer frame, top-left,
      // before applying physical bevel/outline/extrusion dimensions. The
      // surrounding text still reserves the complete outer frame.
      const innerWidth = inner ? integer(inner, 'cx') : width, innerHeight = inner ? integer(inner, 'cy') : height;
      const scale = Math.min(width / innerWidth, height / innerHeight);
      assets[assetId] = { scene: { type: 'picture3d', width: innerWidth * scale, height: innerHeight * scale, image: { assetId: path, crop, ...(opacity !== 1 ? { opacity } : {}) }, ...threeD, ...(backingFill ? { backingFill } : {}) }, width: width / 9525, height: height / 9525, ...shadowProperties };
      delete result.opacity; // The texture is modified before lighting/outlines.
      return validateImage({ ...result, kind: 'drawing', retainedDrawing: true, assetId });
    }
    try { return validateImage(result); } catch (e) { fail(e.message); }
  };
}

/** Add only referenced new assets; preserve all existing parts and relationships. */
/**
 * Rewrite a drawing's frame for its wrapping: `wp:inline` (§20.4.2.8) without an anchor, otherwise
 * `wp:anchor` (§20.4.2.3) with its column/paragraph offsets, layer, stacking order and wrapSquare,
 * wrapTopAndBottom or wrapNone. The extent, effect extent, properties and graphic move across unchanged.
 */
export function reframeDrawing(doc, drawing, image) {
  const old = [...drawing.children].find(n => n.namespaceURI === WP && ['inline', 'anchor'].includes(n.localName));
  if (!old) throw new Error('The drawing has no frame to rewrite.');
  const pick = name => [...old.children].find(n => n.namespaceURI === WP && n.localName === name);
  const graphic = [...old.children].find(n => n.namespaceURI === A && n.localName === 'graphic');
  // New elements reuse the frame's own prefix, which is declared wherever the frame is.
  const prefix = old.prefix ? `${old.prefix}:` : '';
  const make = (name, attrs = {}) => { const n = doc.createElementNS(WP, prefix + name.replace(/^wp:/, '')); for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, String(value)); return n; };
  const [extent, effect, properties, frameProperties] = ['extent', 'effectExtent', 'docPr', 'cNvGraphicFramePr'].map(pick);
  let frame;
  if (!image.anchor) {
    frame = make('wp:inline', { distT: 0, distB: 0, distL: 0, distR: 0 });
    frame.append(...[extent, effect, properties, frameProperties, graphic].filter(Boolean));
  } else {
    const a = image.anchor, square = a.wrap === 'square', d = square ? a.distances : { T: 0, B: 0, L: 114300, R: 114300 };
    frame = make('wp:anchor', { distT: d.T, distB: d.B, distL: d.L, distR: d.R, simplePos: 0, relativeHeight: a.order ?? 1, behindDoc: a.behind ? 1 : 0, locked: 0, layoutInCell: 1, allowOverlap: 1 });
    frame.append(make('wp:simplePos', { x: 0, y: 0 }));
    for (const [name, base, axis] of [['wp:positionH', a.horizontal, 'x'], ['wp:positionV', a.vertical, 'y']]) {
      const position = make(name, { relativeFrom: base }), offset = make('wp:posOffset');
      offset.textContent = String(Math.round(a[axis] || 0)); position.append(offset); frame.append(position);
    }
    frame.append(extent, effect || make('wp:effectExtent', { l: 0, t: 0, r: 0, b: 0 }),
      square ? make('wp:wrapSquare', { wrapText: a.wrapText || 'bothSides' }) : make(a.wrap === 'topAndBottom' ? 'wp:wrapTopAndBottom' : 'wp:wrapNone'),
      ...[properties, frameProperties || make('wp:cNvGraphicFramePr'), graphic].filter(Boolean));
  }
  old.replaceWith(frame);
}

export function imageWriter(parts, paragraphs, assets, doc, sourcePart = 'word/document.xml') {
  const relPath = relationshipPartPath(sourcePart);
  const images = paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image)), relations = new Map();
  for (const image of images) if (image.shell) relations.set(image.assetId, image.relId);
  let rels, types;
  // A drawing inserted in this session brings its own package parts (a chart part, SVG and PNG
  // media). They are written while the drawing is in the story; undoing the insertion leaves none.
  for (const image of images) if (image.shell) for (const id of new Set([image.assetId, image.fallbackAssetId])) for (const part of assets[id]?.packageParts || []) {
    rels ||= parts[relPath] ? parseXml(parts[relPath]) : parseXml(`<Relationships xmlns="${REL}"/>`);
    types ||= parseXml(parts['[Content_Types].xml']);
    if (part.relId) {
      const target = relativePartTarget(sourcePart, part.path), existing = children(rels.documentElement).find(n => n.getAttribute('Id') === part.relId);
      if (existing && existing.getAttribute('Target') !== target) throw new Error('An inserted drawing\'s relationship conflicts with the document.');
      if (!existing) {
        const rel = rels.createElementNS(REL, 'Relationship');
        for (const [key, value] of Object.entries({ Id: part.relId, Type: part.relType, Target: target })) rel.setAttribute(key, value);
        rels.documentElement.append(rel);
      }
    }
    parts[part.path] = part.bytes;
    if (part.contentType && ![...types.documentElement.children].some(n => n.localName === 'Override' && n.getAttribute('PartName') === `/${part.path}`)) {
      const type = types.createElementNS(types.documentElement.namespaceURI, 'Override'); type.setAttribute('PartName', `/${part.path}`); type.setAttribute('ContentType', part.contentType); types.documentElement.append(type);
    }
  }
  for (const image of images) {
    validateImage(image);
    if (image.shell) continue;
    if (relations.has(image.assetId)) continue;
    const asset = assets[image.assetId]; if (!asset) throw new Error('An image asset is missing.');
    const info = imageInfo(asset.bytes);
    rels ||= parts[relPath] ? parseXml(parts[relPath]) : parseXml(`<Relationships xmlns="${REL}"/>`);
    types ||= parseXml(parts['[Content_Types].xml']);
    const extension = { 'image/png': 'png', 'image/tiff': 'tiff', 'image/gif': 'gif' }[info.mime] || 'jpg';
    let index = 1, path; do { path = `word/media/canvas-image${index++}.${extension}`; } while (parts[path]);
    const ids = new Set(children(rels.documentElement).map(n => n.getAttribute('Id'))); let id = 'rImage1', number = 1; while (ids.has(id)) id = `rImage${++number}`;
    const rel = rels.createElementNS(REL, 'Relationship'); for (const [key, value] of Object.entries({ Id: id, Type: `${R}/image`, Target: relativePartTarget(sourcePart, path) })) rel.setAttribute(key, value);
    rels.documentElement.append(rel); parts[path] = asset.bytes; relations.set(image.assetId, id);
    const type = types.createElementNS(types.documentElement.namespaceURI, 'Override'); type.setAttribute('PartName', `/${path}`); type.setAttribute('ContentType', info.mime); types.documentElement.append(type);
  }
  if (rels) { parts[relPath] = strToU8(serialize(rels)); parts['[Content_Types].xml'] = strToU8(serialize(types)); }
  const writeDrawingLink = drawingHyperlinkWriter(parts, images, sourcePart);
  return image => {
    const drawing = image.shell ? doc.importNode(parseXml(image.shell).documentElement, true) : doc.createElementNS(W, 'w:drawing');
    // The frame's id is the one the model holds: drawing XML built before insertion (ink, a group) can carry
    // another, which could repeat an id in use, and a part with repeated ids no longer opens for editing.
    const frameProperties = image.shell && drawing.getElementsByTagNameNS(WP, 'docPr')[0];
    if (frameProperties && Number.isInteger(image.id) && frameProperties.getAttribute('id') !== String(image.id)) frameProperties.setAttribute('id', String(image.id));
    // A changed wrapping rewrites the whole frame, including the position and layer it records.
    if (image.wrapChanged && image.shell) reframeDrawing(doc, drawing, image);
    else if (image.anchorChanged && image.shell) {
      const anchor = drawing.getElementsByTagNameNS(WP, 'anchor')[0];
      if (!anchor) throw new Error('The source drawing has no editable floating anchor.');
      anchor.setAttribute('behindDoc', image.anchor.behind ? '1' : '0');
      anchor.setAttribute('relativeHeight', String(image.anchor.order));
      for (const [axis, name] of [['x', 'positionH'], ['y', 'positionV']]) {
        const original = parseXml(image.shell).getElementsByTagNameNS(WP, name)[0];
        const pos = anchor.getElementsByTagNameNS(WP, name)[0];
        // Preserve authored alignment/percentage coordinates unless that axis was moved.
        if (image.anchor[axis + 'Align'] || image.anchor[axis + 'Percentage'] !== undefined) continue;
        if (original && pos) { const offset = doc.createElementNS(WP, 'wp:posOffset'); offset.textContent = String(image.anchor[axis]); pos.replaceChildren(offset); }
      }
    }
    if (image.retainedDrawing) return writeDrawingLink(drawing, image);
    if (image.shell) writeDrawingLink(drawing, image);
    const make = (ns, name, attrs = {}, parent) => { const n = doc.createElementNS(ns, name); for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, String(value)); parent?.append(n); return n; };
    if (!image.shell) {
      const inline = make(WP, 'wp:inline', {}, drawing); make(WP, 'wp:extent', { cx: image.width, cy: image.height }, inline);
      make(WP, 'wp:docPr', { id: image.id, name: image.name, descr: image.alt }, inline);
      const graphic = make(A, 'a:graphic', {}, inline), data = make(A, 'a:graphicData', { uri: PIC }, graphic), pic = make(PIC, 'pic:pic', {}, data);
      const nv = make(PIC, 'pic:nvPicPr', {}, pic); make(PIC, 'pic:cNvPr', { id: 0, name: image.name }, nv); make(PIC, 'pic:cNvPicPr', {}, nv);
      const fill = make(PIC, 'pic:blipFill', {}, pic), blip = make(A, 'a:blip', {}, fill); blip.setAttributeNS(R, 'r:embed', relations.get(image.assetId));
      for (const pair of assets[image.assetId]?.pictureEffects || assets[image.assetId]?.duotone || []) {
        if (!Array.isArray(pair)) {
          const percent = value => Number.isInteger(value * 100000) ? value * 100000 : (value * 100) + '%';
          if (pair.type === 'colorChange') {
            const effect = make(A, 'a:clrChange', { useA: pair.useAlpha ? '1' : '0' }, blip);
            for (const [name, color] of [['clrFrom', pair.from], ['clrTo', pair.to]]) {
              const node = make(A, 'a:srgbClr', { val: color.rgb }, make(A, 'a:' + name, {}, effect));
              if (color.alpha !== 1) make(A, 'a:alpha', { val: percent(color.alpha) }, node);
            }
            continue;
          }
          if (pair.type === 'biLevel') { make(A, 'a:biLevel', { thresh: Math.round(pair.threshold * 100000) }, blip); continue; }
          make(A, 'a:lum', { bright: percent(pair.brightness), contrast: percent(pair.contrast) }, blip); continue;
        }
        const effect = make(A, 'a:duotone', {}, blip);
        for (const color of pair) make(A, 'a:srgbClr', { val: color }, effect);
      }
      make(A, 'a:fillRect', {}, make(A, 'a:stretch', {}, fill));
      const shape = make(PIC, 'pic:spPr', {}, pic), xfrm = make(A, 'a:xfrm', {}, shape); make(A, 'a:off', { x: 0, y: 0 }, xfrm); make(A, 'a:ext', { cx: image.width, cy: image.height }, xfrm);
      make(A, 'a:avLst', {}, make(A, 'a:prstGeom', { prst: 'rect' }, shape));
    } else {
      if (image.sizeChanged) {
        const extent = drawing.getElementsByTagNameNS(WP, 'extent')[0]; extent.setAttribute('cx', image.width); extent.setAttribute('cy', image.height);
        const ext = child(drawing.getElementsByTagNameNS(A, 'xfrm')[0], A, 'ext'); if (ext) { ext.setAttribute('cx', image.width); ext.setAttribute('cy', image.height); }
      }
      if (image.altChanged) drawing.getElementsByTagNameNS(WP, 'docPr')[0].setAttribute('descr', image.alt);
    }
    for (const key of ['flipH', 'flipV', 'rotation']) if (image[`${key}Changed`] || !image.shell && image[key]) {
      const shape = drawing.getElementsByTagNameNS(PIC, 'spPr')[0];
      let transform = child(shape, A, 'xfrm');
      if (!transform) {
        transform = make(A, 'a:xfrm'); shape.insertBefore(transform, shape.firstChild);
        make(A, 'a:off', { x: 0, y: 0 }, transform); make(A, 'a:ext', { cx: image.width, cy: image.height }, transform);
      }
      transform.setAttribute(key === 'rotation' ? 'rot' : key, key === 'rotation' ? String(normalizedRotation(image.rotation)) : image[key] ? '1' : '0');
      if (key === 'rotation') {
        let ext = child(transform, A, 'ext'); if (!ext) ext = make(A, 'a:ext', {}, transform);
        ext.setAttribute('cx', image.width); ext.setAttribute('cy', image.height);
      }
    }
    if (image.extentChanged || !image.shell && CROP_SIDES.some(side => imageExtents(image)[side])) {
      const inline = drawing.getElementsByTagNameNS(WP, 'inline')[0] || drawing.getElementsByTagNameNS(WP, 'anchor')[0], extent = imageExtents(image);
      let effects = child(inline, WP, 'effectExtent');
      if (!effects) { effects = make(WP, 'wp:effectExtent'); inline.insertBefore(effects, child(inline, WP, 'extent').nextSibling); }
      for (const side of CROP_SIDES) effects.setAttribute(side[0], String(extent[side]));
    }
    if (image.cropChanged || !image.shell && image.crop) {
      const fill = drawing.getElementsByTagNameNS(PIC, 'blipFill')[0], crop = normalizeCrop(image.crop);
      let rect = child(fill, A, 'srcRect');
      if (!Object.values(crop).some(Boolean)) rect?.remove();
      else {
        if (!rect) { rect = make(A, 'a:srcRect'); fill.insertBefore(rect, child(fill, A, 'stretch')); }
        for (const side of CROP_SIDES) rect.setAttribute(side[0], String(crop[side]));
      }
    }
    if (!image.shell && image.anchor) reframeDrawing(doc, drawing, image);
    return drawing;
  };
}
