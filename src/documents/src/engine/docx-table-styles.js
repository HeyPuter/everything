// DOCX serialization for table styles: a table's style reference and look
// (w:tblStyle, w:tblLook in w:tblPr, §17.4.62/§17.4.55) and the styles.xml
// declaration of a style described by a spec (table-styles.js, §17.7.6).
// Only changed declarations are written; everything else in the part stays.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const LOOK_BITS = { firstRow: 0x20, lastRow: 0x40, firstColumn: 0x80, lastColumn: 0x100, noHBand: 0x200, noVBand: 0x400 };

/** tblLook attributes: the explicit flags and the legacy mask, so either kind of reader agrees. */
export function lookAttributes(look) {
  const mask = Object.entries(LOOK_BITS).reduce((n, [key, bit]) => n | (look[key] ? bit : 0), 0);
  return { val: mask.toString(16).toUpperCase().padStart(4, '0'), ...Object.fromEntries(Object.keys(LOOK_BITS).map(key => [key, look[key] ? '1' : '0'])) };
}

/** A table's style reference, look and cleared direct borders, through the table writer's property setter. */
export function writeTableStyleProperties(table, setTableProperty, prop) {
  if (table.styleChanged) setTableProperty('tblStyle', table.styleId ? prop('tblStyle', { val: table.styleId }) : null);
  if (table.bordersCleared) setTableProperty('tblBorders', null);
  if (table.lookChanged && table.look) setTableProperty('tblLook', prop('tblLook', lookAttributes(table.look)));
}

const SIDES = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];
function bordersNode(make, name, borders) {
  const node = make(name);
  for (const side of SIDES) if (borders?.[side] !== undefined) {
    const value = borders[side], b = make(side);
    if (value === 'nil' || !value) b.setAttributeNS(W, 'w:val', 'nil');
    else for (const [key, v] of Object.entries({ val: value.style || 'single', sz: value.size ?? 4, space: 0, color: value.color || 'auto' })) b.setAttributeNS(W, `w:${key}`, String(v));
    node.append(b);
  }
  return node.childNodes.length ? node : null;
}
function runNode(make, region) {
  if (!region?.bold && !region?.italic && !region?.color) return null;
  const node = make('rPr');
  if (region.bold) node.append(make('b'), make('bCs'));
  if (region.italic) node.append(make('i'), make('iCs'));
  if (region.color) { const color = make('color'); color.setAttributeNS(W, 'w:val', region.color); node.append(color); }
  return node;
}
function shadingNode(make, fill) {
  const node = make('shd');
  for (const [key, v] of Object.entries({ val: 'clear', color: 'auto', fill })) node.setAttributeNS(W, `w:${key}`, v);
  return node;
}

/** Replace a style element's formatting with the spec's. Its name, aliases and other metadata stay. */
export function writeTableStyleDefinition(node, spec, make) {
  for (const old of [...node.children]) if (old.namespaceURI === W && ['pPr', 'rPr', 'tblPr', 'trPr', 'tcPr', 'tblStylePr'].includes(old.localName)) old.remove();
  const set = (parent, name, attrs) => { const n = make(name); for (const [k, v] of Object.entries(attrs)) n.setAttributeNS(W, `w:${k}`, String(v)); parent.append(n); return n; };
  const pPr = make('pPr'); set(pPr, 'spacing', { after: 0, line: 240, lineRule: 'auto' }); node.append(pPr);
  const run = runNode(make, spec.whole); if (run) node.append(run);
  const tblPr = make('tblPr');
  set(tblPr, 'tblStyleRowBandSize', { val: spec.rowBands ?? 1 });
  set(tblPr, 'tblStyleColBandSize', { val: spec.columnBands ?? 1 });
  const borders = bordersNode(make, 'tblBorders', spec.borders); if (borders) tblPr.append(borders);
  const margins = make('tblCellMar');
  for (const [side, w] of [['top', 0], ['left', 108], ['bottom', 0], ['right', 108]]) set(margins, side, { w, type: 'dxa' });
  tblPr.append(margins); node.append(tblPr);
  if (spec.whole?.fill) { const tcPr = make('tcPr'); tcPr.append(shadingNode(make, spec.whole.fill)); node.append(tcPr); }
  for (const [type, region] of Object.entries(spec.regions || {})) {
    const group = make('tblStylePr'); group.setAttributeNS(W, 'w:type', type);
    const regionRun = runNode(make, region); if (regionRun) group.append(regionRun);
    const tcPr = make('tcPr'), cellBorders = bordersNode(make, 'tcBorders', region.borders);
    if (cellBorders) tcPr.append(cellBorders);
    if (region.fill) tcPr.append(shadingNode(make, region.fill));
    if (tcPr.childNodes.length) group.append(tcPr);
    // An empty region still declares itself, so its rows and columns leave the bands.
    node.append(group);
  }
}
