import { projectXlsxConditionalFormats } from './xlsx-condformat-project.js';
import { NATIVE_ICON_SETS, nativeIconCount } from './native-icons.js';
import { conditionalRuleGroups } from './conditional-groups.js';
import { BAR_FORMULAS, SCALE_FORMULAS, conditionalThresholdIsFormula, scaleThresholdFormula, conditionalThresholdFormula, scaleMidpointFormula, conditionalPredicateField, absoluteThresholdFormula } from './conditional-scale.js';
import { scaleColors, barColorOf } from './condformat.js';
/** Native live conditional formats, including app-authored predicates. */
import { cellName } from './cell.js';
import { conditionalRuleFormula } from './condformat-formula.js';
import { toFileFormula } from './xlfn.js';
import { xmlTag, xmlText } from './xlsx-export-styles.js';
import { duplicateSourceAreas, exportNativeDuplicateFormula } from './conditional-duplicates.js';
import { removeRangeRecords } from './range-records.js';
import { sameSheetName, shiftFormula } from './refs.js';

const address = g => `${cellName(g.r1, g.c1)}:${cellName(g.r2, g.c2)}`;
const covered = (ranges, cover) => ranges.every(range => cover.some(g => g.r1 <= range.r1 && g.c1 <= range.c1 && g.r2 >= range.r2 && g.c2 >= range.c2)
  || cover.reduce((pieces, g) => removeRangeRecords(pieces, g), [{ range }]).length === 0);

/** Whether a formula's parentheses balance from start to end, never closing one more than opened (quotes skipped). */
function balanced(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { const end = text.indexOf(ch, i + 1); if (end < 0) return false; i = end; }
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}
/** `prefix(inner)` exactly, with `inner` a whole expression: the inner text, else null. */
const wrapped = (text, prefix) => text.startsWith(`${prefix}(`) && text.endsWith(')') && balanced(text.slice(prefix.length + 1, -1)) ? text.slice(prefix.length + 1, -1) : null;
const CELL_IS = { '=': 'equal', '<>': 'notEqual', '<=': 'lessThanOrEqual', '>=': 'greaterThanOrEqual', '<': 'lessThan', '>': 'greaterThan' };
/**
 * Excel's "Cell Value" rule (cellIs) for a formula rule spelled the way one reads in: A1>(10), or
 * AND(A1>=(1),A1<=(9)) and its NOT for between and not between, where A1 is the rule's top-left cell. Excel
 * defines cellIs as exactly that comparison, so the rule means the same and shows in Excel as it was made.
 */
function cellIsRule(formula, cell) {
  for (const [op, operator] of Object.entries(CELL_IS)) {
    const value = wrapped(formula, `${cell}${op}`);
    if (value != null && value.trim()) return { operator, formulas: [value] };
  }
  for (const [outer, operator] of [['', 'between'], ['NOT', 'notBetween']]) {
    const and = wrapped(outer ? wrapped(formula, outer) ?? '' : formula, 'AND');
    if (and == null) continue;
    // The comma between the two comparisons: the first at which the low bound's parentheses close.
    for (let i = and.indexOf(','); i > 0; i = and.indexOf(',', i + 1)) {
      const low = wrapped(and.slice(0, i), `${cell}>=`), high = wrapped(and.slice(i + 1), `${cell}<=`);
      if (low != null && high != null && low.trim() && high.trim()) return { operator, formulas: [low, high] };
    }
  }
  return null;
}

/** Rejoin native sqref paint pieces only when their coverage still equals the
 * statistical source. A partial copy keeps its independent source via a live
 * expression instead. Never cross an intervening rule's priority.
 */
function duplicateGroup(sheet, index) {
  const rule = sheet.rules[index];
  if (!['dup', 'unique'].includes(rule.type) || rule.duplicateRange == null) return null;
  const areas = duplicateSourceAreas(rule.duplicateRange);
  if (!areas?.length || areas.some(ref => ref.sheet && !sameSheetName(ref.sheet, sheet.name))) return null;
  const ranges = [], style = JSON.stringify(rule.style);
  for (let end = index; end < sheet.rules.length; end++) {
    const next = sheet.rules[end];
    if (JSON.stringify(next.pivotRuleIds) !== JSON.stringify(rule.pivotRuleIds) || !!next.pivot !== !!rule.pivot || next.type !== rule.type || next.duplicateRange !== rule.duplicateRange || JSON.stringify(next.style) !== style
      || (next.stopIfTrue !== false) !== (rule.stopIfTrue !== false) || !covered([next.range], areas)) break;
    ranges.push(next.range);
    if (covered(areas, ranges)) return { end, sqref: areas.map(address).join(' ') };
  }
  return null;
}

/** A native threshold is relative to the complete applies-to range. Rejoin
 * adjacent pieces only when no intervening rule changes their priority. */
function thresholdGroup(sheet, index) {
  const rule = sheet.rules[index];
  if (!['scale', 'databar', 'icons'].includes(rule.type) || !rule.statisticsRange) return null;
  const areas = duplicateSourceAreas(rule.statisticsRange);
  if (!areas?.length || areas.some(ref => ref.sheet && !sameSheetName(ref.sheet, sheet.name))) return null;
  const predicate = conditionalPredicateField(rule);
  const settings = ({ id, range, ...rest }) => JSON.stringify({ ...rest, ...(predicate && rest[predicate] ? {
    [predicate]: shiftFormula(rest[predicate], rule.range.r1 - range.r1, rule.range.c1 - range.c1) } : {}) });
  const key = settings(rule), ranges = [];
  for (let end = index; end < sheet.rules.length; end++) {
    const next = sheet.rules[end];
    if (settings(next) !== key || !covered([next.range], areas)) break;
    ranges.push(next.range);
    if (covered(areas, ranges)) {
      const base = areas.reduce((a, g) => ({ r1: Math.min(a.r1, g.r1), c1: Math.min(a.c1, g.c1) }));
      const active = predicate && shiftFormula(rule[predicate], base.r1 - rule.range.r1, base.c1 - rule.range.c1);
      if (active && shiftFormula(active, rule.range.r1 - base.r1, rule.range.c1 - base.c1) !== rule[predicate]) return null;
      return { end, sqref: areas.map(address).join(' '), base, active };
    }
  }
  return null;
}
const typedThreshold = (rule, key, allowed, convert) => {
  const type = rule[`${key}Type`];
  // Fixed doubles do not depend on the statistical source. Converting them to
  // formula literals loses precision and can exceed Excel's literal range.
  return (allowed || type === 'num') && ['min', 'max', 'num', 'percent', 'percentile', 'autoMin', 'autoMax'].includes(type)
    ? { type, ...(['num', 'percent', 'percentile'].includes(type) ? { val: conditionalThresholdIsFormula(rule, key) ? convert(rule[key]) : rule[key] } : {}) } : null;
};

export function writeXlsxConditionalFormats(xml, wb, originalSheet, styles, define, record = () => {}) {
  const { sheet, sources } = projectXlsxConditionalFormats(originalSheet);
  const recordNative = (start, end) => record(sources[start], sources[end], start + 1);
  const blocks = [], extensions = [], predicateGroups = new Map();
  let start = 0;
  for (const group of conditionalRuleGroups(sheet.rules)) {
    predicateGroups.set(start, { end: start + group.rules.length - 1, ranges: group.rules.map(rule => rule.range) });
    start += group.rules.length;
  }
  for (let index = 0; index < sheet.rules.length; index++) {
    const rule = sheet.rules[index], group = duplicateGroup(sheet, index);
    const thresholdAreas = thresholdGroup(sheet, index), sqref = thresholdAreas?.sqref || address(rule.range);
    const convertThreshold = formula => toFileFormula(absoluteThresholdFormula(wb.structuredToA1(sheet.id, 0, 0, formula, null, false, { relativeRows: true })));
    const nativeThresholds = !rule.statisticsRange || !!thresholdAreas;
    const statisticalRanges = rule.statisticsRange && duplicateSourceAreas(rule.statisticsRange) || [rule.range];
    if (group) {
      recordNative(index, group.end);
      blocks.push(xmlTag('conditionalFormatting', { sqref: group.sqref, ...(rule.pivot || rule.pivotRuleIds?.length ? { pivot: 1 } : {}) },
        xmlTag('cfRule', { type: rule.type === 'dup' ? 'duplicateValues' : 'uniqueValues', dxfId: styles.differential(rule.style),
          priority: index + 1, stopIfTrue: Number(rule.stopIfTrue !== false) })));
      index = group.end;
      continue;
    }
    if (rule.type === 'databar' && ['legacy', 'extended'].includes(rule.barMode)) {
      recordNative(index, thresholdAreas?.end ?? index);
      const formulas = BAR_FORMULAS.map((key, i) => {
        const expression = conditionalThresholdFormula(rule, key) || scaleThresholdFormula(i ? 'max' : 'min', null, statisticalRanges);
        return toFileFormula(absoluteThresholdFormula(wb.structuredToA1(sheet.id, 0, 0, expression, null, false, { relativeRows: true })));
      });
      const values = BAR_FORMULAS.map((key, i) => typedThreshold(rule, key, nativeThresholds, convertThreshold) || { type: 'formula', val: formulas[i] });
      const limits = values.map((value, i) => xmlTag('cfvo', ['autoMin', 'autoMax'].includes(value.type) ? { type: 'formula', val: formulas[i] } : value)).join('');
      const rgb = color => `FF${color.slice(1).toUpperCase()}`;
      const fill = barColorOf(rule), color = xmlTag('color', { rgb: rgb(fill) });
      const extended = rule.barMode === 'extended', id = extended ? `{${crypto.randomUUID().toUpperCase()}}` : null;
      const min = rule.barMinLength ?? 10, max = rule.barMaxLength ?? 90;
      const namespace = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
      const link = extended ? xmlTag('extLst', {}, xmlTag('ext', {
        uri: '{B025F937-C7B1-47D3-B67F-A62EFF666E3E}', 'xmlns:x14': namespace,
      }, xmlTag('x14:id', {}, id))) : '';
      // The 2010 0–100 default requires a 10–90 fallback for older readers.
      const fallback = extended && min === 0 && max === 100;
      const active = rule.barActiveFormula ? xmlTag('formula', {}, xmlText(toFileFormula(wb.structuredToA1(sheet.id, thresholdAreas?.base.r1 ?? rule.range.r1, thresholdAreas?.base.c1 ?? rule.range.c1, thresholdAreas?.active || rule.barActiveFormula, null, false, { relativeRows: true })))) : '';
      blocks.push(xmlTag('conditionalFormatting', { sqref, ...(rule.pivot || rule.pivotRuleIds?.length ? { pivot: 1 } : {}) }, xmlTag('cfRule', { type: 'dataBar', priority: index + 1, ...(rule.stopIfTrue ? { stopIfTrue: 1 } : {}) },
        active + xmlTag('dataBar', { minLength: fallback ? 10 : min, maxLength: fallback ? 90 : max, showValue: Number(!rule.barOnly) }, limits + color) + link)));
      if (extended) {
        const safe = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
        const colors = [
          ...(rule.barBorder ? [['borderColor', safe(rule.barBorderColor, fill)]] : []),
          ...(!rule.barNegativeColorSame ? [['negativeFillColor', safe(rule.barNegativeColor, '#ff0000')]] : []),
          ...(rule.barBorder && rule.barNegativeBorderColorSame === false ? [['negativeBorderColor', safe(rule.barNegativeBorderColor, '#ff0000')]] : []),
          ...(rule.barAxisPosition !== 'none' ? [['axisColor', safe(rule.barAxisColor, '#000000')]] : []),
        ].map(([name, value]) => xmlTag(`x14:${name}`, { rgb: rgb(value) })).join('');
        extensions.push(xmlTag('x14:conditionalFormatting', { 'xmlns:xm': 'http://schemas.microsoft.com/office/excel/2006/main', ...(rule.pivot || rule.pivotRuleIds?.length ? { pivot: 1 } : {}) },
          xmlTag('x14:cfRule', { type: 'dataBar', id }, xmlTag('x14:dataBar', {
            minLength: min, maxLength: max, showValue: Number(!rule.barOnly), border: Number(!!rule.barBorder), gradient: Number(rule.barGradient !== false),
            direction: rule.barDirection || 'context', axisPosition: rule.barAxisPosition || 'automatic',
            negativeBarColorSameAsPositive: Number(!!rule.barNegativeColorSame),
            negativeBarBorderColorSameAsPositive: Number(rule.barNegativeBorderColorSame !== false),
          }, values.map(value => xmlTag('x14:cfvo', { type: value.type }, value.val == null ? '' : xmlTag('xm:f', {}, xmlText(value.val)))).join('') + colors))
          + xmlTag('xm:sqref', {}, sqref)));
      }
      if (thresholdAreas) index = thresholdAreas.end;
      continue;
    }
    if (rule.type === 'icons' && NATIVE_ICON_SETS[rule.iconSet]) {
      const extended = !!(NATIVE_ICON_SETS[rule.iconSet].extended || rule.iconCustom || rule.iconActiveFormula);
      recordNative(index, thresholdAreas?.end ?? index);
      const thresholds = Array.from({ length: nativeIconCount(rule) }, (_, i) => {
        const key = `iconThreshold${i}`;
        const native = typedThreshold(rule, key, nativeThresholds, convertThreshold);
        const formula = native ? null : conditionalThresholdFormula(rule, key);
        const value = native || { type: 'formula', val: toFileFormula(absoluteThresholdFormula(wb.structuredToA1(sheet.id, 0, 0, formula || '0', null, false, { relativeRows: true }))) };
        return extended ? xmlTag('x14:cfvo', { type: value.type, ...(rule[`${key}Gte`] === false ? { gte: 0 } : {}) }, xmlTag('xm:f', {}, xmlText(value.val)))
          : xmlTag('cfvo', { ...value, ...(rule[`${key}Gte`] === false ? { gte: 0 } : {}) });
      }).join('');
      const attributes = { iconSet: rule.iconSet, showValue: Number(!rule.iconOnly), reverse: Number(!!rule.iconReverse),
        ...(rule.iconPercent != null ? { percent: Number(rule.iconPercent) } : {}) };
      if (extended) {
        const choices = rule.iconCustom ? Array.from({ length: nativeIconCount(rule) }, (_, i) => xmlTag('x14:cfIcon', { iconSet: rule[`icon${i}Set`], iconId: rule[`icon${i}Id`] })).join('') : '';
        const active = rule.iconActiveFormula ? xmlTag('xm:f', {}, xmlText(toFileFormula(wb.structuredToA1(sheet.id, thresholdAreas?.base.r1 ?? rule.range.r1, thresholdAreas?.base.c1 ?? rule.range.c1, thresholdAreas?.active || rule.iconActiveFormula, null, false, { relativeRows: true })))) : '';
        extensions.push(xmlTag('x14:conditionalFormatting', { 'xmlns:xm': 'http://schemas.microsoft.com/office/excel/2006/main', ...(rule.pivot || rule.pivotRuleIds?.length ? { pivot: 1 } : {}) },
          xmlTag('x14:cfRule', { type: 'iconSet', priority: index + 1, id: `{${crypto.randomUUID().toUpperCase()}}`,
            ...(active ? { activePresent: 1 } : {}), ...(rule.stopIfTrue ? { stopIfTrue: 1 } : {}) }, active +
            xmlTag('x14:iconSet', { ...attributes, ...(rule.iconCustom ? { custom: 1 } : {}) }, thresholds + choices)) + xmlTag('xm:sqref', {}, sqref)));
      } else blocks.push(xmlTag('conditionalFormatting', { sqref, ...(rule.pivot || rule.pivotRuleIds?.length ? { pivot: 1 } : {}) }, xmlTag('cfRule', { type: 'iconSet', priority: index + 1, ...(rule.stopIfTrue ? { stopIfTrue: 1 } : {}) }, xmlTag('iconSet', attributes, thresholds))));
      if (thresholdAreas) index = thresholdAreas.end;
      continue;
    }
    if (rule.type === 'scale') {
      recordNative(index, thresholdAreas?.end ?? index);
      const limits = Object.fromEntries(SCALE_FORMULAS.map(key => [key, conditionalThresholdFormula(rule, key)]));
      // Keep ordinary automatic midpoints native so Excel copies recompute the
      // destination's percent threshold. A span outside finite arithmetic needs
      // the live formula fallback; explicit bounds already require a formula.
      const automatic = rule.mid && !SCALE_FORMULAS.some(key => limits[key]) && !rule.statisticsRange;
      const stats = automatic ? wb._conditionalStatistics(sheet, rule) : null;
      const midpointFormula = limits.scaleMin || limits.scaleMax || rule.statisticsRange || (stats && !Number.isFinite(stats.max - stats.min));
      const stops = [['scaleMin', 'min'], ...(rule.mid ? [['scaleMid', 'percent']] : []), ['scaleMax', 'max']];
      const thresholds = stops.map(([key, type]) => {
        const native = typedThreshold(rule, key, nativeThresholds, convertThreshold);
        if (native) return xmlTag('cfvo', native);
        const value = limits[key] || (key === 'scaleMid' && midpointFormula
          ? scaleMidpointFormula(limits.scaleMin || scaleThresholdFormula('min', null, statisticalRanges), limits.scaleMax || scaleThresholdFormula('max', null, statisticalRanges))
          : rule.statisticsRange ? scaleThresholdFormula(type, type === 'percent' ? 50 : null, statisticalRanges) : null);
        const formula = typeof value === 'string' && value.trim()
          ? wb.structuredToA1(sheet.id, 0, 0, value, null, false, { relativeRows: true }) : null;
        return xmlTag('cfvo', formula ? { type: 'formula', val: toFileFormula(absoluteThresholdFormula(formula)) } : { type, ...(type === 'percent' ? { val: 50 } : {}) });
      }).join('');
      const colors = scaleColors(rule).map(color => xmlTag('color', { rgb: `FF${color.slice(1).toUpperCase()}` })).join('');
      blocks.push(xmlTag('conditionalFormatting', { sqref, ...(rule.pivot || rule.pivotRuleIds?.length ? { pivot: 1 } : {}) },
        xmlTag('cfRule', { type: 'colorScale', priority: index + 1 }, xmlTag('colorScale', {}, thresholds + colors))));
      if (thresholdAreas) index = thresholdAreas.end;
      continue;
    }
    const expression = define && ['dup', 'unique'].includes(rule.type) && rule.duplicateRange != null
      ? exportNativeDuplicateFormula(rule, sheet.name, define) : conditionalRuleFormula(rule);
    if (!expression) continue;
    const g = rule.range;
    const formula = wb.structuredToA1(sheet.id, g.r1, g.c1, expression, null, false, { relativeRows: true });
    if (!formula) continue;
    let predicateGroup = predicateGroups.get(index), exportedFormula = formula;
    if (predicateGroup) {
      const base = predicateGroup.ranges.reduce((a, range) => ({ r1: Math.min(a.r1, range.r1), c1: Math.min(a.c1, range.c1) }));
      const rebased = shiftFormula(formula, base.r1 - g.r1, base.c1 - g.c1);
      // A negative relative reference at the bounding corner cannot later
      // recover in Excel. Keep separate rules when a union loses information.
      if (shiftFormula(rebased, g.r1 - base.r1, g.c1 - base.c1) !== formula) predicateGroup = null;
      else exportedFormula = rebased;
    }
    recordNative(index, predicateGroup?.end ?? index);
    // ISO 29500 §18.3.1.10: lower priority numbers win, and expressions
    // are relative to the top-left cell of sqref. App rules default to stop.
    const corner = predicateGroup ? predicateGroup.ranges.reduce((a, range) => ({ r1: Math.min(a.r1, range.r1), c1: Math.min(a.c1, range.c1) })) : g;
    const cellIs = rule.type === 'formula' ? cellIsRule(exportedFormula, cellName(corner.r1, corner.c1)) : null;
    blocks.push(xmlTag('conditionalFormatting', { sqref: (predicateGroup?.ranges || [g]).map(address).join(' '), ...(rule.pivot || rule.pivotRuleIds?.length ? { pivot: 1 } : {}) },
      xmlTag('cfRule', { type: cellIs ? 'cellIs' : 'expression', dxfId: styles.differential(rule.style), priority: index + 1,
        stopIfTrue: Number(rule.stopIfTrue !== false), ...(cellIs ? { operator: cellIs.operator } : {}) },
      (cellIs ? cellIs.formulas : [exportedFormula]).map(f => xmlTag('formula', {}, xmlText(toFileFormula(f)))).join(''))));
    if (predicateGroup) index = predicateGroup.end;
  }
  if (extensions.length) {
    // Extension URIs are case-sensitive identifiers, including the lowercase d.
    const extension = xmlTag('ext', { uri: '{78C0D931-6437-407d-A8EE-F0AAD7539E65}', 'xmlns:x14': 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main' },
      xmlTag('x14:conditionalFormattings', {}, extensions.join('')));
    // Only the worksheet's final extension list, never one inside another node.
    xml = /<extLst>[^]*<\/extLst>\s*<\/worksheet>/.test(xml)
      ? xml.replace(/<\/extLst>(\s*<\/worksheet>)/, `${extension}</extLst>$1`)
      : xml.replace('</worksheet>', `${xmlTag('extLst', {}, extension)}</worksheet>`);
  }
  // CT_Worksheet places conditionalFormatting after merges/phoneticPr and
  // before validation, hyperlinks, print settings, and drawings.
  return blocks.length ? xml.replace(/<(?:dataValidations|hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>/,
    match => blocks.join('') + match) : xml;
}
