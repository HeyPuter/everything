import { UnsupportedDocumentError } from './errors.js';
import { checkedCellMargins } from './cell-margins.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const ORDER = ['top', 'start', 'left', 'bottom', 'end', 'right'];
const children = node => [...(node?.children || [])];
const fail = reason => { throw new UnsupportedDocumentError('cell margins with ' + reason); };

export function readCellMargins(parent, table = false) {
  const result = {};
  if (!parent) return result;
  if ([...parent.attributes].some(a => a.namespaceURI === W) || [...parent.childNodes].some(n => [3, 4].includes(n.nodeType) && n.textContent.trim())) fail('malformed containers');
  for (const node of children(parent)) {
    const side = node.localName;
    if (node.namespaceURI !== W || !ORDER.includes(side) || Object.hasOwn(result, side)) fail('unknown or duplicate sides');
    if ([...node.attributes].some(a => a.namespaceURI === W && !['type', 'w'].includes(a.localName)) || [...node.childNodes].some(n => n.nodeType === 1 || [3, 4].includes(n.nodeType) && n.textContent.trim())) fail('malformed declarations');
    let type = node.getAttributeNS(W, 'type') ?? 'dxa';
    if (!['dxa', 'nil', 'auto', 'pct'].includes(type)) fail('unknown units');
    const raw = (node.getAttributeNS(W, 'w') ?? '0').trim(), units = /^(\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)$/.exec(raw), percent = /^(\d+(?:\.\d+)?)%$/.exec(raw);
    let value;
    if (units) { type = 'dxa'; value = Math.round(Number(units[1]) * { mm: 1440 / 25.4, cm: 1440 / 2.54, in: 1440, pt: 20, pc: 240, pi: 240 }[units[2]]); }
    else if (percent) { type = 'pct'; value = Number(percent[1]); }
    // A decimal without units ("100.0", written by some producers) is read as the nearest whole value.
    else { if (!/^\+?\d+(?:\.\d+)?$/.test(raw)) fail('invalid measurements'); value = Math.round(Number(raw)); }
    if (!Number.isFinite(value)) fail('invalid measurements');
    // Nil/pct/auto cell exceptions reset to table defaults. The
    // table-level leading/trailing defaults instead treat pct/auto as zero.
    if (type === 'nil') value = null;
    else if (type === 'auto' || type === 'pct') value = table && ['start', 'left', 'end', 'right'].includes(side) ? 0 : null;
    else if (!Number.isInteger(value) || value > 31680) fail('measurements beyond 22 inches');
    result[side] = value;
  }
  if (Object.hasOwn(result, 'start')) result.left = result.start;
  if (Object.hasOwn(result, 'end')) result.right = result.end;
  delete result.start; delete result.end;
  return result;
}

export function writeCellMargins(parent, patch, make) {
  for (const [side, value] of Object.entries(checkedCellMargins(patch))) {
    const aliases = [side, ...(side === 'left' ? ['start'] : side === 'right' ? ['end'] : [])];
    for (const node of children(parent)) if (node.namespaceURI === W && aliases.includes(node.localName)) node.remove();
    if (value === null) continue;
    const node = make(side); node.setAttributeNS(W, 'w:w', String(value)); node.setAttributeNS(W, 'w:type', 'dxa');
    parent.insertBefore(node, children(parent).find(n => ORDER.indexOf(n.localName) > ORDER.indexOf(side)) || null);
  }
}
