import { checkedCellBorder } from './cell-borders.js';
import { UnsupportedDocumentError } from './errors.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const ORDER = ['top', 'start', 'left', 'bottom', 'end', 'right', 'insideH', 'insideV', 'tl2br', 'tr2bl'];
const children = n => [...(n?.children || [])];
const fail = reason => { throw new UnsupportedDocumentError('table borders with ' + reason); };
const flag = (node, name) => {
  const value = node.getAttributeNS(W, name);
  if (value === null) return false;
  if (!['0', '1', 'true', 'false', 'on', 'off'].includes(value)) fail(`invalid ${name}`);
  return ['1', 'true', 'on'].includes(value);
};
export function readTableBorders(parent, readColor, cell = false) {
  const result = {};
  if (!parent) return result;
  if ([...parent.attributes].some(a => a.namespaceURI === W) || [...parent.childNodes].some(n => [3, 4].includes(n.nodeType) && n.textContent.trim())) fail('malformed containers');
  for (const node of children(parent)) {
    const side = node.localName, style = node.getAttributeNS(W, 'val');
    if (node.namespaceURI !== W || !ORDER.slice(0, cell ? 10 : 8).includes(side) || Object.hasOwn(result, side)) fail('unknown or duplicate sides');
    if ([...node.childNodes].some(n => n.nodeType === 1 || [3, 4].includes(n.nodeType) && n.textContent.trim())) fail('nested content');
    const integer = (name, fallback) => {
      const raw = node.getAttributeNS(W, name); if (raw === null) return fallback;
      if (!/^\+?\d+$/.test(raw.trim()) || !Number.isFinite(Number(raw))) fail(`invalid ${name}`);
      return Number(raw);
    };
    const size = integer('sz', 0), space = integer('space', 0), color = readColor(parent, side, 'border');
    const theme = Object.fromEntries(['themeColor', 'themeTint', 'themeShade'].filter(key => node.hasAttributeNS(W, key)).map(key => [key, node.getAttributeNS(W, key)]));
    try {
      result[side] = checkedCellBorder({ style, size: style === 'nil' || !size ? 0 : Math.max(2, Math.min(96, size)), space, color, frame: flag(node, 'frame'), shadow: flag(node, 'shadow'), ...(Object.keys(theme).length ? { theme } : {}) });
    } catch (error) { fail(error.message); }
  }
  // This editor supports LTR tables. Logical edges supersede legacy physical
  // edges within a declaration; both source elements survive unrelated edits.
  if (result.start) result.left = result.start;
  if (result.end) result.right = result.end;
  delete result.start; delete result.end;
  return result;
}

export function writeCellBorders(parent, patch, make) {
  for (const [side, value] of Object.entries(patch)) {
    const aliases = [side, ...(side === 'left' ? ['start'] : side === 'right' ? ['end'] : [])];
    for (const node of children(parent)) if (node.namespaceURI === W && aliases.includes(node.localName)) node.remove();
    if (value === null) continue;
    const border = checkedCellBorder(value), node = make(side);
    for (const [key, value] of Object.entries({ val: border.style, sz: border.size, color: border.color })) node.setAttributeNS(W, 'w:' + key, String(value));
    parent.insertBefore(node, children(parent).find(n => ORDER.indexOf(n.localName) > ORDER.indexOf(side)) || null);
  }
}
