/**
 * Conditional formatting in an .ods file from LibreOffice: the calcext:conditional-formats block at the end
 * of each table (LibreOffice's own extension; ODF itself has none), given as the SpreadsheetML
 * <conditionalFormatting> blocks Excel would write for the same rules, so that the .xlsx reader
 * (xlsx-condformat.js) makes them this app's rules exactly as it does Excel's.
 *
 * The reader gathers each calcext:conditional-format as { targets, entries }: its target-range-address, and
 * its entries in order, a condition as { kind: 'condition', value, base, props } (the condition text, the
 * base cell its relative references are written from, and its cell style's properties as odsCellStyle reads
 * them), a colour scale, data bar or icon set as { kind: 'scale' | 'bar' | 'icons', stops, color, set }.
 * `convert` turns an OpenFormula expression ("of:=[.A1]>[.B1]") into Excel's spelling (A1>B1), and
 * `address` an ODF range address into its [sheet, ref] parts.
 */
import { odsCellStyle } from './ods-cell-styles.js';
import { parseRange, cellName } from './cell.js';
import { shiftFormula } from './refs.js';

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const COMPARISONS = [['>=', 'greaterThanOrEqual'], ['<=', 'lessThanOrEqual'], ['!=', 'notEqual'], ['<>', 'notEqual'], ['=', 'equal'], ['>', 'greaterThan'], ['<', 'lessThan']];
const AVERAGES = { 'above-average': [1, 0], 'below-average': [0, 0], 'above-equal-average': [1, 1], 'below-equal-average': [0, 1] };
// LibreOffice's threshold kinds as Excel's cfvo types.
const STOP_TYPES = { minimum: 'min', 'auto-minimum': 'min', maximum: 'max', 'auto-maximum': 'max', percentile: 'percentile', percent: 'percent', number: 'num', formula: 'formula' };
const HEX = /^#[\da-f]{6}$/i;

/** The arguments of a call's text ("1,5" or "1;5"), split at the separators outside quotes, brackets and parentheses. */
function splitArguments(text) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { const end = text.indexOf(ch, i + 1); if (end < 0) return null; i = end; }
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if ((ch === ',' || ch === ';') && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map((part) => part.trim());
}

/** The literal text of a quoted OpenFormula string ("a ""b""" is a "b"), or null. */
const literal = (text) => (/^"(?:[^"]|"")*"$/.test(text) ? text.slice(1, -1).replace(/""/g, '"') : null);

/**
 * The cfRule elements for one condition, its formulas moved from the condition's base cell to `corner`, the
 * top-left of the targets, where Excel anchors them. Null for a condition this app has no rule for.
 */
function conditionRule(value, base, corner, dxfId, convert) {
  const formula = (text) => {
    let f;
    try { f = convert(`of:=${text}`); } catch { return null; }
    if (typeof f !== 'string' || !f.trim()) return null;
    return base ? shiftFormula(f, corner.r1 - base.r1, corner.c1 - base.c1) : f;
  };
  const cell = cellName(corner.r1, corner.c1);
  const rule = (attrs, formulas = [], extra = '') => {
    const xs = formulas.map(formula);
    if (xs.some((f) => f == null)) return null;
    return `<cfRule ${Object.entries({ ...attrs, dxfId }).map(([k, v]) => `${k}="${escape(v)}"`).join(' ')}>${xs.map((f) => `<formula>${escape(f)}</formula>`).join('')}${extra}</cfRule>`;
  };
  const text = String(value ?? '').trim();
  const call = /^([a-z-]+)\(([\s\S]*)\)$/.exec(text);
  if (call) {
    const [, name, body] = call;
    const args = splitArguments(body);
    if (!args) return null;
    if ((name === 'between' || name === 'not-between') && args.length === 2) return rule({ type: 'cellIs', operator: name === 'between' ? 'between' : 'notBetween' }, args);
    if (name === 'formula-is' && args.length >= 1) return rule({ type: 'expression' }, [body]);
    if (['contains-text', 'not-contains-text', 'begins-with', 'ends-with'].includes(name) && args.length === 1) {
      const needle = literal(args[0]);
      if (needle == null) return null;
      const type = { 'contains-text': 'containsText', 'not-contains-text': 'notContainsText', 'begins-with': 'beginsWith', 'ends-with': 'endsWith' }[name];
      return `<cfRule type="${type}" dxfId="${dxfId}" text="${escape(needle)}"/>`;
    }
    if ((name === 'top-elements' || name === 'bottom-elements') && args.length === 1 && /^\d+$/.test(args[0])) {
      return `<cfRule type="top10" dxfId="${dxfId}" rank="${Number(args[0])}"${name === 'bottom-elements' ? ' bottom="1"' : ''}/>`;
    }
    return null;
  }
  if (text === 'duplicate' || text === 'unique') return `<cfRule type="${text === 'duplicate' ? 'duplicateValues' : 'uniqueValues'}" dxfId="${dxfId}"/>`;
  if (AVERAGES[text]) return `<cfRule type="aboveAverage" dxfId="${dxfId}" aboveAverage="${AVERAGES[text][0]}" equalAverage="${AVERAGES[text][1]}"/>`;
  if (text === 'is-error' || text === 'is-no-error') {
    return `<cfRule type="${text === 'is-error' ? 'containsErrors' : 'notContainsErrors'}" dxfId="${dxfId}"><formula>${escape(`${text === 'is-error' ? '' : 'NOT('}ISERROR(${cell})${text === 'is-error' ? '' : ')'}`)}</formula></cfRule>`;
  }
  for (const [op, operator] of COMPARISONS) if (text.startsWith(op)) return rule({ type: 'cellIs', operator }, [text.slice(op.length)]);
  return null;
}

/** A threshold as Excel's cfvo, its formula (if any) in Excel's spelling. */
function stop({ type, value }, convert) {
  const kind = STOP_TYPES[type];
  if (!kind) return null;
  if (kind === 'min' || kind === 'max') return `<cfvo type="${kind}"/>`;
  let val = String(value ?? '').trim();
  if (kind === 'formula') { try { val = convert(`of:=${val}`); } catch { return null; } }
  else if (!Number.isFinite(Number(val)) || val === '') return null;
  return `<cfvo type="${kind}" val="${escape(val)}"/>`;
}
const color = (hex) => `<color rgb="FF${hex.slice(1).toUpperCase()}"/>`;

/**
 * The SpreadsheetML conditional formatting for a sheet's gathered calcext:conditional-format elements, as
 * { xml, dxfs }: the blocks for the .xlsx reader, and the cell styles their dxfId attributes index.
 */
export function odsConditionalFormatsXml(formats, { convert, address }) {
  const blocks = [], dxfs = [];
  let priority = 0;
  for (const format of formats || []) {
    const targets = String(format.targets || '').trim().split(/\s+/).map((ref) => {
      try { return address(ref)[1].replace(/\$/g, ''); } catch { return null; }
    }).filter((ref) => ref && parseRange(ref));
    if (!targets.length) continue;
    const ranges = targets.map((ref) => parseRange(ref));
    const corner = ranges.reduce((a, g) => ({ r1: Math.min(a.r1, g.r1), c1: Math.min(a.c1, g.c1) }));
    const rules = [];
    for (const entry of format.entries || []) {
      let xml = null;
      if (entry.kind === 'condition') {
        let base = null;
        try { base = entry.base ? parseRange(address(entry.base)[1].replace(/\$/g, '')) : null; } catch { base = null; }
        xml = conditionRule(entry.value, base, corner, dxfs.length, convert);
        // LibreOffice gives a cell the style of the first condition it meets, as Excel's Stop If True does.
        if (xml) { dxfs.push(odsCellStyle(entry.props) || {}); xml = xml.replace(/^<cfRule /, '<cfRule stopIfTrue="1" '); }
      } else if (entry.kind === 'scale' && [2, 3].includes(entry.stops?.length) && entry.stops.every((s) => HEX.test(s.color || ''))) {
        const cfvos = entry.stops.map((s) => stop(s, convert));
        if (cfvos.every(Boolean)) xml = `<cfRule type="colorScale"><colorScale>${cfvos.join('')}${entry.stops.map((s) => color(s.color)).join('')}</colorScale></cfRule>`;
      } else if (entry.kind === 'bar' && entry.stops?.length === 2 && HEX.test(entry.color || '')) {
        const cfvos = entry.stops.map((s) => stop(s, convert));
        if (cfvos.every(Boolean)) xml = `<cfRule type="dataBar"><dataBar>${cfvos.join('')}${color(entry.color)}</dataBar></cfRule>`;
      } else if (entry.kind === 'icons' && /^[345][A-Za-z0-9]+$/.test(entry.set || '') && entry.stops?.length === Number(entry.set[0])) {
        const cfvos = entry.stops.map((s) => stop(s, convert));
        if (cfvos.every(Boolean)) xml = `<cfRule type="iconSet"><iconSet iconSet="${escape(entry.set)}">${cfvos.join('')}</iconSet></cfRule>`;
      }
      if (xml) rules.push(xml.replace(/^<cfRule /, `<cfRule priority="${++priority}" `));
    }
    if (rules.length) blocks.push(`<conditionalFormatting sqref="${targets.join(' ')}">${rules.join('')}</conditionalFormatting>`);
  }
  return blocks.length ? { xml: blocks.join(''), dxfs } : null;
}
