import { BORDER_SIDES, checkedParagraphBorder, checkedParagraphBorders } from './paragraph-borders.js';
import { UnsupportedDocumentError } from './errors.js';
import { elementChildren } from './docx-xml.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const children = node => node?.children ? elementChildren(node) : [];
const fail = reason => { throw new UnsupportedDocumentError('paragraph borders with ' + reason); };
const number = (node, name, maximum, minimum = 0) => {
  const raw = node.getAttributeNS(W, name);
  if (raw === null) return 0;
  if (!/^\+?\d+$/.test(raw.trim())) fail(`invalid ${name}`);
  // CT_Border permits consumers to normalize out-of-range line widths.
  const value = Number(raw);
  if (!Number.isFinite(value) || name !== 'sz' && value > maximum) fail(`unsupported ${name}`);
  return Math.max(minimum, Math.min(maximum, value));
};
const flag = (node, name) => {
  const value = node.getAttributeNS(W, name);
  if (value === null) return false;
  if (!['0', '1', 'false', 'true', 'off', 'on'].includes(value)) fail(`invalid ${name}`);
  return ['1', 'true', 'on'].includes(value);
};

export function readParagraphBorders(pPr, readColor) {
  const nodes = children(pPr).filter(n => n.namespaceURI === W && n.localName === 'pBdr');
  if (!nodes.length) return undefined;
  if (nodes.length !== 1) fail('duplicate declarations');
  const parent = nodes[0], borders = {};
  if ([...parent.attributes].some(a => a.namespaceURI === W)) fail('unknown container attributes');
  if ([...parent.childNodes].some(n => [3, 4].includes(n.nodeType) && n.textContent.trim())) fail('text content');
  for (const node of children(parent)) {
    const side = node.localName;
    if (node.namespaceURI !== W || !BORDER_SIDES.includes(side) || Object.hasOwn(borders, side)) fail('unknown or duplicate sides');
    if ([...node.childNodes].some(n => n.nodeType === 1 || [3, 4].includes(n.nodeType) && n.textContent.trim())) fail('nested content');
    const size = number(node, 'sz', 96);
    const color = readColor(parent, side, 'border');
    const theme = Object.fromEntries(['themeColor', 'themeTint', 'themeShade'].filter(key => node.hasAttributeNS(W, key)).map(key => [key, node.getAttributeNS(W, key)]));
    try {
      borders[side] = checkedParagraphBorder({ style: node.getAttributeNS(W, 'val'), size: size ? Math.max(2, size) : 0, space: number(node, 'space', 31), color, frame: flag(node, 'frame'), shadow: flag(node, 'shadow'), ...(Object.keys(theme).length ? { theme } : {}) });
    } catch (e) { fail(e.message); }
  }
  return borders;
}

/** Write only edited sides; leave other border declarations and their themes intact. */
export function writeParagraphBorders(parent, patch, make) {
  for (const [side, value] of Object.entries(checkedParagraphBorders(patch, true))) {
    let node = children(parent).find(n => n.namespaceURI === W && n.localName === side);
    if (value === null) { node?.remove(); continue; }
    if (!node) {
      node = make(side);
      parent.insertBefore(node, children(parent).find(n => BORDER_SIDES.indexOf(n.localName) > BORDER_SIDES.indexOf(side)) || null);
    }
    for (const attr of [...node.attributes]) if (attr.namespaceURI === W) node.removeAttributeNode(attr);
    for (const [attr, next] of Object.entries({ val: value.style, sz: value.size, space: value.space, color: value.color, frame: value.frame ? '1' : '0', shadow: value.shadow ? '1' : '0' })) node.setAttributeNS(W, 'w:' + attr, String(next));
  }
}
