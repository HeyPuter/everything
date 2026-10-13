// Results for the fields Insert → Field, Date & Time and Quick Parts insert (ECMA-376 Part 1
// §17.16.5): dates and times with a date-time picture switch (§17.16.4.1), document information
// (AUTHOR, TITLE, SUBJECT, KEYWORDS, COMMENTS, LASTSAVEDBY, DOCPROPERTY, FILENAME, USERNAME…),
// document statistics (NUMPAGES, NUMWORDS, NUMCHARS) and the general formatting switch (§17.16.4.3).
// A field is inserted with its current result as cached text, so every consumer shows it at once;
// Update Field recomputes it from the same evaluator.
import { fieldInstructionTokens } from './docx-page-fields.js';
import { formatPageNumber } from './page-numbering.js';
import { newBodyField } from './toc.js';
import { bodyFieldRanges } from './body-fields.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n, size = 2) => String(n).padStart(size, '0');

/** Format a date with a date-time picture (§17.16.4.1): M MM MMM MMMM d dd ddd dddd yy yyyy h hh H HH m mm s ss AM/PM am/pm, 'literal'. */
export function formatDatePicture(date, picture) {
  let out = '', i = 0;
  const run = ch => { let n = 0; while (picture[i + n] === ch) n++; return n; };
  while (i < picture.length) {
    const ch = picture[i];
    if (ch === "'") { const end = picture.indexOf("'", i + 1); out += end < 0 ? picture.slice(i + 1) : picture.slice(i + 1, end); i = end < 0 ? picture.length : end + 1; continue; }
    if (/^am\/pm/i.test(picture.slice(i, i + 5))) { const pm = date.getHours() >= 12, token = picture.slice(i, i + 5); out += token === token.toLowerCase() ? (pm ? 'pm' : 'am') : (pm ? 'PM' : 'AM'); i += 5; continue; }
    const n = run(ch);
    if (ch === 'M') out += n >= 4 ? MONTHS[date.getMonth()] : n === 3 ? MONTHS[date.getMonth()].slice(0, 3) : n === 2 ? pad(date.getMonth() + 1) : String(date.getMonth() + 1);
    else if (ch === 'd' || ch === 'D') out += n >= 4 ? DAYS[date.getDay()] : n === 3 ? DAYS[date.getDay()].slice(0, 3) : n === 2 ? pad(date.getDate()) : String(date.getDate());
    else if (ch === 'y' || ch === 'Y') out += n >= 3 ? String(date.getFullYear()) : pad(date.getFullYear() % 100);
    else if (ch === 'h') { const h = date.getHours() % 12 || 12; out += n >= 2 ? pad(h) : String(h); }
    else if (ch === 'H') out += n >= 2 ? pad(date.getHours()) : String(date.getHours());
    else if (ch === 'm') out += n >= 2 ? pad(date.getMinutes()) : String(date.getMinutes());
    else if (ch === 's' || ch === 'S') out += n >= 2 ? pad(date.getSeconds()) : String(date.getSeconds());
    else { out += ch; i += 1; continue; }
    i += n;
  }
  return out;
}

/** Date-time pictures offered by Insert → Date & Time, in the order they are listed. */
export const DATE_PICTURES = Object.freeze(['M/d/yyyy', 'dddd, MMMM d, yyyy', 'MMMM d, yyyy', 'M/d/yy', 'yyyy-MM-dd', 'd-MMM-yy', 'M.d.yyyy', 'MMM. d, yy', 'd MMMM yyyy', 'MMMM yy', 'MMM-yy',
  'M/d/yyyy h:mm am/pm', 'M/d/yyyy h:mm:ss am/pm', 'h:mm am/pm', 'h:mm:ss am/pm', 'HH:mm', 'HH:mm:ss']);
const ORDINAL = n => { const s = n % 100; return `${n}${s >= 11 && s <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`; };
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
/** Whole numbers in words, as the CardText switch writes them (up to 999,999). */
export function cardinalText(n) {
  if (!Number.isInteger(n) || n < 0 || n > 999999) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${cardinalText(n % 100)}` : ''}`;
  return `${cardinalText(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${cardinalText(n % 1000)}` : ''}`;
}

/** The general formatting switch (§17.16.4.3) on a result: case and number formats; MERGEFORMAT keeps formatting. */
export function applyGeneralFormat(text, format) {
  const f = String(format || '');
  if (/^upper$/i.test(f)) return text.toLocaleUpperCase();
  if (/^lower$/i.test(f)) return text.toLocaleLowerCase();
  if (/^firstcap$/i.test(f)) return text.charAt(0).toLocaleUpperCase() + text.slice(1);
  if (/^caps$/i.test(f)) return text.replace(/(^|\s)(\p{L})/gu, (_, gap, ch) => gap + ch.toLocaleUpperCase());
  const n = Number(text);
  if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(n)) return text;
  if (f === 'roman') return formatPageNumber(n, 'lowerRoman');
  if (f === 'ROMAN') return formatPageNumber(n, 'upperRoman');
  if (f === 'alphabetic') return formatPageNumber(n, 'lowerLetter');
  if (f === 'ALPHABETIC') return formatPageNumber(n, 'upperLetter');
  if (/^ordinal$/i.test(f)) return ORDINAL(n);
  if (/^cardtext$/i.test(f)) return cardinalText(n);
  if (/^ordtext$/i.test(f)) { const words = cardinalText(n); return words.replace(/(one|two|three|five|eight|nine|twelve|y|\w+)$/, w => ({ one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' }[w] || (w.endsWith('y') ? `${w.slice(0, -1)}ieth` : `${w}th`))); }
  if (/^hex$/i.test(f)) return n.toString(16).toUpperCase();
  return text;
}

/** Core and extended document properties from a package's parts: { title, subject, author, keywords, comments, lastModifiedBy, category, created, modified, company, manager, … }. */
export function documentProperties(parts = {}) {
  const read = path => { const bytes = parts[path]; if (!bytes) return null; try { return new DOMParser().parseFromString(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes), 'application/xml'); } catch { return null; } };
  const text = (doc, name) => [...(doc?.documentElement?.children || [])].find(n => n.localName === name)?.textContent?.trim() || '';
  const core = read('docProps/core.xml'), app = read('docProps/app.xml');
  return { title: text(core, 'title'), subject: text(core, 'subject'), author: text(core, 'creator'), keywords: text(core, 'keywords'), comments: text(core, 'description'),
    lastModifiedBy: text(core, 'lastModifiedBy'), category: text(core, 'category'), status: text(core, 'contentStatus'), created: text(core, 'created'), modified: text(core, 'modified'),
    company: text(app, 'Company'), manager: text(app, 'Manager'), template: text(app, 'Template') };
}

/**
 * The fields the Field dialog offers: name, category, a short description in this app's words, the
 * switches it supports, and the property a DOCPROPERTY/INFO field reads. Order is the dialog's order.
 */
export const FIELD_CATALOG = Object.freeze([
  { name: 'DATE', category: 'Date and Time', description: 'Today\u2019s date, updated when fields update', picture: true },
  { name: 'TIME', category: 'Date and Time', description: 'The current time, updated when fields update', picture: true },
  { name: 'CREATEDATE', category: 'Date and Time', description: 'When the document was created', picture: true },
  { name: 'SAVEDATE', category: 'Date and Time', description: 'When the document was last saved', picture: true },
  { name: 'AUTHOR', category: 'Document Information', description: 'The document\u2019s author', format: true },
  { name: 'TITLE', category: 'Document Information', description: 'The document\u2019s title property', format: true },
  { name: 'SUBJECT', category: 'Document Information', description: 'The document\u2019s subject property', format: true },
  { name: 'KEYWORDS', category: 'Document Information', description: 'The document\u2019s keywords', format: true },
  { name: 'COMMENTS', category: 'Document Information', description: 'The document\u2019s comments property', format: true },
  { name: 'LASTSAVEDBY', category: 'Document Information', description: 'Who saved the document last', format: true },
  { name: 'FILENAME', category: 'Document Information', description: 'The document\u2019s file name', format: true, options: [['\\p', 'Add path to file name']] },
  { name: 'DOCPROPERTY', category: 'Document Information', description: 'A document property you choose', format: true, argument: 'property' },
  { name: 'NUMPAGES', category: 'Document Information', description: 'The number of pages', number: true },
  { name: 'NUMWORDS', category: 'Document Information', description: 'The number of words', number: true },
  { name: 'NUMCHARS', category: 'Document Information', description: 'The number of characters', number: true },
  { name: 'PAGE', category: 'Numbering', description: 'The number of the page it is on', number: true },
  { name: 'SEQ', category: 'Numbering', description: 'A numbered sequence, such as figure numbers', number: true, argument: 'identifier' },
  { name: 'REF', category: 'Links and References', description: 'The text of a bookmark', format: true, argument: 'bookmark' },
  { name: 'USERNAME', category: 'User Information', description: 'Your name', format: true },
  { name: 'USERINITIALS', category: 'User Information', description: 'Your initials', format: true },
]);
export const DOCUMENT_PROPERTY_NAMES = Object.freeze([['Title', 'title'], ['Subject', 'subject'], ['Author', 'author'], ['Keywords', 'keywords'], ['Comments', 'comments'], ['Category', 'category'], ['Status', 'status'], ['Company', 'company'], ['Manager', 'manager'], ['LastSavedBy', 'lastModifiedBy']]);
export const GENERAL_FORMATS = Object.freeze([['Upper', 'UPPERCASE'], ['Lower', 'lowercase'], ['FirstCap', 'First capital'], ['Caps', 'Title Case']]);
export const NUMBER_FORMATS = Object.freeze([['Arabic', '1, 2, 3'], ['roman', 'i, ii, iii'], ['ROMAN', 'I, II, III'], ['alphabetic', 'a, b, c'], ['ALPHABETIC', 'A, B, C'], ['Ordinal', '1st, 2nd, 3rd'], ['CardText', 'One, Two, Three'], ['OrdText', 'First, Second, Third']]);

/** An instruction from the dialog's choices: ` NAME [argument] [\@ "picture"] [\* format] [options] \* MERGEFORMAT `. */
export function fieldInstruction({ name, argument = '', picture = '', format = '', options = [], preserve = true }) {
  const quote = value => /[\s"\\]/.test(value) || !value ? `"${String(value).replace(/(["\\])/g, '\\$1')}"` : value;
  return ` ${[name, argument ? quote(argument) : '', picture ? `\\@ ${quote(picture)}` : '', format ? `\\* ${format}` : '', ...options, preserve ? '\\* MERGEFORMAT' : ''].filter(Boolean).join(' ')} `;
}

/**
 * The result an instruction shows now, or null when this evaluator does not compute that field.
 * context: { now: Date, properties, fileName, path, user: { name, initials }, pages, text, bookmarks: Map(name → text) }.
 */
export function evaluateField(instruction, context = {}) {
  let tokens; try { tokens = fieldInstructionTokens(instruction); } catch { return null; }
  const name = tokens[0]?.toUpperCase(), now = context.now || new Date(), properties = context.properties || {};
  let picture = null, formats = [], argument = null, path = false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '\\@') picture = tokens[++i] ?? '';
    else if (t === '\\*') formats.push(tokens[++i] ?? '');
    else if (t === '\\p') path = true;
    else if (!t.startsWith('\\') && argument === null) argument = t;
    else if (t.startsWith('\\')) { if (['\\#', '\\s', '\\r'].includes(t)) i++; }
  }
  const dated = (value, fallback) => {
    const date = value instanceof Date ? value : value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    return formatDatePicture(date, picture ?? fallback);
  };
  const words = text => String(text || '').replace(/\ufffc/g, ' ').trim().split(/\s+/u).filter(Boolean).length;
  let value;
  switch (name) {
    case 'DATE': value = dated(now, 'M/d/yyyy'); break;
    case 'TIME': value = dated(now, 'h:mm am/pm'); break;
    case 'CREATEDATE': value = dated(properties.created, 'M/d/yyyy h:mm:ss am/pm'); break;
    case 'SAVEDATE': value = dated(properties.modified, 'M/d/yyyy h:mm:ss am/pm'); break;
    case 'AUTHOR': value = properties.author || ''; break;
    case 'TITLE': value = properties.title || ''; break;
    case 'SUBJECT': value = properties.subject || ''; break;
    case 'KEYWORDS': value = properties.keywords || ''; break;
    case 'COMMENTS': value = properties.comments || ''; break;
    case 'LASTSAVEDBY': value = properties.lastModifiedBy || ''; break;
    case 'FILENAME': value = path && context.path ? context.path : context.fileName || ''; break;
    case 'USERNAME': value = context.user?.name || ''; break;
    case 'USERINITIALS': value = context.user?.initials || (context.user?.name || '').split(/\s+/).map(w => w[0] || '').join('').toUpperCase(); break;
    case 'DOCPROPERTY': {
      const key = DOCUMENT_PROPERTY_NAMES.find(([label]) => label.toLowerCase() === String(argument || '').toLowerCase())?.[1];
      if (!key) return null;
      value = properties[key] || ''; break;
    }
    case 'NUMPAGES': if (!Number.isInteger(context.pages)) return null; value = String(context.pages); break;
    case 'NUMWORDS': if (context.text === undefined) return null; value = String(words(context.text)); break;
    case 'NUMCHARS': if (context.text === undefined) return null; value = String([...String(context.text).replace(/[\s\ufffc]/gu, '')].length); break;
    default: return null;
  }
  for (const format of formats) if (!/^mergeformat$/i.test(format) && !/^charformat$/i.test(format)) value = applyGeneralFormat(value, format);
  return value;
}

/**
 * Insert a body field at the caret (replacing a selection) with its result as cached text. Runs inside
 * an engine transaction. An empty result shows as nothing, as fields with no value do.
 */
export function insertBodyField(model, instruction, result) {
  const text = String(result ?? '').replace(/[\n\f\v]/g, ' ');
  const field = newBodyField(instruction);
  if (field.type === 'HYPERLINK' || field.type === 'TOC') throw new Error('Insert that field from its own command.');
  const start = model.range[0];
  model.replace(text);
  let at = 0, index = 0;
  while (index < model.paragraphs.length - 1 && at + model.paragraphs[index].runs.reduce((n, r) => n + r.text.length, 0) < start) at += model.paragraphs[index++].runs.reduce((n, r) => n + r.text.length, 0) + 1;
  const p = model.paragraphs[index], order = Math.max(0, ...model.paragraphs.flatMap(q => (q.fieldMarkers || []).map(m => m.order ?? 0))) + 1;
  (p.fieldMarkers ||= []).push({ type: 'start', field, offset: start - at, order }, { type: 'end', field, offset: start - at + text.length, order: order + 1 });
  model.hasBodyFields = true;
  bodyFieldRanges(model.paragraphs);
  model.select(start + text.length);
  model.didChange();
  return field;
}

// The open document's information (properties, file name, user, page count) comes from the editor.
// Without it only the clock-based fields are recomputed, so cached document information is never blanked.
let contextProvider = null;
export function setFieldContextProvider(provider) { contextProvider = provider; }
export const fieldEvaluationContext = () => contextProvider?.() || null;

/** Fields this evaluator recomputes, with the text they should show now: [{ range, text }]. */
export function fieldResultPlan(model, context = fieldEvaluationContext()) {
  const changes = [], text = model.text, ranges = bodyFieldRanges(model.paragraphs);
  for (const range of ranges) {
    if (range.parentId || ranges.some(r => r.parentId === range.field.id)) continue;
    if (range.field.locked || range.field.type === 'SEQ' || range.field.type === 'REF') continue;
    if (!context && !['DATE', 'TIME'].includes(range.field.type)) continue;
    const value = evaluateField(range.field.instruction, { ...(context || {}), text });
    if (value !== null && text.slice(range.start, range.end) !== value) changes.push({ range, text: value });
  }
  return changes;
}
