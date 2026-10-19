/** Native SpreadsheetML validations, kept as sparse rules rather than cell data. */
import { cellName, parseRange } from './cell.js';
import { shiftFormula, mapFormulaRefs, quoteSheet } from './refs.js';
import { fromFileFormula } from './xlfn.js';
import { ruleFormulaBody, isRangeSource, listOptions, VALIDATION_COMPARISONS, validationComparisonFormula } from './validation.js';
const MAIN = new Set(['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main']);
// Excel writes a validation whose formula reaches another worksheet into the x14 extension
// list, where the formula and the targets are xm:f and xm:sqref children rather than element
// text and an attribute; a cross-sheet dropdown from Excel arrives only through this block.
const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const XM = 'http://schemas.microsoft.com/office/excel/2006/main';
const bool = value => ['true', '1'].includes(String(value ?? '').trim());

function ranges(text) {
  return String(text || '').trim().split(/\s+/).map(ref => {
    if (!/^\$?[A-Za-z]{1,3}\$?[1-9]\d*(?::\$?[A-Za-z]{1,3}\$?[1-9]\d*)?$/.test(ref)) return null;
    const range = parseRange(ref);
    return range && range.r2 < 1048576 && range.c2 < 16384 ? range : null;
  }).filter(Boolean);
}
function convert(record, decodeString, date1904) {
  const a = record.attrs, targets = ranges(a.sqref);
  if (!targets.length) return [];
  const bound = value => {
    const formula = fromFileFormula(value || '').trim().replace(/^=\s*/, '');
    // Cell dates have already been converted to the app's 1900 epoch.
    return date1904 && a.type === 'date' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(formula) && Number.isFinite(Number(formula)) ? String(Number(formula) + 1462) : formula;
  };
  const first = bound(record.formula1), second = bound(record.formula2);
  const base = targets[0], kind = a.type || 'none', op = a.operator || 'between';
  let rule, formula;
  if (kind === 'list') {
    if (!first) return [];
    if (/^"(?:[^"]|"")*"$/.test(first)) rule = { type: 'list', source: first.slice(1, -1).replace(/""/g, '"').split(',') };
    else rule = { type: 'list', source: '=' + first, relativeSource: true };
  } else if (kind === 'custom') { if (!first) return []; formula = first; }
  else if (kind === 'none') rule = { type: 'any' };
  else if (['whole', 'decimal', 'date', 'time', 'textLength'].includes(kind)) {
    if (!first) return [];
    const cell = cellName(base.r1, base.c1), value = kind === 'textLength' ? `LEN(${cell})` : cell;
    const operators = { equal: '=', notEqual: '<>', lessThan: '<', lessThanOrEqual: '<=', greaterThan: '>', greaterThanOrEqual: '>=' };
    if (op === 'between' || op === 'notBetween') {
      if (!second) return [];
      formula = `AND(${value}>=(${first}),${value}<=(${second}))`;
      if (op === 'notBetween') formula = `NOT(${formula})`;
    } else if (Object.hasOwn(operators, op)) formula = `${value}${operators[op]}(${first})`;
    else return [];
    if (kind === 'whole') formula = `AND(${cell}=TRUNC(${cell}),${formula})`;
    if (kind !== 'textLength') formula = `IF(ISNUMBER(${cell}),${formula},FALSE())`;
  } else return [];
  // Literal whole/time criteria can retain their native editor controls. Formula bounds keep
  // the existing candidate-scoped predicate so relative and cross-sheet references stay live.
  const numericBound = value => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value));
  // Date and text-length rules come in as the app's Date and Text length rules too, which the writer saves as
  // native ones again, rather than as a formula Excel then shows as Custom.
  const native = { whole: 'whole', time: 'time', date: 'date', textLength: 'text' }[kind];
  if (native && numericBound(first) && (!['between', 'notBetween'].includes(op) || numericBound(second))) {
    rule = { type: native, min: Number(first), ...(['between', 'notBetween'].includes(op) ? { max: Number(second) } : {}), ...(op === 'between' ? {} : { operator: op }) };
    formula = null;
  }
  if (formula != null) rule = { type: 'formula', source: '=' + formula };
  const message = name => decodeString(String(a[name] || '').replace(/\r\n?/g, '\n').replace(/[\t\n]/g, ' '));
  return targets.map(range => ({
    ...rule, range,
    source: typeof rule.source === 'string' ? shiftFormula(rule.source, range.r1 - base.r1, range.c1 - base.c1) : rule.source,
    allowBlank: kind === 'none' || bool(a.allowBlank),
    strict: bool(a.showErrorMessage) && (!a.errorStyle || a.errorStyle === 'stop'),
    errorStyle: ['warning', 'information'].includes(a.errorStyle) ? a.errorStyle : 'stop',
    showErrorMessage: bool(a.showErrorMessage),
    ...(a.errorTitle ? { errorTitle: message('errorTitle') } : {}),
    ...(a.error ? { message: message('error') } : {}),
    ...(a.prompt ? { prompt: message('prompt') } : {}),
    ...(a.promptTitle ? { promptTitle: message('promptTitle') } : {}),
    ...((a.prompt || a.promptTitle) && !bool(a.showInputMessage) ? { showInputMessage: false } : {}),
  }));
}

export function readXlsxValidations(xml, rootTag, { attributes, decode, decodeString, date1904 = false }) {
  const namespaces = new Map(), stack = [], records = [];
  const declarations = attrs => {
    const changes = [];
    for (const [name, value] of Object.entries(attrs)) {
      if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
      const prefix = name === 'xmlns' ? '' : name.slice(6);
      changes.push([prefix, namespaces.get(prefix)]); namespaces.set(prefix, decode(value));
    }
    return changes;
  };
  declarations(attributes(rootTag));
  const close = (frame, at) => {
    if (frame.field) frame.record[frame.field] = decode(xml.slice(frame.start, at));
    if (frame.recordRoot) records.push(frame.recordRoot);
    for (const [prefix, previous] of frame.changes.reverse()) {
      if (previous == null) namespaces.delete(prefix); else namespaces.set(prefix, previous);
    }
  };
  // The worksheet reader has already normalized comments and CDATA. Scan only
  // the post-sheetData section, respecting quotes and namespace scope.
  const tags = /<\/?([\w.-]+(?::[\w.-]+)?)(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  let match;
  while ((match = tags.exec(xml))) {
    const tag = match[0];
    if (tag.startsWith('</')) { const frame = stack.pop(); if (frame) close(frame, match.index); continue; }
    const attrs = attributes(tag), changes = declarations(attrs), parts = match[1].split(':');
    const name = parts.at(-1), uri = namespaces.get(parts.length > 1 ? parts[0] : '');
    const frame = { name, uri, changes }, parent = stack.at(-1);
    if (name === 'dataValidation' && (MAIN.has(uri) || uri === X14) && parent?.name === 'dataValidations' && parent.uri === uri) frame.recordRoot = { attrs };
    else if (['formula1', 'formula2'].includes(name) && parent?.recordRoot && uri === parent.uri) {
      if (uri === X14) { frame.wraps = name; frame.record = parent.recordRoot; }
      else { frame.field = name; frame.record = parent.recordRoot; frame.start = tags.lastIndex; }
    } else if (name === 'f' && uri === XM && parent?.wraps) {
      frame.field = parent.wraps; frame.record = parent.record; frame.start = tags.lastIndex;
    } else if (name === 'sqref' && uri === XM && parent?.recordRoot?.attrs && parent.uri === X14) {
      frame.field = 'sqref'; frame.record = parent.recordRoot.attrs; frame.start = tags.lastIndex;
    }
    if (tag.endsWith('/>')) close(frame, tags.lastIndex); else stack.push(frame);
  }
  const rules = records.flatMap(record => convert(record, decodeString, date1904));
  // Excel uses the first native rule at an overlapping cell (also across main
  // and x14 lists). The app uses the latest edit. Import disjoint effective
  // regions so new app rules still override imports without reversing file order.
  const cuts = overlappingPriorityRules(rules, true);
  return rules.flatMap((rule, i) => {
    let parts = [rule.range];
    for (const j of cuts[i]) { parts = parts.flatMap(g => subtract(g, rules[j].range)); if (!parts.length) break; }
    return parts.map(range => ({ ...rule, range,
      source: rule.type === 'formula' || rule.relativeSource === true
        ? shiftFormula(rule.source, range.r1 - rule.range.r1, range.c1 - rule.range.c1) : rule.source }));
  });
}

/** Subtract a higher-priority region without allocating cells for its targets. */
function subtract(range, cut) {
  const r1 = Math.max(range.r1, cut.r1), c1 = Math.max(range.c1, cut.c1);
  const r2 = Math.min(range.r2, cut.r2), c2 = Math.min(range.c2, cut.c2);
  if (r1 > r2 || c1 > c2) return [range];
  return [
    { ...range, r2: r1 - 1 }, { ...range, r1: r2 + 1 },
    { r1, r2, c1: range.c1, c2: c1 - 1 }, { r1, r2, c1: c2 + 1, c2: range.c2 },
  ].filter(g => g.r1 <= g.r2 && g.c1 <= g.c2);
}
const absolute = formula => mapFormulaRefs(formula, ref => ({ ...ref, absR1: true, absR2: true, absC1: true, absC2: true }));
/**
 * A rule's bound as a finite number, or null. A bound from an older or hand-edited
 * sidecar can be text, blank, or infinite; written as it is (>=NaN, <=0 for a blank)
 * it makes a formula Excel reports as a corrupt file, so such a bound is left out.
 */
export function finiteBound(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
/**
 * Whether a Text length or Date comparison (other than between) means the same as Excel's native rule: any text
 * length comparison, and a date one that only accepts numbers at or above a bound of zero or more, where the
 * app's refusal of negative numbers changes nothing.
 */
function nativeComparison(rule) {
  const op = rule.operator, min = finiteBound(rule.min);
  if (!op || op === 'between' || (!Object.hasOwn(VALIDATION_COMPARISONS, op) && op !== 'notBetween') || min == null) return false;
  if (rule.type === 'text') return op !== 'notBetween' || finiteBound(rule.max) != null;
  return rule.type === 'date' && ['equal', 'greaterThan', 'greaterThanOrEqual'].includes(op) && min >= 0;
}
const quoted = value => '"' + String(value).replaceAll('"', '""') + '"';
function inlineList(rule) {
  const options = listOptions(rule, null, { typed: true });
  if (!options.length) return '';
  if (options.every(v => typeof v === 'string' && !/[,"\r\n]/.test(v))) {
    const text = quoted(options.join(','));
    if (text.length <= 255) return text;
  }
  return null;
}

/** Store lists that cannot fit a comma-delimited formula beside the app metadata. */
export function prepareXlsxValidationLists(book, metaSheet, extra, X, reservedNames = []) {
  const used = new Set([...reservedNames, ...(book.Workbook.Names || []).map(n => n.Name)].map(n => n.toLowerCase()));
  const cells = {}, names = [], shared = new Map(); let row = 0, col = 1, serial = 0;
  const nextName = () => {
    let name;
    do { name = `_puter_validation_${++serial}`; } while (used.has(name.toLowerCase()));
    used.add(name.toLowerCase()); return name;
  };
  for (const sheet of book.SheetNames) for (const rule of book.Sheets[sheet]['!validations'] || []) {
    if (rule.type !== 'list') continue;
    if (isRangeSource(rule.source)) {
      let crossSheet = false, relative = false;
      const formula = ruleFormulaBody(rule.source);
      const ref = mapFormulaRefs(formula, ref => {
        if (ref.sheet && ref.sheet !== sheet) crossSheet = true;
        if (!(ref.absR1 && ref.absR2 && ref.absC1 && ref.absC2)) relative = true;
        return { ...ref, sheet: ref.sheet || sheet, ...(rule.relativeSource === true ? {} : { absR1: true, absR2: true, absC1: true, absC2: true }) };
      });
      // Classic Excel dropdowns use a name for references to another sheet.
      if (crossSheet && (rule.relativeSource !== true || !relative)) {
        const name = nextName();
        names.push({ Name: name, Ref: ref, Sheet: book.SheetNames.indexOf(sheet) });
        rule.source = '=' + name;
      }
      continue;
    }
    if (inlineList(rule) != null) continue;
    const values = listOptions(rule, null, { typed: true }), key = JSON.stringify(values);
    let name = shared.get(key);
    if (!name) {
      if (row + values.length > 1048576) { row = 0; col++; }
      if (values.length > 1048576 || col >= 16384) throw new Error('Dropdown options exceed the XLSX worksheet limits');
      name = nextName(); shared.set(key, name);
      const start = row;
      for (const value of values) cells[X.utils.encode_cell({ r: row++, c: col })] = {
        t: typeof value === 'number' ? 'n' : typeof value === 'boolean' ? 'b' : 's', v: value,
      };
      names.push({ Name: name, Ref: `${quoteSheet(metaSheet)}!${absolute(cellName(start, col) + ':' + cellName(row - 1, col))}` });
    }
    rule.source = '=' + name;
  }
  if (names.length) {
    book.Workbook.Names = [...(book.Workbook.Names || []), ...names];
    extra.validationNames = names;
  }
  return cells;
}

/**
 * For each rule, the higher-priority rules whose ranges overlap it, in file order. A sweep
 * down the rows keeps only the rules still open at each rule's first row, so a
 * sheet of thousands of rules stacked in a column, which a LibreOffice file with
 * one rule per row produces, costs a look at each rule rather than at every pair.
 */
function overlappingPriorityRules(rules, firstWins = false) {
  const cuts = rules.map(() => []);
  const byRow = rules.map((rule, i) => i).sort((a, b) => rules[a].range.r1 - rules[b].range.r1 || a - b);
  const open = [];
  for (const j of byRow) {
    const range = rules[j].range;
    let shadowed = false;
    for (let k = open.length - 1; k >= 0; k--) {
      const i = open[k], other = rules[i].range;
      if (other.r2 < range.r1) { open[k] = open[open.length - 1]; open.pop(); continue; }
      if (other.c2 < range.c1 || other.c1 > range.c2) continue;
      const first = Math.min(i, j), last = Math.max(i, j);
      if (firstWins && i < j && other.r1 <= range.r1 && other.r2 >= range.r2 && other.c1 <= range.c1 && other.c2 >= range.c2) {
        // A wholly shadowed native record adds no coverage. Retire it from
        // the sweep rather than retaining quadratic cuts for duplicate rules.
        cuts[j] = [i]; shadowed = true; break;
      }
      cuts[firstWins ? last : first].push(firstWins ? first : last);
    }
    if (!shadowed) open.push(j);
  }
  for (const list of cuts) list.sort((a, b) => a - b);
  return cuts;
}

export function writeXlsxValidations(rules = [], { escape, attribute }) {
  const records = [], cuts = overlappingPriorityRules(rules);
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]; let parts = [rule.range];
    for (const j of cuts[i]) { parts = parts.flatMap(g => subtract(g, rules[j].range)); if (!parts.length) break; }
    for (const range of parts) {
      const cell = cellName(range.r1, range.c1), attrs = {
        type: 'custom', allowBlank: rule.allowBlank === false ? '0' : '1',
        showErrorMessage: rule.strict === false && rule.showErrorMessage === false ? '0' : '1',
        errorStyle: rule.strict !== false ? 'stop' : ['stop', 'warning', 'information'].includes(rule.errorStyle) ? rule.errorStyle : 'warning',
        sqref: cell + (range.r1 === range.r2 && range.c1 === range.c2 ? '' : ':' + cellName(range.r2, range.c2)),
      };
      // Excel allows 255 characters here and repairs the file, dropping the rule, past that; the full text rides in the sidecar.
      if (rule.message) attrs.error = String(rule.message).slice(0, 255);
      if (rule.errorTitle) attrs.errorTitle = String(rule.errorTitle).slice(0, 32);
      if (rule.prompt) attrs.prompt = String(rule.prompt).slice(0, 255);
      if (rule.promptTitle) attrs.promptTitle = String(rule.promptTitle).slice(0, 32);
      if (rule.prompt || rule.promptTitle) attrs.showInputMessage = rule.showInputMessage === false ? '0' : '1';
      let formula, second;
      if (rule.type === 'any') attrs.type = 'none';
      else if (rule.type === 'formula') formula = shiftFormula(ruleFormulaBody(rule.source), range.r1 - rule.range.r1, range.c1 - rule.range.c1);
      else if (rule.type === 'checkbox') formula = `ISLOGICAL(${cell})`;
      else if (rule.type === 'list') {
        attrs.type = 'list';
        if (isRangeSource(rule.source)) {
          const source = ruleFormulaBody(rule.source);
          formula = rule.relativeSource === true ? shiftFormula(source, range.r1 - rule.range.r1, range.c1 - rule.range.c1) : absolute(source);
        } else formula = inlineList(rule);
        if (!formula) { attrs.type = 'custom'; formula = 'FALSE()'; }
      } else if (rule.type === 'whole' || rule.type === 'time') {
        const min = finiteBound(rule.min), max = finiteBound(rule.max), op = rule.operator || 'between';
        if ((['between', 'notBetween'].includes(op) && min != null && max != null) || (Object.hasOwn(VALIDATION_COMPARISONS, op) && min != null)) {
          attrs.type = rule.type; attrs.operator = op; formula = String(min);
          if (op === 'between' || op === 'notBetween') second = String(max);
        } else {
          const comparison = validationComparisonFormula(rule, cell);
          formula = `IF(ISNUMBER(${cell}),${rule.type === 'whole' ? `AND(${cell}=TRUNC(${cell}),${comparison})` : comparison},FALSE())`;
        }
      } else if (nativeComparison(rule)) {
        // A text-length comparison, and a date one no negative number could pass either way, are Excel's own rules.
        const op = rule.operator;
        attrs.type = rule.type === 'date' ? 'date' : 'textLength'; attrs.operator = op; formula = String(finiteBound(rule.min));
        if (op === 'notBetween') second = String(finiteBound(rule.max));
      } else if (['number', 'date', 'text'].includes(rule.type) && rule.operator && rule.operator !== 'between') {
        const value = rule.type === 'number' ? `VALUE(${cell})` : rule.type === 'text' ? `LEN(${cell})` : cell;
        const comparison = validationComparisonFormula(rule, value);
        // Preserve existing numeric-string acceptance and date nonnegativity in public files.
        formula = rule.type === 'number' ? `IF(OR(ISNUMBER(${cell}),ISTEXT(${cell})),IFERROR(${comparison},FALSE()),FALSE())`
          : rule.type === 'date' ? `IF(ISNUMBER(${cell}),AND(${cell}>=0,${comparison}),FALSE())` : comparison;
      } else if (rule.type === 'number') {
        // The app accepts numeric strings but rejects logical values.
        const value = `VALUE(${cell})`, checks = [`ISNUMBER(${value})`], min = finiteBound(rule.min), max = finiteBound(rule.max);
        if (min != null) checks.push(`${value}>=${min}`);
        if (max != null) checks.push(`${value}<=${max}`);
        formula = `IF(OR(ISNUMBER(${cell}),ISTEXT(${cell})),IFERROR(AND(${checks.join(',')}),FALSE()),FALSE())`;
      } else if (rule.type === 'date' || rule.type === 'text') {
        attrs.type = rule.type === 'date' ? 'date' : 'textLength';
        const low = finiteBound(rule.min) ?? 0, high = finiteBound(rule.max);
        const min = rule.type === 'date' ? Math.max(0, low) : low;
        attrs.operator = high == null ? 'greaterThanOrEqual' : 'between';
        formula = String(min); if (high != null) second = String(high);
      } else continue;
      const text = Object.entries(attrs).map(([key, value]) => `${key}="${attribute(String(value))}"`).join(' ');
      records.push(`<dataValidation ${text}>${formula == null ? '' : `<formula1>${escape(formula)}</formula1>`}${second == null ? '' : `<formula2>${escape(second)}</formula2>`}</dataValidation>`);
    }
  }
  return records.length ? `<dataValidations count="${records.length}">${records.join('')}</dataValidations>` : '';
}
