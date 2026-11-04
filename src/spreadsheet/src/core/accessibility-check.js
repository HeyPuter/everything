/**
 * Check Accessibility (Review ▸ Check Accessibility): the workbook inspected for what keeps people who use
 * assistive technology from reading it, in three tiers. Errors make content hard or impossible to
 * understand, warnings make it hard to understand, tips are worth a look. The status bar reads
 * "Accessibility: No issues" while there are no errors or warnings, and "Review suggested" otherwise.
 */
import { rangeName } from './cell.js';
import { fontColorCss } from './font-color.js';
import { fillColorCss } from './fill-color.js';
import { objectNames } from './arrange.js';
import { t } from '../i18n/index.js';

/**
 * The rules, the tier each belongs to, and why and how to fix it (the pane's Additional Information), as
 * catalog keys: groupFindings puts them in the interface language.
 */
export const ACCESSIBILITY_RULES = {
  altText: { severity: 'error', label: 'accessibilityCheck.altText.label', why: 'accessibilityCheck.altText.why', how: 'accessibilityCheck.altText.how' },
  tableHeader: { severity: 'error', label: 'accessibilityCheck.tableHeader.label', why: 'accessibilityCheck.tableHeader.why', how: 'accessibilityCheck.tableHeader.how' },
  contrast: { severity: 'warning', label: 'accessibilityCheck.contrast.label', why: 'accessibilityCheck.contrast.why', how: 'accessibilityCheck.contrast.how' },
  merged: { severity: 'warning', label: 'accessibilityCheck.merged.label', why: 'accessibilityCheck.merged.why', how: 'accessibilityCheck.merged.how' },
  sheetName: { severity: 'tip', label: 'accessibilityCheck.sheetName.label', why: 'accessibilityCheck.sheetName.why', how: 'accessibilityCheck.sheetName.how' },
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

/** A stored colour as a key: a string as it is, a theme colour (an object) by its contents. */
const colorKey = (value) => (value != null && typeof value === 'object' ? JSON.stringify(value) : String(value));

/** Large text (18pt, or 14pt bold) needs only 3:1. Sizes are stored in pixels (a point is 4/3 px). */
const minimumRatio = (style) => {
  const points = (style?.size || 13) * 3 / 4;
  return points >= 18 || (style?.bold && points >= 14) ? 3 : 4.5;
};


/**
 * Inspect the workbook. Each finding: { rule, severity, sheetId, sheet, label, target } where target is
 * { range } for cells or { chartId } for an object, or null for the sheet itself.
 */
export function checkAccessibility(wb) {
  const findings = [];
  const add = (rule, sheet, label, target) => findings.push({ rule, severity: ACCESSIBILITY_RULES[rule].severity, sheetId: sheet.id, sheet: sheet.name, label, target });
  const visible = wb.sheets.filter((s) => !s.hidden);
  const verdicts = new Map(); // "ink|fill|minimum ratio" → too little contrast
  for (const sheet of visible) {
    if (sheet.kind === 'chart') {
      const names = objectNames(sheet.charts);
      sheet.charts.forEach((obj) => { if (!obj.decorative && !obj.description && !obj.title) add('altText', sheet, t('accessibilityCheck.place', { name: names.get(obj.id), sheet: sheet.name }), { chartId: obj.id }); });
      continue;
    }
    // Objects without a description and not marked decorative. Scroll bars and slicers carry their own names.
    // Each is named as the Selection Pane names it, where it is found and given a name of its own.
    const names = objectNames(sheet.charts);
    sheet.charts.forEach((obj) => {
      if (obj.type === 'scroll' || obj.type === 'slicer' || obj.decorative) return;
      // A SmartArt graphic reads out its own text when it has no description.
      const alt = obj.description || (obj.type === 'image' ? obj.title : obj.type === 'smartart' ? (obj.items || []).map((it) => it.text).join(' ') : '');
      if (!String(alt || '').trim()) add('altText', sheet, t('accessibilityCheck.place', { name: names.get(obj.id), sheet: sheet.name }), { chartId: obj.id });
    });
    // Pictures placed in cells with no alt text of their own (an IMAGE formula gives its alt text as an argument).
    for (const [key, cell] of sheet.cells) {
      const v = cell?.v;
      if (!v || typeof v !== 'object' || typeof v.image !== 'string' || String(v.alt || '').trim()) continue;
      const [r, c] = key.split(',').map(Number);
      add('altText', sheet, t('accessibilityCheck.cellPicture', { cell: rangeName({ r1: r, c1: c, r2: r, c2: c }), sheet: sheet.name }), { range: { r1: r, c1: c, r2: r, c2: c } });
    }
    for (const table of sheet.tables || []) {
      if (table.headerRow === false || table.headerRowCount === 0) add('tableHeader', sheet, t('accessibilityCheck.place', { name: table.name, sheet: sheet.name }), { range: table.range });
    }
    for (const m of sheet.merges || []) add('merged', sheet, t('accessibilityCheck.place', { name: rangeName(m), sheet: sheet.name }), { range: { r1: m.r1, c1: m.c1, r2: m.r2, c2: m.c2 } });
    // Text drawn in a color too close to its fill: only cells that hold something and set a color or a fill.
    // The status bar runs this after each pause in editing, so the cheap questions come first (the style, then
    // whether its colours are too close, then the value, read without the calculator for a cell that holds no
    // formula), and each pairing of colours and text size is judged once: a styled sheet repeats a few of them
    // over thousands of cells.
    let scanned = 0;
    for (const [key, cell] of sheet.cells) {
      if (++scanned > MAX_CONTRAST_CELLS) break;
      if (cell.v == null && cell.f == null) continue;
      const comma = key.indexOf(',');
      const r = +key.slice(0, comma), c = +key.slice(comma + 1);
      // As styleAt reads it (the cell's own style over its row's, column's and sheet's), without looking the sheet and cell up again.
      const line = wb._lineStyle(sheet, r, c);
      const style = line ? { ...line, ...cell.s } : cell.s;
      if (!style || (style.color == null && style.bg == null)) continue;
      const minimum = minimumRatio(style);
      const pairing = `${colorKey(style.color)}|${colorKey(style.bg)}|${minimum}`;
      let poor = verdicts.get(pairing);
      if (poor === undefined) {
        const ink = hex6(style.color === 'windowtext' ? '#000000' : fontColorCss(style.color)) || '#000000';
        const paper = hex6(fillColorCss(style.bg)) || '#ffffff';
        const ratio = contrastRatio(ink, paper);
        poor = ratio != null && ratio < minimum;
        verdicts.set(pairing, poor);
      }
      if (!poor) continue;
      // Only text drawn in such colours counts: a formula's value is worked out for these cells alone, not for
      // every styled formula on the sheet (25,000 of them took a third of a second as a large book opened).
      const value = cell.f == null && !cell.array ? cell.v : wb.getValue(sheet.id, r, c);
      if (value != null && value !== '') add('contrast', sheet, t('accessibilityCheck.place', { name: rangeName({ r1: r, c1: c, r2: r, c2: c }), sheet: sheet.name }), { range: { r1: r, c1: c, r2: r, c2: c } });
    }
    // A default name is worth changing once the sheet holds something.
    if (DEFAULT_SHEET_NAME.test(sheet.name) && (sheet.cells.size || sheet.charts.length) && visible.length > 1) add('sheetName', sheet, sheet.name, null);
  }
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  return findings;
}

/** The status bar's state for a set of findings: 'Review suggested' or 'No issues' (an identifier; accessibilityStatusText words it). */
export function accessibilityStatus(findings) {
  return findings.some((f) => f.severity !== 'tip') ? 'Review suggested' : 'No issues';
}

/** The status bar's words for a status accessibilityStatus gave: "Accessibility: No issues". */
export function accessibilityStatusText(status) {
  return status === 'No issues' ? t('accessibilityCheck.status.noIssues') : t('accessibilityCheck.status.reviewSuggested');
}

/** Findings grouped by tier, then by rule, for the pane. */
export function groupFindings(findings) {
  return SEVERITY_ORDER.map((severity) => {
    const ofTier = findings.filter((f) => f.severity === severity);
    const rules = [...new Set(ofTier.map((f) => f.rule))].map((rule) => {
      const { label, why, how } = ACCESSIBILITY_RULES[rule];
      return { rule, ...ACCESSIBILITY_RULES[rule], label: t(label), why: t(why), how: t(how), items: ofTier.filter((f) => f.rule === rule) };
    });
    return { severity, count: ofTier.length, rules };
  });
}
