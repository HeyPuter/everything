import { it, expect, describe } from 'vitest';
import { syllables, textStatistics, isPassive, easeLabel, sentences } from '../src/lib/readability.js';
import { countWords } from '../src/core/text.js';
import { checkAccessibility, contrastRatio, luminance } from '../src/lib/accessibility.js';
import { grammarPrompt, parseSuggestions, locateSuggestions, batches, checkGrammar, parseTranslation, translateParagraphs } from '../src/lib/proofing-ai.js';
import { mentionPieces, mentionsIn } from '../src/views/mentions.js';
import { textBoxParagraphs } from '../src/views/word-count.js';
import { wordAt } from '../src/views/thesaurus-pane.js';

describe('readability', () => {
  it('estimates syllables for common English words', () => {
    const cases = { the: 1, cat: 1, table: 2, water: 2, beautiful: 3, education: 4, wanted: 2, boxes: 2, makes: 1, readability: 5, are: 1, simple: 2, radio: 3, ratio: 2, special: 2, piano: 3 };
    for (const [word, count] of Object.entries(cases)) expect(syllables(word), word).toBe(count);
  });

  it('applies the Flesch formulas to known counts', () => {
    // 2 sentences, 14 words, all one syllable (hand-counted).
    const s = textStatistics('The cat sat on the mat. The dog ran to the big red barn.');
    expect([s.sentences, s.words, s.syllables]).toEqual([2, 14, 14]);
    const wps = s.words / s.sentences, spw = s.syllables / s.words;
    expect(s.readability.fleschReadingEase).toBeCloseTo(206.835 - 1.015 * wps - 84.6 * spw, 0);
    expect(s.readability.fleschKincaidGrade).toBeCloseTo(Math.max(0, 0.39 * wps + 11.8 * spw - 15.59), 0);
    expect(s.readability.fleschReadingEase).toBeGreaterThan(90);
    expect(easeLabel(s.readability.fleschReadingEase)).toBe('Very easy');
  });

  it('counts characters, paragraphs and averages', () => {
    const s = textStatistics('One two three.\n\nFour five.');
    expect(s).toMatchObject({ words: 5, paragraphs: 2, characters: 24, charactersNoSpaces: 21 });
    expect(s.averages.wordsPerSentence).toBe(2.5);
    expect(textStatistics('').readability).toEqual({ fleschReadingEase: 0, fleschKincaidGrade: 0, passivePercent: 0 });
  });

  it('counts words between spaces, as the status bar and the Word Count dialog both show them', () => {
    const text = 'E-mail the well-known co-op today. It costs $5.50 (or 5,000 yen) — fine.';
    expect(countWords(text)).toBe(13);
    expect(textStatistics(text).words).toBe(13);
    expect(countWords('  one\ttwo\nthree\u000efour  ')).toBe(4);
    expect([countWords(''), countWords('   '), countWords('\uFFFC'), countWords('a picture \uFFFC here')]).toEqual([0, 0, 0, 3]);
    // Thai, Lao, Khmer and Myanmar, written without spaces, count the words in them.
    expect(countWords('ภาษาไทยง่ายนิดเดียว')).toBeGreaterThan(1);
    expect(textStatistics('ภาษาไทยง่ายนิดเดียว').words).toBe(countWords('ภาษาไทยง่ายนิดเดียว'));
  });

  it('estimates passive sentences', () => {
    expect(isPassive('The report was written by the team.')).toBe(true);
    expect(isPassive('The cake is being eaten.')).toBe(true);
    expect(isPassive('The results were quickly published.')).toBe(true);
    expect(isPassive('The team wrote the report.')).toBe(false);
    expect(isPassive('She is happy.')).toBe(false);
    expect(isPassive('That was indeed true.')).toBe(false);
    expect(textStatistics('The report was written. We wrote it.').readability.passivePercent).toBe(50);
    expect(sentences('First line\nSecond line')).toEqual(['First line', 'Second line']);
  });
});

describe('accessibility rules', () => {
  const run = (text, extra = {}) => ({ text, ...extra });
  const para = (runs, extra = {}) => ({ id: `p${Math.random()}`, runs, ...extra });
  it('computes contrast ratios per the luminance definition', () => {
    expect(contrastRatio('000000', 'FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('FFFFFF', 'FFFFFF')).toBe(1);
    expect(contrastRatio('777777', 'FFFFFF')).toBeCloseTo(4.48, 1);
    expect(luminance('nothex')).toBeNull();
  });

  it('flags each kind of problem with a position and a fix', () => {
    const paragraphs = [
      para([run('Title')], { format: { outlineLevel: 0 } }),
      para([run('Skipped')], { format: { outlineLevel: 2 } }),
      para([run('￼', { image: { name: 'Chart', alt: '' } })]),
      para([run('Faint', { color: 'EEEEEE' }), run(' highlighted', { color: '000000', highlight: 'black' })]),
      para([]), para([]), para([]),
      para([run('See '), run('here', { link: { id: 'l1', target: 'https://example.com' } }), run('   gap')]),
      para([run('A')], { cellId: 'c1' }), para([run('B')], { cellId: 'c2' }), para([run('')], { cellId: 'c3' }), para([run('')], { cellId: 'c4' }),
      para([run('End')]),
    ];
    const tables = [{ id: 't', rows: [{ cells: [{ id: 'c1' }, { id: 'c2', span: 2 }] }, { cells: [{ id: 'c3' }, { id: 'c4' }] }] }];
    const issues = checkAccessibility({ paragraphs, tables, pageSettings: { background: 'auto' } }, { headingLevel: p => p.format?.outlineLevel !== undefined ? p.format.outlineLevel + 1 : null });
    const by = rule => issues.filter(i => i.rule === rule);
    expect(by('headingOrder')).toHaveLength(1);
    expect(by('altText')[0]).toMatchObject({ severity: 'error', fix: { kind: 'altText' } });
    expect(by('lowContrast')[0]).toMatchObject({ fix: { kind: 'autoColor' } });
    expect(by('hardColors')[0]).toMatchObject({ fix: { kind: 'clearHighlight' } });
    expect(by('emptyParagraphs')[0].fix.paragraphs).toHaveLength(3);
    expect(by('unclearLinks')[0].detail).toBe('“here”');
    expect(by('repeatedBlanks')[0]).toMatchObject({ detail: '3 spaces in a row', fix: { kind: 'collapseBlanks' } });
    expect(by('tableHeader')[0].fix).toMatchObject({ kind: 'headerRow', cellId: 'c1' });
    expect(by('mergedCells')).toHaveLength(1);
    expect(by('blankRows')[0].fix).toMatchObject({ kind: 'deleteRow', cellId: 'c3' });
    const text = paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n');
    expect(text.slice(by('unclearLinks')[0].start, by('unclearLinks')[0].end)).toBe('here');
    // Automatic text color is readable on a dark page.
    expect(checkAccessibility({ paragraphs: [para([run('Auto')])], tables: [], pageSettings: { background: '111111' } }).filter(i => i.rule === 'lowContrast')).toEqual([]);
  });
});

describe('AI grammar and translation helpers', () => {
  it('builds a fenced prompt and parses suggestions defensively', () => {
    const prompt = grammarPrompt(['Their going home.', 'Fine text.'], { kinds: ['grammar'] });
    expect(prompt).toContain('[1] Their going home.');
    expect(prompt).toMatch(/"""\n\[1\]/);
    const answer = 'Sure! [{"paragraph":1,"original":"Their going","suggestion":"They\'re going","kind":"grammar","reason":"Contraction."},{"paragraph":9,"original":"x","suggestion":"y"},{"paragraph":2,"original":"Fine","suggestion":"Fine"}]';
    const parsed = parseSuggestions(answer, 2);
    expect(parsed).toEqual([{ paragraph: 0, original: 'Their going', suggestion: 'They\'re going', kind: 'grammar', reason: 'Contraction.' }]);
    expect(parseSuggestions('no json here', 2)).toEqual([]);
    expect(locateSuggestions(parsed, [{ text: 'Their going home.', start: 10 }])).toEqual([{ ...parsed[0], start: 10, end: 21 }]);
    expect(batches([{ text: 'a'.repeat(4000) }, { text: 'b'.repeat(4000) }, { text: 'c' }], 6000).map(b => b.length)).toEqual([1, 2]);
  });

  it('checks paragraphs with an injected chat and reports service failures readably', async () => {
    const chat = async prompt => prompt.includes('Their') ? '[{"paragraph":1,"original":"Their","suggestion":"They\'re","kind":"grammar"}]' : '[]';
    const found = await checkGrammar([{ text: 'Their here.', start: 0 }, { text: 'ok', start: 12 }], { chat });
    expect(found.map(f => [f.start, f.end, f.suggestion])).toEqual([[0, 5, 'They\'re']]);
    await expect(checkGrammar([{ text: 'Some text here', start: 0 }], { chat: async () => { throw new Error('insufficient funds'); } })).rejects.toThrow(/not available for your account/);
  });

  it('translates paragraphs in batches, keeping empty ones', async () => {
    expect(parseTranslation('["Hola","Mundo"]', 2)).toEqual(['Hola', 'Mundo']);
    expect(parseTranslation('[1] Hola\n[2] Mundo', 2)).toEqual(['Hola', 'Mundo']);
    expect(parseTranslation('["Hola"]', 2)).toBeNull();
    const chat = async prompt => JSON.stringify([...prompt.matchAll(/\[(\d+)\] (.*)/g)].map(m => m[2].toUpperCase()));
    expect(await translateParagraphs(['hello', '', 'world'], 'Shouting', { chat })).toEqual(['HELLO', '', 'WORLD']);
  });
});

describe('mentions, words and text boxes', () => {
  it('finds @mentions of known people only', () => {
    const people = ['Ada Lovelace', 'Ada', 'Grace Hopper'];
    expect(mentionPieces('Thanks @Ada Lovelace and @grace hopper! mail@example.com', people)).toEqual([
      { text: 'Thanks ' }, { text: '@Ada Lovelace', mention: 'Ada Lovelace' }, { text: ' and ' }, { text: '@grace hopper', mention: 'Grace Hopper' }, { text: '! mail@example.com' }]);
    expect(mentionsIn('@Ada, please check', people)).toEqual(['Ada']);
    expect(mentionsIn('@Nobody here', people)).toEqual([]);
  });

  it('finds the word at a position and text in drawings', () => {
    expect(wordAt('The quick brown fox.', 6)).toEqual({ start: 4, end: 9, word: 'quick' });
    expect(wordAt('don’t stop', 2)).toEqual({ start: 0, end: 5, word: 'don’t' });
    expect(wordAt('   ', 1)).toBeNull();
    const assets = { a: { scene: { children: [{ text: { paragraphs: [{ runs: [{ text: 'Box text' }] }] } }] } }, b: { width: 3 } };
    expect(textBoxParagraphs(assets).map(p => p.runs[0].text)).toEqual(['Box text']);
  });
});
