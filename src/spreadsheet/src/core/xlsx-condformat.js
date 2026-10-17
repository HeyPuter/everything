import { readXlsxIcons, iconXmlContents } from './xlsx-icons.js';
/** Native Excel conditional formats which the cell reader leaves in worksheet XML. */
import { conditionalThresholdIsFormula, readConditionalThreshold, rebaseConditionalPredicate, BAR_FORMULAS, SCALE_FORMULAS, ICON_FORMULAS, absoluteThresholdFormula } from './conditional-scale.js';
import { duplicateSourceFormula } from './conditional-duplicates.js';
import { cellName, parseRange } from './cell.js';
import { shiftFormula } from './refs.js';
import { fromFileFormula } from './xlfn.js';
import { dataBarLink, extendedBarEntries, readExtendedBar } from './xlsx-databar.js';
import { xlsxAttr as attr, xlsxElements as elements, xlsxColor, xlsxText, readXlsxDifferentialStyle } from './xlsx-styles.js';

/** Relative CFVO references are forbidden by MS-XLSX 2.6.26. For malformed
 * input Excel still parses them from the bounding sqref corner, then evaluates
 * at A1. Resolve that target once; even Excel copies keep it fixed. */
function thresholdReferences(rule, ranges, legacy) {
  if (legacy) return rule; // Versions 1/2 sidecar fingerprints used raw formulas.
  const keys = rule.type === 'scale' ? SCALE_FORMULAS : rule.type === 'databar' ? BAR_FORMULAS : rule.type === 'icons' ? ICON_FORMULAS : [];
  if (!keys.length) return rule;
  const base = ranges.reduce((a, g) => ({ r1: Math.min(a.r1, g.r1), c1: Math.min(a.c1, g.c1) }));
  const out = { ...rule };
  for (const key of keys) if (conditionalThresholdIsFormula(rule, key)) {
    out[key] = absoluteThresholdFormula(rule[key], base);
  }
  return out;
}

const BARE_NUMBER = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

/**
 * `dateTargets(ranges)`, given for a file on the 1904 date system, says whether a rule's cells are
 * date-formatted. Their values were moved to this app's 1900 serials, and a bare-number threshold over
 * them (a "greater than 2024-01-01" Excel stores as 43830) is a 1904 serial too, moved with them.
 */
export function readXlsxConditionalFormats(xml, styles, themes, definedNames, { priorities = false, legacyThresholds = false, dateTargets = null } = {}) {
  const rules = [];
  const dated = new WeakMap();
  const serial = (value, targets) => {
    if (!dateTargets || !BARE_NUMBER.test(value)) return value;
    if (!dated.has(targets)) dated.set(targets, !!dateTargets(targets));
    return dated.get(targets) ? String(Number(value) + 1462) : value;
  };
  // A scale's, a bar's or an icon set's number thresholds ("num" stops).
  const serialStops = (rule, targets) => {
    if (dateTargets) for (const key of Object.keys(rule)) if (rule[`${key}Type`] === 'num') rule[key] = serial(rule[key], targets);
    return rule;
  };
  const parseRanges = text => String(text || '').trim().split(/\s+/).flatMap(ref => {
      if (!/^\$?[A-Z]{1,3}\$?[1-9]\d*(?::\$?[A-Z]{1,3}\$?[1-9]\d*)?$/i.test(ref)) return [];
      const range = parseRange(ref);
      return range && range.r2 < 1048576 && range.c2 < 16384 ? [range] : [];
    });
  xml = (xml || '').replace(/<!--[\s\S]*?-->/g, '');
  const extended = extendedBarEntries(xml, parseRanges), byId = new Map(extended.filter(entry => !entry.priority && entry.id).map(entry => [entry.id, entry])), consumed = new Set();
  for (const block of elements(xml, 'conditionalFormatting')) {
    const inline = attr(block, 'sqref') == null;
    const ranges = parseRanges(inline ? iconXmlContents(elements(block, 'sqref')[0]) : attr(block, 'sqref'));
    if (!ranges.length) continue;
    // Excel anchors relative formulas at the bounding top-left of sqref,
    // even when that cell belongs to none of its (possibly unordered) areas.
    const base = ranges.reduce((a, g) => ({ r1: Math.min(a.r1, g.r1), c1: Math.min(a.c1, g.c1) }));
    for (const source of elements(block, 'cfRule')) {
      const type = attr(source, 'type');
      const priority = Number(attr(source, 'priority'));
      // MS-XLSX CT_CfRule: a standalone extension has a positive priority,
      // xm:f predicates and inline dxf paint. Bars/icons have separate readers.
      if (inline && (!Number.isInteger(priority) || priority <= 0 || ['dataBar', 'iconSet', 'colorScale'].includes(type))) continue;
      const formulas = elements(source, inline ? 'f' : 'formula').map(tag => fromFileFormula(xlsxText(tag.replace(/^<[^>]+>|<\/[^>]+>$/g, '')), definedNames));
      let rule, targets = ranges;
      const dxfId = attr(source, 'dxfId');
      const style = inline ? readXlsxDifferentialStyle(elements(source, 'dxf')[0], themes)
        : dxfId != null ? styles?.dxfs?.[Number(dxfId)] : {};
      if (type === 'expression' && formulas[0]) rule = { type: 'formula', value: formulas[0] };
      else if (type === 'duplicateValues' || type === 'uniqueValues') {
        rule = { type: type === 'duplicateValues' ? 'dup' : 'unique', duplicateRange: duplicateSourceFormula(ranges) };
      }
      else if (['containsText', 'notContainsText', 'beginsWith', 'endsWith'].includes(type) && attr(source, 'text') != null) {
        // Excel can list the legend before the input cells in sqref while its
        // generated formula still names the input column. Text rules test each
        // target cell itself; rebuild that reference rather than shifting the
        // saved formula from the wrong area. SEARCH keeps Excel's wildcards.
        const literal = `"${attr(source, 'text').replace(/"/g, '""')}"`, cell = cellName(base.r1, base.c1);
        const search = `ISERROR(SEARCH(${literal},${cell}))`;
        const value = type === 'containsText' ? `NOT(${search})` : type === 'notContainsText' ? search
          : `${type === 'beginsWith' ? 'LEFT' : 'RIGHT'}(${cell},LEN(${literal}))=${literal}`;
        rule = { type: 'formula', value };
      }
      else if (['containsBlanks', 'notContainsBlanks', 'containsErrors', 'notContainsErrors'].includes(type) && formulas[0]) {
        // These predicates use their saved formula, including custom references.
        // Unlike ordinary expression rules, Excel's notContainsBlanks treats a
        // failed logical conversion (errors or nonlogical text) as a match.
        rule = { type: 'formula', value: type === 'notContainsBlanks'
          ? `IFERROR(IF(${formulas[0]},TRUE,FALSE),TRUE)` : formulas[0] };
      }
      else if (type === 'cellIs' && formulas[0]) {
        formulas.splice(0, 2, ...formulas.slice(0, 2).map(value => serial(value, ranges)));
        const cell = cellName(base.r1, base.c1), op = attr(source, 'operator');
        const operators = { equal: '=', notEqual: '<>', lessThan: '<', lessThanOrEqual: '<=', greaterThan: '>', greaterThanOrEqual: '>=' };
        let value;
        if (Object.hasOwn(operators, op)) value = `${cell}${operators[op]}(${formulas[0]})`;
        else if (['between', 'notBetween'].includes(op) && formulas[1]) {
          value = `AND(${cell}>=(${formulas[0]}),${cell}<=(${formulas[1]}))`;
          if (op === 'notBetween') value = `NOT(${value})`;
        }
        if (value) rule = { type: 'formula', value };
      } else if (type === 'colorScale') {
        const scale = elements(source, 'colorScale')[0], limits = elements(scale, 'cfvo');
        const colors = elements(scale, 'color').map(tag => xlsxColor(tag, themes));
        const keys = limits.length === 3 ? ['scaleMin', 'scaleMid', 'scaleMax'] : ['scaleMin', 'scaleMax'];
        const values = limits.map((tag, i) => readConditionalThreshold(keys[i], attr(tag, 'type'), attr(tag, 'val'), ranges));
        if ([2, 3].includes(values.length) && colors.length === values.length && colors.every(Boolean) && values.every(v => v != null)) {
          rule = { type: 'scale', from: colors[0], to: colors.at(-1), ...Object.assign({}, ...values),
            ...(values.length === 3 ? { mid: colors[1] } : {}) };
          if (values.some(v => Object.keys(v).some(k => k.endsWith('Type')))) rule.statisticsRange = duplicateSourceFormula(ranges);
          for (const key of ['scaleMin', 'scaleMid', 'scaleMax']) if (rule[key]) rule[key] = fromFileFormula(rule[key], definedNames);
        }
      } else if (type === 'iconSet') {
        rule = readXlsxIcons(source, ranges, definedNames);
      } else if (type === 'dataBar') {
        const bar = elements(source, 'dataBar')[0], limits = elements(bar, 'cfvo');
        const values = limits.map((tag, i) => readConditionalThreshold(i ? 'barMaxFormula' : 'barMinFormula', attr(tag, 'type'), attr(tag, 'val'), ranges));
        const lengths = ['minLength', 'maxLength'].map((key, i) => attr(bar, key) == null ? [10, 90][i] : Number(attr(bar, key)));
        const color = xlsxColor(elements(bar, 'color')[0], themes);
        if (values.length === 2 && values.every(v => v != null) && color && lengths.every(Number.isInteger)
          && lengths[0] >= 0 && lengths[0] <= lengths[1] && lengths[1] <= 100) rule = {
          type: 'databar', barMode: 'legacy', barColor: color, barFullHeight: true,
          ...Object.assign({}, ...values),
          ...(values.some(v => Object.keys(v).some(k => k.endsWith('Type'))) ? { statisticsRange: duplicateSourceFormula(ranges) } : {}),
          barMinLength: lengths[0], barMaxLength: lengths[1],
          ...(['0', 'false'].includes(attr(bar, 'showValue')) ? { barOnly: true } : {}),
        };
        if (rule) for (const key of ['barMinFormula', 'barMaxFormula']) if (conditionalThresholdIsFormula(rule, key)) rule[key] = fromFileFormula(rule[key], definedNames);
        const entry = byId.get(dataBarLink(source));
        const replacement = entry && readExtendedBar(entry, color, themes, definedNames);
        if (replacement) {
          rule = replacement; targets = entry.ranges; consumed.add(entry);
          // Excel takes value visibility from the base record of a linked
          // data bar, even when the extension explicitly disagrees. Standalone
          // extensions still use their own showValue in readExtendedBar.
          if (['0', 'false'].includes(attr(bar, 'showValue'))) rule.barOnly = true;
          else delete rule.barOnly;
        }
        // Excel moves an x14 activation into the legacy rule's formula on save.
        if (rule && formulas[0] && !rule.barActiveFormula) rule.barActiveFormula = formulas[0];
      }
      if (!rule || (['formula', 'dup', 'unique'].includes(rule.type) && !style)) continue;
      rule = thresholdReferences(serialStops(rule, targets), targets, legacyThresholds);
      for (const [i, range] of targets.entries()) {
        if (targets.slice(0, i).some(g => g.r1 <= range.r1 && g.c1 <= range.c1 && g.r2 >= range.r2 && g.c2 >= range.c2)) continue;
        rules.push({
          ...rebaseConditionalPredicate(rule, range.r1 - base.r1, range.c1 - base.c1), range, style: { ...style }, relativeNames: true,
          ...(['1', 'true'].includes(attr(block, 'pivot')) ? { pivot: true } : {}),
          priority: Number.isFinite(priority) && priority > 0 ? priority : Infinity,
          stopIfTrue: ['1', 'true'].includes(attr(source, 'stopIfTrue')),
        });
      }
    }
  }
  for (const block of elements(xml, 'conditionalFormatting')) {
    if (attr(block, 'sqref') != null) continue;
    const ranges = parseRanges(iconXmlContents(elements(block, 'sqref')[0]));
    if (!ranges.length) continue;
    const base = ranges.reduce((a, g) => ({ r1: Math.min(a.r1, g.r1), c1: Math.min(a.c1, g.c1) }));
    for (const source of elements(block, 'cfRule')) {
      const priority = Number(attr(source, 'priority'));
      if (attr(source, 'type') !== 'iconSet' || !Number.isInteger(priority) || priority <= 0) continue;
      let rule = readXlsxIcons(source, ranges, definedNames, true);
      if (rule) rule = thresholdReferences(serialStops(rule, ranges), ranges, legacyThresholds);
      if (rule) for (const range of ranges) rules.push({ ...rule, range, style: {}, relativeNames: true, priority,
        ...(['1', 'true'].includes(attr(block, 'pivot')) ? { pivot: true } : {}),
        ...(rule.iconActiveFormula ? { iconActiveFormula: shiftFormula(rule.iconActiveFormula, range.r1 - base.r1, range.c1 - base.c1) } : {}),
        stopIfTrue: ['1', 'true'].includes(attr(source, 'stopIfTrue')) });
    }
  }
  for (const entry of extended) if (!consumed.has(entry) && entry.priority > 0) {
    let rule = readExtendedBar(entry, null, themes, definedNames);
    if (rule) rule = thresholdReferences(serialStops(rule, entry.ranges), entry.ranges, legacyThresholds);
    const base = entry.ranges.reduce((a, g) => ({ r1: Math.min(a.r1, g.r1), c1: Math.min(a.c1, g.c1) }));
    if (rule) for (const range of entry.ranges) rules.push({ ...rebaseConditionalPredicate(rule, range.r1 - base.r1, range.c1 - base.c1),
      range, style: {}, relativeNames: true, ...(entry.pivot ? { pivot: true } : {}), priority: entry.priority, stopIfTrue: ['1', 'true'].includes(attr(entry.source, 'stopIfTrue')) });
  }
  return rules.sort((a, b) => a.priority - b.priority).map(({ priority, ...rule }) => priorities ? { ...rule, priority } : rule);
}
