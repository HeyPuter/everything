import { UnsupportedDocumentError } from './errors.js';

/**
 * The editor's ink extension (see docx-ink.js): one element in this app's namespace inside a shape's
 * non-visual extension list, recording a stroke's tool, colour, width and centre line, or marking a
 * drawing canvas's frame. Kept apart from the writer so the drawing reader can validate it cheaply.
 */
export const INK_EXTENSION_URI = '{3582A2A6-0F3C-4AC8-9E1A-D2DA59872D4E}';
export const INK_NS = 'http://schemas.puter.com/documents/2026/ink';
const EMU_PER_PX = 9525;
const TOOLS = ['pen', 'pencil', 'highlighter'];
const fail = why => { throw new UnsupportedDocumentError(`ink extensions with ${why}`); };

// Strokes stay on a page (22 inches is 2,112 px) and within what a hand draws: a far point or a flood of
// them made erasing and redrawing a stroke allocate without bound and crash the tab.
const MAX_POINTS = 50000, MAX_COORDINATE = 10000;
function decodePoints(text) {
  const values = String(text || '').trim().split(/\s+/).filter(Boolean).map(Number);
  if (!values.length || values.length % 3 || values.length > MAX_POINTS * 3 || values.some(v => !Number.isFinite(v))) fail('invalid ink points');
  for (let i = 0; i < values.length; i += 3) if (Math.abs(values[i]) > MAX_COORDINATE * EMU_PER_PX || Math.abs(values[i + 1]) > MAX_COORDINATE * EMU_PER_PX) fail('ink points off the page');
  const points = [];
  for (let i = 0; i < values.length; i += 3) points.push({ x: values[i] / EMU_PER_PX, y: values[i + 1] / EMU_PER_PX, p: values[i + 2] / 100 });
  return points;
}

/** Validate the ink extension inside a non-visual properties extension list (see docx-drawing-metadata.js). */
export function readInkExtension(extension) {
  const children = [...extension.children];
  if (children.length !== 1 || children[0].namespaceURI !== INK_NS || !['stroke', 'canvas'].includes(children[0].localName)) fail('unknown content');
  const node = children[0];
  if ([...node.childNodes].some(n => n.nodeType === 1 || [3, 4].includes(n.nodeType) && /\S/.test(n.textContent))) fail('unexpected content');
  const allowed = node.localName === 'stroke' ? ['tool', 'color', 'width', 'points'] : [];
  for (const attr of node.attributes) if (attr.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (attr.namespaceURI || !allowed.includes(attr.localName))) fail('unknown attributes');
  if (node.localName === 'canvas') return { canvas: true };
  const tool = node.getAttribute('tool'), width = Number(node.getAttribute('width'));
  if (!TOOLS.includes(tool) || !/^[0-9A-F]{6}$/i.test(node.getAttribute('color') || '') || !(width > 0 && width <= 200)) fail('invalid stroke properties');
  return { stroke: { tool, color: node.getAttribute('color').toUpperCase(), width, points: decodePoints(node.getAttribute('points')) } };
}

