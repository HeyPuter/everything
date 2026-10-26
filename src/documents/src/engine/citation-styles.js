// Citation and reference-list formatters, written for this editor from the
// public rules of each style: APA (7th edition), MLA (9th edition), Chicago
// author-date (17th edition), IEEE and Harvard (author-date). Output is runs
// ({ text, italic }) so titles keep their italics in the document. These are
// practical implementations of the common source types, not complete style
// manuals; the remaining gaps are listed in docs/parity/references.md.
import { isPlaceholder } from './bibliography.js';

export const CITATION_STYLES = {
  apa: { name: 'APA', edition: 'Seventh Edition', heading: 'References', numbered: false },
  chicago: { name: 'Chicago', edition: 'Author-Date, 17th Edition', heading: 'References', numbered: false },
  harvard: { name: 'Harvard', edition: 'Author-Date', heading: 'Reference List', numbered: false },
  ieee: { name: 'IEEE', edition: '2021', heading: 'References', numbered: true },
  mla: { name: 'MLA', edition: 'Ninth Edition', heading: 'Works Cited', numbered: false },
};
export const DEFAULT_STYLE = 'apa';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June', 'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];
const IEEE_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];

/* ---- Small helpers ---- */
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const field = (source, key) => clean(source.fields?.[key]);
const strip = text => clean(text).replace(/[.,;:]+$/, '');
/** Index 0–11 of a month written as a name, abbreviation or number, else -1. */
function monthIndex(value) {
  const v = clean(value).toLowerCase().replace(/\.$/, '');
  if (!v) return -1;
  if (/^\d{1,2}$/.test(v)) { const n = Number(v) - 1; return n >= 0 && n < 12 ? n : -1; }
  return MONTHS.findIndex(m => m.toLowerCase().startsWith(v.slice(0, 3)));
}
const pageRange = value => clean(value).replace(/\s*(?:-|–|—|to)\s*/g, '–');
const isRange = value => /[–,]/.test(pageRange(value));
const doiOf = url => /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)(10\.\S+)$/i.exec(clean(url))?.[1] || (/^10\.\d{4,}\/\S+$/.test(clean(url)) ? clean(url) : null);
// "Jean-Paul" and "J.-P." both give "J.-P."; an empty piece ("J.-" or a stray hyphen) gives nothing rather than failing.
const initials = name => clean(name).split(/\s+/).map(word => word.split('-').map(piece => piece.split('.').filter(Boolean).map(p => `${[...p][0].toUpperCase()}.`).join(' ')).filter(Boolean).join('-')).filter(Boolean).join(' ');
const ordinal = n => { const v = Number(n); if (!Number.isInteger(v)) return clean(n); const s = ['th', 'st', 'nd', 'rd'], m = v % 100; return v + (s[(m - 20) % 10] || s[m] || s[0]); };
const editionText = (edition, abbreviation = 'ed.') => { const e = clean(edition); if (!e) return ''; return /^\d+$/.test(e) ? `${ordinal(e)} ${abbreviation}` : /ed\.?$/i.test(e) ? e : `${e} ${abbreviation}`; };
const sentence = text => { const t = clean(text); return !t ? '' : /[.?!]$/.test(t) ? t : `${t}.`; };
// A title in quotation marks takes the period or comma inside them, unless it ends in its own ? or !.
const inQuotes = (title, mark) => `“${title}${/[?!]$/.test(title) ? '' : mark}”`;
const sortKey = text => clean(text).toLowerCase().replace(/^(?:a|an|the)\s+/, '');

/** The people a reference is listed under, and how: { list, role }. */
export function contributors(source) {
  const n = source.names || {};
  const order = source.type === 'Film' ? ['Director', 'Writer', 'ProducerName', 'Author'] : source.type === 'Interview' ? ['Interviewee', 'Author'] : source.type === 'Patent' ? ['Inventor', 'Author']
    : source.type === 'SoundRecording' ? ['Performer', 'Composer', 'Author'] : source.type === 'Performance' ? ['Writer', 'Director', 'Performer'] : ['Author', 'Editor', 'Compiler'];
  for (const role of order) if (n[role]?.some(p => p.corporate || p.last || p.first)) return { list: n[role].filter(p => p.corporate || p.last || p.first), role };
  return { list: [], role: null };
}
const lastName = p => p.corporate || p.last || p.first || '';

/* ---- Runs ---- */
class Runs {
  constructor() { this.list = []; }
  add(text, italic = false) {
    if (!text) return this;
    const last = this.list.at(-1);
    if (last && !!last.italic === !!italic) last.text += text; else this.list.push(italic ? { text, italic: true } : { text });
    return this;
  }
  get text() { return this.list.map(r => r.text).join(''); }
  /** Make sure the text so far ends with `mark` (no doubled periods after "ed." or "Inc."). */
  end(mark = '.') {
    const text = this.text.trimEnd();
    if (!text) return this;
    if (mark === '.' && /[.?!]$/.test(text)) return this;
    const last = this.list.at(-1);
    last.text = last.text.replace(/\s+$/, '');
    // Punctuation after an italic title stays upright.
    if (last.italic) this.list.push({ text: mark }); else last.text += mark;
    return this;
  }
  /** The finished runs. A part left out for a missing field (an author, a title) leaves no double space behind. */
  done() {
    let before = ' ';
    for (const run of this.list) {
      run.text = run.text.replace(/ {2,}/g, ' ');
      if (before.endsWith(' ')) run.text = run.text.replace(/^ +/, '');
      if (run.text) before = run.text;
    }
    this.list = this.list.filter(run => run.text);
    const last = this.list.at(-1); if (last) last.text = last.text.replace(/\s+$/, '');
    return this.list;
  }
}

/* ---- Name lists per style ---- */
function apaName(p) { return p.corporate || [p.last, [initials(p.first), initials(p.middle)].filter(Boolean).join(' ')].filter(Boolean).join(', '); }
function apaNames(list) {
  const names = list.map(apaName);
  if (names.length === 1) return names[0];
  if (names.length <= 20) return `${names.slice(0, -1).join(', ')}, & ${names.at(-1)}`;
  return `${names.slice(0, 19).join(', ')}, . . . ${names.at(-1)}`;
}
const apaEditors = list => list.map(p => p.corporate || [initials(p.first), initials(p.middle), p.last].filter(Boolean).join(' ')).reduce((s, name, i, all) => i === 0 ? name : i === all.length - 1 ? `${s}${all.length > 2 ? ',' : ''} & ${name}` : `${s}, ${name}`, '');
function mlaNames(list) {
  const first = p => p.corporate || [p.last, [p.first, p.middle].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const normal = p => p.corporate || personFull(p);
  if (list.length === 1) return first(list[0]);
  if (list.length === 2) return `${first(list[0])}, and ${normal(list[1])}`;
  return `${first(list[0])}, et al.`;
}
const personFull = p => p.corporate || [p.first, p.middle, p.last].filter(Boolean).join(' ');
function chicagoNames(list) {
  const first = p => p.corporate || [p.last, [p.first, p.middle].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const names = [first(list[0]), ...list.slice(1, 10).map(personFull)];
  if (list.length > 10) return `${names.slice(0, 7).join(', ')}, et al.`;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]}, and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}
const ieeeName = p => p.corporate || [[initials(p.first), initials(p.middle)].filter(Boolean).join(' '), p.last].filter(Boolean).join(' ');
function ieeeNames(list) {
  if (list.length > 6) return `${ieeeName(list[0])} et al.`;
  const names = list.map(ieeeName);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}
const harvardName = p => p.corporate || `${p.last}${p.first || p.middle ? `, ${[initials(p.first), initials(p.middle)].filter(Boolean).join('').replace(/ /g, '')}` : ''}`;
function harvardNames(list) {
  if (list.length >= 4) return `${harvardName(list[0])} et al.`;
  const names = list.map(harvardName);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/* ---- In-text name forms ---- */
function citeNames(list, style) {
  const last = list.map(lastName);
  if (!last.length) return '';
  if (style === 'apa') return last.length === 1 ? last[0] : last.length === 2 ? `${last[0]} & ${last[1]}` : `${last[0]} et al.`;
  if (style === 'mla') return last.length === 1 ? last[0] : last.length === 2 ? `${last[0]} and ${last[1]}` : `${last[0]} et al.`;
  if (style === 'chicago') return last.length === 1 ? last[0] : last.length === 2 ? `${last[0]} and ${last[1]}` : last.length === 3 ? `${last[0]}, ${last[1]}, and ${last[2]}` : `${last[0]} et al.`;
  return last.length === 1 ? last[0] : last.length <= 3 ? `${last.slice(0, -1).join(', ')} and ${last.at(-1)}` : `${last[0]} et al.`;
}

/* ---- Dates ---- */
function apaDate(source, letter = '') {
  const year = field(source, 'Year'), month = monthIndex(field(source, 'Month')), day = field(source, 'Day');
  const dated = ['ArticleInAPeriodical', 'InternetSite', 'DocumentFromInternetSite', 'Interview', 'Patent'].includes(source.type);
  if (!year) return `(n.d.${letter ? `-${letter}` : ''})`;
  return `(${year}${letter}${dated && month >= 0 ? `, ${MONTHS[month]}${day ? ` ${day}` : ''}` : ''})`;
}
function mlaDate(day, month, year) {
  const m = monthIndex(month);
  return [clean(day), m >= 0 ? SHORT_MONTHS[m] : clean(month), clean(year)].filter(Boolean).join(' ');
}
const accessedMla = source => { const y = field(source, 'YearAccessed'); return y ? `Accessed ${mlaDate(field(source, 'DayAccessed'), field(source, 'MonthAccessed'), y)}.` : ''; };
const urlMla = url => clean(url).replace(/^https?:\/\//i, '');

/* ---- Reference-list entries ---- */
function apaEntry(source, { letter = '' } = {}) {
  const r = new Runs(), { list, role } = contributors(source), title = strip(field(source, 'Title')), url = field(source, 'URL'), doi = doiOf(url);
  const publisher = field(source, 'Publisher') || field(source, 'Institution');
  const pages = pageRange(field(source, 'Pages')), edition = editionText(field(source, 'Edition'));
  const authorFirst = list.length > 0;
  if (authorFirst) {
    r.add(apaNames(list));
    if (role === 'Editor') r.add(list.length > 1 ? ' (Eds.)' : ' (Ed.)');
    if (role === 'Director') r.add(` (${list.length > 1 ? 'Directors' : 'Director'})`);
    r.end('.').add(' ');
  } else if (title) {
    // Without an author the title moves to the author position.
    const italicTitle = ['Book', 'Report', 'InternetSite', 'DocumentFromInternetSite', 'Film', 'Misc', 'Patent'].includes(source.type);
    r.add(title, italicTitle).end('.').add(' ');
  }
  r.add(apaDate(source, letter)).add('. ');
  const titleItalic = !authorFirst ? null : ['Book', 'Report', 'InternetSite', 'DocumentFromInternetSite', 'Film', 'Misc', 'Patent', 'Case', 'Art', 'ElectronicSource', 'SoundRecording'].includes(source.type);
  const addTitle = () => { if (authorFirst && title) r.add(title, titleItalic); };
  switch (source.type) {
    case 'Book': {
      addTitle();
      const notes = [edition, field(source, 'Volume') ? `Vol. ${field(source, 'Volume')}` : ''].filter(Boolean);
      if (notes.length) r.add(` (${notes.join(', ')})`);
      r.end('.');
      if (publisher) r.add(` ${sentence(publisher)}`);
      break;
    }
    case 'BookSection': {
      addTitle(); r.end('.');
      const editors = source.names?.Editor?.length ? `${apaEditors(source.names.Editor)} (${source.names.Editor.length > 1 ? 'Eds.' : 'Ed.'}), ` : '';
      const bookTitle = field(source, 'BookTitle');
      if (bookTitle || editors) {
        r.add(` In ${editors}`).add(strip(bookTitle), true);
        const notes = [edition, pages ? `${isRange(pages) ? 'pp.' : 'p.'} ${pages}` : ''].filter(Boolean);
        if (notes.length) r.add(` (${notes.join(', ')})`);
        r.end('.');
      }
      if (publisher) r.add(` ${sentence(publisher)}`);
      break;
    }
    case 'JournalArticle': case 'ArticleInAPeriodical': {
      addTitle(); r.end('.');
      const journal = field(source, source.type === 'JournalArticle' ? 'JournalName' : 'PeriodicalTitle'), volume = field(source, 'Volume'), issue = field(source, 'Issue');
      if (journal) {
        r.add(' ').add(journal, true);
        if (volume) r.add(', ', true).add(volume, true);
        if (issue) r.add(`(${issue})`);
        if (pages) r.add(`, ${pages}`);
        r.end('.');
      }
      break;
    }
    case 'ConferenceProceedings': {
      addTitle(); r.end('.');
      const conference = field(source, 'ConferenceName');
      if (conference) { r.add(' In ').add(strip(conference), true); if (pages) r.add(` (${isRange(pages) ? 'pp.' : 'p.'} ${pages})`); r.end('.'); }
      if (publisher) r.add(` ${sentence(publisher)}`);
      break;
    }
    case 'Report': {
      addTitle();
      const number = field(source, 'StandardNumber');
      if (number) r.add(` (${field(source, 'Type') || 'Report'} No. ${number})`);
      r.end('.');
      if (publisher) r.add(` ${sentence(publisher)}`);
      break;
    }
    case 'InternetSite': case 'DocumentFromInternetSite': {
      addTitle(); r.end('.');
      const site = field(source, 'InternetSiteTitle') || field(source, 'Publisher');
      if (site && !list.some(p => p.corporate === site)) r.add(` ${sentence(site)}`);
      break;
    }
    case 'Film': {
      addTitle(); r.add(' [Film]').end('.');
      const company = field(source, 'ProductionCompany');
      if (company) r.add(` ${sentence(company)}`);
      break;
    }
    case 'Interview': {
      addTitle();
      const interviewer = source.names?.Interviewer?.length ? ` [Interview by ${source.names.Interviewer.map(personFull).join(', ')}]` : ' [Interview]';
      r.add(interviewer).end('.');
      const where = field(source, 'PublicationTitle') || publisher;
      if (where) r.add(` ${sentence(where)}`);
      break;
    }
    case 'Patent': {
      addTitle();
      const number = field(source, 'PatentNumber'), country = field(source, 'CountryRegion');
      if (number) r.add(` (${country ? `${country} ` : ''}Patent No. ${number})`);
      r.end('.');
      break;
    }
    case 'Case': {
      // Legal references follow their own order: Name, reporter cite (Court Year).
      const parts = new Runs().add(title || 'Untitled case', true);
      const cite = field(source, 'AbbreviatedCaseNumber') || [field(source, 'CaseNumber'), field(source, 'Reporter')].filter(Boolean).join(' ');
      if (cite) parts.add(`, ${cite}`);
      const court = field(source, 'Court'), year = field(source, 'Year');
      if (court || year) parts.add(` (${[court, year].filter(Boolean).join(' ')})`);
      parts.end('.');
      if (url) parts.add(` ${url}`);
      return parts.done();
    }
    default: {
      addTitle();
      const medium = field(source, 'Medium');
      if (medium) r.add(` [${medium}]`);
      r.end('.');
      const where = field(source, 'PublicationTitle');
      if (where) r.add(' ').add(sentence(where), true);
      if (publisher) r.add(` ${sentence(publisher)}`);
    }
  }
  if (doi) r.add(` https://doi.org/${doi}`); else if (url) r.add(` ${url}`);
  return r.done();
}

function mlaEntry(source) {
  const r = new Runs(), { list, role } = contributors(source), title = strip(field(source, 'Title')), url = field(source, 'URL'), doi = doiOf(url);
  const publisher = field(source, 'Publisher') || field(source, 'Institution'), year = field(source, 'Year'), pages = pageRange(field(source, 'Pages'));
  if (list.length && source.type !== 'Film') {
    r.add(mlaNames(list));
    if (role === 'Editor') r.add(list.length > 1 ? ', editors' : ', editor');
    r.end('.').add(' ');
  }
  const container = (text, ...rest) => { const items = rest.filter(Boolean); if (text) { r.add(' ').add(strip(text), true); if (items.length) r.add(','); } if (items.length) r.add(` ${items.join(', ')}`); r.end('.'); };
  const quoted = () => { if (title) r.add(inQuotes(title, '.')); };
  const italicTitle = () => { if (title) r.add(title, true).end('.'); };
  const date = mlaDate(field(source, 'Day'), field(source, 'Month'), year);
  const location = pages ? `${isRange(pages) ? 'pp.' : 'p.'} ${pages}` : '';
  switch (source.type) {
    case 'Book': {
      italicTitle();
      const items = [editionText(field(source, 'Edition')), field(source, 'Volume') ? `vol. ${field(source, 'Volume')}` : '', publisher, year].filter(Boolean);
      if (source.names?.Editor?.length && role !== 'Editor') items.unshift(`edited by ${source.names.Editor.map(personFull).join(' and ')}`);
      if (items.length) r.add(` ${items.join(', ')}`).end('.');
      break;
    }
    case 'BookSection': {
      quoted();
      const edited = source.names?.Editor?.length ? `edited by ${source.names.Editor.map(personFull).join(' and ')}` : '';
      container(field(source, 'BookTitle'), edited, editionText(field(source, 'Edition')), publisher, year, location);
      break;
    }
    case 'JournalArticle': {
      quoted();
      container(field(source, 'JournalName'), field(source, 'Volume') ? `vol. ${field(source, 'Volume')}` : '', field(source, 'Issue') ? `no. ${field(source, 'Issue')}` : '', year, location);
      break;
    }
    case 'ArticleInAPeriodical': {
      quoted();
      container(field(source, 'PeriodicalTitle'), date, location);
      break;
    }
    case 'ConferenceProceedings': {
      quoted();
      container(field(source, 'ConferenceName'), publisher, year, location);
      break;
    }
    case 'InternetSite': case 'DocumentFromInternetSite': {
      quoted();
      container(field(source, 'InternetSiteTitle'), field(source, 'Publisher') !== field(source, 'InternetSiteTitle') ? field(source, 'Publisher') : '', date);
      break;
    }
    case 'Film': {
      italicTitle();
      const directors = source.names?.Director?.length ? `Directed by ${source.names.Director.map(personFull).join(' and ')}` : '';
      const items = [directors, field(source, 'ProductionCompany'), year].filter(Boolean);
      if (items.length) r.add(` ${items.join(', ')}`).end('.');
      break;
    }
    case 'Interview': {
      if (title) quoted(); else r.add('Interview').end('.');
      if (source.names?.Interviewer?.length) r.add(` Interview by ${source.names.Interviewer.map(personFull).join(' and ')}`).end('.');
      container(field(source, 'PublicationTitle'), publisher, date);
      break;
    }
    case 'Patent': {
      italicTitle();
      const items = [field(source, 'PatentNumber') ? `${field(source, 'CountryRegion') ? `${field(source, 'CountryRegion')} ` : ''}Patent ${field(source, 'PatentNumber')}` : '', date].filter(Boolean);
      if (items.length) r.add(` ${items.join(', ')}`).end('.');
      break;
    }
    case 'Case': {
      italicTitle();
      const items = [field(source, 'Court'), field(source, 'CaseNumber') || field(source, 'AbbreviatedCaseNumber'), date].filter(Boolean);
      if (items.length) r.add(` ${items.join(', ')}`).end('.');
      break;
    }
    default: {
      italicTitle();
      container(field(source, 'PublicationTitle'), publisher, date || year, field(source, 'Medium'));
    }
  }
  if (doi) r.add(` https://doi.org/${doi}`).end('.'); else if (url) r.add(` ${urlMla(url)}`).end('.');
  const accessed = accessedMla(source);
  if (accessed && ['InternetSite', 'DocumentFromInternetSite', 'ElectronicSource', 'Misc'].includes(source.type)) r.add(` ${accessed}`);
  return r.done();
}

function chicagoEntry(source, { letter = '' } = {}) {
  const r = new Runs(), { list, role } = contributors(source), title = strip(field(source, 'Title')), url = field(source, 'URL'), doi = doiOf(url);
  const publisher = field(source, 'Publisher') || field(source, 'Institution'), city = field(source, 'City'), year = field(source, 'Year'), pages = pageRange(field(source, 'Pages'));
  const imprint = [city, publisher].filter(Boolean).join(': ');
  if (list.length) {
    r.add(chicagoNames(list));
    if (role === 'Editor') r.add(list.length > 1 ? ', eds' : ', ed');
    if (role === 'Director') r.add(', dir');
    r.end('.').add(' ');
  } else if (title) r.add(title, ['Book', 'Report', 'Film', 'Misc'].includes(source.type)).end('.').add(' ');
  r.add(`${year || 'n.d.'}${letter}`).end('.');
  const addTitle = italic => { if (list.length && title) r.add(' ').add(italic ? title : inQuotes(title, '.'), italic); if (italic && list.length && title) r.end('.'); };
  switch (source.type) {
    case 'Book': case 'Report': case 'Misc': case 'Patent':
      addTitle(true);
      if (field(source, 'Edition')) r.add(` ${editionText(field(source, 'Edition'))}`).end('.');
      if (imprint) r.add(` ${sentence(imprint)}`);
      break;
    case 'BookSection': {
      addTitle(false);
      r.add(' In ').add(strip(field(source, 'BookTitle')), true);
      if (source.names?.Editor?.length) r.add(`, edited by ${source.names.Editor.map(personFull).join(' and ')}`);
      if (pages) r.add(`, ${pages}`);
      r.end('.');
      if (imprint) r.add(` ${sentence(imprint)}`);
      break;
    }
    case 'JournalArticle': case 'ArticleInAPeriodical': {
      addTitle(false);
      const journal = field(source, source.type === 'JournalArticle' ? 'JournalName' : 'PeriodicalTitle');
      if (journal) r.add(' ').add(journal, true);
      if (field(source, 'Volume')) r.add(` ${field(source, 'Volume')}`);
      if (field(source, 'Issue')) r.add(` (${field(source, 'Issue')})`);
      if (source.type === 'ArticleInAPeriodical' && monthIndex(field(source, 'Month')) >= 0) r.add(`, ${MONTHS[monthIndex(field(source, 'Month'))]}${field(source, 'Day') ? ` ${field(source, 'Day')}` : ''}`);
      if (pages) r.add(`: ${pages}`);
      r.end('.');
      break;
    }
    case 'InternetSite': case 'DocumentFromInternetSite': {
      addTitle(false);
      const site = field(source, 'InternetSiteTitle');
      if (site) r.add(` ${sentence(site)}`);
      if (monthIndex(field(source, 'Month')) >= 0) r.add(` ${MONTHS[monthIndex(field(source, 'Month'))]}${field(source, 'Day') ? ` ${field(source, 'Day')}` : ''}, ${year}.`);
      break;
    }
    case 'Film':
      addTitle(true);
      if ([city, field(source, 'ProductionCompany')].some(Boolean)) r.add(` ${sentence([city, field(source, 'ProductionCompany')].filter(Boolean).join(': '))}`);
      break;
    case 'ConferenceProceedings':
      addTitle(false);
      if (field(source, 'ConferenceName')) r.add(' Paper presented at ').add(strip(field(source, 'ConferenceName')), true).end('.');
      if (imprint) r.add(` ${sentence(imprint)}`);
      break;
    case 'Case': {
      addTitle(true);
      const cite = [field(source, 'AbbreviatedCaseNumber') || field(source, 'CaseNumber'), field(source, 'Reporter'), field(source, 'Court')].filter(Boolean).join(', ');
      if (cite) r.add(` ${sentence(cite)}`);
      break;
    }
    default:
      addTitle(false);
      if (field(source, 'PublicationTitle')) r.add(' ').add(strip(field(source, 'PublicationTitle')), true).end('.');
      if (imprint) r.add(` ${sentence(imprint)}`);
  }
  if (doi) r.add(` https://doi.org/${doi}.`); else if (url) r.add(` ${url}.`);
  return r.done();
}

function harvardEntry(source, { letter = '' } = {}) {
  const r = new Runs(), { list, role } = contributors(source), title = strip(field(source, 'Title')), url = field(source, 'URL'), doi = doiOf(url);
  const publisher = field(source, 'Publisher') || field(source, 'Institution'), city = field(source, 'City'), year = field(source, 'Year'), pages = pageRange(field(source, 'Pages'));
  const imprint = [city, publisher].filter(Boolean).join(': ');
  if (list.length) { r.add(harvardNames(list)); if (role === 'Editor') r.add(list.length > 1 ? ' (eds.)' : ' (ed.)'); r.add(' '); }
  else if (title) r.add(title, true).add(' ');
  r.add(`(${year || 'no date'}${letter}) `);
  const italicTitle = () => { if (list.length && title) r.add(title, true).end('.'); };
  const quotedTitle = () => { if (list.length && title) r.add(`‘${title}’`); };
  switch (source.type) {
    case 'JournalArticle': case 'ArticleInAPeriodical': {
      quotedTitle();
      const journal = field(source, source.type === 'JournalArticle' ? 'JournalName' : 'PeriodicalTitle');
      if (journal) r.add(', ').add(journal, true);
      const volume = field(source, 'Volume'), issue = field(source, 'Issue');
      if (volume) r.add(`, ${volume}${issue ? `(${issue})` : ''}`);
      if (pages) r.add(`, ${isRange(pages) ? 'pp.' : 'p.'} ${pages}`);
      r.end('.');
      break;
    }
    case 'BookSection': {
      quotedTitle();
      r.add(', in ');
      if (source.names?.Editor?.length) r.add(`${harvardNames(source.names.Editor)} (${source.names.Editor.length > 1 ? 'eds.' : 'ed.'}) `);
      r.add(strip(field(source, 'BookTitle')), true);
      r.end('.');
      if (imprint) r.add(` ${imprint}`);
      if (pages) r.add(`, ${isRange(pages) ? 'pp.' : 'p.'} ${pages}`);
      r.end('.');
      break;
    }
    case 'InternetSite': case 'DocumentFromInternetSite':
      italicTitle();
      break;
    case 'ConferenceProceedings':
      quotedTitle();
      if (field(source, 'ConferenceName')) r.add(', ').add(strip(field(source, 'ConferenceName')), true);
      if (imprint) r.add(`. ${imprint}`);
      if (pages) r.add(`, ${isRange(pages) ? 'pp.' : 'p.'} ${pages}`);
      r.end('.');
      break;
    case 'Film':
      italicTitle(); r.add(' [Film]');
      if (field(source, 'ProductionCompany')) r.add(` ${field(source, 'ProductionCompany')}`);
      r.end('.');
      break;
    default:
      italicTitle();
      if (field(source, 'Edition')) r.add(` ${editionText(field(source, 'Edition'))}`).end('.');
      if (imprint) r.add(` ${sentence(imprint)}`);
  }
  if (doi) r.add(` doi:${doi}.`);
  else if (url) {
    r.add(` Available at: ${url}`);
    const accessed = field(source, 'YearAccessed');
    if (accessed) { const m = monthIndex(field(source, 'MonthAccessed')); r.add(` (Accessed: ${[field(source, 'DayAccessed'), m >= 0 ? MONTHS[m] : field(source, 'MonthAccessed'), accessed].filter(Boolean).join(' ')})`); }
    r.end('.');
  }
  return r.done();
}

function ieeeEntry(source, { number = 1 } = {}) {
  const r = new Runs(), { list, role } = contributors(source), title = strip(field(source, 'Title')), url = field(source, 'URL'), doi = doiOf(url);
  const publisher = field(source, 'Publisher') || field(source, 'Institution'), city = field(source, 'City'), year = field(source, 'Year'), pages = pageRange(field(source, 'Pages'));
  const month = monthIndex(field(source, 'Month')), date = [month >= 0 ? IEEE_MONTHS[month] : '', field(source, 'Day') && month >= 0 ? `${field(source, 'Day')},` : '', year].filter(Boolean).join(' ');
  r.add(`[${number}]\t`);
  if (list.length) { r.add(ieeeNames(list)); if (role === 'Editor') r.add(list.length > 1 ? ', Eds.' : ', Ed.'); r.add(', '); }
  const imprint = [city, publisher].filter(Boolean).join(': ');
  const pp = pages ? `${isRange(pages) ? 'pp.' : 'p.'} ${pages}` : '';
  switch (source.type) {
    case 'Book': {
      if (title) r.add(title, true);
      const edition = editionText(field(source, 'Edition'));
      if (edition) r.add(`, ${edition}`);
      r.end('.').add(' ');
      r.add([imprint, year].filter(Boolean).join(', ')).end('.');
      break;
    }
    case 'BookSection': {
      if (title) r.add(`${inQuotes(title, ',')} `);
      r.add('in ').add(strip(field(source, 'BookTitle')), true);
      if (source.names?.Editor?.length) r.add(`, ${source.names.Editor.map(ieeeName).join(', ')}, ${source.names.Editor.length > 1 ? 'Eds' : 'Ed'}`);
      r.add('. ');
      r.add([imprint, year, pp].filter(Boolean).join(', ')).end('.');
      break;
    }
    case 'JournalArticle': case 'ArticleInAPeriodical': {
      if (title) r.add(`${inQuotes(title, ',')} `);
      const journal = field(source, source.type === 'JournalArticle' ? 'JournalName' : 'PeriodicalTitle');
      if (journal) r.add(journal, true);
      const items = [field(source, 'Volume') ? `vol. ${field(source, 'Volume')}` : '', field(source, 'Issue') ? `no. ${field(source, 'Issue')}` : '', pp, date].filter(Boolean);
      if (items.length) r.add(`, ${items.join(', ')}`);
      r.end('.');
      if (doi) { r.add(` doi: ${doi}.`); return r.done(); }
      break;
    }
    case 'ConferenceProceedings': {
      if (title) r.add(`${inQuotes(title, ',')} `);
      r.add('in ').add(strip(field(source, 'ConferenceName') || 'Proceedings'), true);
      const items = [city, year, pp].filter(Boolean);
      if (items.length) r.add(`, ${items.join(', ')}`);
      r.end('.');
      break;
    }
    case 'Report': {
      if (title) r.add(`${inQuotes(title, ',')} `);
      const items = [publisher, city, field(source, 'StandardNumber') ? `Rep. ${field(source, 'StandardNumber')}` : '', year].filter(Boolean);
      r.add(items.join(', ')).end('.');
      break;
    }
    case 'InternetSite': case 'DocumentFromInternetSite': {
      if (title) r.add(`${inQuotes(title, '.')} `);
      if (field(source, 'InternetSiteTitle')) r.add(field(source, 'InternetSiteTitle'), true).end('.');
      if (url) r.add(` ${url}`);
      const accessed = field(source, 'YearAccessed');
      if (accessed) { const m = monthIndex(field(source, 'MonthAccessed')); r.add(` (accessed ${[m >= 0 ? IEEE_MONTHS[m] : '', field(source, 'DayAccessed') ? `${field(source, 'DayAccessed')},` : '', accessed].filter(Boolean).join(' ')})`); }
      r.end('.');
      return r.done();
    }
    case 'Patent': {
      if (title) r.add(`${inQuotes(title, ',')} `);
      r.add([field(source, 'CountryRegion') ? `${field(source, 'CountryRegion')} Patent` : 'Patent', field(source, 'PatentNumber')].filter(Boolean).join(' '));
      if (date) r.add(`, ${date}`);
      r.end('.');
      break;
    }
    case 'Film': {
      if (title) r.add(title, true);
      r.add('. ');
      r.add([field(source, 'ProductionCompany'), year].filter(Boolean).join(', ')).end('.');
      break;
    }
    default: {
      if (title) r.add(title, true);
      r.add('. ');
      r.add([imprint, date || year].filter(Boolean).join(', ')).end('.');
    }
  }
  if (doi) r.add(` doi: ${doi}.`); else if (url) r.add(` [Online]. Available: ${url}`);
  return r.done();
}

const ENTRY = { apa: apaEntry, mla: mlaEntry, chicago: chicagoEntry, harvard: harvardEntry, ieee: ieeeEntry };

/* ---- Ordering, numbering and disambiguation ---- */
const authorKey = source => contributors(source).list.map(p => sortKey(lastName(p)) + '/' + sortKey(p.first || '')).join(';');
// Entries are ordered by their authors' names (surname, then given names) one author after another, a work by one
// author before works by that author with others, and a work without authors by its title in their place.
const authorNames = source => { const list = contributors(source).list; return list.length ? list.map(p => [sortKey(lastName(p)), sortKey(p.first || '')]) : [[sortKey(field(source, 'Title')), '']]; };
function compareAuthors(a, b) {
  const x = authorNames(a), y = authorNames(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (!x[i]) return -1;
    if (!y[i]) return 1;
    const order = x[i][0].localeCompare(y[i][0]) || x[i][1].localeCompare(y[i][1]);
    if (order) return order;
  }
  return 0;
}

/**
 * The context a style needs across a document: IEEE numbers in order of first citation, and the a/b/c
 * letters that tell apart one author's works from the same year in author-date styles.
 */
export function citationContext(style, sources, citedTags = []) {
  const real = sources.filter(s => !isPlaceholder(s));
  const numbers = new Map(), letters = new Map();
  if (style === 'ieee') {
    let n = 1;
    for (const tag of citedTags) { const s = real.find(x => x.tag.toLowerCase() === tag.toLowerCase()); if (s && !numbers.has(s.tag)) numbers.set(s.tag, n++); }
    for (const s of real) if (!numbers.has(s.tag)) numbers.set(s.tag, n++);
  } else if (style !== 'mla') {
    const groups = new Map();
    for (const s of real) { const key = `${authorKey(s) || sortKey(field(s, 'Title'))}|${field(s, 'Year')}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(s); }
    for (const group of groups.values()) if (group.length > 1 && authorKey(group[0])) group.sort((a, b) => sortKey(field(a, 'Title')).localeCompare(sortKey(field(b, 'Title')))).forEach((s, i) => letters.set(s.tag, String.fromCharCode(97 + (i % 26))));
  }
  return { numbers, letters };
}

/** The reference list: [{ tag, runs }] in the style's order. Placeholders are left out. */
export function formatBibliography(style, sources, citedTags = []) {
  const format = ENTRY[style] || ENTRY[DEFAULT_STYLE];
  const context = citationContext(style, sources, citedTags);
  const real = sources.filter(s => !isPlaceholder(s));
  const ordered = style === 'ieee' ? [...real].sort((a, b) => context.numbers.get(a.tag) - context.numbers.get(b.tag))
    : [...real].sort((a, b) => compareAuthors(a, b) || field(a, 'Year').localeCompare(field(b, 'Year')) || (context.letters.get(a.tag) || '').localeCompare(context.letters.get(b.tag) || '') || sortKey(field(a, 'Title')).localeCompare(sortKey(field(b, 'Title'))));
  return ordered.map(source => ({ tag: source.tag, runs: format(source, { letter: context.letters.get(source.tag) || '', number: context.numbers.get(source.tag) }) }));
}

/**
 * An in-text citation for `entries` ([{ source, pages, prefix, suffix, volume, noAuthor, noYear, noTitle }]),
 * as runs. Missing sources and placeholders show their tag.
 */
export function formatCitation(style, entries, context = { numbers: new Map(), letters: new Map() }) {
  const r = new Runs();
  if (style === 'ieee') {
    const parts = entries.map(e => {
      const n = e.source && !isPlaceholder(e.source) ? context.numbers.get(e.source.tag) : null;
      const inner = n ? `${n}${e.pages ? `, ${isRange(e.pages) ? 'pp.' : 'p.'} ${pageRange(e.pages)}` : ''}` : e.tag;
      return `${e.prefix ? `${e.prefix} ` : ''}[${inner}]${e.suffix ? ` ${e.suffix}` : ''}`;
    });
    return r.add(parts.join(', ')).done();
  }
  r.add('(');
  entries.forEach((e, i) => {
    if (i) r.add('; ');
    if (e.prefix) r.add(`${e.prefix} `);
    const source = e.source;
    if (!source || isPlaceholder(source)) { r.add(source?.tag || e.tag); if (e.suffix) r.add(`, ${e.suffix}`); return; }
    const { list } = contributors(source), title = strip(field(source, 'ShortTitle') || field(source, 'Title'));
    const year = `${field(source, 'Year') || (style === 'harvard' ? 'no date' : 'n.d.')}${context.letters.get(source.tag) ? `${style === 'apa' && !field(source, 'Year') ? '-' : ''}${context.letters.get(source.tag)}` : ''}`;
    const italicTitle = ['Book', 'Report', 'Film', 'InternetSite', 'DocumentFromInternetSite', 'Misc'].includes(source.type);
    const who = () => {
      if (list.length) { r.add(citeNames(list, style)); return true; }
      if (title && !e.noTitle) { if (italicTitle) r.add(title, true); else r.add(`“${title}”`); return true; }
      return false;
    };
    const pages = e.pages ? pageRange(e.pages) : '';
    if (style === 'mla') {
      const named = !e.noAuthor && who();
      const locator = [e.volume ? `${e.volume}${pages ? ':' : ''}` : '', pages].filter(Boolean).join('');
      if (locator) r.add(`${named ? ' ' : ''}${locator}`);
      if (!named && !locator) r.add(field(source, 'Year') || source.tag);
    } else {
      const named = !e.noAuthor && who();
      const comma = style === 'chicago' ? ' ' : ', ';
      if (!e.noYear) r.add(`${named ? comma : ''}${year}`);
      const locator = pages ? (style === 'chicago' ? pages : `${isRange(pages) ? 'pp.' : 'p.'} ${pages}`) : '';
      const volume = e.volume ? (style === 'chicago' ? `${e.volume}:` : `vol. ${e.volume}`) : '';
      if (volume || locator) r.add(`${named || !e.noYear ? ', ' : ''}${style === 'chicago' ? `${volume}${locator}` : [volume, locator].filter(Boolean).join(', ')}`);
    }
    if (e.suffix) r.add(`, ${e.suffix}`);
  });
  return r.add(')').done();
}
