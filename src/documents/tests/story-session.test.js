import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const first = 'word/footer-first.xml', even = 'word/footer-even.xml';
async function setup() {
  const pkg = await DocxPackage.open(readFileSync('tests/fixtures/page-stories/footer-variants.docx'));
  return { pkg, session: new StorySession(new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets), pkg.pageStories) };
}
const parts = async (s, p) => unzipSync(new Uint8Array(await s.export(p).arrayBuffer()));

it('undoes body and separate story edits chronologically regardless of the selected area', async () => {
  const { pkg, session: s } = await setup();
  s.run(d => d.replace('Body '));
  s.activate(first); s.run(d => d.replace('First '));
  s.activate(even); s.page = 1; s.run(d => d.replace('Even '));
  const edited = await parts(s, pkg);
  s.activate(null);
  expect(s.undo()).toBe(true); expect(s.path).toBe(even); expect(s.page).toBe(1); expect(s.model.text).toBe('Even \ufffc');
  s.undo(); expect(s.path).toBe(first); expect(s.model.text).toBe('First \ufffc');
  s.undo(); expect(s.path).toBe(null); expect(await parts(s, pkg)).toEqual(pkg.parts);
  s.redo(); s.redo(); s.redo(); expect(await parts(s, pkg)).toEqual(edited);
  expect(s.history.map(entry => entry.path)).toEqual([null, first, even]);
  expect(s.history.every(entry => !('stories' in entry.state))).toBe(true);
});

it('rolls back failed commands and failed undo without losing either story or redo history', async () => {
  const { pkg, session: s } = await setup();
  s.run(d => d.replace('Body ')); s.activate(first); s.run(d => d.replace('Header '));
  s.activate(null); const before = await parts(s, pkg), history = [...s.history];
  expect(() => s.undo(() => { throw new Error('layout rejected'); })).toThrow('layout rejected');
  expect(s.path).toBe(null); expect(await parts(s, pkg)).toEqual(before); expect(s.history).toEqual(history);
  s.undo(); const undone = await parts(s, pkg), future = [...s.future];
  expect(() => s.run(d => d.replace('Bad '), () => { throw new Error('command rejected'); })).toThrow('command rejected');
  expect(await parts(s, pkg)).toEqual(undone); expect(s.future).toEqual(future);
  s.redo(); expect(await parts(s, pkg)).toEqual(before);
});

it('shares document-wide numbering across stories and restores it on undo', async () => {
  const { session: s } = await setup(); s.activate(first);
  const before = structuredClone(s.body.numbering);
  s.run(d => d.toggleList('bullet'));
  expect(s.body.numbering).toEqual(s.model.numbering); expect(s.body.numbering).not.toEqual(before);
  s.activate(even); expect(s.model.numbering).toEqual(s.body.numbering);
  s.undo(); expect(s.path).toBe(first); expect(s.body.numbering).toEqual(before);
  s.activate(even); expect(s.model.numbering).toEqual(before);
});

it('does not create history for switching areas or selection, and a new edit clears cross-story redo', async () => {
  const { session: s } = await setup(); s.activate(first); s.run(d => d.select(2));
  expect(s.history).toEqual([]); s.run(d => d.replace('X')); s.undo();
  s.activate(even); s.run(d => d.replace('Y')); expect(s.future).toEqual([]);
  expect(() => s.activate('word/missing.xml')).toThrow('not available'); expect(s.path).toBe(even);
});

it('types beside an atomic page field without copying its field metadata', async () => {
  const { pkg, session: s } = await setup(); s.activate(first);
  const original = s.model.text;
  s.run(d => { d.select(d.text.length); return d.replace(' after'); });
  expect(s.model.paragraphs.flatMap(p => p.runs).filter(r => r.field)).toHaveLength(1);
  const reopened = await DocxPackage.open(new Uint8Array(await s.export(pkg).arrayBuffer()));
  expect(reopened.pageStories.stories[first].paragraphs[0].runs.map(r => r.text).join('')).toBe(original + ' after');
  s.undo(); expect(await parts(s, pkg)).toEqual(pkg.parts);
});

describe('the cost of one command', () => {
  it('copies the document once per keystroke, and still undoes each command exactly', () => {
    const doc = new TextDocument(Array.from({ length: 50 }, (_, i) => paragraph(`Paragraph ${i}`)));
    const session = new StorySession(doc, null);
    let copies = 0;
    const snapshot = doc.snapshot.bind(doc);
    doc.snapshot = () => { copies++; return snapshot(); };
    doc.select(3);
    for (let k = 0; k < 5; k++) session.run(() => doc.replace('x'), undefined, { record: k === 0 });
    expect(copies).toBe(5);
    expect(doc.text.startsWith('Parxxxxxagraph 0')).toBe(true);
    session.run(() => { doc.select(0, 4); return doc.delete(1); });
    session.undo();
    expect(doc.text.startsWith('Parxxxxxagraph 0')).toBe(true);
    session.undo();
    expect(doc.text.startsWith('Paragraph 0')).toBe(true);
    // Outside a session the model keeps full copies for its own undo.
    expect(Object.hasOwn(doc, 'checkpoint')).toBe(false);
    doc.select(0); doc.replace('y'); doc.undo();
    expect(doc.text.startsWith('Paragraph 0')).toBe(true);
  });
});

describe('a section break in a one-section document with a footer', () => {
  it('gives the new section the file\'s headers and footers', async () => {
    const { pageStoryPath } = await import('../src/engine/page-stories.js');
    const pkg = await DocxPackage.open(readFileSync('public/fixtures/default-paragraph-spacing-after.docx'));
    const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    const session = new StorySession(doc, pkg.pageStories);
    expect(pkg.pageStories.sections).toHaveLength(1);
    const kind = Object.values(pkg.pageStories.stories).find(s => ['header', 'footer'].includes(s.kind))?.kind;
    expect(kind).toBeTruthy();
    doc.select(0); doc.insertSectionBreak('nextPage');
    expect(session.pageStories.sections).toHaveLength(2);
    expect(pageStoryPath(session.pageStories, 1, kind, 2, true)).toBe(pageStoryPath(session.pageStories, 0, kind, 1, true));
  });
});

it('undoes and redoes header and footer options as one step each, saving as before them', async () => {
  const { pkg, session: s } = await setup();
  s.settingsHost = { capture: () => pkg.settingsState(), restore: state => pkg.restoreSettings(state) };
  const setOptions = (section, patch) => {
    if ('firstPageDifferent' in patch) pkg.setTitlePage(section, patch.firstPageDifferent);
    if ('pageNumbering' in patch) pkg.setPageNumbering(section, patch.pageNumbering);
    s.definition = { ...s.definition, sections: s.definition.sections.map((value, i) => (i === section ? { ...value, ...patch } : value)) };
  };
  s.run(d => d.replace('Body '));
  const typed = await parts(s, pkg), was = s.definition.sections[0].firstPageDifferent;
  expect(s.changeSettings(() => setOptions(0, { firstPageDifferent: !was, pageNumbering: { format: 'upperRoman' } }))).toBe(true);
  // Setting what is already set is no step.
  expect(s.changeSettings(() => setOptions(0, { firstPageDifferent: !was }))).toBe(false);
  expect(s.history).toHaveLength(2);
  const changed = await parts(s, pkg);
  expect(new TextDecoder().decode(changed['word/document.xml'])).toContain('upperRoman');
  expect(s.undo()).toBe(true);
  expect(s.definition.sections[0]).toMatchObject({ firstPageDifferent: was });
  expect(s.definition.sections[0].pageNumbering).toBeUndefined();
  expect(s.model.text.startsWith('Body ')).toBe(true);
  expect(await parts(s, pkg)).toEqual(typed);
  s.redo();
  expect(await parts(s, pkg)).toEqual(changed);
  s.undo(); s.undo();
  expect(await parts(s, pkg)).toEqual(pkg.parts);
});

it('undoes and redoes edits to several stories made as one transaction in one step', async () => {
  const { pkg, session: s } = await setup();
  s.run(d => d.replace('Body '));
  const before = await parts(s, pkg);
  s.transact(() => {
    s.activate(first); s.run(d => d.replace('First '));
    s.activate(even); s.page = 1; s.run(d => d.replace('Even '));
    s.activate(null); s.run(d => d.replace('More '));
  });
  const edited = await parts(s, pkg);
  expect(s.history).toHaveLength(2);
  expect(s.undo()).toBe(true);
  expect(await parts(s, pkg)).toEqual(before);
  // It ends where the transaction's first change was made.
  expect(s.path).toBe(first);
  expect(s.history).toHaveLength(1);
  expect(s.redo()).toBe(true);
  expect(await parts(s, pkg)).toEqual(edited);
  // Round and round, the same two states.
  s.undo(); s.redo(); s.undo();
  expect(await parts(s, pkg)).toEqual(before);
  s.undo();
  expect(await parts(s, pkg)).toEqual(pkg.parts);
  s.redo(); s.redo();
  expect(await parts(s, pkg)).toEqual(edited);
  // A transaction of one change is that change's own step.
  s.transact(() => s.run(d => d.replace('Last ')));
  expect(s.history).toHaveLength(3);
  expect(s.history.at(-1).steps).toBeUndefined();
});

it('takes back a transaction of text and settings changes in one step', async () => {
  const { pkg, session: s } = await setup();
  s.settingsHost = { capture: () => pkg.settingsState(), restore: state => pkg.restoreSettings(state) };
  const original = await parts(s, pkg), was = !!s.definition.sections[0].firstPageDifferent;
  s.transact(() => {
    s.run(d => d.replace('Body '));
    s.changeSettings(() => { pkg.setTitlePage(0, !was); s.definition = { ...s.definition, sections: s.definition.sections.map((v, i) => (i ? v : { ...v, firstPageDifferent: !was })) }; });
  });
  const changed = await parts(s, pkg);
  expect(s.history).toHaveLength(1);
  s.undo();
  expect(await parts(s, pkg)).toEqual(original);
  expect(!!s.definition.sections[0].firstPageDifferent).toBe(was);
  s.redo();
  expect(await parts(s, pkg)).toEqual(changed);
  expect(!!s.definition.sections[0].firstPageDifferent).toBe(!was);
});

it('takes back settings an edit wrote (run with settings) with the edit, in both directions', () => {
  const s = new StorySession(new TextDocument([paragraph('Text')]));
  let stored = { style: 'apa' };
  s.settingsHost = { capture: () => ({ ...stored }), restore: state => { stored = { ...state }; } };
  s.run(model => { stored = { style: 'mla' }; model.select(4); model.replace(' (MLA)'); }, undefined, { settings: true });
  expect(s.history).toHaveLength(1);
  s.undo();
  expect([s.model.text, stored.style]).toEqual(['Text', 'apa']);
  s.redo();
  expect([s.model.text, stored.style]).toEqual(['Text (MLA)', 'mla']);
  // A failed edit leaves both as they were.
  expect(() => s.run(() => { stored = { style: 'ieee' }; throw new Error('refused'); }, undefined, { settings: true })).toThrow('refused');
  expect(stored.style).toBe('mla');
});
