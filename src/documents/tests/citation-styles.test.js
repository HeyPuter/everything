import { describe, it, expect } from 'vitest';
import { formatBibliography, formatCitation, citationContext } from '../src/engine/citation-styles.js';
import { parseCitation, citationInstruction, sourceTag } from '../src/engine/bibliography.js';

const person = (last, first, middle = '') => ({ last, first, middle });
const book = { tag: 'Ada20', type: 'Book', names: { Author: [person('Lovelace', 'Ada', 'King')] }, fields: { Title: 'Notes on the analytical engine', Year: '2020', City: 'London', Publisher: 'Harbor Press', Edition: '2' } };
const article = { tag: 'Hop19', type: 'JournalArticle', names: { Author: [person('Hopper', 'Grace'), person('Mauchly', 'John', 'W.'), person('Eckert', 'J.', 'Presper')] }, fields: { Title: 'Compiling arithmetic expressions', JournalName: 'Journal of Machine Languages', Year: '2019', Volume: '12', Issue: '3', Pages: '45-67', URL: 'https://doi.org/10.1234/jml.2019.3' } };
const site = { tag: 'Org21', type: 'InternetSite', names: { Author: [{ corporate: 'Open Standards Group' }] }, fields: { Title: 'Document formats explained', InternetSiteTitle: 'Standards Hub', Year: '2021', Month: 'March', Day: '5', URL: 'https://example.org/formats', YearAccessed: '2022', MonthAccessed: '1', DayAccessed: '9' } };
const chapter = { tag: 'Tur18', type: 'BookSection', names: { Author: [person('Turing', 'Alan', 'M.')], Editor: [person('Church', 'Alonzo'), person('Kleene', 'Stephen', 'C.')] }, fields: { Title: 'On computable numbers', BookTitle: 'Foundations of computing', Year: '2018', Pages: '10-35', City: 'Princeton', Publisher: 'Logic House' } };
const film = { tag: 'Var17', type: 'Film', names: { Director: [person('Varda', 'Agnes')] }, fields: { Title: 'Faces and places', Year: '2017', ProductionCompany: 'Ciné-Tamaris' } };
const placeholder = { tag: 'Placeholder1', type: 'Misc', names: {}, fields: {} };
const sources = [book, article, site, chapter, film, placeholder];
const text = runs => runs.map(r => r.text).join('');
const italics = runs => runs.filter(r => r.italic).map(r => r.text);

describe('APA 7', () => {
  const entries = Object.fromEntries(formatBibliography('apa', sources).map(e => [e.tag, e.runs]));
  it('formats books, articles, chapters, websites and films', () => {
    expect(text(entries.Ada20)).toBe('Lovelace, A. K. (2020). Notes on the analytical engine (2nd ed.). Harbor Press.');
    expect(italics(entries.Ada20)).toEqual(['Notes on the analytical engine']);
    expect(text(entries.Hop19)).toBe('Hopper, G., Mauchly, J. W., & Eckert, J. P. (2019). Compiling arithmetic expressions. Journal of Machine Languages, 12(3), 45–67. https://doi.org/10.1234/jml.2019.3');
    expect(italics(entries.Hop19)).toEqual(['Journal of Machine Languages, 12']);
    expect(text(entries.Tur18)).toBe('Turing, A. M. (2018). On computable numbers. In A. Church & S. C. Kleene (Eds.), Foundations of computing (pp. 10–35). Logic House.');
    expect(text(entries.Org21)).toBe('Open Standards Group. (2021, March 5). Document formats explained. Standards Hub. https://example.org/formats');
    expect(text(entries.Var17)).toBe('Varda, A. (Director). (2017). Faces and places [Film]. Ciné-Tamaris.');
  });
  it('orders the list by author and leaves placeholders out', () => {
    expect(formatBibliography('apa', sources).map(e => e.tag)).toEqual(['Hop19', 'Ada20', 'Org21', 'Tur18', 'Var17']);
  });
  it('cites with et al., pages, suppressions and several sources', () => {
    const context = citationContext('apa', sources);
    expect(text(formatCitation('apa', [{ source: book }], context))).toBe('(Lovelace, 2020)');
    expect(text(formatCitation('apa', [{ source: article, pages: '50-52' }], context))).toBe('(Hopper et al., 2019, pp. 50–52)');
    expect(text(formatCitation('apa', [{ source: book, noAuthor: true, pages: '7' }], context))).toBe('(2020, p. 7)');
    expect(text(formatCitation('apa', [{ source: book }, { source: site }], context))).toBe('(Lovelace, 2020; Open Standards Group, 2021)');
    expect(text(formatCitation('apa', [{ source: placeholder, tag: 'Placeholder1' }], context))).toBe('(Placeholder1)');
  });
  it('tells apart one author\'s works from the same year', () => {
    const second = { ...book, tag: 'Ada20b', fields: { ...book.fields, Title: 'A sketch of the engine' } };
    const list = [book, second], context = citationContext('apa', list);
    // Titles sort without a leading article, so "A sketch…" files under S.
    expect(text(formatCitation('apa', [{ source: second }], context))).toBe('(Lovelace, 2020b)');
    expect(formatBibliography('apa', list).map(e => text(e.runs).slice(0, 26))).toEqual(['Lovelace, A. K. (2020a). N', 'Lovelace, A. K. (2020b). A']);
  });
});

describe('MLA 9', () => {
  const entries = Object.fromEntries(formatBibliography('mla', sources).map(e => [e.tag, e.runs]));
  it('formats works cited entries', () => {
    expect(text(entries.Ada20)).toBe('Lovelace, Ada King. Notes on the analytical engine. 2nd ed., Harbor Press, 2020.');
    expect(text(entries.Hop19)).toBe('Hopper, Grace, et al. “Compiling arithmetic expressions.” Journal of Machine Languages, vol. 12, no. 3, 2019, pp. 45–67. https://doi.org/10.1234/jml.2019.3.');
    expect(text(entries.Org21)).toBe('Open Standards Group. “Document formats explained.” Standards Hub, 5 Mar. 2021. example.org/formats. Accessed 9 Jan. 2022.');
    expect(text(entries.Var17)).toBe('Faces and places. Directed by Agnes Varda, Ciné-Tamaris, 2017.');
  });
  it('cites author and page without a comma', () => {
    const context = citationContext('mla', sources);
    expect(text(formatCitation('mla', [{ source: book, pages: '12' }], context))).toBe('(Lovelace 12)');
    expect(text(formatCitation('mla', [{ source: article }], context))).toBe('(Hopper et al.)');
  });
});

describe('Chicago author-date', () => {
  it('formats the reference list and citations', () => {
    const entries = Object.fromEntries(formatBibliography('chicago', sources).map(e => [e.tag, e.runs]));
    expect(text(entries.Ada20)).toBe('Lovelace, Ada King. 2020. Notes on the analytical engine. 2nd ed. London: Harbor Press.');
    expect(text(entries.Hop19)).toBe('Hopper, Grace, John W. Mauchly, and J. Presper Eckert. 2019. “Compiling arithmetic expressions.” Journal of Machine Languages 12 (3): 45–67. https://doi.org/10.1234/jml.2019.3.');
    const context = citationContext('chicago', sources);
    expect(text(formatCitation('chicago', [{ source: article, pages: '50' }], context))).toBe('(Hopper, Mauchly, and Eckert 2019, 50)');
  });
});

describe('IEEE', () => {
  it('numbers sources in order of first citation', () => {
    const context = citationContext('ieee', sources, ['Hop19', 'Ada20']);
    expect(text(formatCitation('ieee', [{ source: article }], context))).toBe('[1]');
    expect(text(formatCitation('ieee', [{ source: book, pages: '3' }], context))).toBe('[2, p. 3]');
    const entries = formatBibliography('ieee', sources, ['Hop19', 'Ada20']);
    expect(entries.map(e => e.tag).slice(0, 2)).toEqual(['Hop19', 'Ada20']);
    expect(text(entries[0].runs)).toBe('[1]\tG. Hopper, J. W. Mauchly, and J. P. Eckert, “Compiling arithmetic expressions,” Journal of Machine Languages, vol. 12, no. 3, pp. 45–67, 2019. doi: 10.1234/jml.2019.3.');
    expect(text(entries[1].runs)).toBe('[2]\tA. K. Lovelace, Notes on the analytical engine, 2nd ed. London: Harbor Press, 2020.');
  });
});

describe('Harvard', () => {
  it('formats entries and citations', () => {
    const entries = Object.fromEntries(formatBibliography('harvard', sources).map(e => [e.tag, e.runs]));
    expect(text(entries.Ada20)).toBe('Lovelace, A.K. (2020) Notes on the analytical engine. 2nd ed. London: Harbor Press.');
    expect(text(entries.Hop19)).toBe('Hopper, G., Mauchly, J.W. and Eckert, J.P. (2019) ‘Compiling arithmetic expressions’, Journal of Machine Languages, 12(3), pp. 45–67. doi:10.1234/jml.2019.3.');
    expect(text(entries.Org21)).toBe('Open Standards Group (2021) Document formats explained. Available at: https://example.org/formats (Accessed: 9 January 2022).');
    expect(text(formatCitation('harvard', [{ source: book, pages: '9' }], citationContext('harvard', sources)))).toBe('(Lovelace, 2020, p. 9)');
  });
});

describe('reference list order', () => {
  it('orders by every author\'s name, a sole author before the same author with others', () => {
    const work = (tag, authors, year) => ({ tag, type: 'Book', names: { Author: authors }, fields: { Title: `Work ${tag}`, Year: year, Publisher: 'Press' } });
    const list = [work('SmithZ', [person('Smith', 'Zoe')], '2010'), work('SmithJones', [person('Smith', 'Ann'), person('Jones', 'Kim')], '2015'),
      work('SmithBrown', [person('Smith', 'Ann'), person('Brown', 'Lee')], '2018'), work('Smith', [person('Smith', 'Ann')], '2020')];
    for (const style of ['apa', 'chicago', 'harvard', 'mla']) expect(formatBibliography(style, list).map(e => e.tag), style).toEqual(['Smith', 'SmithBrown', 'SmithJones', 'SmithZ']);
  });
});

describe('titles ending in a question or exclamation mark', () => {
  it('take no extra period or comma inside the quotation marks', () => {
    const question = { tag: 'Q20', type: 'JournalArticle', names: { Author: [person('Smith', 'Ann')] }, fields: { Title: 'Why do engines fail?', JournalName: 'Review', Year: '2020', Volume: '3', Pages: '1-2' } };
    const entry = style => text(formatBibliography(style, [question])[0].runs);
    expect(entry('mla')).toBe('Smith, Ann. “Why do engines fail?” Review, vol. 3, 2020, pp. 1–2.');
    expect(entry('chicago')).toBe('Smith, Ann. 2020. “Why do engines fail?” Review 3: 1–2.');
    expect(entry('ieee')).toBe('[1]\tA. Smith, “Why do engines fail?” Review, vol. 3, pp. 1–2, 2020.');
    for (const style of ['mla', 'chicago', 'ieee']) expect(entry(style), style).not.toMatch(/[?!][.,]”/);
  });
});

describe('sources missing a part', () => {
  it('leave no double space where the author, title or book title would be', () => {
    const anonymous = { tag: 'Anon', type: 'Book', names: {}, fields: { Title: 'Common prayers', Publisher: 'Parish Press' } };
    const untitled = { tag: 'Unt', type: 'BookSection', names: { Author: [person('Turing', 'Alan')], Editor: [person('Church', 'Alonzo')] }, fields: { BookTitle: 'Foundations', Year: '2018', Publisher: 'Logic House' } };
    const film = { tag: 'Film', type: 'Film', names: { Director: [person('Varda', 'Agnes')] }, fields: { Year: '2017', ProductionCompany: 'Ciné-Tamaris' } };
    const entries = style => Object.fromEntries(formatBibliography(style, [anonymous, untitled, film]).map(e => [e.tag, text(e.runs)]));
    expect(entries('apa').Anon).toBe('Common prayers. (n.d.). Parish Press.');
    expect(entries('harvard').Anon).toBe('Common prayers (no date) Parish Press.');
    expect(entries('apa').Unt).toBe('Turing, A. (2018). In A. Church (Ed.), Foundations. Logic House.');
    expect(entries('mla').Film).toBe('Directed by Agnes Varda, Ciné-Tamaris, 2017.');
    for (const style of ['apa', 'mla', 'chicago', 'harvard', 'ieee']) for (const entry of Object.values(entries(style))) expect(entry, style).not.toMatch(/ {2}|^ /);
  });
});

describe('initials', () => {
  it('keeps hyphenated initials and never fails on a stray hyphen', () => {
    const sartre = { tag: 'Sar43', type: 'Book', names: { Author: [person('Sartre', 'J.-P.')] }, fields: { Title: 'Being and nothingness', Year: '1943', Publisher: 'Gallimard' } };
    const camus = { tag: 'Cam42', type: 'Book', names: { Author: [person('Camus', 'Jean-Albert', '-')] }, fields: { Title: 'The stranger', Year: '1942', Publisher: 'Gallimard' } };
    for (const style of ['apa', 'chicago', 'harvard', 'ieee', 'mla']) expect(() => formatBibliography(style, [sartre, camus]), style).not.toThrow();
    const apa = Object.fromEntries(formatBibliography('apa', [sartre, camus]).map(e => [e.tag, text(e.runs)]));
    expect(apa.Sar43).toBe('Sartre, J.-P. (1943). Being and nothingness. Gallimard.');
    expect(apa.Cam42).toMatch(/^Camus, J\.-A\. \(1942\)/);
  });
});

describe('citation instructions and tags', () => {
  it('round-trips CITATION switches', () => {
    const instruction = citationInstruction({ tags: ['Ada20', 'Hop19'], pages: '12-14', prefix: 'see', suffix: 'for details', noYear: true });
    expect(instruction).toBe(' CITATION Ada20 \\l 1033 \\m Hop19 \\f see \\s "for details" \\p 12-14 \\y ');
    expect(parseCitation(instruction)).toMatchObject({ tags: ['Ada20', 'Hop19'], pages: '12-14', prefix: 'see', suffix: 'for details', noYear: true, noAuthor: false, lcid: '1033' });
    expect(parseCitation(' CITATION ')).toBeNull();
  });
  it('makes unique tags from the first author and year', () => {
    expect(sourceTag(book)).toBe('Lov20');
    expect(sourceTag(book, ['Lov20', 'lov201'])).toBe('Lov202');
  });
});
