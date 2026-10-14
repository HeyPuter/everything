// Bibliography sources (ECMA-376 Part 1 §22.6, namespace
// http://schemas.openxmlformats.org/officeDocument/2006/bibliography) and the
// CITATION/BIBLIOGRAPHY field instructions (§17.16.5.8, §17.16.5.7). Sources
// live in a custom XML part (§22.5) so other processors read them; a source
// this editor has not changed is written back exactly as it was read.

export const BIB_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography';

/** Name roles of CT_AuthorType this editor edits, with labels. */
export const NAME_ROLES = { Author: 'Author', Editor: 'Editor', Translator: 'Translator', BookAuthor: 'Book author', Director: 'Director', ProducerName: 'Producer', Writer: 'Writer', Interviewee: 'Interviewee', Interviewer: 'Interviewer', Inventor: 'Inventor', Counsel: 'Counsel', Performer: 'Performer', Compiler: 'Compiler' };
/** Text fields of CT_SourceType this editor edits (all ST_String in the schema), with labels. */
export const TEXT_FIELDS = {
  Title: 'Title', ShortTitle: 'Short title', Year: 'Year', Month: 'Month', Day: 'Day', City: 'City', StateProvince: 'State/Province', CountryRegion: 'Country/Region',
  Publisher: 'Publisher', Edition: 'Edition', Volume: 'Volume', NumberVolumes: 'Number of volumes', Pages: 'Pages', ChapterNumber: 'Chapter',
  BookTitle: 'Book title', JournalName: 'Journal name', Issue: 'Issue', PeriodicalTitle: 'Periodical title', ConferenceName: 'Conference name',
  PublicationTitle: 'Publication title', Institution: 'Institution', Department: 'Department', ThesisType: 'Thesis type', Type: 'Type',
  InternetSiteTitle: 'Website name', URL: 'URL or DOI', YearAccessed: 'Year accessed', MonthAccessed: 'Month accessed', DayAccessed: 'Day accessed',
  ProductionCompany: 'Production company', Distributor: 'Distributor', Medium: 'Medium', PatentNumber: 'Patent number', CaseNumber: 'Case number',
  AbbreviatedCaseNumber: 'Abbreviated case number', Court: 'Court', Reporter: 'Reporter', StandardNumber: 'Standard number', Comments: 'Comments',
  Version: 'Version', Station: 'Station', Broadcaster: 'Broadcaster', BroadcastTitle: 'Broadcast title', AlbumTitle: 'Album title', Theater: 'Theater', RecordingNumber: 'Recording number',
};
// Element names the reader recognises; anything else stays in the retained source XML.
const KNOWN = new Set(['Tag', 'SourceType', 'Guid', 'LCID', 'RefOrder', 'Author', ...Object.keys(TEXT_FIELDS)]);

/** Source types (ST_SourceType) and the fields the source dialog asks for, most important first. */
export const SOURCE_TYPES = {
  Book: { label: 'Book', names: ['Author', 'Editor', 'Translator'], fields: ['Title', 'Year', 'City', 'Publisher', 'Edition', 'Volume', 'NumberVolumes', 'URL'] },
  BookSection: { label: 'Book section', names: ['Author', 'Editor', 'BookAuthor'], fields: ['Title', 'BookTitle', 'Year', 'Pages', 'City', 'Publisher', 'Edition', 'URL'] },
  JournalArticle: { label: 'Journal article', names: ['Author'], fields: ['Title', 'JournalName', 'Year', 'Volume', 'Issue', 'Pages', 'URL'] },
  ArticleInAPeriodical: { label: 'Article in a periodical', names: ['Author'], fields: ['Title', 'PeriodicalTitle', 'Year', 'Month', 'Day', 'Volume', 'Issue', 'Pages', 'URL'] },
  ConferenceProceedings: { label: 'Conference proceedings', names: ['Author', 'Editor'], fields: ['Title', 'ConferenceName', 'Year', 'City', 'Publisher', 'Pages', 'URL'] },
  Report: { label: 'Report', names: ['Author'], fields: ['Title', 'Year', 'Publisher', 'Institution', 'City', 'Type', 'StandardNumber', 'URL'] },
  InternetSite: { label: 'Website', names: ['Author'], fields: ['Title', 'InternetSiteTitle', 'Year', 'Month', 'Day', 'URL', 'YearAccessed', 'MonthAccessed', 'DayAccessed'] },
  DocumentFromInternetSite: { label: 'Document from website', names: ['Author'], fields: ['Title', 'InternetSiteTitle', 'Year', 'Month', 'Day', 'Publisher', 'URL', 'YearAccessed', 'MonthAccessed', 'DayAccessed'] },
  Film: { label: 'Film', names: ['Director', 'ProducerName', 'Writer'], fields: ['Title', 'Year', 'ProductionCompany', 'Distributor', 'Medium', 'CountryRegion', 'URL'] },
  Interview: { label: 'Interview', names: ['Interviewee', 'Interviewer'], fields: ['Title', 'Year', 'Month', 'Day', 'PublicationTitle', 'Publisher', 'Medium', 'URL'] },
  Patent: { label: 'Patent', names: ['Inventor'], fields: ['Title', 'PatentNumber', 'CountryRegion', 'Type', 'Year', 'Month', 'Day', 'URL'] },
  Case: { label: 'Case', names: ['Counsel'], fields: ['Title', 'CaseNumber', 'AbbreviatedCaseNumber', 'Court', 'Reporter', 'Year', 'Month', 'Day', 'URL'] },
  Misc: { label: 'Miscellaneous', names: ['Author'], fields: ['Title', 'PublicationTitle', 'Year', 'Month', 'Day', 'City', 'Publisher', 'Medium', 'URL'] },
  SoundRecording: { label: 'Sound recording', names: ['Performer', 'Composer'], fields: ['Title', 'AlbumTitle', 'Year', 'ProductionCompany', 'Medium', 'City', 'URL'] },
  Performance: { label: 'Performance', names: ['Writer', 'Director', 'Performer'], fields: ['Title', 'Theater', 'City', 'Year', 'Month', 'Day', 'URL'] },
  Art: { label: 'Art', names: ['Author'], fields: ['Title', 'Institution', 'City', 'Year', 'Medium', 'URL'] },
  ElectronicSource: { label: 'Electronic source', names: ['Author'], fields: ['Title', 'PublicationTitle', 'Year', 'Month', 'Day', 'Publisher', 'Medium', 'URL'] },
};
/** The source types offered first in the dialog. */
export const COMMON_SOURCE_TYPES = ['Book', 'BookSection', 'JournalArticle', 'ArticleInAPeriodical', 'ConferenceProceedings', 'Report', 'InternetSite', 'DocumentFromInternetSite', 'Film', 'Interview', 'Patent', 'Case', 'Misc'];

const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const children = node => [...node.children];
const named = (node, name) => children(node).filter(n => n.namespaceURI === BIB_NS && n.localName === name);
const textOf = (node, name) => named(node, name)[0]?.textContent.trim() || '';

/** A person { last, first, middle } as it reads: "First Middle Last". */
export const personName = p => p.corporate || [p.first, p.middle, p.last].filter(Boolean).join(' ');

function readNames(node) {
  const corporate = named(node, 'Corporate')[0];
  if (corporate) return [{ corporate: corporate.textContent.trim() }];
  const list = named(node, 'NameList')[0];
  if (!list) return [];
  return named(list, 'Person').map(person => ({ last: named(person, 'Last').map(n => n.textContent.trim()).join(' '), first: named(person, 'First').map(n => n.textContent.trim()).join(' '), middle: named(person, 'Middle').map(n => n.textContent.trim()).join(' ') }));
}

/** One b:Source element as a plain object; `xml` keeps its exact source for unchanged writing. */
export function readSource(node) {
  const source = { tag: textOf(node, 'Tag'), type: textOf(node, 'SourceType') || 'Misc', names: {}, fields: {}, guid: textOf(node, 'Guid'), lcid: textOf(node, 'LCID'), refOrder: textOf(node, 'RefOrder'),
    xml: new XMLSerializer().serializeToString(node),
    // Elements this editor does not edit are kept when the source is edited.
    retained: children(node).filter(n => n.namespaceURI !== BIB_NS || !KNOWN.has(n.localName)).map(n => new XMLSerializer().serializeToString(n)) };
  const author = named(node, 'Author')[0];
  if (author) for (const role of children(author)) if (role.namespaceURI === BIB_NS) source.names[role.localName] = readNames(role);
  for (const key of Object.keys(TEXT_FIELDS)) { const value = textOf(node, key); if (value) source.fields[key] = value; }
  return source;
}

/** Sources from a b:Sources document string: { style, styleName, uri, sources }. */
export function parseSources(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml'), root = doc.documentElement;
  if (root.namespaceURI !== BIB_NS || root.localName !== 'Sources') throw new Error('This is not a bibliography sources part.');
  return { style: root.getAttribute('SelectedStyle') || '', styleName: root.getAttribute('StyleName') || '', uri: root.getAttribute('URI') || '', sources: named(root, 'Source').map(readSource) };
}

function namesXml(role, list) {
  if (!list?.length) return '';
  if (list[0].corporate !== undefined && list[0].corporate !== '') return role === 'Author' || role === 'Performer' ? `<b:${role}><b:Corporate>${escape(list[0].corporate)}</b:Corporate></b:${role}>` : '';
  const people = list.filter(p => p.last || p.first || p.middle);
  if (!people.length) return '';
  return `<b:${role}><b:NameList>${people.map(p => `<b:Person>${p.last ? `<b:Last>${escape(p.last)}</b:Last>` : ''}${p.first ? `<b:First>${escape(p.first)}</b:First>` : ''}${p.middle ? `<b:Middle>${escape(p.middle)}</b:Middle>` : ''}</b:Person>`).join('')}</b:NameList></b:${role}>`;
}

/** A b:Source element string for `source` (its retained XML when it was not edited). */
export function sourceXml(source) {
  // An unchanged source is written exactly as it was read (with its own namespace declarations).
  if (source.xml && !source.edited) return source.xml;
  const names = Object.entries(source.names || {}).map(([role, list]) => namesXml(role, list)).join('');
  const fields = Object.entries(source.fields || {}).filter(([key, value]) => Object.hasOwn(TEXT_FIELDS, key) && String(value).trim()).map(([key, value]) => `<b:${key}>${escape(String(value).trim())}</b:${key}>`).join('');
  return `<b:Source><b:Tag>${escape(source.tag)}</b:Tag><b:SourceType>${escape(SOURCE_TYPES[source.type] ? source.type : 'Misc')}</b:SourceType>${source.guid ? `<b:Guid>${escape(source.guid)}</b:Guid>` : ''}${source.lcid ? `<b:LCID>${escape(source.lcid)}</b:LCID>` : ''}${names ? `<b:Author>${names}</b:Author>` : ''}${fields}${source.refOrder ? `<b:RefOrder>${escape(source.refOrder)}</b:RefOrder>` : ''}${(source.retained || []).join('')}</b:Source>`;
}

/** A complete b:Sources part. */
export function serializeSources({ style = '', styleName = '', uri = '', sources = [] }) {
  const attrs = `${style ? ` SelectedStyle="${escape(style)}"` : ''}${styleName ? ` StyleName="${escape(styleName)}"` : ''}${uri ? ` URI="${escape(uri)}"` : ''}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><b:Sources xmlns:b="${BIB_NS}" xmlns="${BIB_NS}"${attrs}>${sources.map(sourceXml).join('')}</b:Sources>`;
}

/** A placeholder: a tag without details, shown as its name until filled in. */
export const isPlaceholder = source => !source.fields?.Title && !Object.values(source.names || {}).some(list => list?.length);

/** A unique tag from the first author and year, such as Smi20. */
export function sourceTag(source, taken = []) {
  const names = source.names?.Author || Object.values(source.names || {}).find(list => list?.length) || [];
  const first = names[0], base = ((first?.last || first?.corporate || source.fields?.Title || 'Source').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 3) || 'Src') + (source.fields?.Year || '').replace(/\D/g, '').slice(-2);
  const used = new Set(taken.map(t => t.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 1; ; i++) if (!used.has(`${base}${i}`.toLowerCase())) return `${base}${i}`;
}

/** A new random source GUID in the braced form producers write. */
export function newGuid() {
  const hex = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89AB'[parseInt(hex[16], 16) & 3]}${hex.slice(17, 20)}-${hex.slice(20, 32)}}`;
}

/* ---- Field instructions ---- */

function tokens(instruction) {
  const out = [], pattern = /\s*(?:"((?:[^"\\]|\\.)*)"|(\S+))/gy;
  let match;
  while ((match = pattern.exec(instruction)) && match[0].trim()) out.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2]);
  return out;
}
const quote = value => /[\s"\\]/.test(value) || !value ? `"${String(value).replace(/["\\]/g, '\\$&')}"` : value;

/**
 * A CITATION instruction (§17.16.5.8): { tags, lcid, pages, prefix, suffix, volume, noAuthor, noYear, noTitle }.
 * Each \m adds a source; pages and the other options apply to the first source.
 */
export function parseCitation(instruction) {
  const list = tokens(instruction || '');
  if (list[0]?.toUpperCase() !== 'CITATION' || !list[1] || list[1].startsWith('\\')) return null;
  const result = { tags: [list[1]], lcid: '', pages: '', prefix: '', suffix: '', volume: '', noAuthor: false, noYear: false, noTitle: false };
  for (let i = 2; i < list.length; i++) {
    const t = list[i], next = list[i + 1];
    if (t === '\\l' && next) { result.lcid = next; i++; }
    else if (t === '\\p' && next !== undefined) { result.pages = next; i++; }
    else if (t === '\\f' && next !== undefined) { result.prefix = next; i++; }
    else if (t === '\\s' && next !== undefined) { result.suffix = next; i++; }
    else if (t === '\\v' && next !== undefined) { result.volume = next; i++; }
    else if (t === '\\m' && next) { result.tags.push(next); i++; }
    else if (t === '\\n') result.noAuthor = true;
    else if (t === '\\y') result.noYear = true;
    else if (t === '\\t') result.noTitle = true;
  }
  return result;
}

export function citationInstruction({ tags, lcid = '1033', pages = '', prefix = '', suffix = '', volume = '', noAuthor = false, noYear = false, noTitle = false }) {
  const parts = ['CITATION', quote(tags[0])];
  if (lcid) parts.push('\\l', lcid);
  for (const tag of tags.slice(1)) parts.push('\\m', quote(tag));
  if (prefix) parts.push('\\f', quote(prefix));
  if (suffix) parts.push('\\s', quote(suffix));
  if (pages) parts.push('\\p', quote(pages));
  if (volume) parts.push('\\v', quote(volume));
  if (noAuthor) parts.push('\\n');
  if (noYear) parts.push('\\y');
  if (noTitle) parts.push('\\t');
  return ` ${parts.join(' ')} `;
}

export const bibliographyInstruction = (lcid = '1033') => ` BIBLIOGRAPHY \\l ${lcid} `;
