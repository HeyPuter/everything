import { zipSync, strToU8 } from 'fflate';
import { readShapeScene } from './docx-shapes.js';
import { validateImage } from './images.js';
import { PRESET_CATEGORIES } from './preset-geometries.js';

/**
 * Shapes inserted from Insert → Shapes. Each is written as ordinary WordprocessingML DrawingML — a
 * `wps:wsp` preset shape in a `w:drawing` — and read back through the same shape reader imported
 * drawings use, so what is painted is exactly what is saved. Editing a shape (fill, outline, size)
 * writes its DrawingML again from these parameters.
 */
const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
};
export const EMU_PER_INCH = 914400;

/** [preset, name, group, width, height] in inches. Lines are drawn left to right. */
const BASE_PRESETS = [
  ['line', 'Line', 'Lines', 1.5, 0], ['straightArrow', 'Line Arrow', 'Lines', 1.5, 0],
  ['rect', 'Rectangle', 'Rectangles', 1.5, 1], ['roundRect', 'Rounded Rectangle', 'Rectangles', 1.5, 1],
  ['ellipse', 'Oval', 'Basic Shapes', 1.25, 1.25], ['triangle', 'Isosceles Triangle', 'Basic Shapes', 1.25, 1.1], ['rtTriangle', 'Right Triangle', 'Basic Shapes', 1.25, 1.1],
  ['diamond', 'Diamond', 'Basic Shapes', 1.25, 1.25], ['parallelogram', 'Parallelogram', 'Basic Shapes', 1.5, 1], ['trapezoid', 'Trapezoid', 'Basic Shapes', 1.5, 1],
  ['pentagon', 'Pentagon', 'Basic Shapes', 1.25, 1.2], ['hexagon', 'Hexagon', 'Basic Shapes', 1.4, 1.2], ['octagon', 'Octagon', 'Basic Shapes', 1.25, 1.25],
  ['plus', 'Cross', 'Basic Shapes', 1.25, 1.25], ['cloud', 'Cloud', 'Basic Shapes', 1.5, 1],
  ['rightArrow', 'Right Arrow', 'Block Arrows', 1.5, 0.8], ['leftArrow', 'Left Arrow', 'Block Arrows', 1.5, 0.8], ['upArrow', 'Up Arrow', 'Block Arrows', 0.8, 1.5],
  ['downArrow', 'Down Arrow', 'Block Arrows', 0.8, 1.5], ['leftRightArrow', 'Left-Right Arrow', 'Block Arrows', 1.75, 0.8], ['chevron', 'Chevron', 'Block Arrows', 1.25, 1],
  ['homePlate', 'Pentagon Arrow', 'Block Arrows', 1.5, 0.8],
  ['star5', '5-Point Star', 'Stars and Banners', 1.25, 1.2], ['star4', '4-Point Star', 'Stars and Banners', 1.25, 1.25],
];
/** Gallery names for the presets preset-geometries-more.js adds, in this app's own words. */
const NAMES = { snip1Rect: 'Snipped Corner Rectangle', snip2SameRect: 'Snipped Top Corners', snip2DiagRect: 'Snipped Diagonal Corners', snipRoundRect: 'Snipped and Rounded Rectangle',
  round1Rect: 'Rounded Corner Rectangle', round2DiagRect: 'Rounded Diagonal Corners', can: 'Cylinder', foldedCorner: 'Folded Corner', smileyFace: 'Smiley Face', lightningBolt: 'Lightning Bolt',
  blockArc: 'Block Arc', noSmoking: 'Circle with Slash', bracketPair: 'Double Bracket', bracePair: 'Double Brace', leftBracket: 'Left Bracket', rightBracket: 'Right Bracket', leftBrace: 'Left Brace', rightBrace: 'Right Brace',
  corner: 'L-Shape', diagStripe: 'Diagonal Stripe', upDownArrow: 'Up-Down Arrow', quadArrow: 'Four-Way Arrow', leftRightUpArrow: 'Three-Way Arrow', leftUpArrow: 'Left-Up Arrow', bentUpArrow: 'Bent-Up Arrow',
  notchedRightArrow: 'Notched Right Arrow', stripedRightArrow: 'Striped Right Arrow', bentArrow: 'Bent Arrow', uturnArrow: 'U-Turn Arrow', rightArrowCallout: 'Right Arrow Callout', leftArrowCallout: 'Left Arrow Callout',
  upArrowCallout: 'Up Arrow Callout', downArrowCallout: 'Down Arrow Callout', leftRightArrowCallout: 'Left-Right Arrow Callout', quadArrowCallout: 'Four-Way Arrow Callout',
  mathPlus: 'Plus Sign', mathMinus: 'Minus Sign', mathMultiply: 'Multiplication Sign', mathDivide: 'Division Sign', mathEqual: 'Equals Sign', mathNotEqual: 'Not Equal Sign',
  irregularSeal1: 'Burst', irregularSeal2: 'Burst with Points', ribbon: 'Ribbon', wave: 'Wave', doubleWave: 'Double Wave', verticalScroll: 'Vertical Scroll', horizontalScroll: 'Horizontal Scroll',
  wedgeRectCallout: 'Speech Bubble: Rectangle', wedgeRoundRectCallout: 'Speech Bubble: Rounded', wedgeEllipseCallout: 'Speech Bubble: Oval', borderCallout1: 'Line Callout: Bordered', callout1: 'Line Callout', accentCallout1: 'Line Callout: Accent Bar',
  frame: 'Frame', halfFrame: 'Half Frame', donut: 'Ring', plaque: 'Plaque', round2SameRect: 'Rounded Top Corners', ribbon2: 'Ribbon Up', cloudCallout: 'Thought Bubble', flowChartOffpageConnector: 'Flowchart: Off-page Connector' };
const GROUPS = { rectangles: 'Rectangles', basic: 'Basic Shapes', blockArrows: 'Block Arrows', equation: 'Equation Shapes', flowchart: 'Flowchart', starsBanners: 'Stars and Banners', callouts: 'Callouts' };
const label = preset => NAMES[preset] || (preset.startsWith('flowChart') ? `Flowchart: ${preset.slice(9).replace(/([a-z])([A-Z])/g, '$1 $2')}` : /^star\d+$/.test(preset) ? `${preset.slice(4)}-Point Star` : preset.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()));
const size = (group, preset) => group === 'Block Arrows' && /up|down/i.test(preset) && !/left|right/i.test(preset) ? [0.9, 1.4] : group === 'Flowchart' ? [1.4, 0.9] : group === 'Callouts' || group === 'Block Arrows' ? [1.6, 1] : group === 'Equation Shapes' ? [1.1, 1.1] : ['rectangles', 'Rectangles'].includes(group) ? [1.5, 1] : [1.25, 1.25];
const extra = [...Object.entries(PRESET_CATEGORIES).flatMap(([key, presets]) => presets.map(preset => [preset, GROUPS[key]])),
  ['round2SameRect', 'Rectangles'], ['frame', 'Basic Shapes'], ['halfFrame', 'Basic Shapes'], ['donut', 'Basic Shapes'], ['plaque', 'Basic Shapes'],
  ['flowChartOffpageConnector', 'Flowchart'], ['ribbon2', 'Stars and Banners'], ['cloudCallout', 'Callouts']];
const ORDER = ['Lines', 'Rectangles', 'Basic Shapes', 'Block Arrows', 'Equation Shapes', 'Flowchart', 'Stars and Banners', 'Callouts'];
export const SHAPE_PRESETS = Object.freeze([...BASE_PRESETS, ...extra.filter(([preset]) => !BASE_PRESETS.some(([p]) => p === preset)).map(([preset, group]) => [preset, label(preset), group, ...size(group, preset)])]
  .sort((a, b) => ORDER.indexOf(a[2]) - ORDER.indexOf(b[2])));
export const LINE_PRESETS = new Set(['line', 'straightArrow']);
/** Open outlines that are drawn without a fill when inserted. */
export const UNFILLED_PRESETS = new Set(['arc', 'leftBracket', 'rightBracket', 'leftBrace', 'rightBrace', 'bracketPair', 'bracePair']);

/** The default look of a new shape: a blue fill with a darker outline; lines are a blue stroke. */
export const DEFAULT_SHAPE_STYLE = Object.freeze({ fill: '4472C4', line: '2F528F', lineWidth: 12700 });

/** A new text box body: the DrawingML default 0.1 in side and 0.05 in top/bottom insets, wrapped text from the top, no autofit. */
const TEXT_BODY = '<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="t" anchorCtr="0"><a:noAutofit/></wps:bodyPr>';
const wrapXml = anchor => anchor.wrap === 'square' ? `<wp:wrapSquare wrapText="${anchor.wrapText || 'bothSides'}"/>` : anchor.wrap === 'topAndBottom' ? '<wp:wrapTopAndBottom/>' : '<wp:wrapNone/>';
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const solid = color => color ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` : '<a:noFill/>';

/**
 * The `w:drawing` for a shape. params: { preset, width, height (EMU), fill (hex or null), line (hex or
 * null), lineWidth (EMU), anchor? }. The anchor is the editor's floating anchor object.
 */
export function shapeDrawingXml({ id, name, preset, width, height, fill, line, lineWidth, anchor, text, bodyXml }) {
  const isLine = LINE_PRESETS.has(preset);
  const geometry = preset === 'straightArrow' ? 'line' : preset;
  const ends = preset === 'straightArrow' ? '<a:tailEnd type="triangle"/>' : '';
  const outline = line ? `<a:ln w="${lineWidth}">${solid(line)}${ends}</a:ln>` : '<a:ln><a:noFill/></a:ln>';
  // A text box keeps its paragraphs and body properties as authored; a plain shape has an empty body.
  const body = text !== undefined ? `<wps:txbx><w:txbxContent>${text}</w:txbxContent></wps:txbx>${bodyXml || TEXT_BODY}` : '<wps:bodyPr/>';
  const shape = `<a:graphic><a:graphicData uri="${NS.wps}"><wps:wsp><wps:cNvSpPr${text !== undefined ? ' txBox="1"' : ''}/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm>`
    + `<a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom>${isLine ? '' : solid(fill)}${outline}</wps:spPr>${body}</wps:wsp></a:graphicData></a:graphic>`;
  const docPr = `<wp:docPr id="${id}" name="${escape(name)}"/>`, extent = `<wp:extent cx="${width}" cy="${height}"/>`;
  const frame = anchor
    ? `<wp:anchor distT="${anchor.distances?.T ?? 0}" distB="${anchor.distances?.B ?? 0}" distL="${anchor.distances?.L ?? 114300}" distR="${anchor.distances?.R ?? 114300}" simplePos="0" relativeHeight="${anchor.order ?? 1}" behindDoc="${anchor.behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1">`
      + `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="${anchor.horizontal || 'column'}"><wp:posOffset>${Math.round(anchor.x || 0)}</wp:posOffset></wp:positionH>`
      + `<wp:positionV relativeFrom="${anchor.vertical || 'paragraph'}"><wp:posOffset>${Math.round(anchor.y || 0)}</wp:posOffset></wp:positionV>${extent}<wp:effectExtent l="0" t="0" r="0" b="0"/>${wrapXml(anchor)}${docPr}<wp:cNvGraphicFramePr/>${shape}</wp:anchor>`
    : `<wp:inline distT="0" distB="0" distL="0" distR="0">${extent}<wp:effectExtent l="0" t="0" r="0" b="0"/>${docPr}<wp:cNvGraphicFramePr/>${shape}</wp:inline>`;
  return `<w:drawing xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:a="${NS.a}" xmlns:wp="${NS.wp}" xmlns:wps="${NS.wps}">${frame}</w:drawing>`;
}

const unsupported = what => () => { throw new Error(`An authored shape cannot use ${what}.`); };

/** Read a shape's drawing into the editor's image and drawing asset, through the imported-drawing reader. */
export function buildShape(params) {
  const shell = shapeDrawingXml(params);
  const doc = new DOMParser().parseFromString(shell, 'application/xml');
  const wsp = doc.getElementsByTagNameNS(NS.wps, 'wsp')[0];
  if (!wsp || doc.getElementsByTagName('parsererror').length) throw new Error('The shape could not be created.');
  const scene = readShapeScene(wsp, unsupported('pictures'), unsupported('text'), unsupported('picture fills'), unsupported('theme colors'), unsupported('theme fonts'), unsupported('theme styles'), { frame: { width: params.width, height: params.height } });
  const asset = { scene, width: params.width / 9525, height: params.height / 9525 };
  const image = validateImage({ kind: 'drawing', retainedDrawing: true, assetId: params.assetId, width: params.width, height: params.height,
    ...(LINE_PRESETS.has(params.preset) ? { flatLine: { rotation: 0, flipH: false, flipV: false, strokeWidth: scene.outline?.width || 0, ...(scene.outline?.tailEnd ? { markerPen: scene.outline.declaredWidth ?? scene.outline.width, tailEnd: scene.outline.tailEnd } : {}) } } : {}),
    effectExtent: { left: 0, top: 0, right: 0, bottom: 0 }, ...(params.anchor ? { anchor: params.anchor } : {}), id: params.id, name: params.name, alt: '', shell });
  return { image, asset };
}

/**
 * The parameters of a simple preset shape, whether inserted here or imported: one `wps:wsp` with a
 * supported preset, a solid or no fill and a solid or no outline, no text and no effects. Null otherwise.
 */
export function shapeParams(image) {
  if (!image?.retainedDrawing || !image.shell) return null;
  const doc = new DOMParser().parseFromString(image.shell, 'application/xml');
  const shapes = doc.getElementsByTagNameNS(NS.wps, 'wsp');
  if (shapes.length !== 1 || doc.getElementsByTagNameNS(NS.a, 'graphicData').length !== 1) return null;
  const props = [...shapes[0].children].find(n => n.localName === 'spPr');
  if (!props || [...shapes[0].children].some(n => !['cNvPr', 'cNvSpPr', 'spPr', 'bodyPr', 'txbx'].includes(n.localName))) return null;
  // A text box's paragraphs and body properties travel with the shape unchanged.
  const box = [...shapes[0].children].find(n => n.localName === 'txbx'), content = box && [...box.children].find(n => n.localName === 'txbxContent');
  if (box && (!content || box.children.length !== 1)) return null;
  const serializer = new XMLSerializer(), bodyNode = [...shapes[0].children].find(n => n.localName === 'bodyPr');
  const text = content ? [...content.childNodes].map(n => serializer.serializeToString(n)).join('') : undefined;
  if ([...props.children].some(n => !['xfrm', 'prstGeom', 'solidFill', 'noFill', 'ln'].includes(n.localName))) return null;
  const geometry = [...props.children].find(n => n.localName === 'prstGeom'), xfrm = [...props.children].find(n => n.localName === 'xfrm');
  if (!geometry || [...(geometry.firstElementChild?.children || [])].length || xfrm?.getAttribute('rot') || xfrm?.getAttribute('flipH') === '1' || xfrm?.getAttribute('flipV') === '1') return null;
  const color = node => { const srgb = node && [...node.children].find(n => n.localName === 'srgbClr'); return srgb && !srgb.children.length ? srgb.getAttribute('val') : undefined; };
  const fillNode = [...props.children].find(n => ['solidFill', 'noFill'].includes(n.localName));
  const fill = !fillNode || fillNode.localName === 'noFill' ? null : color(fillNode);
  const ln = [...props.children].find(n => n.localName === 'ln');
  const lnFill = ln && [...ln.children].find(n => ['solidFill', 'noFill'].includes(n.localName));
  const tail = ln && [...ln.children].find(n => n.localName === 'tailEnd');
  if (ln && [...ln.children].some(n => !['solidFill', 'noFill', 'tailEnd'].includes(n.localName))) return null;
  const line = !lnFill || lnFill.localName === 'noFill' ? null : color(lnFill);
  if (fill === undefined || line === undefined) return null;
  let preset = geometry.getAttribute('prst');
  if (preset === 'line' && tail?.getAttribute('type') === 'triangle') preset = 'straightArrow';
  else if (tail) return null;
  if (!SHAPE_PRESETS.some(([p]) => p === preset)) return null;
  return { preset, fill, line, lineWidth: Number(ln?.getAttribute('w') || 12700), ...(text !== undefined ? { text, bodyXml: bodyNode ? serializer.serializeToString(bodyNode) : undefined } : {}) };
}

/** Parts that give a shape's text the document's styles and theme: its styles part and theme, when present. */
function textParts(sourceParts = {}) {
  const decode = bytes => typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  const rels = sourceParts['word/_rels/document.xml.rels'] ? decode(sourceParts['word/_rels/document.xml.rels']) : '';
  const target = type => rels.match(new RegExp(`<Relationship[^>]*Type="[^"]*/${type}"[^>]*Target="([^"]+)"`))?.[1] || rels.match(new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Type="[^"]*/${type}"`))?.[1];
  const part = name => name && sourceParts[`word/${name.replace(/^\.\//, '')}`];
  return { styles: part(target('styles')), theme: part(target('theme')), themeName: target('theme') };
}

/**
 * Build a shape that has text: its drawing is placed in a minimal package with the document's styles
 * and theme and read like any opened document, so its paragraphs resolve as they do in any opened file.
 */
export async function buildTextShape(params, sourceParts) {
  const { DocxPackage, createDocx } = await import('./docx.js');
  const shell = shapeDrawingXml(params);
  const base = createDocx().parts, parts = { ...base }, { styles, theme, themeName } = textParts(sourceParts);
  if (styles) parts['word/styles.xml'] = styles;
  if (theme && themeName && !themeName.includes('..')) {
    parts[`word/${themeName}`] = theme;
    parts['word/_rels/document.xml.rels'] = strToU8(new TextDecoder().decode(parts['word/_rels/document.xml.rels']).replace('</Relationships>', `<Relationship Id="rTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="${themeName}"/></Relationships>`));
    parts['[Content_Types].xml'] = strToU8(new TextDecoder().decode(parts['[Content_Types].xml']).replace('</Types>', `<Override PartName="/word/${themeName}" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`));
  }
  const drawing = shell.replace(/^<w:drawing [^>]*>/, '<w:drawing>');
  parts['word/document.xml'] = strToU8(`<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:a="${NS.a}" xmlns:wp="${NS.wp}" xmlns:wps="${NS.wps}"><w:body><w:p><w:r>${drawing}</w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  const opened = await DocxPackage.open(zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]))));
  const image = opened.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image))[0];
  if (!image || opened.readOnly) throw new Error('The text box could not be created.');
  const asset = opened.assets[image.assetId];
  const readers = { readDrawingTextParagraph: opened.readDrawingTextParagraph, readDrawingTextBlocks: opened.readDrawingTextBlocks, readDrawingTextBox: opened.readDrawingTextBox };
  return { image: validateImage({ ...image, assetId: params.assetId, id: params.id, name: params.name, alt: '', shell }), asset, readers };
}
