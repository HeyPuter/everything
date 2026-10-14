/**
 * Threaded comments in an .xlsx ([MS-XLSX] 2.1.17 and 2.1.18): each worksheet with threads gets an
 * xl/threadedComments/threadedCommentN.xml part (one threadedComment per comment, replies naming their
 * thread's first comment as parentId), the workbook gets xl/persons/person.xml listing the authors, and
 * each thread also keeps a plain note in the legacy comments part (written by the vendored writer from
 * io.js), authored "tc={first comment id}", so a reader that knows only notes still shows it.
 *
 * A comment that @mentions people lists them in its <mentions> element: each mention names a person of the
 * person list (where a Puter user is known by username, anyone else by email address) and where in the
 * text the "@Name" stands (startIndex and length, in UTF-16 code units).
 */
import { cellKey, cellName, parseKey } from './cell.js';
import { xmlTag, xmlText } from './xlsx-export-styles.js';
import { xlsxAttr, xlsxText } from './xlsx-styles.js';
import { decodeXlsxString } from './xlsx-string.js';
import { newCommentId, normalizeThread } from './comments.js';

export const THREADED_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const THREADED_REL = 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment';
export const PERSON_REL = 'http://schemas.microsoft.com/office/2017/10/relationships/person';
const THREADED_TYPE = 'application/vnd.ms-excel.threadedcomments+xml';
const PERSON_TYPE = 'application/vnd.ms-excel.person+xml';
const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** ST_Xstring element text: a literal escape-shaped underscore and the control characters XML cannot carry are escaped. */
const encodeText = (value) => xmlText(String(value).replace(/_(?=x[\da-f]{4}_)/gi, '_x005F_')
  .replace(/[\u0000-\u0008\u000b-\u001f￾￿]/g, (ch) => `_x${ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}_`));

/** The time as the format writes it: UTC, without a zone designator, to the hundredth of a second. */
function fileTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().replace(/(\.\d{2})\d*Z$/, '$1');
}

/** The authors of a workbook's threads, one person each, collected as the sheets are written. */
export function createPersonList() {
  const people = new Map();
  return {
    /** The person someone mentions: known by email address where there is one, else by Puter username. */
    idForMention(m) {
      return this.idFor({ author: m.name, userId: m.email || m.user || m.name, providerId: 'None' });
    },
    idFor(item) {
      const userId = item.userId || item.author, providerId = item.providerId || 'None';
      const key = JSON.stringify([item.author, userId, providerId]);
      if (!people.has(key)) people.set(key, { id: newCommentId(), displayName: item.author, userId, providerId });
      return people.get(key).id;
    },
    get size() { return people.size; },
    xml() {
      return HEADER + xmlTag('personList', { xmlns: THREADED_NS, 'xmlns:x': MAIN },
        [...people.values()].map((p) => xmlTag('person', { displayName: p.displayName, id: p.id, userId: p.userId, providerId: p.providerId })).join(''));
    },
  };
}

/** The threadedComments part for one sheet's threads, in cell order. */
export function threadedCommentsXml(comments, persons) {
  const entries = [...comments].map(([key, thread]) => ({ ...parseKey(key), thread }))
    .sort((a, b) => a.r - b.r || a.c - b.c);
  let body = '';
  for (const { r, c, thread } of entries) {
    const ref = cellName(r, c), root = thread.items[0].id;
    thread.items.forEach((item, i) => {
      body += xmlTag('threadedComment', {
        ref, dT: fileTime(item.time), personId: persons.idFor(item), id: item.id,
        ...(i ? { parentId: root } : { done: thread.done ? 1 : null }),
      }, xmlTag('text', {}, encodeText(item.text)) + mentionsXml(item, persons));
    });
  }
  return HEADER + xmlTag('ThreadedComments', { xmlns: THREADED_NS, 'xmlns:x': MAIN }, body);
}

/** A comment's <mentions>, or '' when it mentions nobody. */
function mentionsXml(item, persons) {
  if (!item.mentions?.length) return '';
  return xmlTag('mentions', {}, item.mentions.map((m) => xmlTag('mention', {
    mentionpersonId: persons.idForMention(m), mentionId: m.id, startIndex: m.start, length: m.length,
  })).join(''));
}

const relationshipsXml = (rels) => rels || `${HEADER}<Relationships xmlns="${PACKAGE_RELS}"></Relationships>`;
const addRelationship = (rels, attrs) => relationshipsXml(rels).replace('</Relationships>', `${xmlTag('Relationship', attrs)}</Relationships>`);

/**
 * Write a worksheet's threads (the sheet is the index-th part, 1-based) beside the legacy notes the
 * vendored writer made for them. `io` is completeXlsx's { get, set, contentType }.
 */
export function writeXlsxThreadedComments(sheet, index, persons, { get, set, contentType }) {
  if (!sheet.comments?.size) return;
  const path = `/xl/threadedComments/threadedComment${index}.xml`;
  set(path, threadedCommentsXml(sheet.comments, persons));
  contentType(path, THREADED_TYPE);
  const relPath = `/xl/worksheets/_rels/sheet${index}.xml.rels`;
  const rels = get(relPath);
  set(relPath, addRelationship(rels, { Id: 'puterThreadedComments', Type: THREADED_REL, Target: `../threadedComments/threadedComment${index}.xml` }));
  // Each thread's legacy note names its thread by uid as well as by its "tc=" author, as files from Excel do.
  const legacy = [...(rels || '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0])
    .find((rel) => /\/relationships\/comments"/.test(rel));
  const target = legacy && xlsxAttr(legacy, 'Target');
  if (target) {
    const path = `/${resolveTarget(`xl/worksheets/sheet${index}.xml`, target)}`;
    const xml = get(path);
    if (xml) set(path, linkLegacyNotes(xml));
  }
}

const REVISION_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2014/revision';
const COMPAT_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

/** Mark each legacy note authored "tc={id}" with that thread id (xr:uid), declaring the namespace as an ignorable one. */
export function linkLegacyNotes(xml) {
  const authors = [...(xml.match(/<authors>([\s\S]*?)<\/authors>/)?.[1] || '').matchAll(/<author>([\s\S]*?)<\/author>/g)].map((m) => m[1]);
  let linked = false;
  const out = xml.replace(/<comment\b([^>]*)>/g, (head, attrs) => {
    const id = /^tc=(\{[0-9A-Fa-f-]{36}\})$/.exec(authors[Number(xlsxAttr(head, 'authorId'))] || '')?.[1];
    if (!id || /\bxr:uid=/.test(attrs)) return head;
    linked = true;
    return `<comment${attrs} shapeId="0" xr:uid="${id}">`;
  });
  if (!linked) return xml;
  return out.replace(/<comments\b([^>]*)>/, (head, attrs) => /xmlns:xr=/.test(attrs) ? head
    : `<comments${attrs} xmlns:mc="${COMPAT_NS}" mc:Ignorable="xr" xmlns:xr="${REVISION_NS}">`);
}

/** The workbook's person list, once every sheet has named its authors. */
export function writeXlsxPersons(persons, { get, set, contentType }) {
  if (!persons.size) return;
  set('/xl/persons/person.xml', persons.xml());
  contentType('/xl/persons/person.xml', PERSON_TYPE);
  set('/xl/_rels/workbook.xml.rels', addRelationship(get('/xl/_rels/workbook.xml.rels'), { Id: 'puterPersons', Type: PERSON_REL, Target: 'persons/person.xml' }));
}

/* ---------- Reading ---------- */

const stripMarkup = (xml) => xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');

/** The text of a <text> element: entities and CDATA decoded, then the ST_Xstring escapes, each once. */
function elementText(inner) {
  let out = '';
  const parts = inner.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/);
  for (const part of parts) {
    if (part.startsWith('<![CDATA[')) out += part.slice(9, -3);
    else out += xlsxText(stripMarkup(part).replace(/<[^>]*>/g, ''));
  }
  return decodeXlsxString(out.replace(/\r\n?/g, '\n'));
}

function readParts(book) {
  const files = book?.files || {};
  const text = (path) => {
    const part = files[path.replace(/^\//, '')];
    return part?.content ? new TextDecoder().decode(part.content) : null;
  };
  return { files, text };
}

/** Resolve a relationship target against the folder of the part that names it. */
function resolveTarget(fromPart, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromPart.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function relationships(text, part) {
  const relsPath = part.replace(/([^/]+)$/, '_rels/$1.rels');
  const xml = text(relsPath);
  if (!xml) return [];
  return [...stripMarkup(xml).matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)].map((m) => ({
    id: xlsxAttr(m[0], 'Id'), type: xlsxAttr(m[0], 'Type') || '', target: xlsxAttr(m[0], 'Target') || '',
    external: xlsxAttr(m[0], 'TargetMode') === 'External',
  })).filter((r) => !r.external && r.target);
}

/** The workbook's persons by id: { name, userId, providerId }. */
export function readXlsxPersons(xml) {
  const people = new Map();
  for (const m of stripMarkup(xml || '').matchAll(/<(?:\w+:)?person\b[^>]*>/g)) {
    const id = xlsxAttr(m[0], 'id');
    if (!id) continue;
    const name = decodeXlsxString(xlsxAttr(m[0], 'displayName') || '').replace(/[\t\n\r]/g, ' ');
    people.set(id.toUpperCase(), { name, userId: decodeXlsxString(xlsxAttr(m[0], 'userId') || ''), providerId: xlsxAttr(m[0], 'providerId') || '' });
  }
  return people;
}

const EMAIL_IN = /[^\s@:<>()",;\\[\]]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

/**
 * The mentions of one threadedComment (its inner XML): who, from the person list, and where. A person's
 * userId says who they are: an email address in it is theirs; a bare name with no provider is a Puter
 * username (how this app writes one). The text check is left to the model (normalizeMentions).
 */
function readMentions(inner, persons) {
  const list = /<(?:\w+:)?mentions\b[^>]*>([\s\S]*?)<\/(?:\w+:)?mentions>/.exec(inner);
  if (!list) return [];
  const out = [];
  for (const m of list[1].matchAll(/<(?:\w+:)?mention\b[^>]*>/g)) {
    const person = persons.get((xlsxAttr(m[0], 'mentionpersonId') || '').toUpperCase());
    const start = Number(xlsxAttr(m[0], 'startIndex')), length = Number(xlsxAttr(m[0], 'length'));
    if (!Number.isInteger(start) || !Number.isInteger(length)) continue;
    const userId = person?.userId || '';
    const email = EMAIL_IN.exec(userId)?.[0];
    const mention = { id: (xlsxAttr(m[0], 'mentionId') || '').toUpperCase(), name: person?.name || '', start, length };
    if (email) mention.email = email.toLowerCase();
    else if ((!person?.providerId || person.providerId === 'None') && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(userId)) mention.user = userId;
    out.push(mention);
  }
  return out;
}

/** A threadedComments part as the model's threads ({ "r,c": thread }). */
export function readThreadedCommentsXml(xml, persons = new Map()) {
  const roots = new Map(), byRef = new Map(), all = [];
  const pattern = /<(?:\w+:)?threadedComment\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?threadedComment>)/g;
  for (const m of stripMarkup(xml || '').matchAll(pattern)) {
    const head = `<x ${m[1]}>`, inner = m[2] || '';
    const ref = (xlsxAttr(head, 'ref') || '').toUpperCase(), id = (xlsxAttr(head, 'id') || '').toUpperCase();
    const parentId = (xlsxAttr(head, 'parentId') || '').toUpperCase();
    const cell = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref);
    const textMatch = inner.match(/<(?:\w+:)?text\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?text>)/);
    if (!textMatch) continue;
    const person = persons.get((xlsxAttr(head, 'personId') || '').toUpperCase());
    const time = xlsxAttr(head, 'dT');
    const mentions = readMentions(inner, persons);
    const item = {
      id, author: person?.name || 'Unknown', text: elementText(textMatch[1] || ''),
      time: time ? (/[zZ]|[+-]\d\d:?\d\d$/.test(time) ? time : `${time}Z`) : null,
      // A person this app wrote (named by display name, with no provider) needs nothing more than the name.
      ...(person?.userId && person.userId !== person.name ? { userId: person.userId } : {}),
      ...(person?.providerId && person.providerId !== 'None' ? { providerId: person.providerId } : {}),
      ...(mentions.length ? { mentions } : {}),
    };
    all.push({ ref, cell, parentId, item, done: /^(1|true)$/i.test(xlsxAttr(head, 'done') || '') });
  }
  const threads = new Map();
  for (const entry of all) {
    if (entry.parentId || !entry.cell) continue;
    const thread = { done: entry.done, items: [entry.item] };
    roots.set(entry.item.id, thread);
    if (!byRef.has(entry.ref)) { byRef.set(entry.ref, thread); threads.set(entry.ref, thread); }
  }
  // A reply joins its thread; one whose thread is missing joins the thread on its cell, if any.
  for (const entry of all) {
    if (!entry.parentId) continue;
    const thread = roots.get(entry.parentId) || byRef.get(entry.ref);
    if (thread) thread.items.push(entry.item);
  }
  const out = {};
  for (const [ref, thread] of threads) {
    const t = normalizeThread(thread);
    const cell = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref);
    let c = 0;
    for (const ch of cell[1]) c = c * 26 + ch.charCodeAt(0) - 64;
    if (t) out[cellKey(Number(cell[2]) - 1, c - 1)] = t;
  }
  return out;
}

/**
 * Give the imported sheets their threads. The vendored reader turns a thread into a note on its cell (and
 * drops the legacy note beside it); the thread replaces that note. `sheets` are importSheet's results.
 */
export function importXlsxThreadedComments(book, sheets) {
  const { files, text } = readParts(book);
  if (!files['xl/workbook.xml'] || !Array.isArray(book.Workbook?.Sheets)) return;
  const workbookRels = relationships(text, 'xl/workbook.xml');
  const personRel = workbookRels.find((r) => r.type === PERSON_REL || /\/person$/.test(r.type));
  const persons = readXlsxPersons(text(personRel ? resolveTarget('xl/workbook.xml', personRel.target) : 'xl/persons/person.xml'));
  const targets = new Map(workbookRels.map((r) => [r.id, resolveTarget('xl/workbook.xml', r.target)]));
  for (const sheet of sheets) {
    const index = book.SheetNames.indexOf(sheet.name);
    const part = targets.get(book.Workbook.Sheets[index]?.id);
    if (!part) continue;
    const rel = relationships(text, part).find((r) => r.type === THREADED_REL || /\/threadedComment$/.test(r.type));
    const xml = rel && text(resolveTarget(part, rel.target));
    if (!xml) continue;
    const threads = readThreadedCommentsXml(xml, persons);
    if (!Object.keys(threads).length) continue;
    sheet.comments = threads;
    if (sheet.notes) for (const key of Object.keys(threads)) delete sheet.notes[key];
  }
}
