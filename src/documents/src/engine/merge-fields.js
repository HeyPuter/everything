// Mail merge field evaluation (ECMA-376 Part 1 §17.16.5): MERGEFIELD,
// ADDRESSBLOCK, GREETINGLINE and the merge rules ASK, FILLIN, IF, MERGEREC,
// MERGESEQ, NEXT, NEXTIF, SET, SKIPIF, plus REF to a bookmark that ASK or SET
// assigned. This module is pure: it reads field codes and recipient records and
// returns result text. Placing results in a document is the caller's job.
//
// A field code with nested fields in its instruction is written with braces,
// as field codes are conventionally displayed: IF "{ MERGEFIELD City }" = "Oslo" "Hei" "Hello".

import { formatPageNumber } from './page-numbering.js';

/** Address concepts an address block or greeting line draws on, with column names they commonly appear under. */
export const ADDRESS_FIELDS = [
  { id: 'title', label: 'Courtesy title', token: '_TITLE0_', aliases: ['title', 'courtesy title', 'salutation', 'prefix', 'honorific'] },
  { id: 'first', label: 'First name', token: '_FIRST0_', aliases: ['first name', 'firstname', 'first', 'given name', 'forename'] },
  { id: 'middle', label: 'Middle name', token: '_MIDDLE0_', aliases: ['middle name', 'middle', 'middle initial'] },
  { id: 'last', label: 'Last name', token: '_LAST0_', aliases: ['last name', 'lastname', 'last', 'surname', 'family name'] },
  { id: 'suffix', label: 'Suffix', token: '_SUFFIX0_', aliases: ['suffix', 'name suffix'] },
  { id: 'nickname', label: 'Nickname', token: '_NICK0_', aliases: ['nickname', 'preferred name', 'known as'] },
  { id: 'company', label: 'Company', token: '_COMPANY_', aliases: ['company', 'company name', 'organization', 'organisation', 'business', 'employer'] },
  { id: 'address1', label: 'Address line 1', token: '_STREET1_', aliases: ['address line 1', 'address 1', 'address1', 'address', 'street', 'street address', 'street 1'] },
  { id: 'address2', label: 'Address line 2', token: '_STREET2_', aliases: ['address line 2', 'address 2', 'address2', 'street 2', 'suite', 'apartment'] },
  { id: 'city', label: 'City', token: '_CITY_', aliases: ['city', 'town', 'locality'] },
  { id: 'state', label: 'State or province', token: '_STATE_', aliases: ['state', 'province', 'region', 'county', 'state or province'] },
  { id: 'postal', label: 'Postal code', token: '_POSTAL_', aliases: ['zip', 'zip code', 'zipcode', 'postal code', 'postcode', 'post code'] },
  { id: 'country', label: 'Country or region', token: '_COUNTRY_', aliases: ['country', 'country or region', 'nation'] },
  { id: 'phone', label: 'Phone', token: null, aliases: ['phone', 'telephone', 'phone number', 'mobile', 'cell'] },
  { id: 'email', label: 'Email address', token: null, aliases: ['email', 'e-mail', 'email address', 'e-mail address', 'mail'] },
];
const TOKEN_FIELDS = new Map(ADDRESS_FIELDS.filter(f => f.token).map(f => [f.token, f.id]));

/** Columns a new typed list starts with. */
export const DEFAULT_COLUMNS = ['Title', 'First Name', 'Last Name', 'Company', 'Address Line 1', 'Address Line 2', 'City', 'State', 'ZIP Code', 'Country', 'Phone', 'Email'];

/** Field types the merge evaluates; everything else keeps its cached result. */
export const MERGE_TYPES = new Set(['MERGEFIELD', 'ADDRESSBLOCK', 'GREETINGLINE', 'ASK', 'FILLIN', 'IF', 'MERGEREC', 'MERGESEQ', 'NEXT', 'NEXTIF', 'SET', 'SKIPIF']);

const normalize = name => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Pair each address concept with the column it most likely lives in: { first: 'First Name', … }. */
export function autoMatchFields(columns) {
  const mapping = {}, used = new Set();
  for (const field of ADDRESS_FIELDS) {
    const wanted = new Set([field.label, ...field.aliases].map(normalize));
    const column = columns.find(c => !used.has(c) && wanted.has(normalize(c)));
    if (column) { mapping[field.id] = column; used.add(column); }
  }
  return mapping;
}

/* ---- Field code syntax ---- */

/** Split a flattened field code into text and nested field codes: { parts: [string | node] }. Unbalanced braces stay text. */
export function parseFieldCode(text) {
  const root = { parts: [] }, stack = [root];
  const push = (node, s) => { const parts = node.parts; if (typeof parts.at(-1) === 'string') parts[parts.length - 1] += s; else parts.push(s); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') { const node = { parts: [] }; stack.at(-1).parts.push(node); stack.push(node); }
    else if (c === '}' && stack.length > 1) stack.pop();
    else push(stack.at(-1), c);
  }
  // An unclosed brace is literal text: fold the open nodes back into their parents.
  while (stack.length > 1) {
    const node = stack.pop(), parent = stack.at(-1);
    parent.parts.pop();
    push(parent, '{' + flattenFieldCode(node));
  }
  return root;
}

/** The text form of a parsed field code. */
export function flattenFieldCode(node) {
  return node.parts.map(part => typeof part === 'string' ? part : `{${flattenFieldCode(part)}}`).join('');
}

/** The field keyword of a code: 'MERGEFIELD', 'IF', … */
export function fieldKeyword(code) {
  const text = typeof code === 'string' ? code : node(code).parts.find(p => typeof p === 'string' && p.trim()) || '';
  return /^\s*([A-Za-z]+)/.exec(text)?.[1]?.toUpperCase() || '';
}
const node = code => typeof code === 'string' ? parseFieldCode(code) : code;

/**
 * Tokens of an instruction: whitespace-separated words and "quoted text" (with \" and \\ escapes).
 * Placeholders for nested results are kept inside their token, so a nested result with spaces stays one argument.
 */
export function tokenizeInstruction(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    if (text[i] === '"') {
      let value = ''; i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) { value += text[i + 1]; i += 2; }
        else value += text[i++];
      }
      i++; tokens.push({ value, quoted: true });
    } else {
      let value = '';
      while (i < text.length && !/\s/.test(text[i])) value += text[i++];
      tokens.push({ value, quoted: false });
    }
  }
  return tokens;
}

/** Quote an argument for a field instruction. */
export const quoteArgument = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** A MERGEFIELD name, quoted when it has spaces or quotes. */
export const fieldName = name => /^[^\s"\\{}]+$/.test(name) ? name : quoteArgument(name);

/** Split tokens after the keyword into positional arguments and switches ({ '\\b': 'text', '\\o': true, '\\*': ['Upper'] }). */
export function fieldSwitches(tokens, withArgument = ['\\b', '\\f', '\\d', '\\e', '\\c', '\\l', '\\#', '\\@']) {
  const args = [], switches = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.quoted && /^\\./.test(t.value)) {
      const key = t.value.slice(0, 2).toLowerCase();
      // A switch argument can be glued on (\*Upper) or follow as the next token.
      const glued = t.value.slice(2);
      if (key === '\\*') { (switches[key] ||= []).push(glued || tokens[++i]?.value || ''); continue; }
      if (withArgument.includes(key)) { switches[key] = glued || (tokens[i + 1] ? tokens[++i].value : ''); continue; }
      switches[key] = true;
    } else args.push(t.value);
  }
  return { args, switches };
}

/* ---- Formatting switches (§17.16.4) ---- */

const capitalize = word => word ? word[0].toLocaleUpperCase() + word.slice(1) : word;
function applyGeneralFormats(value, formats = []) {
  for (const f of formats) {
    const name = String(f).toLowerCase();
    if (name === 'upper') value = value.toLocaleUpperCase();
    else if (name === 'lower') value = value.toLocaleLowerCase();
    else if (name === 'firstcap') value = capitalize(value);
    else if (name === 'caps') value = value.replace(/\p{L}[\p{L}\p{M}'’]*/gu, w => capitalize(w.toLocaleLowerCase()));
    else if (['arabic', 'roman', 'alphabetic'].includes(name) && /^\s*\d+\s*$/.test(value)) {
      const n = Number(value), upper = f === f.toUpperCase();
      if (n > 0 && Number.isSafeInteger(n)) value = formatPageNumber(n, name === 'arabic' ? 'decimal' : name === 'roman' ? (upper ? 'upperRoman' : 'lowerRoman') : (upper ? 'upperLetter' : 'lowerLetter'));
    } else if (name === 'ordinal' && /^\s*\d+\s*$/.test(value)) {
      const n = Number(value), tens = n % 100;
      value = `${n}${tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;
    }
  }
  return value;
}

/** A numeric picture (\# "$#,##0.00"): digits, grouping, decimals and literal text around them. */
export function formatNumberPicture(value, picture) {
  const number = Number(String(value).replace(/[,\s$€£¥]/g, ''));
  if (!String(value).trim() || !Number.isFinite(number)) return value;
  const sections = picture.split(';');
  const section = number < 0 && sections[1] !== undefined ? sections[1] : number === 0 && sections[2] !== undefined ? sections[2] : sections[0];
  const negativeSection = number < 0 && sections[1] !== undefined;
  const first = section.search(/[0#x]/), last = Math.max(section.lastIndexOf('0'), section.lastIndexOf('#'), section.lastIndexOf('x'));
  if (first < 0) return section.replace(/'([^']*)'/g, '$1');
  const prefix = section.slice(0, first).replace(/'([^']*)'/g, '$1'), suffix = section.slice(last + 1).replace(/'([^']*)'/g, '$1');
  const body = section.slice(first, last + 1), dot = body.indexOf('.');
  const decimals = dot < 0 ? 0 : body.slice(dot + 1).replace(/[^0#]/g, '').length;
  const required = dot < 0 ? 0 : body.slice(dot + 1).replace(/[^0]/g, '').length;
  const integerDigits = (dot < 0 ? body : body.slice(0, dot)).replace(/[^0]/g, '').length;
  let [whole, fraction = ''] = Math.abs(number).toFixed(decimals).split('.');
  fraction = fraction.replace(/0+$/, '').padEnd(required, '0');
  whole = whole.padStart(integerDigits, '0');
  if (whole === '0' && !integerDigits && fraction) whole = '';
  if (body.includes(',')) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = number < 0 && !negativeSection ? '-' : '';
  return `${sign}${prefix}${whole}${fraction ? '.' + fraction : ''}${suffix}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** A date picture (\@ "MMMM d, yyyy") applied to a value that reads as a date; other values pass through. */
export function formatDatePicture(value, picture) {
  const text = String(value).trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(text);
  const date = iso ? new Date(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0)) : text && !/^\d+$/.test(text) ? new Date(text) : null;
  if (!date || Number.isNaN(date.getTime())) return value;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const h12 = date.getHours() % 12 || 12;
  const tokens = { yyyy: date.getFullYear(), yy: pad(date.getFullYear() % 100), MMMM: MONTHS[date.getMonth()], MMM: MONTHS[date.getMonth()].slice(0, 3), MM: pad(date.getMonth() + 1), M: date.getMonth() + 1,
    dddd: DAYS[date.getDay()], ddd: DAYS[date.getDay()].slice(0, 3), dd: pad(date.getDate()), d: date.getDate(), HH: pad(date.getHours()), H: date.getHours(), hh: pad(h12), h: h12, mm: pad(date.getMinutes()),
    'AM/PM': date.getHours() < 12 ? 'AM' : 'PM', 'am/pm': date.getHours() < 12 ? 'am' : 'pm' };
  return picture.replace(/'([^']*)'|AM\/PM|am\/pm|yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm/g, (m, literal) => literal !== undefined ? literal : String(tokens[m]));
}

/** Apply a field's formatting switches to a merged value. */
export function formatValue(value, switches) {
  let text = String(value ?? '');
  if (switches['\\#'] && text) text = formatNumberPicture(text, switches['\\#']);
  if (switches['\\@'] && text) text = formatDatePicture(text, switches['\\@']);
  text = applyGeneralFormats(text, switches['\\*']);
  if (text && typeof switches['\\b'] === 'string') text = switches['\\b'] + text;
  if (text && typeof switches['\\f'] === 'string') text = text + switches['\\f'];
  return text;
}

/* ---- Address blocks and greeting lines ---- */

/** Address block formats offered by the dialog: [id, label, name format]. */
export const NAME_FORMATS = [
  ['firstLast', 'Avery Quinn', '<<_FIRST0_>><< _LAST0_>>'],
  ['titleFirstLast', 'Dr. Avery Quinn', '<<_TITLE0_ >><<_FIRST0_>><< _LAST0_>>'],
  ['full', 'Dr. Avery J. Quinn III', '<<_TITLE0_ >><<_FIRST0_>><< _MIDDLE0_>><< _LAST0_>><< _SUFFIX0_>>'],
  ['firstLastSuffix', 'Avery Quinn III', '<<_FIRST0_>><< _LAST0_>><< _SUFFIX0_>>'],
  ['lastFirst', 'Quinn, Avery', '<<_LAST0_>><<, _FIRST0_>>'],
  ['titleLast', 'Dr. Quinn', '<<_TITLE0_ >><<_LAST0_>>'],
  ['first', 'Avery', '<<_FIRST0_>>'],
];
export const GREETING_NAMES = [
  ['titleLast', 'Dr. Quinn', '<<_TITLE0_ >><<_LAST0_>>'],
  ['first', 'Avery', '<<_FIRST0_>>'],
  ['firstLast', 'Avery Quinn', '<<_FIRST0_>><< _LAST0_>>'],
  ['titleFirstLast', 'Dr. Avery Quinn', '<<_TITLE0_ >><<_FIRST0_>><< _LAST0_>>'],
  ['nickname', 'Ave', '<<_NICK0_>>'],
];
export const SAMPLE_RECIPIENT = { title: 'Dr.', first: 'Avery', middle: 'J.', last: 'Quinn', suffix: 'III', nickname: 'Ave', company: 'Northwind Studio', address1: '42 Harbor Lane', address2: 'Suite 5', city: 'Portland', state: 'OR', postal: '97201', country: 'United States' };

/** The ADDRESSBLOCK format for dialog choices. */
export function addressBlockFormat({ name = 'titleFirstLast', company = true, postal = true, country = 'unlessExcluded' } = {}) {
  const nameFormat = (NAME_FORMATS.find(f => f[0] === name) || NAME_FORMATS[1])[2];
  let format = nameFormat;
  if (company) format += '\n<<_COMPANY_\n>>'; else format += '\n';
  if (postal) format += '<<_STREET1_\n>><<_STREET2_\n>><<_CITY_>><<, _STATE_>><< _POSTAL_>>' + (country === 'never' ? '' : '<<\n_COUNTRY_>>');
  return format.replace(/\n$/, '');
}

/** An ADDRESSBLOCK instruction: format, company and country exclusion switches. */
export function addressBlockInstruction(options = {}) {
  const { company = true, country = 'unlessExcluded', excluded = 'United States' } = options;
  return ` ADDRESSBLOCK \\f ${quoteArgument(addressBlockFormat(options))} \\c ${company ? 1 : 0}${country === 'unlessExcluded' && excluded ? ` \\e ${quoteArgument(excluded)}` : ''} `;
}

/** The GREETINGLINE format for dialog choices. */
export function greetingFormat({ salutation = 'Dear', name = 'titleLast', punctuation = ',' } = {}) {
  const nameFormat = (GREETING_NAMES.find(f => f[0] === name) || GREETING_NAMES[0])[2];
  return `${salutation ? `<<_BEFORE_ ${salutation} >>` : ''}${nameFormat}${punctuation ? `<<_AFTER_ ${punctuation}>>` : ''}`;
}
export function greetingInstruction(options = {}) {
  const fallback = options.fallback ?? 'Dear Friend,';
  return ` GREETINGLINE \\f ${quoteArgument(greetingFormat(options))}${fallback ? ` \\e ${quoteArgument(fallback)}` : ''} `;
}

/** Expand <<prefix _TOKEN_ suffix>> groups; a group whose token is empty disappears. Returns { text, filled }. */
function expandGroups(format, lookup) {
  let filled = 0;
  const text = format.replace(/\\n/g, '\n').replace(/\r\n?/g, '\n').replace(/<<([\s\S]*?)>>/g, (whole, group) => {
    const match = /_([A-Z]+[0-9]?)_/.exec(group);
    if (!match) return group;
    const token = match[0];
    if (token === '_BEFORE_' || token === '_AFTER_') return '\u0002' + token + group.replace(token, '').replace(/^ /, '') + '\u0002';
    const value = lookup(token);
    if (!value) return '';
    filled++;
    return group.replace(token, value);
  });
  return { text, filled };
}

/** Render an ADDRESSBLOCK for one record: lines joined with \n, blank lines removed. */
export function renderAddressBlock(instruction, field) {
  const { switches } = fieldSwitches(tokenizeInstruction(instruction).slice(1));
  const format = typeof switches['\\f'] === 'string' && switches['\\f'] ? switches['\\f'] : addressBlockFormat();
  const includeCompany = switches['\\c'] === undefined || switches['\\c'] === true || switches['\\c'] !== '0';
  const excluded = typeof switches['\\e'] === 'string' ? switches['\\e'].trim().toLowerCase() : '';
  const { text } = expandGroups(format, token => {
    const id = TOKEN_FIELDS.get(token); if (!id) return '';
    if (id === 'company' && !includeCompany) return '';
    const value = String(field(id) ?? '').trim();
    if (id === 'country' && excluded && value.toLowerCase() === excluded) return '';
    return value;
  });
  return text.split('\n').map(line => line.replace(/\s+$/, '')).filter(line => line.trim()).join('\n');
}

/** Render a GREETINGLINE for one record; with no name it uses the \e text. */
export function renderGreetingLine(instruction, field) {
  const { switches } = fieldSwitches(tokenizeInstruction(instruction).slice(1));
  const format = typeof switches['\\f'] === 'string' && switches['\\f'] ? switches['\\f'] : greetingFormat();
  const { text, filled } = expandGroups(format, token => {
    const id = TOKEN_FIELDS.get(token);
    return id ? String(field(id) ?? '').trim() : '';
  });
  if (!filled) return typeof switches['\\e'] === 'string' ? switches['\\e'] : '';
  // _BEFORE_ text joins the name with a space; _AFTER_ punctuation follows directly.
  return text.replace(/\u0002_BEFORE_([^\u0002]*)\u0002/g, (_, s) => s.trim() ? s.trim() + ' ' : '').replace(/\u0002_AFTER_([^\u0002]*)\u0002/g, (_, s) => s.trim()).replace(/\s+/g, ' ').trim();
}

/* ---- Rules ---- */

const wildcard = pattern => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '[\\s\\S]') + '$');
const numeric = value => /^\s*[-+]?(\d+(\.\d*)?|\.\d+)\s*$/.test(value) ? Number(value) : null;
/** Compare two operands the way IF, NEXTIF and SKIPIF do: numbers numerically, text exactly, = and <> with * and ? wildcards. */
export function compareOperands(left, operator, right) {
  const a = numeric(left), b = numeric(right);
  if (operator === '=' || operator === '<>') {
    const equal = a !== null && b !== null ? a === b : /[*?]/.test(right) ? wildcard(right).test(left) : left === right;
    return operator === '=' ? equal : !equal;
  }
  const order = a !== null && b !== null ? Math.sign(a - b) : left.localeCompare(right);
  return { '<': order < 0, '<=': order <= 0, '>': order > 0, '>=': order >= 0 }[operator] ?? false;
}
const OPERATORS = ['<>', '<=', '>=', '=', '<', '>'];
/** Split "City=Oslo"-style glued comparisons into three tokens. */
function splitOperators(tokens) {
  const out = [];
  for (const t of tokens) {
    if (t.quoted || OPERATORS.includes(t.value)) { out.push(t); continue; }
    const m = /^(.*?)(<>|<=|>=|=|<|>)(.*)$/.exec(t.value);
    if (m && (m[1] || m[3])) { if (m[1]) out.push({ value: m[1], quoted: false }); out.push({ value: m[2], quoted: false }); if (m[3]) out.push({ value: m[3], quoted: false }); }
    else out.push(t);
  }
  return out;
}
/** Evaluate a condition from tokens [left, operator, right]; returns { result, rest }. */
function condition(tokens) {
  const list = splitOperators(tokens);
  if (list.length >= 3 && OPERATORS.includes(list[1].value) && !list[1].quoted) return { result: compareOperands(list[0].value, list[1].value, list[2].value), rest: list.slice(3) };
  // A lone expression is true when it is a nonzero number or nonempty text.
  const value = list[0]?.value ?? '';
  return { result: numeric(value) !== null ? numeric(value) !== 0 : !!value, rest: list.slice(1) };
}

/* ---- Evaluation ---- */

/**
 * Merge context for one output copy. `data` is the ordered list of records being merged
 * ({ number, values: { column: value } }); `cursor` indexes it. NEXT and NEXTIF move the cursor;
 * SKIPIF marks the copy skipped. `variables` holds ASK and SET bookmarks.
 */
export function mergeContext({ data = [], cursor = 0, sequence = 1, mapping = {}, answers = {}, variables = new Map(), placeholders = false, onIssue = () => {} } = {}) {
  return { data, cursor, sequence, mapping, answers, variables, placeholders, onIssue, skipped: false, used: new Set([cursor]), exhausted: cursor >= data.length };
}

const record = ctx => ctx.data[ctx.cursor] || null;
function columnValue(ctx, name) {
  const rec = record(ctx);
  if (!rec) return '';
  if (Object.hasOwn(rec.values, name)) return rec.values[name] ?? '';
  // Column names match regardless of case and spacing, as data sources rename freely.
  const key = Object.keys(rec.values).find(k => normalize(k) === normalize(name));
  return key === undefined ? undefined : rec.values[key] ?? '';
}
function conceptValue(ctx, id) {
  const column = ctx.mapping[id];
  if (column) return columnValue(ctx, column) ?? '';
  const field = ADDRESS_FIELDS.find(f => f.id === id);
  const rec = record(ctx);
  if (!rec || !field) return '';
  const key = Object.keys(rec.values).find(k => [field.label, ...field.aliases].some(a => normalize(a) === normalize(k)));
  return key === undefined ? '' : rec.values[key] ?? '';
}
const advance = ctx => { ctx.cursor++; ctx.used.add(ctx.cursor); if (ctx.cursor >= ctx.data.length) ctx.exhausted = true; };

/** The display text a field shows outside preview: «City», «AddressBlock», «Next Record»… */
export function placeholderText(code) {
  const tree = node(code), keyword = fieldKeyword(tree);
  const flat = flattenFieldCode(tree);
  const { args, switches } = fieldSwitches(tokenizeInstruction(flat).slice(1));
  switch (keyword) {
    case 'MERGEFIELD': return `«${args[0] || 'Field'}»`;
    case 'ADDRESSBLOCK': return '«AddressBlock»';
    case 'GREETINGLINE': return '«GreetingLine»';
    case 'NEXT': return '«Next Record»';
    case 'NEXTIF': return '«Next Record If…»';
    case 'SKIPIF': return '«Skip Record If…»';
    case 'MERGEREC': return '«Merge Record #»';
    case 'MERGESEQ': return '«Merge Sequence #»';
    case 'ASK': return `«Ask: ${args[0] || ''}»`;
    case 'SET': return `«Set: ${args[0] || ''}»`;
    case 'FILLIN': return typeof switches['\\d'] === 'string' && switches['\\d'] ? switches['\\d'] : '«Fill-in»';
    default: return null;
  }
}

/**
 * Evaluate a field code against the context: a string result, or null for fields the merge does
 * not own (their cached result stays). REF evaluates only for ASK/SET bookmarks.
 */
export function evaluateField(code, ctx) {
  const tree = node(code), keyword = fieldKeyword(tree);
  if (!MERGE_TYPES.has(keyword) && keyword !== 'REF') return null;
  // Nested fields evaluate first, their results standing in as single arguments.
  const values = [];
  let flat = '';
  for (const part of tree.parts) {
    if (typeof part === 'string') { flat += part; continue; }
    const value = evaluateField(part, ctx);
    values.push(value ?? '');
    flat += `\u0001${values.length - 1}\u0001`;
  }
  const tokens = tokenizeInstruction(flat).map(t => ({ ...t, value: t.value.replace(/\u0001(\d+)\u0001/g, (_, i) => values[i]) }));
  const rest = tokens.slice(1);
  if (keyword === 'REF') {
    const name = rest[0]?.value;
    return ctx.variables.has(name) ? formatValue(ctx.variables.get(name), fieldSwitches(rest.slice(1)).switches) : null;
  }
  if (ctx.placeholders && keyword !== 'IF') return placeholderText(flattenFieldCode(tree));
  const { args, switches } = fieldSwitches(keyword === 'IF' || keyword === 'NEXTIF' || keyword === 'SKIPIF' ? [] : rest);
  switch (keyword) {
    case 'MERGEFIELD': {
      const name = args[0] || '';
      if (ctx.exhausted) return '';
      const value = columnValue(ctx, name);
      if (value === undefined) { ctx.onIssue({ type: 'missingField', field: name, record: record(ctx)?.number }); return `«${name}»`; }
      return formatValue(value, switches);
    }
    case 'ADDRESSBLOCK': return ctx.exhausted ? '' : renderAddressBlock(flattenFieldCode(tree), id => conceptValue(ctx, id));
    case 'GREETINGLINE': return ctx.exhausted ? '' : renderGreetingLine(flattenFieldCode(tree), id => conceptValue(ctx, id));
    case 'MERGEREC': return ctx.exhausted ? '' : String(record(ctx)?.number ?? '');
    case 'MERGESEQ': return String(ctx.sequence);
    case 'NEXT': advance(ctx); return '';
    case 'NEXTIF': { if (!ctx.exhausted && condition(rest).result) advance(ctx); return ''; }
    case 'SKIPIF': { if (!ctx.exhausted && condition(rest).result) ctx.skipped = true; return ''; }
    case 'SET': { if (args[0]) ctx.variables.set(args[0], args[1] ?? ''); return ''; }
    case 'ASK': {
      const name = args[0];
      if (name) ctx.variables.set(name, answerFor(ctx, 'ASK', name, args[1], switches));
      return '';
    }
    case 'FILLIN': return formatValue(answerFor(ctx, 'FILLIN', args[0] || '', args[0], switches), switches);
    case 'IF': {
      const { result, rest: branches } = condition(rest);
      const chosen = branches[result ? 0 : 1];
      if (ctx.placeholders) return branches[0]?.value || '«If…»';
      return formatValue(chosen?.value ?? '', fieldSwitches(branches.slice(2)).switches);
    }
    default: return null;
  }
}
function answerFor(ctx, kind, key, prompt, switches) {
  const id = `${kind}:${key}`;
  if (Object.hasOwn(ctx.answers, id)) return ctx.answers[id];
  return typeof switches['\\d'] === 'string' ? switches['\\d'] : '';
}

/** ASK and FILLIN prompts in a document's merge fields: [{ id, kind, name, prompt, defaultValue, once }]. */
export function mergePrompts(codes) {
  const prompts = new Map();
  const visit = tree => {
    const keyword = fieldKeyword(tree);
    for (const part of tree.parts) if (typeof part !== 'string') visit(part);
    if (keyword !== 'ASK' && keyword !== 'FILLIN') return;
    const { args, switches } = fieldSwitches(tokenizeInstruction(flattenFieldCode(tree)).slice(1));
    const key = keyword === 'ASK' ? args[0] : args[0] || '';
    if (keyword === 'ASK' && !key) return;
    const id = `${keyword}:${key}`;
    if (!prompts.has(id)) prompts.set(id, { id, kind: keyword, name: keyword === 'ASK' ? key : null, prompt: (keyword === 'ASK' ? args[1] : args[0]) || key || 'Enter a value', defaultValue: typeof switches['\\d'] === 'string' ? switches['\\d'] : '', once: !!switches['\\o'] });
  };
  for (const code of codes) visit(node(code));
  return [...prompts.values()];
}

/**
 * Evaluate one output copy: the document's merge fields in order, starting at record `start`.
 * Returns { results, start, next, skipped, records } where `next` is the record after this copy.
 */
export function mergeCopy(codes, { data, start = 0, sequence = 1, mapping = {}, answers = {}, placeholders = false, onIssue } = {}) {
  const ctx = mergeContext({ data, cursor: start, sequence, mapping, answers, placeholders, onIssue });
  const results = codes.map(code => evaluateField(code, ctx));
  return { results, start, next: ctx.cursor + 1, skipped: ctx.skipped, records: [...ctx.used].filter(i => i < data.length) };
}

/**
 * Plan a whole merge: one copy per record (or per sheet of labels, where NEXT consumes several),
 * skipping copies a SKIPIF rejects. Returns [{ results, records, sequence }].
 */
export function planMerge(codes, { data, mapping = {}, answers = {}, onIssue, limit = 5000 } = {}) {
  const copies = [];
  let at = 0, sequence = 1;
  while (at < data.length) {
    if (copies.length >= limit) throw new Error(`A merge can produce at most ${limit} documents at a time. Choose fewer recipients.`);
    const copy = mergeCopy(codes, { data, start: at, sequence, mapping, answers, onIssue });
    // A copy always moves on by at least one record, so a document without NEXT fields gets one copy per record.
    at = Math.max(copy.next, at + 1);
    if (copy.skipped) continue;
    copies.push({ ...copy, sequence });
    sequence++;
  }
  return copies;
}

/* ---- Recipient lists ---- */

/** A recipient list: { columns, rows: [{ values: [], included }], sort, filters }. */
export function emptyRecipientList(columns = DEFAULT_COLUMNS) {
  return { columns: [...columns], rows: [], sort: [], filters: [] };
}

const FILTER_TESTS = {
  equals: (v, x) => v.toLowerCase() === x.toLowerCase(),
  notEquals: (v, x) => v.toLowerCase() !== x.toLowerCase(),
  contains: (v, x) => v.toLowerCase().includes(x.toLowerCase()),
  notContains: (v, x) => !v.toLowerCase().includes(x.toLowerCase()),
  startsWith: (v, x) => v.toLowerCase().startsWith(x.toLowerCase()),
  empty: v => !v.trim(),
  notEmpty: v => !!v.trim(),
  less: (v, x) => compareOperands(v, '<', x),
  greater: (v, x) => compareOperands(v, '>', x),
};
export const FILTER_OPERATORS = [['equals', 'Equals'], ['notEquals', 'Does not equal'], ['contains', 'Contains'], ['notContains', 'Does not contain'], ['startsWith', 'Starts with'], ['empty', 'Is blank'], ['notEmpty', 'Is not blank'], ['less', 'Less than'], ['greater', 'Greater than']];

/** Whether a row passes the list's filters (joined with and/or, left to right). */
export function passesFilters(list, row) {
  let result = null;
  for (const filter of list.filters || []) {
    const index = list.columns.indexOf(filter.column);
    if (index < 0 || !FILTER_TESTS[filter.operator]) continue;
    const ok = FILTER_TESTS[filter.operator](String(row.values[index] ?? ''), String(filter.value ?? ''));
    result = result === null ? ok : filter.join === 'or' ? result || ok : result && ok;
  }
  return result ?? true;
}

/** Rows in display order: filtered and sorted, each with its 1-based record number in the source. */
export function visibleRows(list) {
  const rows = list.rows.map((row, i) => ({ row, number: i + 1 })).filter(({ row }) => passesFilters(list, row));
  const keys = (list.sort || []).map(s => ({ index: list.columns.indexOf(s.column), descending: !!s.descending })).filter(k => k.index >= 0);
  if (keys.length) rows.sort((a, b) => {
    for (const k of keys) {
      const x = String(a.row.values[k.index] ?? ''), y = String(b.row.values[k.index] ?? '');
      const nx = numeric(x), ny = numeric(y);
      const order = nx !== null && ny !== null ? nx - ny : x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true });
      if (order) return k.descending ? -order : order;
    }
    return a.number - b.number;
  });
  return rows;
}

/** The records a merge uses: checked rows that pass the filters, in sort order, as { number, values: { column: value } }. */
export function mergeRecords(list) {
  if (!list) return [];
  return visibleRows(list).filter(({ row }) => row.included !== false).map(({ row, number }) => ({ number, values: Object.fromEntries(list.columns.map((c, i) => [c, row.values[i] ?? ''])) }));
}

/** Groups of rows whose values match after trimming and ignoring case: [[number, …]]. */
export function duplicateRows(list, columns = list.columns) {
  const indices = columns.map(c => list.columns.indexOf(c)).filter(i => i >= 0);
  const groups = new Map();
  list.rows.forEach((row, i) => {
    const key = indices.map(k => String(row.values[k] ?? '').trim().toLowerCase().replace(/\s+/g, ' ')).join('\u0000');
    if (!key.replace(/\u0000/g, '')) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i + 1);
  });
  return [...groups.values()].filter(g => g.length > 1);
}

/** Light address checks for each included row: [{ number, problems: [text] }]. */
export function validateAddresses(list, mapping = autoMatchFields(list.columns)) {
  const get = (row, id) => { const i = list.columns.indexOf(mapping[id]); return i < 0 ? '' : String(row.values[i] ?? '').trim(); };
  const report = [];
  list.rows.forEach((row, i) => {
    if (row.included === false) return;
    const problems = [];
    if (!get(row, 'first') && !get(row, 'last') && !get(row, 'company')) problems.push('No name or company');
    if (mapping.address1 && !get(row, 'address1')) problems.push('No street address');
    if (mapping.city && !get(row, 'city')) problems.push('No city');
    const postal = get(row, 'postal'), country = get(row, 'country').toLowerCase();
    if (mapping.postal && !postal) problems.push('No postal code');
    else if (postal && /^(us|usa|u\.s\.a?\.?|united states|united states of america)$/.test(country) && !/^\d{5}(-\d{4})?$/.test(postal)) problems.push('Postal code is not a 5- or 9-digit ZIP code');
    const email = get(row, 'email');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.push('Email address looks incomplete');
    if (problems.length) report.push({ number: i + 1, problems });
  });
  return report;
}
