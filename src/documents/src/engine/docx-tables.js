import { parseXml } from './docx-xml.js';
import { appendControlledBlocks, writeControlPlaceholder } from './docx-block-controls.js';
import { tableBookmarkResolver } from './bookmarks.js';
import { writeBookmark } from './docx-bookmarks.js';
import { serializeFragment } from './docx-compatibility.js';
import { checkedCellAlignment } from './cell-alignment.js';
import { readCellShading } from './docx-cell-shading.js';
import { writeParagraphShading as writeCellShading } from './docx-paragraph-shading.js';
import { cellShadingFill } from './backgrounds.js';
import { readTableBorders, writeCellBorders } from './docx-table-borders.js';
import { resolveCellBorders } from './cell-borders.js';
import { readCellMargins, writeCellMargins } from './docx-cell-margins.js';
import { resolveCellMargins } from './cell-margins.js';
import { readRowHeight } from './docx-row-height.js';
import { rowHeight } from './row-height.js';
import { UnsupportedDocumentError } from './errors.js';
import { readFloatingTable } from './floating-tables.js';
import { tableId, cellSpan, verticalMerges } from './tables.js';
import { tableStyleLook } from './table-style-regions.js';
import { refreshConditionalTable } from './conditional-table-formatting.js';
import { writeTableStyleProperties } from './docx-table-styles.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const children = n => [...(n?.children || [])];
const child = (n, name) => children(n).find(c => c.namespaceURI === W && c.localName === name);
const attr = (n, name) => n?.getAttributeNS(W, name);
const normalTableStyle = style => !['1', 'true', 'on'].includes(attr(style, 'customStyle')) && attr(child(style, 'name'), 'val')?.toLowerCase() === 'normal table';
const xml = n => new XMLSerializer().serializeToString(n);
const fail = reason => { throw new UnsupportedDocumentError(`tables with ${reason}`); };
function check(node, allowed) {
  const seen = new Set();
  for (const n of children(node)) {
    if (n.namespaceURI !== W || !allowed.includes(n.localName)) fail(n.localName);
    if (seen.has(n.localName)) fail(`duplicate ${n.localName} properties`);
    seen.add(n.localName);
  }
}
function integer(raw, fallback = 0) {
  if (raw == null) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 31680) fail('invalid measurements');
  return Number(raw);
}
function flag(n) {
  if (!n) return false;
  const v = attr(n, 'val');
  if (children(n).length || n.textContent.trim() || [...n.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && !(a.namespaceURI === W && a.localName === 'val'))) fail('invalid on/off properties');
  if (v != null && !['0', '1', 'true', 'false', 'on', 'off'].includes(v)) fail('invalid on/off properties');
  return !['0', 'false', 'off'].includes(v);
}
function width(n, signed = false) {
  if (!n) return null;
  let type = attr(n, 'type') || 'dxa', value;
  if (!['dxa', 'pct', 'auto', 'nil'].includes(type)) fail('unsupported width units');
  const raw = attr(n, 'w') || '0', percent = /^([+-]?\d+(?:\.\d+)?)%$/.exec(raw), units = /^([+-]?\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)$/.exec(raw);
  // An explicit unit takes precedence over a contradictory type (§17.4.87).
  if (percent) { type = 'pct'; value = Number(percent[1]) * 50; }
  else if (units) { type = 'dxa'; value = Math.round(Number(units[1]) * { mm: 1440 / 25.4, cm: 1440 / 2.54, in: 1440, pt: 20, pc: 240, pi: 240 }[units[2]]); }
  else { if (!/^[+-]?\d+$/.test(raw)) fail('invalid measurements'); value = Number(raw); }
  if (!Number.isFinite(value) || !signed && value < 0 || Math.abs(value) > 31680) fail('invalid measurements');
  return { type, value };
}
function checkedProperties(node, allowed) {
  check(node, allowed);
  return node;
}
// Property readers are pure projections. In display-only import, retry failed
// groups one property at a time and omit only properties that cannot be read.
// Never mutate source XML or guess a repair for a cross-property constraint.
function previewProperties(read, node, args, report) {
  try { return read(node, ...args); }
  catch (error) {
    if (!report || !node || !(error instanceof UnsupportedDocumentError)) throw error;
    const retained = node.cloneNode(false);
    let omitted = false;
    for (const property of children(node)) {
      const isolated = node.cloneNode(false);
      isolated.append(property.cloneNode(true));
      try { read(isolated, ...args); }
      catch (propertyError) {
        if (!(propertyError instanceof UnsupportedDocumentError)) throw propertyError;
        report(propertyError); omitted = true; continue;
      }
      retained.append(property.cloneNode(true));
    }
    if (!omitted) throw error;
    return read(retained, ...args);
  }
}
function checkCellSpacing(node) {
  if (!node) return;
  if (children(node).length || node.textContent.trim() || [...node.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && !(a.namespaceURI === W && ['w', 'type'].includes(a.localName)))) fail('malformed cell spacing');
  let type = attr(node, 'type') ?? 'dxa';
  if (!['dxa', 'pct', 'auto', 'nil'].includes(type)) fail('unsupported width units');
  const raw = attr(node, 'w') ?? '0';
  const integerText = raw.trim(); // XML Schema integer whitespace is collapsed.
  const measure = /^([+-]?\d+(?:\.\d+)?)(%|mm|cm|in|pt|pc|pi)$/.exec(raw);
  if (measure) type = measure[2] === '%' ? 'pct' : 'dxa';
  else if (!/^[+-]?\d+$/.test(integerText)) fail('invalid measurements');
  // §§17.4.43–45 ignore pct/auto spacing; nil denotes zero (§17.4.87).
  // Preserve these declarations in the XML shell. Nonzero physical spacing
  // needs a separate layout/border model and must not silently disappear.
  // Ignored values need lexical validation, not the physical layout range
  // limit. Testing zero as text also avoids rounding tiny nonzero gaps away.
  if (type === 'dxa' && !/^[+-]?0+(?:\.0+)?$/.test(measure ? measure[1] : integerText)) fail('cell spacing');
}
function tableProperties(n, base, readColor) {
  check(n, ['tblStyle', 'tblpPr', 'tblOverlap', 'tblW', 'jc', 'tblInd', 'tblBorders', 'tblLayout', 'tblCellMar', 'tblCellSpacing', 'tblLook', 'tblCaption', 'tblDescription', 'shd', 'tblStyleRowBandSize', 'tblStyleColBandSize']);
  const next = { ...base };
  const overlap = child(n, 'tblOverlap');
  if (overlap) {
    if (!['never', 'overlap'].includes(attr(overlap, 'val')) || children(overlap).length || overlap.textContent.trim() || [...overlap.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && !(a.namespaceURI === W && a.localName === 'val'))) fail('invalid table overlap');
    next.overlap = attr(overlap, 'val');
  }
  if (child(n, 'tblpPr')) { try { next.floating = readFloatingTable(child(n, 'tblpPr')); } catch (e) { fail(e.message); } }
  if (child(n, 'tblLayout')) next.layout = attr(child(n, 'tblLayout'), 'type');
  if (child(n, 'tblW')) next.width = width(child(n, 'tblW'));
  if (child(n, 'jc')) next.alignment = attr(child(n, 'jc'), 'val');
  if (child(n, 'tblInd')) {
    const w = width(child(n, 'tblInd'), true);
    if (['dxa', 'nil'].includes(w.type)) next.indentDeclared = true;
    next.indent = ['dxa', 'nil'].includes(w.type) ? w.type === 'nil' ? 0 : w.value : 0;
  }
  checkCellSpacing(child(n, 'tblCellSpacing'));
  if (child(n, 'tblCaption')) next.caption = attr(child(n, 'tblCaption'), 'val') ?? '';
  if (child(n, 'tblDescription')) next.description = attr(child(n, 'tblDescription'), 'val') ?? '';
  next.margins = resolveCellMargins(base.margins, readCellMargins(child(n, 'tblCellMar'), true));
  next.borders = { ...base.borders, ...readTableBorders(child(n, 'tblBorders'), readColor) };
  next.shading = readCellShading(n, readColor) ?? base.shading;
  next.fill = cellShadingFill(next.shading);
  return next;
}
function rowAlignment(node) {
  if (!node) return undefined;
  const value = attr(node, 'val');
  if (!['left', 'center', 'right', 'start', 'end'].includes(value) || children(node).length || node.textContent.trim() || [...node.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && !(a.namespaceURI === W && a.localName === 'val'))) fail('invalid row alignment');
  return { start: 'left', end: 'right' }[value] || value;
}
function rowProperties(n, base = {}) {
  check(n, ['cantSplit', 'trHeight', 'tblHeader', 'tblCellSpacing', 'cnfStyle', 'gridBefore', 'gridAfter', 'wBefore', 'wAfter', 'jc']);
  checkCellSpacing(child(n, 'tblCellSpacing'));
  const gaps = {};
  for (const side of ['Before', 'After']) {
    const grid = child(n, `grid${side}`);
    if (grid) {
      if (children(grid).length || grid.textContent.trim() || [...grid.attributes].some(a => a.namespaceURI === W && a.localName !== 'val') || attr(grid, 'val') === null) fail('invalid omitted grid columns');
      gaps[`grid${side}`] = integer(attr(grid, 'val'));
      if (gaps[`grid${side}`] > 31) fail('excessive omitted grid columns');
    }
    if (child(n, `w${side}`)) gaps[`width${side}`] = width(child(n, `w${side}`));
  }
  return { ...base, ...gaps, ...(child(n, 'jc') ? { alignment: rowAlignment(child(n, 'jc')) } : {}), ...(child(n, 'cantSplit') ? { cantSplit: flag(child(n, 'cantSplit')) } : {}), ...(child(n, 'tblHeader') ? { header: flag(child(n, 'tblHeader')) } : {}), ...readRowHeight(child(n, 'trHeight')) };
}
function cellProperties(n, base = {}, readColor, tableStyle = false, preview = false) {
  check(n, ['tcW', 'tcMar', 'vAlign', 'shd', 'gridSpan', 'vMerge', 'cnfStyle', 'tcBorders', 'hideMark', 'noWrap', 'textDirection']);
  const direction = child(n, 'textDirection');
  if (direction && (!['lrTb', 'btLr', 'tbRl'].includes(attr(direction, 'val')) || children(direction).length || direction.textContent.trim()
    || [...direction.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && !(a.namespaceURI === W && a.localName === 'val')))) fail('unsupported cell text direction');
  // [MS-OI29500] 17.7.6.8(b)/17.7.6.9(a): cell text direction is ignored
  // in both conditional and base table styles. Preserve those declarations
  // in styles.xml, but resolve rotation only from the cell's own properties.
  if (!tableStyle && direction) base = { ...base, textDirection: attr(direction, 'val'), textDirectionExplicit: true };
  const wrapping = child(n, 'noWrap');
  if (wrapping && ([...wrapping.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && !(a.namespaceURI === W && a.localName === 'val')) || children(wrapping).length || wrapping.textContent.trim())) fail('malformed noWrap');
  const hiddenMark = child(n, 'hideMark');
  if (hiddenMark && ([...hiddenMark.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && !(a.namespaceURI === W && a.localName === 'val')) || [...hiddenMark.childNodes].some(c => c.nodeType === 1 || [3, 4].includes(c.nodeType) && c.textContent.trim()))) fail('malformed hideMark');
  const merge = child(n, 'vMerge'), vMerge = merge ? attr(merge, 'val') ?? 'continue' : null;
  if (merge && !['restart', 'continue'].includes(vMerge)) fail('invalid vertical merge values');
  const spanNode = child(n, 'gridSpan'), span = spanNode ? integer(attr(spanNode, 'val'), 0) : 1;
  if (span < 1 || span > 32) fail('invalid grid spans');
  const alignment = child(n, 'vAlign'), inheritedVertical = base.vertical || 'top';
  let align = inheritedVertical;
  if (alignment) {
    if ([...alignment.attributes].some(a => a.namespaceURI === W && a.localName !== 'val') || [...alignment.childNodes].some(c => c.nodeType === 1 || [3, 4].includes(c.nodeType) && c.textContent.trim())) fail('malformed cell alignment');
    // §17.18.101: page-only vertical justification is ignored in cells,
    // returning to top rather than inheriting an ancestor's alignment.
    const value = attr(alignment, 'val');
    try { align = value === 'both' ? 'top' : checkedCellAlignment(value); } catch { fail('unsupported cell alignment'); }
  }
  const directShading = readCellShading(n, readColor), inheritedShading = base.shading, shading = directShading ?? inheritedShading;
  // [MS-OI29500] §17.7.6.9: table-wide style tcBorders are ignored even
  // though OOXML permits them. Retain the source style but use tblBorders
  // and direct cell declarations for its effective borders.
  const directBorders = tableStyle ? {} : readTableBorders(child(n, 'tcBorders'), readColor, true), inheritedBorders = base.borders || {};
  const directMargins = readCellMargins(child(n, 'tcMar')), inheritedMargins = base.margins || {};
  return { ...base, span, vMerge, hideMark: flag(hiddenMark), noWrap: wrapping ? flag(wrapping) : base.noWrap || false, noWrapExplicit: !!wrapping, width: width(child(n, 'tcW')) || base.width, margins: tableStyle ? { ...inheritedMargins, ...directMargins } : resolveCellMargins(inheritedMargins, directMargins, base.marginDefaults), inheritedMargins, directMargins, borders: resolveCellBorders(inheritedBorders, directBorders), inheritedBorders, directBorders, shading, inheritedShading, shadingExplicit: !!child(n, 'shd'), shadingNil: attr(child(n, 'shd'), 'val') === 'nil', fill: cellShadingFill(shading), vertical: align, inheritedVertical, verticalExplicit: !!alignment };
}
function shell(n, names) {
  const copy = n.cloneNode(false);
  for (const c of children(n)) if (names.includes(c.localName)) copy.append(c.cloneNode(true));
  return serializeFragment(copy);
}

function conditionalStyle(chain, pr, cellBase, rowBase, readColor, preview, properties) {
  const names = ['band1Horz', 'band2Horz', 'band1Vert', 'band2Vert', 'firstCol', 'lastCol', 'firstRow', 'lastRow', 'nwCell', 'neCell', 'swCell', 'seCell'];
  if (!chain.some(style => child(style, 'tblStylePr'))) return null;
  const parsed = chain.map(style => {
    const conditionals = {}, seen = new Set();
    for (const region of children(style).filter(n => n.localName === 'tblStylePr')) {
      const name = attr(region, 'type');
      if (name === 'wholeTable') continue; // This override type is ignored.
      if (region.namespaceURI !== W || !names.includes(name) || seen.has(name)) fail('unknown or duplicate conditional table regions');
      seen.add(name);
      const supported = properties(checkedProperties, region, ['pPr', 'rPr', 'tblPr', 'trPr', 'tcPr']);
      const group = {};
      const tc = properties(checkedProperties, child(supported, 'tcPr'), ['tcMar', 'tcBorders', 'shd', 'vAlign', 'noWrap', 'textDirection']);
      const tp = properties(checkedProperties, child(supported, 'tblPr'), ['tblCellMar', 'tblBorders', 'shd']);
      const rp = properties(checkedProperties, child(supported, 'trPr'), ['tblHeader']);
      if (rp) {
        group.row = properties(rowProperties, rp);
      }
      if (tc) {
        // Conditional borders remain active; only the direction is omitted
        // from the effective property group below (unlike table-wide tcPr).
        const p = properties(cellProperties, tc, {}, readColor, false, preview);
        group.cell = { margins: p.directMargins, borders: p.directBorders,
          ...(child(tc, 'shd') ? { shading: p.shading } : {}),
          ...(child(tc, 'noWrap') ? { noWrap: p.noWrap } : {}),
          ...(child(tc, 'vAlign') ? { vertical: p.vertical } : {}) };
      }
      if (tp) {
        const p = properties(tableProperties, tp, {}, readColor);
        group.table = { margins: p.margins, borders: p.borders,
          ...(child(tp, 'shd') ? { shading: p.shading } : {}) };
      }
      conditionals[name] = group;
    }
    return { conditionals };
  });
  const settings = { look: tableStyleLook(), rowBandSize: 0, columnBandSize: 0, definedRegions: [...new Set(parsed.flatMap(s => Object.keys(s.conditionals)))] };
  for (const properties of [...chain.map(s => child(s, 'tblPr')), pr]) {
    const look = child(properties, 'tblLook');
    if (look) {
      try { settings.look = tableStyleLook(Object.fromEntries([...look.attributes].filter(a => a.namespaceURI === W).map(a => [a.localName, a.value]))); }
      catch (e) { fail(e.message); }
    }
    for (const [tag, key] of [['tblStyleRowBandSize', 'rowBandSize'], ['tblStyleColBandSize', 'columnBandSize']]) if (child(properties, tag)) {
      settings[key] = integer(attr(child(properties, tag), 'val'));
      if (settings[key] > 3) fail('unsupported conditional band sizes');
    }
  }
  return { chain: parsed, cell: cellBase, row: rowBase, settings };
}

export function readTable(node, readParagraph, stylesRoot, readColor, readCellBlocks, readBookmark, relatedTables = [], restyleParagraph = p => p, readControl, compatibilityMode = 12, preview = false, readEffectsStyles = null, onUnsupported = null) {
  const properties = (read, node, ...args) => previewProperties(read, node, args, preview ? onUnsupported : null);
  const pr = child(node, 'tblPr'), grid = child(node, 'tblGrid');
  const markerNames = readBookmark ? ['bookmarkStart', 'bookmarkEnd'] : [];
  if (children(node).some(n => n.namespaceURI !== W || !['tblPr', 'tblGrid', 'tr', ...markerNames].includes(n.localName))) fail('nested or wrapped table content');
  if (children(node).filter(n => n.localName === 'tblPr').length > 1 || children(node).filter(n => n.localName === 'tblGrid').length !== 1) fail('missing or duplicate table grids');
  let definitions = children(stylesRoot).filter(n => n.localName === 'style' && attr(n, 'type') === 'table');
  const requested = attr(child(pr, 'tblStyle'), 'val');
  const defaultStyle = definitions => definitions.filter(n => ['1', 'true', 'on'].includes(attr(n, 'default'))).at(-1);
  // Companion styles are consulted only when the requested/default table
  // style is absent from the main part. That chain resolves wholly within
  // the selected part; missing properties or basedOn edges are not merged.
  // Paragraph/run style resolution still uses the main part (native controls).
  if (readEffectsStyles && !(requested ? definitions.some(n => attr(n, 'styleId') === requested) : defaultStyle(definitions))) {
    const alternate = children(readEffectsStyles()).filter(n => n.localName === 'style' && attr(n, 'type') === 'table');
    if (requested ? alternate.some(n => attr(n, 'styleId') === requested) : defaultStyle(alternate)) definitions = alternate;
  }
  const styleId = requested || attr(defaultStyle(definitions), 'styleId');
  const chain = [], seen = new Set(); let id = styleId;
  while (id) {
    const style = definitions.find(n => attr(n, 'styleId') === id); if (!style) break;
    if (seen.has(id)) fail('cyclic table styles'); seen.add(id); chain.unshift(style);
    id = attr(child(style, 'basedOn'), 'val');
  }
  // Existing documents expect a departure from §17.4.34's 115-twip default: a resolved table
  // style starts at zero; without one it supplies half-point side margins.
  // Its built-in Normal Table supplies 108 twips even without stored margins.
  // Explicit table/style/cell margins still take precedence (native controls).
  const sideMargin = chain.some(normalTableStyle) ? 108 : chain.length ? 0 : 10;
  let format = { margins: { top: 0, right: sideMargin, bottom: 0, left: sideMargin }, borders: {}, width: null, alignment: 'left', indent: 0, layout: 'autofit', fill: null }, rowBase = { cantSplit: false, header: false, minHeight: 0 }, cellBase = {};
  for (const style of chain) {
    if (children(child(style, 'trPr')).some(n => ['gridBefore', 'gridAfter', 'wBefore', 'wAfter'].includes(n.localName))) fail('omitted grid columns declared by table styles');
    if (child(child(style, 'tcPr'), 'gridSpan')) fail('grid spans declared by table styles');
    if (child(child(style, 'tcPr'), 'vMerge')) fail('vertical merges declared by table styles');
    if (child(child(style, 'tcPr'), 'hideMark')) fail('hideMark declared by table styles');
    // The built-in Normal Table is recognized by its name, not merely an
    // arbitrary style marked default. An unnamed default has no implicit indent.
    if (normalTableStyle(style)) format.indentDeclared = true;
    format = properties(tableProperties, child(style, 'tblPr'), format, readColor);
    rowBase = properties(rowProperties, child(style, 'trPr'), rowBase); cellBase = properties(cellProperties, child(style, 'tcPr'), cellBase, readColor, true, preview);
  }
  format = properties(tableProperties, pr, format, readColor);
  if (format.floating) {
    // Page-relative inside/outside positioning is not table justification.
    // Keep it on tblpPr for placement; the ordinary row/grid alignment remains
    // left until odd/even page placement is known. Do not reject the table as invalid jc.
    const alignment = format.floating.tblpXSpec;
    format.alignment = alignment === 'inside' || alignment === 'outside' ? 'left' : alignment || 'left';
    format.indent = format.floating.tblpXSpec ? 0 : format.floating.tblpX;
  }
  // Direct table justification outranks row justification inherited from a
  // table style. Direct row properties and table-property exceptions still win.
  if (child(pr, 'jc')) delete rowBase.alignment;
  if (!['fixed', 'autofit'].includes(format.layout)) fail('an unknown layout algorithm');
  if (!['left', 'center', 'right', 'start', 'end'].includes(format.alignment)) fail('unsupported table alignment');
  format.alignment = { start: 'left', end: 'right' }[format.alignment] || format.alignment;
  const columns = children(grid).map(n => { if (n.namespaceURI !== W || n.localName !== 'gridCol') fail('changed grids'); return integer(attr(n, 'w')); });
  if (!columns.length || columns.length > 32 || format.layout === 'fixed' && columns.some(w => !w)) fail('missing, zero or excessive grid columns');
  const table = { id: tableId('t'), ...format, styleId: styleId || null, grid: columns, shell: shell(node, ['tblPr', 'tblGrid']), rows: [] }, paragraphs = [], contentByCell = new Map(), wrappedCellSources = new Map();
  const conditional = conditionalStyle(chain, pr, cellBase, rowBase, readColor, preview, properties);
  // The look chooses the style's regions (Table Style Options), with or without regions to choose.
  for (const properties of [...chain.map(s => child(s, 'tblPr')), pr]) {
    const look = child(properties, 'tblLook');
    if (look) try { table.look = tableStyleLook(Object.fromEntries([...look.attributes].filter(a => a.namespaceURI === W).map(a => [a.localName, a.value]))); } catch { /* the conditional reader reports it */ }
  }
  if (conditional) {
    conditional.settings.compatibilityMode = compatibilityMode;
    table.conditionalStyle = conditional;
  }
  const boundaries = [], beforePropertyMarkers = new Set(pr ? children(node).slice(0, children(node).indexOf(pr)) : []);
  const readBoundary = (node, items, row) => {
    const previous = items.at(-1);
    const beforeProperties = !row && beforePropertyMarkers.has(node);
    boundaries.push({ ...readBookmark(node, 0, null, { tableId: table.id }), tableBoundary: { tableId: table.id, rowId: row?.id || previous?.id, ...(row ? { cellId: previous?.id } : {}), side: previous ? 'after' : 'before', ...(beforeProperties ? { beforeProperties: true } : {}) } });
  };
  for (const tr of children(node).filter(n => !['tblPr', 'tblGrid'].includes(n.localName))) {
    if (markerNames.includes(tr.localName)) { readBoundary(tr, table.rows); continue; }
    if (children(tr).some(n => n.namespaceURI !== W || !['tblPrEx', 'trPr', 'tc', ...(readControl ? ['sdt'] : []), ...markerNames].includes(n.localName)) || ['trPr', 'tblPrEx'].some(name => children(tr).filter(n => n.localName === name).length > 1)) fail('row exceptions or wrapped cells');
    const exceptions = properties(checkedProperties, child(tr, 'tblPrEx'), ['tblCellMar', 'tblCellSpacing', 'jc', 'tblBorders', 'tblLook']);
    checkCellSpacing(child(exceptions, 'tblCellSpacing'));
    const rowMargins = readCellMargins(child(exceptions, 'tblCellMar'), true);
    const exceptionAlignment = rowAlignment(child(exceptions, 'jc'));
    const row = { id: tableId('row'), ...properties(rowProperties, child(tr, 'trPr'), { ...rowBase, ...(exceptionAlignment ? { alignment: exceptionAlignment } : {}) }), inheritedRowHeight: rowHeight(rowBase), heightExplicit: !!child(child(tr, 'trPr'), 'trHeight'), shell: shell(tr, ['tblPrEx', 'trPr']), cells: [] };
    if (child(exceptions, 'tblBorders')) row.borderExceptions = readTableBorders(child(exceptions, 'tblBorders'), readColor);
    if (child(exceptions, 'tblLook')) {
      try { row.styleLook = tableStyleLook(Object.fromEntries([...child(exceptions, 'tblLook').attributes].filter(a => a.namespaceURI === W).map(a => [a.localName, a.value]))); }
      catch (error) { fail(error.message); }
    }
    row.headerExplicit = !!child(child(tr, 'trPr'), 'tblHeader');
    if (conditional) row.styleMargins = rowMargins;
    const marginDefaults = resolveCellMargins(format.margins, rowMargins);
    for (let tc of children(tr).filter(n => !['tblPrEx', 'trPr'].includes(n.localName))) {
      if (markerNames.includes(tc.localName)) { readBoundary(tc, row.cells, row); continue; }
      let cellControl;
      if (tc.localName === 'sdt') {
        const parsed = readControl(tc, 'cell'); cellControl = parsed.control;
        table.hasCellControls = true;
        tc = child(parsed.content, 'tc');
      }
      if (children(tc).some(n => n.namespaceURI !== W || !['tcPr', 'p', ...(readCellBlocks ? ['tbl', 'sdt', 'bookmarkStart', 'bookmarkEnd'] : [])].includes(n.localName)) || children(tc).filter(n => n.localName === 'tcPr').length > 1) fail('unsupported cell blocks');
      // Cell-style shading applies when tcPr/shd is absent, not tblPr/shd
      // ([MS-OI29500] §17.4.32). Keep table paint for its separate spacing layer.
      const cell = { id: tableId('cell'), ...properties(cellProperties, child(tc, 'tcPr'), { ...cellBase, marginDefaults, margins: resolveCellMargins(marginDefaults, cellBase.margins), shading: cellBase.shading ?? 'auto' }, readColor, false, preview), shell: shell(tc, ['tcPr']) };
      if (cellControl?.persistent && cell.vMerge === 'continue') fail('persistent controls on vertical continuation cells');
      if (cellControl) { cellControl.kind = 'cell'; cellControl.scope = cell.id; }
      const content = children(tc).filter(n => n.localName !== 'tcPr');
      if (!content.length) fail('empty cells without paragraphs');
      if (content.some(n => ['sdt', 'bookmarkStart', 'bookmarkEnd'].includes(n.localName))) wrappedCellSources.set(cell.id, content.map(serializeFragment));
      const context = { cellId: cell.id, tableStyleId: table.styleId, ...(cellControl ? { blockControls: [cellControl] } : {}) };
      contentByCell.set(cell.id, readCellBlocks ? readCellBlocks(content, context) : content.map(p => ({ source: xml(p), paragraph: readParagraph(p, context) })));
      if (cellControl && cell.vMerge === 'continue') cell.continuationControl = cellControl;
      row.cells.push(cell);
    }
    if (!row.cells.length) fail('rows without cells');
    table.rows.push(row);
  }
  if (!table.rows.length || table.rows.length > 1000) fail('missing or excessive rows');
  const extents = table.rows.map(row => row.cells.reduce((n, cell) => n + cellSpan(cell), (row.gridBefore || 0) + (row.gridAfter || 0))), count = Math.max(columns.length, ...extents);
  if (count > 32 || extents.some(n => n !== count)) fail('omitted cells or excessive grid spans');
  // §17.4.17 requires implicit grid augmentation. Keep the source grid shell
  // intact until a structural/width edit explicitly writes this effective grid.
  while (table.grid.length < count) table.grid.push(format.layout === 'fixed' ? 1440 : 0);
  const styledCells = refreshConditionalTable(table);
  if (styledCells) for (const [id, cell] of styledCells) for (const { paragraph: p } of contentByCell.get(id)) if (p.cellId === id) {
    p.tableStyleRegions = cell.styleRegions;
    try { restyleParagraph(p); } catch (e) { fail(e.message); }
  }
  let owners; try { owners = verticalMerges(table); } catch (e) { fail(e.message); }
  for (const row of table.rows) for (const cell of row.cells) {
    const content = contentByCell.get(cell.id);
    if (owners.get(cell.id).cell !== cell) {
      if (content.some(({ paragraph: p }) => p.cellId && p.cellId !== cell.id)) fail('nested tables in vertical continuation cells');
      if (content.some(({ paragraph: p }) => p.runs.some(r => r.text) || p.list || p.bookmarks?.length)) fail('vertical continuations containing text, numbering or bookmarks');
      cell.continuation = wrappedCellSources.get(cell.id) || content.map(p => p.source);
      const last = content.at(-1).paragraph;
      cell.continuationStyleId = last.resolvedStyleId ?? last.styleId ?? null;
    } else paragraphs.push(...content.map(p => p.paragraph));
  }
  const resolveBoundary = boundaries.length && tableBookmarkResolver(paragraphs, [table, ...relatedTables]);
  for (const marker of boundaries) {
    const boundary = marker.tableBoundary;
    if (!boundary.rowId) boundary.rowId = table.rows[0].id;
    if ('cellId' in boundary && !boundary.cellId) boundary.cellId = table.rows.find(r => r.id === boundary.rowId).cells[0].id;
    const { paragraph, ...position } = resolveBoundary(boundary);
    (paragraph.bookmarks ||= []).push({ ...marker, ...position });
  }
  return { table, paragraphs };
}

export function writeTable(block, doc, writeParagraph) {
  const make = name => doc.createElementNS(W, `w:${name}`);
  const from = (value, name) => value ? doc.importNode(parseXml(value).documentElement, true) : make(name);
  const prop = (name, attrs) => { const n = make(name); for (const [k, v] of Object.entries(attrs)) n.setAttributeNS(W, `w:${k}`, String(v)); return n; };
  const widthAttrs = w => ({ type: w.type, w: w.type === 'pct' && !Number.isInteger(w.value) ? `${w.value / 50}%` : w.value });
  const { table } = block, node = from(table.shell, 'tbl');
  const boundaries = new Map(), boundaryKey = (rowId, cellId, side) => JSON.stringify([rowId, cellId, side]);
  const collectBoundaries = blocks => {
    for (const entry of blocks) {
      if (!entry.paragraph) {
        for (const row of entry.rows) for (const cell of row.cells) collectBoundaries(cell.content);
        continue;
      }
      for (const marker of entry.paragraph.bookmarks || []) {
        const at = marker.tableBoundary; if (at?.tableId !== table.id) continue;
        const key = boundaryKey(at.rowId, at.cellId, at.side);
        if (!boundaries.has(key)) boundaries.set(key, []);
        boundaries.get(key).push(marker);
      }
    }
  };
  for (const row of block.rows) for (const cell of row.cells) collectBoundaries(cell.content);
  const appendBoundary = (parent, rowId, cellId, side) => {
    for (const marker of (boundaries.get(boundaryKey(rowId, cellId, side)) || []).sort((a, b) => a.order - b.order)) parent.insertBefore(writeBookmark(marker, doc), marker.tableBoundary.beforeProperties ? child(parent, 'tblPr') : null);
  };
  if (!table.shell) {
    const pr = make('tblPr');
    if (table.styleId) pr.append(prop('tblStyle', { val: table.styleId }));
    pr.append(prop('tblW', widthAttrs(table.width)));
    const b = make('tblBorders'); for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) b.append(prop(side, { val: 'single', sz: 4, color: '000000' })); pr.append(b);
    pr.append(prop('tblLayout', { type: table.layout }));
    const margins = make('tblCellMar'); for (const side of ['top', 'left', 'bottom', 'right']) margins.append(prop(side, { type: 'dxa', w: table.margins[side] })); pr.append(margins); node.append(pr);
  }
  if (!table.shell || table.gridChanged) {
    const grid = make('tblGrid'); for (const w of table.grid) grid.append(prop('gridCol', { w }));
    const old = child(node, 'tblGrid'); if (old) old.replaceWith(grid); else node.append(grid);
  }
  if (table.widthChanged || table.layoutChanged || table.alignmentChanged || table.indentChanged) {
    let pr = child(node, 'tblPr'); if (!pr) { pr = make('tblPr'); node.prepend(pr); }
    const order = ['tblStyle', 'tblpPr', 'tblOverlap', 'bidiVisual', 'tblStyleRowBandSize', 'tblStyleColBandSize', 'tblW', 'jc', 'tblCellSpacing', 'tblInd', 'tblBorders', 'shd', 'tblLayout', 'tblCellMar', 'tblLook', 'tblCaption', 'tblDescription', 'tblPrChange'];
    for (const [key, tag, attrs] of [['width', 'tblW', widthAttrs(table.width || { type: 'auto', value: 0 })], ['layout', 'tblLayout', { type: table.layout }], ['alignment', 'jc', { val: table.alignment }], ['indent', 'tblInd', { type: 'dxa', w: table.indent }]]) {
      if (!table[`${key}Changed`]) continue;
      const next = prop(tag, attrs), old = child(pr, tag);
      if (old) old.replaceWith(next);
      else pr.insertBefore(next, children(pr).find(n => order.indexOf(n.localName) > order.indexOf(tag)) || null);
    }
  }
  const tableOrder = ['tblStyle', 'tblpPr', 'tblOverlap', 'bidiVisual', 'tblStyleRowBandSize', 'tblStyleColBandSize', 'tblW', 'jc', 'tblCellSpacing', 'tblInd', 'tblBorders', 'shd', 'tblLayout', 'tblCellMar', 'tblLook', 'tblCaption', 'tblDescription', 'tblPrChange'];
  // Replace (or remove, with null) one table property, keeping the schema order.
  const setTableProperty = (tag, next) => {
    let pr = child(node, 'tblPr');
    if (!pr) { if (!next) return; pr = make('tblPr'); node.prepend(pr); }
    const old = child(pr, tag);
    if (old && next) old.replaceWith(next);
    else if (old) old.remove();
    else if (next) pr.insertBefore(next, children(pr).find(n => tableOrder.indexOf(n.localName) > tableOrder.indexOf(tag)) || null);
  };
  writeTableStyleProperties(table, setTableProperty, prop, make);
  if (table.altTextChanged) {
    setTableProperty('tblCaption', table.caption ? prop('tblCaption', { val: table.caption }) : null);
    setTableProperty('tblDescription', table.description ? prop('tblDescription', { val: table.description }) : null);
  }
  if (table.marginsChanged) {
    const margins = make('tblCellMar'); for (const side of ['top', 'left', 'bottom', 'right']) margins.append(prop(side, { type: 'dxa', w: table.margins[side] ?? 0 }));
    setTableProperty('tblCellMar', margins);
  }
  if (table.overlapChanged) setTableProperty('tblOverlap', table.overlap ? prop('tblOverlap', { val: table.overlap }) : null);
  if (table.floatingCreated || table.floatingRemoved || table.floatingRewrite) {
    const position = table.floating;
    setTableProperty('tblpPr', position ? prop('tblpPr', Object.fromEntries(['leftFromText', 'rightFromText', 'topFromText', 'bottomFromText', 'vertAnchor', 'horzAnchor', 'tblpXSpec', 'tblpX', 'tblpYSpec', 'tblpY'].filter(k => position[k] !== undefined && !(k === 'tblpX' && position.tblpXSpec) && !(k === 'tblpY' && position.tblpYSpec)).map(k => [k, position[k]]))) : null);
  } else if (table.floatingChanged) {
    const positioning = child(child(node,'tblPr'),'tblpPr');
    if (!positioning) throw new Error('Missing retained floating-table positioning.');
    positioning.setAttributeNS(W,'w:tblpX',String(table.floating.tblpX));
    if (table.floating.tblpXSpec) positioning.setAttributeNS(W,'w:tblpXSpec',table.floating.tblpXSpec);
    else positioning.removeAttributeNS(W,'tblpXSpec');
  }
  for (const row of block.rows) {
    appendBoundary(node, row.id, undefined, 'before');
    const tr = from(row.shell, 'tr');
    if (row.styleLookCleared) {
      // The table's Style Options replaced this row's own look exception.
      const exceptions = child(tr, 'tblPrEx');
      child(exceptions, 'tblLook')?.remove();
      if (exceptions && !exceptions.children.length) exceptions.remove();
    }
    const rowProperties = () => {
      let pr = child(tr, 'trPr');
      // A row's table-property exceptions precede its ordinary row properties.
      if (!pr) { pr = make('trPr'); tr.append(pr); }
      return pr;
    };
    if (row.alignmentChanged || !row.shell && row.alignment) {
      const pr = rowProperties(); child(pr, 'jc')?.remove();
      pr.insertBefore(prop('jc', { val: row.alignment }), children(pr).find(n => ['hidden', 'ins', 'del', 'trPrChange'].includes(n.localName)) || null);
    }
    for (const side of ['Before', 'After']) if (row[`grid${side}Changed`]) {
      const pr = rowProperties(), name = `grid${side}`, old = child(pr, name), value = row[name] || 0;
      const next = value ? prop(name, { val: value }) : null;
      if (old && next) old.replaceWith(next); else if (old) old.remove();
      else if (next) pr.insertBefore(next, children(pr).find(n => !['cnfStyle', 'divId', ...(side === 'After' ? ['gridBefore'] : [])].includes(n.localName)) || null);
      if (!value) { child(pr, `w${side}`)?.remove(); row[`width${side}Changed`] = false; }
    }
    for (const side of ['Before', 'After']) if (row[`width${side}Changed`]) {
      const pr = rowProperties(), name = `w${side}`, next = prop(name, widthAttrs(row[`width${side}`])), old = child(pr, name);
      if (old) old.replaceWith(next);
      else pr.insertBefore(next, children(pr).find(n => !['cnfStyle', 'divId', 'gridBefore', 'gridAfter', ...(side === 'After' ? ['wBefore'] : [])].includes(n.localName)) || null);
    }
    if (row.heightChanged || !row.shell && (row.minHeight || row.heightExplicit)) {
      const pr = rowProperties();
      child(pr, 'trHeight')?.remove();
      if (row.heightExplicit || !row.shell && row.minHeight) {
        const height = rowHeight(row);
        pr.insertBefore(prop('trHeight', { val: height.value, hRule: height.rule }), children(pr).find(n => ['tblHeader', 'tblCellSpacing', 'jc', 'hidden', 'ins', 'del', 'trPrChange'].includes(n.localName)) || null);
      }
    }
    if (row.keepChanged || !row.shell && row.cantSplit) {
      const pr = rowProperties();
      child(pr, 'cantSplit')?.remove(); pr.insertBefore(prop('cantSplit', { val: row.cantSplit ? '1' : '0' }), children(pr).find(n => ['trHeight', 'tblHeader', 'tblCellSpacing', 'jc', 'hidden', 'ins', 'del', 'trPrChange'].includes(n.localName)) || null);
    }
    if (row.headerChanged || !row.shell && row.header) {
      const pr = rowProperties();
      child(pr, 'tblHeader')?.remove(); pr.insertBefore(prop('tblHeader', { val: row.header ? '1' : '0' }), children(pr).find(n => ['tblCellSpacing', 'jc', 'hidden', 'ins', 'del', 'trPrChange'].includes(n.localName)) || null);
    }
    for (const cell of row.cells) {
      appendBoundary(tr, row.id, cell.id, 'before');
      const tc = from(cell.shell, 'tc'); if (cell.generated) tc.removeAttributeNS(W, 'id');
      if (!cell.shell || cell.widthChanged) {
        let pr = child(tc, 'tcPr'); if (!pr) { pr = make('tcPr'); tc.prepend(pr); }
        const w = prop('tcW', widthAttrs(cell.width));
        const old = child(pr, 'tcW'); if (old) old.replaceWith(w); else pr.insertBefore(w, children(pr).find(n => n.localName !== 'cnfStyle') || null);
      }
      if (cell.spanChanged || !cell.shell && cellSpan(cell) > 1) {
        let pr = child(tc, 'tcPr'); if (!pr) { pr = make('tcPr'); tc.prepend(pr); }
        child(pr, 'gridSpan')?.remove();
        if (cellSpan(cell) > 1) pr.insertBefore(prop('gridSpan', { val: cellSpan(cell) }), children(pr).find(n => !['cnfStyle', 'tcW'].includes(n.localName)) || null);
      }
      if (cell.mergeChanged || !cell.shell && cell.vMerge) {
        let pr = child(tc, 'tcPr'); if (!pr) { pr = make('tcPr'); tc.prepend(pr); }
        child(pr, 'vMerge')?.remove();
        if (cell.vMerge) pr.insertBefore(prop('vMerge', { val: cell.vMerge }), children(pr).find(n => !['cnfStyle', 'tcW', 'gridSpan', 'hMerge'].includes(n.localName)) || null);
      }
      if (cell.verticalChanged || !cell.shell && cell.verticalExplicit) {
        let pr = child(tc, 'tcPr'); if (!pr) { pr = make('tcPr'); tc.prepend(pr); }
        child(pr, 'vAlign')?.remove();
        if (cell.verticalExplicit) pr.insertBefore(prop('vAlign', { val: cell.vertical }), children(pr).find(n => ['hideMark', 'headers', 'cellIns', 'cellDel', 'cellMerge', 'tcPrChange'].includes(n.localName)) || null);
      }
      if (!cell.shell && cell.hideMark) {
        let pr = child(tc, 'tcPr'); if (!pr) { pr = make('tcPr'); tc.prepend(pr); }
        pr.insertBefore(make('hideMark'), children(pr).find(n => ['headers', 'cellIns', 'cellDel', 'cellMerge', 'tcPrChange'].includes(n.localName)) || null);
      }
      if (cell.noWrapChanged || !cell.shell && (cell.noWrap || cell.noWrapExplicit)) {
        let pr = child(tc, 'tcPr'); if (!pr) { pr = make('tcPr'); tc.prepend(pr); }
        child(pr, 'noWrap')?.remove();
        if (cell.noWrapExplicit) pr.insertBefore(prop('noWrap', cell.noWrap ? {} : { val: '0' }), children(pr).find(n => ['tcMar', 'textDirection', 'tcFitText', 'vAlign', 'hideMark', 'headers', 'cellIns', 'cellDel', 'cellMerge', 'tcPrChange'].includes(n.localName)) || null);
      }
      if (cell.textDirectionChanged || !cell.shell && cell.textDirectionExplicit) {
        let pr = child(tc, 'tcPr'); if (!pr) { pr = make('tcPr'); tc.prepend(pr); }
        child(pr, 'textDirection')?.remove();
        if (cell.textDirectionExplicit && cell.textDirection !== 'lrTb') pr.insertBefore(prop('textDirection', { val: cell.textDirection }), children(pr).find(n => ['tcFitText', 'vAlign', 'hideMark', 'headers', 'cellIns', 'cellDel', 'cellMerge', 'tcPrChange'].includes(n.localName)) || null);
      }
      if (cell.shadingChanged || !cell.shell && cell.shadingExplicit) {
        let pr = child(tc, 'tcPr'); if (!pr) { pr = make('tcPr'); tc.prepend(pr); }
        child(pr, 'shd')?.remove();
        if (cell.shadingExplicit) {
          const shading = make('shd'); writeCellShading(shading, cell.shading);
          pr.insertBefore(shading, children(pr).find(n => !['cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge', 'tcBorders'].includes(n.localName)) || null);
        }
      }
      if (cell.borderChanges || !cell.shell && Object.keys(cell.directBorders || {}).length) {
        let pr = child(tc, 'tcPr'); if (!pr) { pr = make('tcPr'); tc.prepend(pr); }
        let borders = child(pr, 'tcBorders');
        if (!borders) { borders = make('tcBorders'); pr.insertBefore(borders, children(pr).find(n => !['cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge'].includes(n.localName)) || null); }
        writeCellBorders(borders, cell.borderChanges || cell.directBorders, make);
        if (!borders.childNodes.length && !borders.attributes.length) borders.remove();
      }
      if (cell.marginChanges || !cell.shell && Object.keys(cell.directMargins || {}).length) {
        let pr = child(tc, 'tcPr'); if (!pr) { pr = make('tcPr'); tc.prepend(pr); }
        let margins = child(pr, 'tcMar');
        if (!margins) { margins = make('tcMar'); pr.insertBefore(margins, children(pr).find(n => !['cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge', 'tcBorders', 'shd', 'noWrap'].includes(n.localName)) || null); }
        writeCellMargins(margins, cell.marginChanges || cell.directMargins, make);
        if (!margins.childNodes.length && !margins.attributes.length) margins.remove();
      }
      appendControlledBlocks(tc, cell.content.map(block => ({ ...block, blockControls: (block.type === 'table' ? block.table : block.paragraph).blockControls })), block => block.type === 'table' ? writeTable(block, doc, writeParagraph) : writeParagraph(block.paragraph), doc, cell.id);
      if (cell.rowSpan === 0) for (const source of cell.continuation || [null]) tc.append(from(source, 'p'));
      const controlParagraphs = blocks => blocks.flatMap(b => b.type === 'table' ? b.rows.flatMap(r => r.cells.flatMap(c => controlParagraphs(c.content))) : [b.paragraph]);
      const control = cell.rowSpan === 0 ? cell.continuationControl : table.hasCellControls && controlParagraphs(cell.content).flatMap(p => p.blockControls || []).find(c => c.kind === 'cell' && c.scope === cell.id);
      if (control) {
        const wrapper = from(control.shell, 'sdt'), content = child(wrapper, 'sdtContent');
        writeControlPlaceholder(wrapper, control, doc);
        content.replaceChildren(tc); tr.append(wrapper);
      } else tr.append(tc);
      appendBoundary(tr, row.id, cell.id, 'after');
    }
    node.append(tr);
    appendBoundary(node, row.id, undefined, 'after');
  }
  return node;
}
