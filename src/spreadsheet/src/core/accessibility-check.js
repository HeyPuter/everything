/**
 * Check Accessibility (Review ▸ Check Accessibility): the workbook inspected for what keeps people who use
 * assistive technology from reading it, in three tiers. Errors make content hard or impossible to
 * understand, warnings make it hard to understand, tips are worth a look. The status bar reads
 * "Accessibility: No issues" while there are no errors or warnings, and "Review suggested" otherwise.
 */
import { rangeName } from './cell.js';
import { fontColorCss } from './font-color.js';
import { fillColorCss } from './fill-color.js';

/** The rules, the tier each belongs to, and why and how to fix it (the pane's Additional Information). */
export const ACCESSIBILITY_RULES = {
  altText: { severity: 'error', label: 'Object has no description', why: 'People who can\'t see the screen rely on a short description to know what a picture, chart or shape shows.',
    how: 'Right-click the object, open its alt text, and write a short description, or mark it as decorative.' },
  tableHeader: { severity: 'error', label: 'Table has no header row', why: 'Without a header row, screen reader users can\'t tell what each column of a table holds.',
    how: 'Select the table and switch its header row on from the Table tab.' },
  contrast: { severity: 'warning', label: 'Text is hard to see against its fill', why: 'Text that does not stand out from its background is hard to read for people with low vision or color blindness.',
    how: 'Choose a darker font color or a lighter fill so the text has a contrast ratio of at least 4.5:1.' },
  merged: { severity: 'warning', label: 'Cells are merged', why: 'Screen readers lose count of rows and columns in merged cells, which makes the sheet hard to follow.',
    how: 'Unmerge the cells, then center the text across the columns or wrap it instead.' },
  sheetName: { severity: 'tip', label: 'Sheet still has its default name', why: 'A sheet name that says what the sheet holds helps people find their way without opening each one.',
    how: 'Double-click the sheet tab and give it a name that describes its content.' },
};

const SEVERITY_ORDER = ['error', 'warning', 'tip'];
const DEFAULT_SHEET_NAME = /^Sheet\d+$/i;
const MAX_CONTRAST_CELLS = 50000;

function luminance(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})/i.exec(hex || '');
  if (!m) return null;
  const [r, g, b] = m.slice(1).map((h) => {
    const v = parseInt(h, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two #rrggbb colors (1 to 21). */
export function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  if (la == null || lb == null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const hex6 = (css) => {
  if (typeof css !== 'string') return null;
  if (/^#[\da-f]{6}/i.test(css)) return css.slice(0, 7);
  const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(css);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : null;
};

/** Large text (18pt, or 14pt bold) needs only 3:1. Sizes are stored in pixels (a point is 4/3 px). */
const minimumRatio = (style) => {
  const points = (style?.size || 13) * 3 / 4;
  return points >= 18 || (style?.bold && points >= 14) ? 3 : 4.5;
};

const objectName = (obj, index) => obj.title || {
  image: `Picture ${index + 1}`, text: `TextBox ${index + 1}`, smartart: `SmartArt ${index + 1}`, slicer: `Slicer ${index + 1}`, scroll: `Scroll Bar ${index + 1}`,
}[obj.type] || `Chart ${index + 1}`;

/**
 * Inspect the workbook. Each finding: { rule, severity, sheetId, sheet, label, target } where target is
 * { range } for cells or { chartId } for an object, or null for the sheet itself.
 */
export function checkAccessibility(wb) {
  const findings = [];
  const add = (rule, sheet, label, target) => findings.push({ rule, severity: ACCESSIBILITY_RULES[rule].severity, sheetId: sheet.id, sheet: sheet.name, label, target });
  const visible = wb.sheets.filter((s) => !s.hidden);
  for (const sheet of visible) {
    if (sheet.kind === 'chart') {
      sheet.charts.forEach((obj, i) => { if (!obj.decorative && !obj.description && !obj.title) add('altText', sheet, `${objectName(obj, i)} (${sheet.name})`, { chartId: obj.id }); });
      continue;
    }
    // Objects without a description and not marked decorative. Scroll bars and slicers carry their own names.
    sheet.charts.forEach((obj, i) => {
      if (obj.type === 'scroll' || obj.type === 'slicer' || obj.decorative) return;
      // A SmartArt graphic reads out its own text when it has no description.
      const alt = obj.description || (obj.type === 'image' ? obj.title : obj.type === 'smartart' ? (obj.items || []).map((it) => it.text).join(' ') : '');
      if (!String(alt || '').trim()) add('altText', sheet, `${objectName(obj, i)} (${sheet.name})`, { chartId: obj.id });
    });
    // Pictures placed in cells with no alt text of their own (an IMAGE formula gives its alt text as an argument).
    for (const [key, cell] of sheet.cells) {
      const v = cell?.v;
      if (!v || typeof v !== 'object' || typeof v.image !== 'string' || String(v.alt || '').trim()) continue;
      const [r, c] = key.split(',').map(Number);
      add('altText', sheet, `Picture in ${rangeName({ r1: r, c1: c, r2: r, c2: c })} (${sheet.name})`, { range: { r1: r, c1: c, r2: r, c2: c } });
    }
    for (const table of sheet.tables || []) {
      if (table.headerRow === false || table.headerRowCount === 0) add('tableHeader', sheet, `${table.name} (${sheet.name})`, { range: table.range });
    }
    for (const m of sheet.merges || []) add('merged', sheet, `${rangeName(m)} (${sheet.name})`, { range: { r1: m.r1, c1: m.c1, r2: m.r2, c2: m.c2 } });
    // Text drawn in a color too close to its fill: only cells that hold something and set a color or a fill.
    let scanned = 0;
    for (const [key, cell] of sheet.cells) {
      if (++scanned > MAX_CONTRAST_CELLS) break;
      if (cell.v == null && cell.f == null) continue;
      const [r, c] = key.split(',').map(Number);
      const value = wb.getValue(sheet.id, r, c);
      if (value == null || value === '') continue;
      const style = wb.styleAt(sheet.id, r, c);
      if (!style || (style.color == null && style.bg == null)) continue;
      const ink = hex6(style.color === 'windowtext' ? '#000000' : fontColorCss(style.color)) || '#000000';
      const paper = hex6(fillColorCss(style.bg)) || '#ffffff';
      const ratio = contrastRatio(ink, paper);
      if (ratio != null && ratio < minimumRatio(style)) add('contrast', sheet, `${rangeName({ r1: r, c1: c, r2: r, c2: c })} (${sheet.name})`, { range: { r1: r, c1: c, r2: r, c2: c } });
    }
    // A default name is worth changing once the sheet holds something.
    if (DEFAULT_SHEET_NAME.test(sheet.name) && (sheet.cells.size || sheet.charts.length) && visible.length > 1) add('sheetName', sheet, sheet.name, null);
  }
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  return findings;
}

/** The status bar's words for a set of findings. */
export function accessibilityStatus(findings) {
  return findings.some((f) => f.severity !== 'tip') ? 'Review suggested' : 'No issues';
}

/** Findings grouped by tier, then by rule, for the pane. */
export function groupFindings(findings) {
  return SEVERITY_ORDER.map((severity) => {
    const ofTier = findings.filter((f) => f.severity === severity);
    const rules = [...new Set(ofTier.map((f) => f.rule))].map((rule) => ({ rule, ...ACCESSIBILITY_RULES[rule], items: ofTier.filter((f) => f.rule === rule) }));
    return { severity, count: ofTier.length, rules };
  });
}
