/** Live Excel expressions for predicate rules authored by the app. */
import { cellName, colName } from './cell.js';
import { MAX_ROW, MAX_COL, quoteSheet } from './refs.js';
import { numberOfText, typedMoment, NUMBER_TEXT_PATTERN, NUMBER_TEXT_SPACE } from './condformat.js';
import { ruleFormulaBody } from './validation.js';
import { duplicateSourceAreas, nativeDuplicateFormula } from './conditional-duplicates.js';

const literal = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : numberOfText(value);
const text = cell => `IFERROR(${cell}&"",VALUETOTEXT(${cell}))`;
// VALUE alone also accepts dates, currency, percentages and locale separators.
// Keep the model's plain-numeral grammar, including Unicode boundary spaces.
const numeric = cell => `IF(ISNUMBER(${cell}),${cell},IF(AND(ISTEXT(${cell}),REGEXTEST(${cell},${literal(NUMBER_TEXT_PATTERN)})),NUMBERVALUE(REGEXREPLACE(${cell},${literal(`^${NUMBER_TEXT_SPACE}+|${NUMBER_TEXT_SPACE}+$`)},""),".",","),NA()))`;
const safe = formula => `IFERROR(${formula},FALSE)`;
const scopedSource = rule => {
  const areas = rule.statisticsRange && duplicateSourceAreas(rule.statisticsRange);
  if (!areas?.length) return null;
  const refs = areas.map(g => `${g.sheet ? `${quoteSheet(g.sheet)}!` : ''}${absolute(g.r1, g.c1)}:${absolute(g.r2, g.c2)}`);
  return refs.length === 1 ? refs[0] : `VSTACK(${refs.map(ref => `TOCOL(TRIMRANGE(${ref}),3)`).join(',')})`;
};
const absolute = (r, c) => cellName(r, c).replace(/([A-Z]+)(\d+)/, '$$$1$$$2');

export function conditionalRuleFormula(rule) {
  if (!rule.range) return null;
  const cell = cellName(rule.range.r1, rule.range.c1), type = rule.type;
  if (type === 'formula') return ruleFormulaBody(rule.value);
  if (type === 'empty') return `IFERROR(${cell}="",FALSE)`;
  if (type === 'notEmpty') return `IFERROR(${cell}<>"",TRUE)`;
  if (['contains', 'notContains', 'beginsWith', 'endsWith'].includes(type)) {
    const needle = String(rule.value ?? '').toLowerCase();
    if (!needle) return 'FALSE';
    const hay = `LOWER(${text(cell)})`, value = literal(needle);
    // FIND has no wildcard interpretation; * ? and ~ in app rules are literal.
    if (type === 'contains' || type === 'notContains') {
      const found = `ISNUMBER(FIND(${value},${hay}))`;
      return type === 'contains' ? found : `NOT(${found})`;
    }
    return `EXACT(${type === 'beginsWith' ? 'LEFT' : 'RIGHT'}(${hay},LEN(${value})),${value})`;
  }
  if (type === 'eq' || type === 'neq') {
    const sameText = `AND(NOT(ISBLANK(${cell})),EXACT(LOWER(${text(cell)}),${literal(String(rule.value ?? '').toLowerCase())}))`;
    const value = number(rule.value);
    // Text that reads as a date or a time also matches the cell holding that moment.
    const moment = value === null ? typedMoment(rule.value) : null;
    const same = value !== null ? `IFERROR(${numeric(cell)}=${value},${sameText})`
      : moment !== null ? `OR(AND(ISNUMBER(${cell}),${cell}=${moment}),${sameText})` : sameText;
    return type === 'eq' ? same : `NOT(${same})`;
  }
  const operators = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
  if (Object.hasOwn(operators, type)) {
    const value = number(rule.value);
    return value === null ? 'FALSE' : safe(`${numeric(cell)}${operators[type]}${value}`);
  }
  if (type === 'between') {
    const a = number(rule.value), b = number(rule.value2);
    return a === null || b === null ? 'FALSE' : safe(`AND(${numeric(cell)}>=${Math.min(a, b)},${numeric(cell)}<=${Math.max(a, b)})`);
  }
  if (type === 'dup' || type === 'unique') {
    if (rule.duplicateRange != null) return nativeDuplicateFormula(rule);
    const g = rule.range, range = '_cfValues';
    const source = scopedSource(rule) || (g.r1 === 0 && g.r2 === MAX_ROW ? `$${colName(g.c1)}:$${colName(g.c2)}`
      : g.c1 === 0 && g.c2 === MAX_COL ? `$${g.r1 + 1}:$${g.r2 + 1}` : `${absolute(g.r1, g.c1)}:${absolute(g.r2, g.c2)}`);
    const trimmed = value => `LOWER(REGEXREPLACE(${value}&"",${literal(`^${NUMBER_TEXT_SPACE}+|${NUMBER_TEXT_SPACE}+$`)},""))`;
    // App identities distinguish numbers, booleans and text, trim text edges,
    // and treat wildcard/operator characters literally. Native duplicateValues
    // uses different matching rules, so serialize the actual typed predicate.
    const count = (kind, same) => `SUMPRODUCT(IFERROR(${kind}(${range})*(${same}),0))`;
    // '=' rounds numeric comparisons in formulas, whereas app identities compare
    // stored numbers exactly. Exact XMATCH preserves that contract. First/last
    // positions distinguish zero, one and multiple hits in the filtered array.
    const numbers = `IF(SUMPRODUCT(--ISNUMBER(${range}))=0,0,LET(_cfNumbers,FILTER(TOCOL(${range}),TOCOL(ISNUMBER(${range}))),_cfFirst,IFERROR(XMATCH(${cell},_cfNumbers,0,1),0),_cfLast,IFERROR(XMATCH(${cell},_cfNumbers,0,-1),0),IF(_cfFirst=0,0,1+--(_cfFirst<>_cfLast))))`;
    const booleans = count('ISLOGICAL', `${range}=${cell}`);
    const strings = count('ISTEXT', `(${range}<>"")*EXACT(${trimmed(range)},${trimmed(cell)})`);
    // Trim blank edges dynamically so whole-column rules do not materialize a
    // million array elements, while newly entered values still join the count.
    return safe(`LET(${range},TRIMRANGE(${source}),AND(NOT(ISBLANK(${cell})),${cell}<>"",IF(ISNUMBER(${cell}),${numbers},IF(ISLOGICAL(${cell}),${booleans},${strings}))${type === 'dup' ? '>1' : '=1'}))`);
  }
  if (type === 'top' || type === 'bottom') {
    const count = Math.trunc(number(rule.value) ?? 0);
    if (count < 1) return 'FALSE';
    const g = rule.range, range = scopedSource(rule) || `${absolute(g.r1, g.c1)}:${absolute(g.r2, g.c2)}`;
    // AGGREGATE ignores error cells, as the model's numeric range statistics do. Only a number ranks:
    // text that reads as one is no more ranked than counted.
    const rank = rule.percent ? `MAX(1,INT(COUNT(${range})*${count}/100))` : count;
    return safe(`AND(ISNUMBER(${cell}),${cell}${type === 'top' ? '>=' : '<='}AGGREGATE(${type === 'top' ? 14 : 15},6,${range},MIN(${rank},COUNT(${range}))))`);
  }
  if (type === 'date') {
    const day = `INT(${numeric(cell)})`, today = 'TODAY()', sunday = `${today}-WEEKDAY(${today})+1`;
    const periods = {
      today: `${day}=${today}`, yesterday: `${day}=${today}-1`, tomorrow: `${day}=${today}+1`,
      last7: `AND(${day}<=${today},${day}>${today}-7)`, next7: `AND(${day}>=${today},${day}<${today}+7)`,
      thisWeek: `AND(${day}>=${sunday},${day}<${sunday}+7)`, lastWeek: `AND(${day}>=${sunday}-7,${day}<${sunday})`,
      thisMonth: `AND(YEAR(${day})=YEAR(${today}),MONTH(${day})=MONTH(${today}))`,
      lastMonth: `AND(YEAR(${day})=YEAR(EDATE(${today},-1)),MONTH(${day})=MONTH(EDATE(${today},-1)))`,
      thisYear: `YEAR(${day})=YEAR(${today})`, past: `${day}<${today}`, future: `${day}>${today}`,
    };
    return Object.hasOwn(periods, rule.value) ? safe(periods[rule.value]) : 'FALSE';
  }
  return null;
}
