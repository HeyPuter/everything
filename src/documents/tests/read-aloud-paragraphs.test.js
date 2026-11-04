import { describe, it, expect } from 'vitest';
import { speakableParagraphs, speechLanguage, spokenWord } from '../src/views/read-aloud.js';

const run = (text, revision) => ({ text, ...(revision ? { revision: { type: revision, author: 'A', date: '2026-01-01T00:00:00Z' } } : {}) });

describe('speakableParagraphs', () => {
  const paragraphs = [{ runs: [run('Keep '), run('old ', 'del'), run('new ', 'ins'), run('word￼.')] }, { runs: [run('  ')] }, { runs: [run('Last')] }];
  it('leaves out deleted text and maps every spoken character to its document position', () => {
    const [first, last, ...rest] = speakableParagraphs(paragraphs, 'all');
    expect(rest).toEqual([]);
    expect(first.text).toBe('Keep new word .');
    expect([first.start, first.end]).toEqual([0, 19]);
    expect(first.at).toEqual([0, 1, 2, 3, 4, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(last).toMatchObject({ start: 23, end: 27, text: 'Last', at: [23, 24, 25, 26] });
  });
  it('in the Original view, reads the deleted text and leaves out the inserted', () => {
    expect(speakableParagraphs(paragraphs, 'original')[0].text).toBe('Keep old word .');
  });
});

describe('the language a paragraph is read in', () => {
  it('follows the script of most of its letters, and the language its runs are marked in', () => {
    expect(speechLanguage('Plain English text.')).toBeNull();
    expect(speechLanguage('我们今天去北京看长城。')).toBe('zh');
    // Kana among ideographs is Japanese, however few kana there are.
    expect(speechLanguage('東京都の天気')).toBe('ja');
    expect(speechLanguage('안녕하세요 세계')).toBe('ko');
    expect(speechLanguage('مرحبا بالعالم')).toBe('ar');
    expect(speechLanguage('שלום עולם')).toBe('he');
    expect(speechLanguage('ภาษาไทยง่ายนิดเดียว')).toBe('th');
    expect(speechLanguage('Привет, мир')).toBe('ru');
    // A few English words in a Chinese paragraph leave it Chinese; digits and punctuation count for nothing.
    expect(speechLanguage('我们用Word写文章，2024年。')).toBe('zh');
    // A run's language for the paragraph's script names it: Traditional Chinese, Persian, French.
    expect(speechLanguage('我們今天去台北', [{ text: '我們今天去台北', fontLanguage: 'en-US', fontEastAsiaLanguage: 'zh-TW' }])).toBe('zh-TW');
    expect(speechLanguage('سلام دنیا', [{ text: 'سلام دنیا', fontBidiLanguage: 'fa-IR' }])).toBe('fa-IR');
    expect(speechLanguage('Bonjour le monde', [{ text: 'Bonjour le monde', fontLanguage: 'fr-FR', fontEastAsiaLanguage: 'zh-CN' }])).toBe('fr-FR');
    expect(speechLanguage('Hello', [{ text: 'Hello', fontLanguage: 'x-none' }])).toBeNull();
    // Set Language marks the main attribute: Japanese written in kanji alone is read in Japanese once marked so,
    // but an English mark (as many documents carry on every run) does not make Russian or Chinese text English.
    expect(speechLanguage('東京都', [{ text: '東京都', fontLanguage: 'ja-JP' }])).toBe('ja-JP');
    expect(speechLanguage('東京都', [{ text: '東京都', fontLanguage: 'en-US' }])).toBe('zh');
    expect(speechLanguage('Привет, мир', [{ text: 'Привет, мир', fontLanguage: 'en-US' }])).toBe('ru');
    expect(speechLanguage('Привіт, світе', [{ text: 'Привіт, світе', fontLanguage: 'uk-UA' }])).toBe('uk-UA');
  });
  it('is carried with each spoken paragraph', () => {
    const [chinese, english] = speakableParagraphs([{ runs: [run('我们今天去北京')] }, { runs: [run('Hello there')] }], 'all');
    expect(chinese.language).toBe('zh'); expect(english.language).toBeNull();
  });
});

describe('the word Read Aloud shows as it is said', () => {
  it('runs to the next space, or the length the voice reports, or in Chinese, Japanese and Thai to the end of the dictionary word', () => {
    expect(spokenWord('four. Five', 0)).toBe('four.');
    expect(spokenWord('four. Five', 0, 4)).toBe('four');
    expect(spokenWord('four. Five', 4)).toBe('.');
    expect(spokenWord('  ', 0)).toBe('');
    const chinese = '我们今天去北京看长城。';
    expect(spokenWord(chinese, 0)).toBe('我们');
    expect(spokenWord(chinese, 2)).toBe('今天');
    expect(spokenWord(chinese, 2, 3)).toBe('今天去');
    expect(spokenWord('ภาษาไทยง่าย', 0)).toBe('ภาษา');
  });
});
