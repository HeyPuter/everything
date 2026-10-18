/** Native ODF validation definitions and compact cell assignments. */
import { cellName } from './cell.js';
import { quoteSheet, parseRefText, shiftFormula, mapFormulaRefs } from './refs.js';
import { isRangeSource, splitList, ruleFormulaBody, validationComparisonFormula } from './validation.js';
import { fromFileFormula } from './xlfn.js';
import { finiteBound } from './xlsx-validation.js';
import { parseFormula } from './formula/parser.js';
import { tokenize } from './formula/tokenizer.js';

const quoted = (s) => `"${String(s).replace(/"/g, '""')}"`;
const xmlBool = (v, fallback) => v == null ? fallback : v === 'true' || v === '1';

function condition(rule, convert) {
  const expr = (f) => convert(ruleFormulaBody(f)).replace(/^of:=/, '');
  if (rule.type === 'any') return 'of:is-true-formula(TRUE())';
  if (['whole', 'time'].includes(rule.type) || ['number', 'date', 'text'].includes(rule.type) && rule.operator && rule.operator !== 'between') {
    const cell = cellName(rule.range.r1, rule.range.c1), value = rule.type === 'number' ? `VALUE(${cell})` : rule.type === 'text' ? `LEN(${cell})` : cell;
    const comparison = validationComparisonFormula(rule, value);
    const formula = rule.type === 'number' ? `IF(OR(ISNUMBER(${cell}),ISTEXT(${cell})),IFERROR(${comparison},FALSE()),FALSE())`
      : rule.type === 'text' ? comparison
      : `IF(ISNUMBER(${cell}),${rule.type === 'whole' ? `AND(${cell}=TRUNC(${cell}),${comparison})` : rule.type === 'date' ? `AND(${cell}>=0,${comparison})` : comparison},FALSE())`;
    return `of:is-true-formula(${expr(formula)})`;
  }
  if (rule.type === 'list') {
    let list;
    if (Array.isArray(rule.source) && rule.source.some(v => typeof v === 'number' || typeof v === 'boolean')) {
      const values = rule.source.filter(v => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)));
      list = expr('{' + values.map(v => typeof v === 'string' ? quoted(v) : typeof v === 'boolean' ? v ? 'TRUE()' : 'FALSE()' : String(v)).join(';') + '}');
    } else list = isRangeSource(rule.source) ? expr(mapFormulaRefs(rule.source, ref => ({ ...ref, absR1: true, absR2: true, absC1: true, absC2: true }))) : splitList(rule.source).map(quoted).join(';');
    return list ? `of:cell-content-is-in-list(${list})` : 'of:is-true-formula(FALSE())';
  }
  if (rule.type === 'formula') return `of:is-true-formula(${expr(rule.source)})`;
  if (rule.type === 'checkbox') return `of:is-true-formula(ISLOGICAL(${expr(cellName(rule.range.r1, rule.range.c1))}))`;
  // A bound that is not a finite number has no place in the condition, as in the .xlsx rule.
  const min = finiteBound(rule.min), max = finiteBound(rule.max);
  const numeric = rule.type === 'number' || rule.type === 'date';
  if (!numeric && rule.type !== 'text') return null;
  const value = numeric ? 'cell-content()' : 'cell-content-text-length()';
  let bound = min != null && max != null ? `${numeric ? 'cell-content' : 'cell-content-text-length'}-is-between(${min},${max})`
    : min != null ? `${value}>=${min}` : max != null ? `${value}<=${max}` : numeric ? 'is-true-formula(TRUE())' : `${value}>=0`;
  if (numeric) bound = `${rule.type === 'date' ? 'cell-content-is-date()' : 'cell-content-is-decimal-number()'} and ${bound}`;
  return `of:${bound}`;
}

export function writeOdsValidations(wb, { convert, address, escape, text }) {
  let body = '';
  wb.SheetNames.forEach((sheet, i) => {
    for (const [j, rule] of (wb.Sheets[sheet]['!validations'] || []).entries()) {
      const value = condition(rule, convert);
      if (!value) continue;
      const attrs = `table:name="dv_${i}_${j}" table:condition="${escape(value)}" table:allow-empty-cell="${rule.allowBlank !== false}" table:base-cell-address="${escape(address(`${quoteSheet(sheet)}!${cellName(rule.range.r1, rule.range.c1)}`))}" table:display-list="unsorted"`;
      const message = (tag, content, extra = '', display = true) => `<table:${tag} table:display="${display}"${extra}><text:p>${text(content || '')}</text:p></table:${tag}>`;
      body += `<table:content-validation ${attrs}>`;
      if (rule.prompt || rule.promptTitle) body += message('help-message', rule.prompt,
        rule.promptTitle ? ` table:title="${escape(rule.promptTitle)}"` : '', rule.showInputMessage !== false);
      body += message('error-message', rule.message, ` table:message-type="${rule.strict === false ? 'warning' : 'stop'}"${rule.errorTitle ? ` table:title="${escape(rule.errorTitle)}"` : ''}`);
      body += '</table:content-validation>';
    }
  });
  return body ? `<table:content-validations>${body}</table:content-validations>` : '';
}

/** Only the added empty area is repeated; existing cells and layouts keep their writer. */
export function odsValidationLayout(rules, used, sheetIndex) {
  let lastRow = used.e.r, lastCol = used.e.c;
  for (const rule of rules) { lastRow = Math.max(lastRow, rule.range.r2); lastCol = Math.max(lastCol, rule.range.c2); }
  // A file from Excel can hold one rule per cell of a scattered list (thousands of them), and the
  // writer asks about every cell and every run: the edges of the rules are sorted once and found by
  // halving, and a row is matched only against the rules that cover it.
  const edges = (axis) => [...new Set(rules.flatMap(({ range }) => [range[axis + '1'], range[axis + '2'] + 1]))].sort((a, b) => a - b);
  const rowEdges = edges('r'), colEdges = edges('c');
  const nextBoundary = (position, list, end) => {
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] > position) hi = mid; else lo = mid + 1; }
    return Math.min(end + 1, lo < list.length ? list[lo] : Infinity);
  };
  const byTop = rules.map((_, i) => i).sort((a, b) => rules[a].range.r1 - rules[b].range.r1);
  let row = -1, next = 0, active = [];
  const covering = (r) => {
    if (r < row) { next = 0; active = []; }
    if (r !== row) {
      while (next < byTop.length && rules[byTop[next]].range.r1 <= r) active.push(byTop[next++]);
      active = active.filter(i => rules[i].range.r2 >= r).sort((a, b) => b - a);
      row = r;
    }
    return active;
  };
  return {
    lastRow, lastCol,
    rows: (r) => r <= used.e.r ? 1 : nextBoundary(r, rowEdges, lastRow) - r,
    // `end` is the last column the writer declares, which a column's width or hidden state can put past
    // every rule and cell: a run there reaches it, rather than counting no cells and never advancing.
    cell: (r, c, end = lastCol) => {
      // The last rule covering the cell wins, as in the app.
      const index = covering(r).find(i => c >= rules[i].range.c1 && c <= rules[i].range.c2) ?? -1;
      return { name: index < 0 ? null : `dv_${sheetIndex}_${index}`,
        count: c <= used.e.c ? 1 : Math.max(1, nextBoundary(c, colEdges, Math.max(end, lastCol)) - c) };
    },
  };
}

/** Conditions without a matching native editor type remain live validation formulas. */
function predicateCondition(condition, convert) {
  const guard = /^cell-content-is-(whole-number|decimal-number|date|time|text)\(\)(?:\s+and\s+([\s\S]+))?$/.exec(condition);
  const body = guard ? guard[2] || 'is-true-formula(TRUE())' : condition;
  const expression = value => fromFileFormula(convert('of:=' + value.trim()));
  let predicate;
  let match = /^is-true-formula\(([\s\S]*)\)$/.exec(body);
  if (match) {
    const formula = expression(match[1]);
    predicate = () => formula;
  } else if ((match = /^cell-content(-text-length)?\(\)\s*(>=|<=|!=|<>|=|>|<)\s*([\s\S]+)$/.exec(body))) {
    const length = !!match[1], op = match[2] === '!=' ? '<>' : match[2], value = expression(match[3]);
    predicate = cell => `${length ? `LEN(${cell})` : cell}${op}(${value})`;
  } else if ((match = /^cell-content(-text-length)?-is-(not-)?between\(([\s\S]*)\)$/.exec(body))) {
    const length = !!match[1], outside = !!match[2], args = expression(match[3]);
    // Split only at the outer separator: bounds may contain calls, arrays,
    // quoted delimiters, or unions of references.
    let depth = 0, separator = null;
    try {
      for (const token of tokenize(args)) {
        if (token.type === 'lparen' || token.type === 'lbrace') depth++;
        else if (token.type === 'rparen' || token.type === 'rbrace') depth--;
        else if (token.type === 'comma' && depth === 0) {
          if (separator) return null;
          separator = token;
        }
      }
    } catch { return null; }
    if (!separator) return null;
    const low = args.slice(0, separator.start), high = args.slice(separator.end);
    if (!low.trim() || !high.trim()) return null;
    predicate = cell => {
      const subject = length ? `LEN(${cell})` : cell;
      const between = `AND(${subject}>=(${low}),${subject}<=(${high}))`;
      return outside ? `NOT(${between})` : between;
    };
  } else return null;
  return { type: 'formula', makeFormula: cell => {
    let formula = predicate(cell);
    if (guard) {
      if (guard[1] === 'whole-number') formula = `AND(${cell}=TRUNC(${cell}),${formula})`;
      formula = `IF(${guard[1] === 'text' ? 'ISTEXT' : 'ISNUMBER'}(${cell}),${formula},FALSE())`;
    }
    return '=' + formula;
  } };
}

function decodeCondition(value, convert) {
  const t = value.replace(/^(?:of|oooc):/, '').trim();
  let m = /^cell-content-is-in-list\(([\s\S]*)\)$/.exec(t);
  if (m) {
    const values = []; let rest = m[1].trim();
    while (rest) {
      const str = /^"((?:[^"]|"")*)"\s*(?:;\s*|$)/.exec(rest);
      if (!str) {
        const formula = fromFileFormula(convert('of:=' + m[1]));
        try {
          const ast = parseFormula(formula);
          const literal = (node) => {
            if (['num', 'str', 'bool'].includes(node.type)) return node.value;
            if (node.type === 'call' && !node.sheet && !node.args.length && ['TRUE', 'FALSE'].includes(node.name)) return node.name === 'TRUE';
            if (node.type === 'unary' && ['+', '-'].includes(node.op) && node.arg.type === 'num') return node.op === '-' ? -node.arg.value : node.arg.value;
            throw new Error('Not a literal');
          };
          if (ast.type === 'array') return { type: 'list', source: ast.rows.flat().map(literal) };
        } catch { /* Keep expressions as live sources. */ }
        return { type: 'list', source: '=' + formula };
      }
      values.push(str[1].replace(/""/g, '"')); rest = rest.slice(str[0].length);
    }
    return { type: 'list', source: values };
  }
  m = /^is-true-formula\(([\s\S]*)\)$/.exec(t);
  if (m) return { type: 'formula', source: '=' + fromFileFormula(convert('of:=' + m[1])) };
  const numeric = /^cell-content-is-(decimal-number|date)\(\)\s+and\s+([\s\S]*)$/.exec(t);
  const type = numeric ? numeric[1] === 'date' ? 'date' : 'number' : 'text';
  const body = numeric ? numeric[2] : t;
  if (numeric && body === 'is-true-formula(TRUE())') return { type };
  const prefix = numeric ? 'cell-content' : 'cell-content-text-length';
  const number = '([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?)';
  m = new RegExp(`^${prefix}-is-between\\(${number}\\s*[,;]\\s*${number}\\)$`).exec(body);
  if (m) return { type, min: Number(m[1]), max: Number(m[2]) };
  m = new RegExp(`^${prefix}\\(\\)\\s*(>=|<=)\\s*${number}$`).exec(body);
  if (m) return { type, [m[1] === '>=' ? 'min' : 'max']: Number(m[2]) };
  return predicateCondition(t, convert);
}

function tagEnd(xml, start, declaration = false) {
  let quote = null, brackets = 0;
  for (let at = start; at < xml.length; at++) {
    const ch = xml[at];
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (declaration && ch === '[') brackets++;
    else if (declaration && ch === ']') brackets--;
    else if (ch === '>' && brackets === 0) return at;
  }
  return xml.length;
}

/** Walk forwards to each expression, restoring namespace bindings when elements close. */
export function odsNamespaceLookup(xml, decode) {
  let at = 0;
  const bindings = new Map(), stack = [], stable = new Map();
  let rootBindings = null, rootEnd = 0;
  const stableUri = prefix => {
    if (!rootBindings?.has(prefix)) return undefined;
    // A root binding with no later declaration applies throughout the document.
    // Matches inside comments or values only disable this shortcut.
    if (!stable.has(prefix)) stable.set(prefix, xml.indexOf('xmlns:' + prefix, rootEnd) < 0 ? rootBindings.get(prefix) : undefined);
    return stable.get(prefix);
  };
  const restore = changes => {
    for (let i = changes.length - 1; i >= 0; i--) {
      const [name, previous] = changes[i];
      if (previous === undefined) bindings.delete(name); else bindings.set(name, previous);
    }
  };
  const lookup = (position, prefix) => {
    const fixed = stableUri(prefix);
    if (fixed !== undefined) return fixed;
    while (at <= position) {
      const start = xml.indexOf('<', at);
      if (start < 0 || start > position) break;
      const terminator = xml.startsWith('<!--', start) ? '-->' : xml.startsWith('<![CDATA[', start) ? ']]>' : xml.startsWith('<?', start) ? '?>' : null;
      if (terminator) {
        const end = xml.indexOf(terminator, start + 2);
        at = end < 0 ? xml.length : end + terminator.length;
        continue;
      }
      const declaration = xml.startsWith('<!', start);
      const end = tagEnd(xml, start + 1, declaration);
      at = end + 1;
      if (declaration) continue;
      const tag = xml.slice(start, end + 1);
      if (tag.startsWith('</')) { restore(stack.pop() || []); continue; }
      const changes = [];
      if (tag.includes('xmlns:')) {
        // Consume complete attributes so namespace-looking text inside a
        // quoted value cannot introduce a declaration.
        for (const attr of tag.matchAll(/\s([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
          if (!attr[1].startsWith('xmlns:')) continue;
          const name = attr[1].slice(6);
          changes.push([name, bindings.get(name)]);
          bindings.set(name, decode(attr[2] ?? attr[3]));
        }
      }
      const uri = start === position ? bindings.get(prefix) : undefined;
      if (tag.endsWith('/>')) restore(changes); else stack.push(changes);
      if (rootBindings == null && stack.length === 1) {
        rootBindings = new Map(bindings); rootEnd = at;
        const fixed = stableUri(prefix);
        if (fixed !== undefined) return fixed;
      }
      if (start === position) return uri;
    }
    return undefined;
  };
  // Only bindings already proved constant across this document can be cached
  // by a formula reader. An unbound or locally redeclared prefix is not fixed.
  lookup.isStable = prefix => stable.get(prefix) !== undefined;
  return lookup;
}

const formulaPrefix = /^([A-Za-z_\u0080-\uFFFF][\w.\-\u0080-\uFFFF]*):/;
const supportedFormulaNamespace = (uri, prefix, legacyUnboundOf) =>
  (legacyUnboundOf && uri === undefined && prefix === 'of') || uri === 'urn:oasis:names:tc:opendocument:xmlns:of:1.2' || uri === 'http://openoffice.org/2004/calc';

/** A prefix selects the formula vocabulary; its spelling alone has no meaning. */
export function odsFormulaBody(value, position, namespaceAt, legacyUnboundOf = false) {
  const prefix = formulaPrefix.exec(value);
  if (!prefix) return value;
  if (!supportedFormulaNamespace(namespaceAt(position, prefix[1]), prefix[1], legacyUnboundOf)) return null;
  return value.slice(prefix[0].length);
}

/** Reuse prefix parsing, while resolving every potentially changing binding. */
export function odsFormulaReader(xml, decode, convert, legacyUnboundOf = false) {
  const namespaceAt = odsNamespaceLookup(xml, decode);
  let prefix = '', name = '', fixed = false, supported = false;
  const reader = (formula, position) => {
    if (!prefix || !formula.startsWith(prefix)) {
      const match = formulaPrefix.exec(formula);
      if (!match) return convert(formula);
      prefix = match[0]; name = match[1];
      supported = supportedFormulaNamespace(namespaceAt(position, name), name, legacyUnboundOf);
      fixed = namespaceAt.isStable(name);
    } else if (!fixed) supported = supportedFormulaNamespace(namespaceAt(position, name), name, legacyUnboundOf);
    if (!supported) return formula;
    // The converter already accepts of:, avoiding a second prefix slice.
    return convert(prefix === 'of:' ? formula : formula.slice(prefix.length));
  };
  return reader;
}

/** Advance past each element once, including malformed input with missing closing tags. */
function* elements(xml, local) {
  const open = new RegExp(`<(?:[\\w.-]+:)?${local}(?=[\\s/>])`, 'g');
  const close = new RegExp(`</(?:[\\w.-]+:)?${local}\\s*>`, 'g');
  let match;
  while ((match = open.exec(xml))) {
    const end = tagEnd(xml, open.lastIndex);
    if (end === xml.length) break;
    const tag = xml.slice(match.index, end + 1);
    if (tag.endsWith('/>')) { open.lastIndex = end + 1; yield { tag, body: '', start: match.index }; continue; }
    close.lastIndex = end + 1;
    const closing = close.exec(xml);
    if (!closing) break;
    open.lastIndex = close.lastIndex;
    yield { tag, body: xml.slice(end + 1, closing.index), start: match.index };
  }
}

export function readOdsValidations(xml, { attributes, decode, convert, address, text }) {
  const definitions = new Map();
  if (!xml.includes('content-validation')) return definitions;
  const namespaceAt = odsNamespaceLookup(xml, decode);
  for (const element of elements(xml, 'content-validation')) {
    const attr = attributes(element.tag);
    if (!attr.name || !attr.condition) continue;
    const condition = odsFormulaBody(decode(attr.condition).trim(), element.start, namespaceAt);
    if (condition == null) continue;
    const rule = decodeCondition(condition, convert);
    if (!rule) continue;
    rule.allowBlank = xmlBool(attr['allow-empty-cell'], true);
    rule.strict = false;
    const base = attr['base-cell-address'] && address(decode(attr['base-cell-address']));
    rule.base = base && parseRefText(base[1]);
    const checkbox = rule.type === 'formula' && /^=ISLOGICAL\((\$?[A-Z]+\$?\d+)\)$/i.exec(rule.source);
    const checkboxRef = checkbox && parseRefText(checkbox[1]);
    if (checkboxRef && rule.base && checkboxRef.r1 === rule.base.r1 && checkboxRef.c1 === rule.base.c1) {
      rule.type = 'checkbox'; delete rule.source;
    }
    const body = element.body;
    for (const kind of ['help-message', 'error-message']) {
      const message = elements(body, kind).next().value;
      if (!message) continue;
      const props = attributes(message.tag);
      const paragraphs = [...elements(message.body, 'p')].map(p => text(p.body));
      if (kind === 'help-message') {
        if (paragraphs.join('\n')) rule.prompt = paragraphs.join('\n');
        if (props.title) rule.promptTitle = decode(props.title);
        if ((rule.prompt || rule.promptTitle) && !xmlBool(props.display, false)) rule.showInputMessage = false;
        continue;
      }
      if (!xmlBool(props.display, false)) continue;
      if (props.title) rule.errorTitle = decode(props.title);
      rule.message = paragraphs.join('\n');
      rule.strict = !props['message-type'] || props['message-type'] === 'stop';
    }
    definitions.set(decode(attr.name), rule);
  }
  return definitions;
}

// The last rule collected for each validation name over each column span of a
// worksheet, so a cell under it on the next row extends that rule.
const odsValidationTails = new WeakMap();

/**
 * Collect rectangles for repeated cells without allocating any cell objects.
 * A column of validated cells arrives one row at a time, and where several
 * columns are validated the rows interleave their names; each cell extends
 * the rule of its own name and columns that ended on the row above, so a
 * column stays one rule however many other columns are validated beside it.
 * The cells of such an extension lie below every rule collected so far, so
 * the order of the rules, which decides precedence, still holds.
 */
export function addOdsValidation(ws, definitions, name, r, c, rows, cols, decode) {
  const definition = definitions.get(decode(name || ''));
  if (!definition || r < 0 || c < 0) return;
  const list = ws['!validations'] || (ws['!validations'] = []);
  const range = { r1: r, c1: c, r2: r + rows - 1, c2: c + cols - 1 };
  let tails = odsValidationTails.get(ws);
  if (!tails) odsValidationTails.set(ws, tails = new Map());
  const key = `${c}:${range.c2}:${name}`;
  const previous = tails.get(key);
  if (previous && previous.range.r2 + 1 === r) {
    previous.range.r2 = range.r2; return;
  }
  const { base, makeFormula, ...rule } = definition;
  if (makeFormula) rule.source = makeFormula(cellName(base?.r1 ?? r, base?.c1 ?? c));
  if (rule.type === 'formula' && base) rule.source = shiftFormula(rule.source, r - base.r1, c - base.c1);
  const added = { ...rule, range, _odsName: name };
  list.push(added);
  tails.set(key, added);
}
