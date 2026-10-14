import { UnsupportedDocumentError } from './errors.js';
import { INK_EXTENSION_URI, readInkExtension } from './docx-ink-extension.js';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const DECORATIVE = 'http://schemas.microsoft.com/office/drawing/2017/decorative';
const URI = '{C183D7F6-B498-43B3-948B-1728B52AA6E4}';
const CREATION = 'http://schemas.microsoft.com/office/drawing/2014/main';
const CREATION_URI = '{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}';
const children = node => [...(node?.children || [])];
const fail = why => { throw new UnsupportedDocumentError(`drawing metadata with ${why}`); };
function content(node, attrs = [], kind = 'decorative') {
  if ([...(node?.childNodes || [])].some(n => [3, 4].includes(n.nodeType) && /[^ \t\r\n]/.test(n.textContent))) fail('unexpected metadata text');
  if (node && [...node.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (a.namespaceURI || !attrs.includes(a.localName)))) fail(`invalid ${kind} properties`);
}

// Shared by nonvisual drawing properties and the image-data extension list.
export function readDrawingCreationId(extension) {
  if (extension.getAttribute('uri')?.toUpperCase() !== CREATION_URI) return false;
  if (extension.namespaceURI !== A || extension.localName !== 'ext') fail('invalid creation ID extensions');
  content(extension, ['uri'], 'creation ID');
  const contents = children(extension), flag = contents[0];
  if (contents.length !== 1 || flag.namespaceURI !== CREATION || flag.localName !== 'creationId') fail('invalid creation ID extensions');
  content(flag, ['id'], 'creation ID');
  // MS-ODRAWXML §§2.25.1.2, 2.25.3.2: optional ST_Guid identity,
  // with no rendering effect. Keep the original spelling in the shell.
  const id = flag.getAttribute('id');
  const token = id?.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (children(flag).length || id !== null && !/^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/.test(token)) fail('invalid creation ID properties');
  return true;
}

// Nonvisual metadata does not affect geometry. Preserve it in the drawing shell,
// including its namespace bindings, rather than stripping it to open a picture.
export function readDrawingMetadata(properties, readHyperlink) {
  let decorative;
  const seen = new Set();
  const nodes = children(properties), lists = nodes.filter(n => n.localName === 'extLst');
  if (nodes.some(n => n.namespaceURI !== A || !['extLst', 'hlinkClick'].includes(n.localName)) || lists.length > 1) fail('unsupported nonvisual properties');
  const links = nodes.filter(n => n.localName === 'hlinkClick');
  if (links.length > 1 || links.length && !readHyperlink) fail('unsupported nonvisual hyperlinks');
  if (links.length && lists.length && nodes.indexOf(links[0]) > nodes.indexOf(lists[0])) fail('misordered nonvisual properties');
  const hyperlink = links.length ? readHyperlink(links[0]) : undefined;
  content(lists[0]);
  for (const extension of children(lists[0])) {
    content(extension, ['uri']);
    const uri = extension.getAttribute('uri')?.toUpperCase();
    if (extension.namespaceURI !== A || extension.localName !== 'ext' || ![URI, CREATION_URI, INK_EXTENSION_URI].includes(uri)) fail('unsupported nonvisual extensions');
    if (seen.has(uri)) fail('duplicate nonvisual extensions');
    seen.add(uri);
    const contents = children(extension), flag = contents[0];
    if (uri === CREATION_URI) {
      readDrawingCreationId(extension);
      continue;
    }
    // The editor's own ink data (docx-ink.js): no rendering effect; the shape's path carries the ink.
    if (uri === INK_EXTENSION_URI) { readInkExtension(extension); continue; }
    if (contents.length !== 1 || flag.namespaceURI !== DECORATIVE || flag.localName !== 'decorative') fail('invalid decorative extensions');
    content(flag, ['val']);
    if (children(flag).length) fail('invalid decorative properties');
    const value = flag.getAttribute('val')?.trim() ?? null;
    if (value !== null && !['0', '1', 'false', 'true'].includes(value)) fail('invalid decorative flags');
    // The extension permits an absent value without defining a default.
    // Retain that spelling without inventing a true/false value in the model.
    if (value !== null) decorative = ['1', 'true'].includes(value);
  }
  return { ...(decorative === undefined ? {} : { decorative }), ...(hyperlink ? { hyperlink } : {}) };
}
