import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { verifyPassword, permissionRanges, protectionGuard, ProtectionError } from '../src/engine/protection.js';
import { mergeDocuments, documentAuthor } from '../src/engine/compare.js';
import { proofingText, wordsToCheck } from '../src/lib/spelling.js';
import { checkAccessibility, summarize } from '../src/lib/accessibility.js';
import { textStatistics } from '../src/lib/readability.js';
import { describeFormatChange } from '../src/engine/revisions.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

// Fixtures written by tools/review_fixture.py, independently of the editor.
const fixture = name => readFileSync(`tests/fixtures/review/${name}`);
const open = async bytes => { const pkg = await DocxPackage.open(bytes); const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { comments: pkg.comments, trackChanges: pkg.trackRevisions }); model.revisionAuthor = 'Me'; return { pkg, model }; };
const save = async (pkg, d) => new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets, undefined, d.comments, d.trackChanges).arrayBuffer());

describe('protected fixture', () => {
  it('verifies the independently hashed password and enforces the read-only restriction', async () => {
    const source = fixture('protected.docx'), { pkg, model } = await open(source);
    expect(pkg.readOnly).toBeFalsy();
    expect(pkg.reviewSettings.protection).toMatchObject({ edit: 'readOnly', enforcement: true, algorithmName: 'SHA-512', spinCount: 100000 });
    expect(await verifyPassword('secret', pkg.reviewSettings.protection)).toBe(true);
    expect(await verifyPassword('Secret', pkg.reviewSettings.protection)).toBe(false);
    expect(permissionRanges(model.paragraphs).map(r => [model.text.slice(r.start, r.end), r.edGrp])).toEqual([['Anyone may edit this part.', 'everyone']]);
    expect(unzipSync(await save(pkg, model))).toEqual(unzipSync(source));
    const session = new StorySession(model, null);
    session.guard = protectionGuard(pkg.reviewSettings.protection, { name: 'Reader' });
    expect(() => session.run(m => { m.select(0); m.replace('X'); })).toThrow(ProtectionError);
    session.run(m => { const at = m.text.indexOf('Anyone'); m.select(at, at + 6); m.replace('Everybody'); });
    expect(model.text).toContain('Everybody may edit this part.');
  });
});

describe('tracked fixture', () => {
  it('reads moves, formatting changes and languages, and keeps them through an edit', async () => {
    const source = fixture('tracked.docx'), { pkg, model } = await open(source);
    expect(model.revisions.map(r => [r.type, r.author])).toEqual([['format', 'Ada'], ['ins', 'Ada'], ['del', 'Grace'], ['del', 'Grace'], ['format', 'Grace'], ['ins', 'Grace']]);
    expect(model.revisions.filter(r => r.move).map(r => [r.type, r.moveName])).toEqual([['del', 'move1'], ['ins', 'move1']]);
    expect(model.revisions.filter(r => r.type === 'format').map(r => r.author)).toEqual(['Ada', 'Grace']);
    expect(describeFormatChange(model.paragraphs[0])).toEqual(['Centered']);
    expect(describeFormatChange(model.paragraphs[1].runs.find(r => r.text === 'Bolded by Grace.'))).toEqual(['Bold']);
    expect(unzipSync(await save(pkg, model))).toEqual(unzipSync(source));
    const french = model.paragraphs[3].runs.find(r => r.text.startsWith('un texte'));
    expect(french.fontLanguage).toBe('fr-FR');
    // French and no-proofing text are not checked against the English dictionary.
    const checked = wordsToCheck(proofingText(model.text, model.paragraphs)).map(w => w.word);
    expect(checked).toContain('English');
    expect(checked).not.toContain('texte');
    expect(checked).not.toContain('xyzzyplugh');
    // An untracked edit rewrites the paragraphs; every revision kind survives.
    model.trackChanges = false;
    model.select(model.text.length); model.replace(' Done.');
    const xml = strFromU8(unzipSync(await save(pkg, model))['word/document.xml']);
    for (const pattern of [/<w:pPrChange w:id="10" w:author="Ada"/, /<w:rPrChange w:id="15" w:author="Grace"/, /<w:moveFromRangeStart [^>]*w:name="move1"/, /<w:moveToRangeStart [^>]*w:name="move1"/, /<w:lang w:val="fr-FR"\/>/, /<w:noProof\/>/]) expect(xml).toMatch(pattern);
    const again = await open(await save(pkg, model));
    expect(again.model.revisions.length).toBe(model.revisions.length);
  });
});

describe('compare fixtures', () => {
  it('produces word-level changes, table cell changes and new rows', async () => {
    const original = await DocxPackage.open(fixture('original.docx')), revised = await DocxPackage.open(fixture('revised.docx'));
    expect(documentAuthor(revised.parts)).toBe('Rae Viewer');
    const result = mergeDocuments({ paragraphs: revised.paragraphs, tables: revised.tables }, { paragraphs: original.paragraphs, tables: original.tables }, { author: 'Rae Viewer', date: '2026-10-13T00:00:00Z', styleIds: new Set(Object.keys(revised.styles.definitions)) });
    const model = new TextDocument(result.paragraphs, revised.pageSettings, revised.numbering, revised.styles, result.tables, revised.assets);
    const changes = model.revisions.map(r => [r.type, model.text.slice(r.start, Math.min(r.end, model.text.length))]);
    expect(changes).toEqual([
      ['del', 'ten'], ['ins', 'twelve'],
      ['del', 'two'], ['ins', 'three'], ['ins', ' and a designer'],
      ['del', '120'], ['ins', '125'],
      ['ins', 'West'], ['ins', '40'],
      ['del', 'steady'], ['ins', 'strong'],
      ['ins', '\nQuestions go to the finance team.'],
    ]);
    expect(model.revisions.every(r => r.author === 'Rae Viewer')).toBe(true);
    const bytes = new Uint8Array(await revised.export(result.paragraphs, revised.pageSettings, revised.numbering, revised.styles, result.tables, revised.assets).arrayBuffer());
    const reopened = await open(bytes);
    expect(reopened.model.revisions.map(r => r.type)).toEqual(model.revisions.map(r => r.type));
    reopened.model.resolveRevisions(true);
    const revisedModel = new TextDocument(revised.paragraphs, revised.pageSettings, revised.numbering, revised.styles, revised.tables, revised.assets);
    expect(reopened.model.text).toBe(revisedModel.text);
    const rejected = await open(bytes); rejected.model.resolveRevisions(false);
    const originalModel = new TextDocument(original.paragraphs, original.pageSettings, original.numbering, original.styles, original.tables, original.assets);
    // Rejecting returns the original's text, except the revised table's extra row, whose structure stays.
    expect(rejected.model.text.replace(/\n{2,}/g, '\n')).toBe(originalModel.text);
  });
});

describe('accessibility fixture', () => {
  it('finds every planted problem', async () => {
    const { model } = await open(fixture('accessibility.docx'));
    const issues = checkAccessibility({ paragraphs: model.paragraphs, tables: model.tables, pageSettings: model.pageSettings }, { headingLevel: p => p.format?.outlineLevel < 9 ? p.format.outlineLevel + 1 : null });
    const rules = new Set(issues.map(i => i.rule));
    for (const rule of ['altText', 'tableHeader', 'lowContrast', 'headingOrder', 'emptyParagraphs', 'unclearLinks', 'repeatedBlanks', 'blankRows']) expect(rules, rule).toContain(rule);
    expect(summarize(issues).errors).toBeGreaterThanOrEqual(3);
    expect(issues.find(i => i.rule === 'unclearLinks').detail).toBe('“click here”');
    expect(textStatistics(model.text).words).toBeGreaterThan(10);
  });
});

it('regenerating a protected fixture from the written package keeps protection intact', async () => {
  const { pkg, model } = await open(fixture('protected.docx'));
  pkg.reviewSettings = { ...pkg.reviewSettings, protection: { ...pkg.reviewSettings.protection, enforcement: false } };
  const out = unzipSync(await save(pkg, model));
  expect(strFromU8(out['word/settings.xml'])).toMatch(/<w:documentProtection w:edit="readOnly" w:enforcement="0" w:algorithmName="SHA-512"/);
  expect((await DocxPackage.open(zipSync(out))).reviewSettings.protection.enforcement).toBe(false);
});
