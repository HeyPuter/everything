import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import { DocxPackage, createDocx } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphFormat } from '../src/engine/model.js';
import { layoutDocument, caretRect } from '../src/engine/layout.js';
import { hyphenate, hyphenationPoints, hyphenatedLanguage } from '../src/engine/hyphenation.js';
import { setHyphenationSettings } from '../src/engine/hyphenation-settings.js';
import { readHyphenationSettings, writeHyphenationSettings } from '../src/engine/docx-hyphenation.js';
import { nextHyphenationCandidate, wordAround } from '../src/engine/manual-hyphenation.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { readFileSync } from 'node:fs';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const measure = t => ({ width: t.length * 8, ascent: 12, descent: 4 });
const page = { width: 160, height: 800, left: 0, right: 0, top: 0, bottom: 0 };
const lines = l => l.lines.map(l => l.fragments.map(f => f.text).join('').trimEnd());
const render = (text, settings = {}, format) => layoutDocument([paragraph(text, format ? { format } : {})], measure, { ...page, autoHyphenation: true, hyphenationZone: 0, ...settings });

describe('the English syllabifier', () => {
  // Each word lists every break a careful typesetter accepts; produced points must be among them.
  const accepted = {
    computer: 'com-pu-ter', beautiful: 'beau-ti-ful', wonderful: 'won-der-ful', important: 'im-por-tant', understand: 'un-der-stand',
    remember: 're-mem-ber', yesterday: 'yes-ter-day', everything: 'ev-ery-thing', television: 'tele-vi-sion', telephone: 'tele-phone',
    transport: 'trans-port', distance: 'dis-tance', whisper: 'whis-per', children: 'chil-dren', hundred: 'hun-dred', making: 'mak-ing',
    running: 'run-ning', handling: 'han-dling', statement: 'state-ment', government: 'gov-ern-ment', creation: 'cre-ation', station: 'sta-tion',
    mention: 'men-tion', question: 'ques-tion', picture: 'pic-ture', feature: 'fea-ture', settlement: 'set-tle-ment', little: 'lit-tle',
    bottle: 'bot-tle', temperature: 'tem-per-a-ture', character: 'char-ac-ter', organization: 'or-ga-ni-za-tion', communication: 'com-mu-ni-ca-tion',
    microphone: 'mi-cro-phone', architecture: 'ar-chi-tec-ture', photograph: 'pho-to-graph', possible: 'pos-si-ble', probably: 'prob-a-bly',
    according: 'ac-cord-ing', between: 'be-tween', another: 'an-oth-er', however: 'how-ev-er', without: 'with-out', although: 'al-though',
    because: 'be-cause', something: 'some-thing', anything: 'any-thing', business: 'busi-ness', experience: 'ex-pe-ri-ence', particular: 'par-tic-u-lar|par-ti-cu-lar',
    available: 'avail-able', environment: 'en-vi-ron-ment', relationship: 're-la-tion-ship', opportunity: 'op-por-tu-ni-ty', successful: 'suc-cess-ful',
    management: 'man-age-ment', department: 'de-part-ment', performance: 'per-for-mance', significant: 'sig-nif-i-cant', traditional: 'tra-di-tion-al',
    teaching: 'teach-ing', washing: 'wash-ing', handled: 'han-dled', tables: 'ta-bles', pickles: 'pick-les', hyphenation: 'hy-phen-ation',
    document: 'doc-u-ment', paragraph: 'para-graph', information: 'in-for-ma-tion', different: 'dif-fer-ent', interesting: 'in-ter-est-ing',
    beginning: 'be-gin-ning', shipping: 'ship-ping', developed: 'de-vel-oped', national: 'na-tion-al', professional: 'pro-fes-sion-al',
    responsibility: 're-spon-si-bil-i-ty', automatic: 'au-to-mat-ic', international: 'in-ter-na-tion-al', community: 'com-mu-ni-ty',
  };
  // Alternatives after | are other readable divisions (maximal onset rather than dictionary stress).
  const allowed = word => { const set = new Set(); for (const form of accepted[word].split('|')) { let at = 0; for (const part of form.split('-').slice(0, -1)) { at += part.length; set.add(at); } } return set; };
  it('places breaks only where English words divide', () => {
    let produced = 0;
    for (const word of Object.keys(accepted)) {
      const points = hyphenationPoints(word), ok = allowed(word);
      for (const point of points) expect(ok.has(point), `${hyphenate(word)} (expected within ${accepted[word]})`).toBe(true);
      produced += points.length;
    }
    // Most words of seven or more letters get at least one break.
    expect(produced).toBeGreaterThan(Object.keys(accepted).length);
  });
  it('keeps two letters before and three after a break, and leaves short words whole', () => {
    expect(hyphenationPoints('table')).toEqual([2]);
    expect(hyphenationPoints('boxes')).toEqual([]);
    expect(hyphenationPoints('wanted')).toEqual([]);
    expect(hyphenationPoints('cat')).toEqual([]);
    for (const word of Object.keys(accepted)) for (const p of hyphenationPoints(word)) { expect(p).toBeGreaterThanOrEqual(2); expect(word.length - p).toBeGreaterThanOrEqual(3); }
  });
  it('never breaks numbers, symbols, mixed case or addresses', () => {
    for (const word of ['2024', 'abc123', 'iPhone', 'JavaScript', 'example.com', 'user@example', 'rock’n’roll', 'don\'t']) expect(hyphenationPoints(word)).toEqual([]);
  });
  it('keeps the case of words in capitals and can leave them whole', () => {
    expect(hyphenate('Confidential')).toBe('Con-fi-den-tial');
    expect(hyphenate('CONFIDENTIAL')).toBe('CON-FI-DEN-TIAL');
    expect(hyphenationPoints('CONFIDENTIAL', { caps: false })).toEqual([]);
    expect(hyphenationPoints('Confidential', { caps: false })).not.toEqual([]);
  });
  it('hyphenates English and untagged text only', () => {
    expect(hyphenatedLanguage('')).toBe(true); expect(hyphenatedLanguage('en-GB')).toBe(true);
    expect(hyphenatedLanguage('de-DE')).toBe(false); expect(hyphenatedLanguage('fr')).toBe(false);
  });
});

describe('automatic hyphenation in layout', () => {
  it('splits the overflowing word at the last point that fits and shows a hyphen', () => {
    // 20 characters per line: "communica-" would need 21, "communi-" fits.
    const l = render('The modern communication tools');
    expect(lines(l)).toEqual(['The modern communi-', 'cation tools']);
    expect(l.lines[0].autoHyphen).toBe(true);
    // The text is unchanged: the break's position is shared and copying sees no hyphen.
    expect(l.lines[0].end).toBe(l.lines[1].start);
    expect(l.lines[0].end).toBe('The modern communi'.length);
    // The caret at the break sits before the hyphen on the first line.
    expect(caretRect(l, 'The modern communi'.length, 'backward').x).toBe(18 * 8);
  });
  it('leaves layout unchanged when hyphenation is off', () => {
    const p = paragraph('The modern communication tools');
    const off = layoutDocument([p], measure, page), plain = layoutDocument([p], measure, { ...page, autoHyphenation: false, hyphenationZone: 0 });
    expect(lines(off)).toEqual(['The modern', 'communication tools']);
    expect(JSON.stringify(plain.lines)).toBe(JSON.stringify(off.lines));
  });
  it('respects the hyphenation zone', () => {
    // Ending before "communication" leaves 10 characters (80px) free: a zone of 90px keeps the word whole.
    expect(lines(render('The modern communication tools', { hyphenationZone: 90 }))).toEqual(['The modern', 'communication tools']);
    expect(lines(render('The modern communication tools', { hyphenationZone: 70 }))[0]).toBe('The modern communi-');
  });
  it('limits consecutive hyphenated lines', () => {
    const text = 'The communication organization responsibility international communication organization professional';
    const free = lines(render(text)), limited = lines(render(text, { consecutiveHyphenLimit: 1 }));
    const count = list => { let run = 0, most = 0; for (const line of list) { run = line.endsWith('-') ? run + 1 : 0; most = Math.max(most, run); } return most; };
    expect(count(free)).toBeGreaterThan(1);
    expect(count(limited)).toBe(1);
  });
  it('skips words in capitals when asked, and paragraphs that suppress hyphenation', () => {
    expect(lines(render('The modern COMMUNICATION tools'))[0]).toBe('The modern COMMUNI-');
    expect(lines(render('The modern COMMUNICATION tools', { doNotHyphenateCaps: true }))[0]).toBe('The modern');
    expect(lines(render('The modern communication tools', {}, { suppressAutoHyphens: true }))[0]).toBe('The modern');
  });
  it('keeps manual soft hyphens and compounds as their own break points', () => {
    expect(lines(render('The modern commu­nication tools'))[0]).toBe('The modern commu-');
    expect(lines(render('The modern well-communication'))[0]).toBe('The modern well-');
  });
});

describe('hyphenation settings', () => {
  const settingsXml = inner => new DOMParser().parseFromString(`<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${inner}</w:settings>`, 'application/xml');
  it('reads the settings with the specified defaults', () => {
    expect(readHyphenationSettings(null)).toEqual({ autoHyphenation: false, doNotHyphenateCaps: false, hyphenationZone: 360, consecutiveHyphenLimit: 0 });
    expect(readHyphenationSettings(settingsXml('<w:autoHyphenation/><w:consecutiveHyphenLimit w:val="2"/><w:hyphenationZone w:val="0.5in"/><w:doNotHyphenateCaps w:val="true"/>').documentElement))
      .toEqual({ autoHyphenation: true, doNotHyphenateCaps: true, hyphenationZone: 720, consecutiveHyphenLimit: 2 });
    expect(readHyphenationSettings(settingsXml('<w:autoHyphenation w:val="0"/>').documentElement).autoHyphenation).toBe(false);
  });
  it('writes changed settings in schema order and removes switched-off ones', () => {
    const doc = settingsXml('<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>');
    const initial = readHyphenationSettings(doc.documentElement);
    expect(writeHyphenationSettings(doc.documentElement, { autoHyphenation: true, doNotHyphenateCaps: true, hyphenationZone: 425, consecutiveHyphenLimit: 3 }, initial)).toBe(true);
    expect([...doc.documentElement.children].map(n => n.localName)).toEqual(['zoom', 'defaultTabStop', 'autoHyphenation', 'consecutiveHyphenLimit', 'hyphenationZone', 'doNotHyphenateCaps', 'characterSpacingControl']);
    const next = readHyphenationSettings(doc.documentElement);
    expect(next).toEqual({ autoHyphenation: true, doNotHyphenateCaps: true, hyphenationZone: 425, consecutiveHyphenLimit: 3 });
    writeHyphenationSettings(doc.documentElement, { autoHyphenation: false, doNotHyphenateCaps: false, hyphenationZone: 425, consecutiveHyphenLimit: 0 }, next);
    expect([...doc.documentElement.children].map(n => n.localName)).toEqual(['zoom', 'defaultTabStop', 'hyphenationZone', 'characterSpacingControl']);
  });
  it('changes settings as one undoable step and saves them with the document', async () => {
    const source = createDocx([paragraph('Hyphenation keeps justified text even.')]);
    const pkg = await DocxPackage.open(await source.export().arrayBuffer().then(b => new Uint8Array(b)));
    const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    expect(setHyphenationSettings(model, { autoHyphenation: true, consecutiveHyphenLimit: 2 })).toBe(true);
    expect(setHyphenationSettings(model, { autoHyphenation: true })).toBe(false);
    model.select(0, 0); model.setParagraphFormat({ suppressAutoHyphens: true });
    const bytes = new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets).arrayBuffer());
    const parts = unzipSync(bytes);
    const settings = strFromU8(parts['word/settings.xml']);
    expect(settings).toContain('<w:autoHyphenation/>'); expect(settings).toContain('<w:consecutiveHyphenLimit w:val="2"/>');
    expect(strFromU8(parts['word/document.xml'])).toContain('<w:suppressAutoHyphens w:val="1"/>');
    const reopened = await DocxPackage.open(bytes);
    expect(reopened.pageSettings).toMatchObject({ autoHyphenation: true, consecutiveHyphenLimit: 2, hyphenationZone: 360 });
    expect(paragraphFormat(reopened.paragraphs[0], reopened.numbering).suppressAutoHyphens).toBe(true);
    model.undo(); model.undo();
    expect(model.pageSettings.autoHyphenation).toBe(false);
  });
});

describe('the hyphenation fixture', () => {
  const open = async () => {
    const pkg = await DocxPackage.open(readFileSync('public/fixtures/hyphenation.docx'));
    const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    const save = async () => unzipSync(new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets).arrayBuffer()));
    return { pkg, model, save };
  };
  it('reads its settings and hyphenates only the eligible paragraphs', async () => {
    const { pkg, model } = await open();
    expect(pkg.readOnly).toBeFalsy();
    expect(pkg.pageSettings).toMatchObject({ autoHyphenation: true, consecutiveHyphenLimit: 2, hyphenationZone: 284, doNotHyphenateCaps: true });
    const layout = layoutDocument(model.paragraphs, measure, pageGeometry(model.pageSettings), model.numbering, model.tables);
    const hyphenated = index => layout.lines.filter(l => l.paragraphId === model.paragraphs[index].id && l.autoHyphen).length;
    expect(hyphenated(1)).toBeGreaterThan(0); // ordinary English text
    expect(hyphenated(3)).toBe(0); // suppressAutoHyphens
    expect(hyphenated(5)).toBe(0); // capitals, with doNotHyphenateCaps
    expect(hyphenated(7)).toBe(0); // German-tagged text
    let run = 0;
    for (const line of layout.lines) { run = line.autoHyphen ? run + 1 : 0; expect(run).toBeLessThanOrEqual(2); }
  });
  it('round-trips a settings change without touching other parts, and undo restores the original bytes', async () => {
    const { pkg, model, save } = await open();
    const original = unzipSync(readFileSync('public/fixtures/hyphenation.docx'));
    setHyphenationSettings(model, { autoHyphenation: false, hyphenationZone: 360 });
    const parts = await save();
    for (const name in original) if (name !== 'word/settings.xml') expect(parts[name], name).toEqual(original[name]);
    const settings = strFromU8(parts['word/settings.xml']);
    expect(settings).not.toContain('autoHyphenation');
    expect(settings).toMatch(/<w:zoom w:percent="100"\/><w:defaultTabStop w:val="720"\/><w:consecutiveHyphenLimit w:val="2"\/><w:hyphenationZone w:val="360"\/><w:doNotHyphenateCaps\/><w:characterSpacingControl/);
    expect((await DocxPackage.open(zipSync(parts))).pageSettings).toMatchObject({ autoHyphenation: false, hyphenationZone: 360, doNotHyphenateCaps: true });
    model.undo();
    const undone = await save();
    for (const name in original) expect(undone[name], name).toEqual(original[name]);
    expect(pkg.pageSettings.autoHyphenation).toBe(true);
  });
  it('finds manual hyphenation candidates and stores accepted breaks as soft hyphens', async () => {
    const { model, save } = await open();
    setHyphenationSettings(model, { autoHyphenation: false });
    const editor = { session: { body: model }, measure, pageStories: undefined, drawingLayouts: undefined };
    const candidate = nextHyphenationCandidate(editor, 0);
    expect(candidate).not.toBeNull();
    expect(candidate.points).toContain(candidate.proposed);
    expect(model.text.slice(candidate.start, candidate.end)).toBe(candidate.text);
    const at = candidate.start + candidate.proposed;
    model.select(at, at); model.replace('­');
    // The next candidate comes after the hyphenated word.
    const next = nextHyphenationCandidate(editor, candidate.end + 1);
    if (next) expect(next.start).toBeGreaterThan(candidate.end);
    const parts = await save();
    expect(strFromU8(parts['word/document.xml'])).toContain('<w:softHyphen/>');
    const reopened = await DocxPackage.open(zipSync(parts));
    expect(reopened.paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n')).toContain(candidate.text.slice(0, candidate.proposed) + '­' + candidate.text.slice(candidate.proposed));
  });
  it('finds the word around a position', () => {
    expect(wordAround('say “hello,” now', 7)).toEqual({ start: 5, end: 10, text: 'hello' });
    expect(wordAround('a b', 1)).toEqual({ start: 0, end: 1, text: 'a' });
    expect(wordAround('  ', 1)).toBeNull();
  });
});
