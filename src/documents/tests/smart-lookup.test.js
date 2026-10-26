// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { lookupTarget, lookupPrompt } from '../src/views/smart-lookup.js';

describe('Smart Lookup context', () => {
  it('sends the sentence that holds the term in text that ends sentences with 。', () => {
    const text = '今日は晴れです。'.repeat(100) + '量子コンピュータは速い。' + 'あとの文です。'.repeat(10);
    const at = text.indexOf('量子');
    expect(lookupTarget(text, at, at + 8)).toEqual({ phrase: '量子コンピュータ', sentence: '量子コンピュータは速い。' });
  });
  it('ends sentences at Arabic and Devanagari punctuation too', () => {
    const arabic = 'هل هذا صحيح؟ الحاسوب الكمومي سريع.';
    const at = arabic.indexOf('الحاسوب');
    expect(lookupTarget(arabic, at, at + 7).sentence).toBe('الحاسوب الكمومي سريع.');
    const hindi = 'यह पहला वाक्य है। क्वांटम कंप्यूटर तेज़ है।';
    const word = hindi.indexOf('क्वांटम');
    expect(lookupTarget(hindi, word, word).sentence).toBe('क्वांटम कंप्यूटर तेज़ है।');
  });
  it('keeps a long unpunctuated sentence to the text around the term', () => {
    const text = `${'alpha '.repeat(500)}quantum ${'omega '.repeat(500)}`;
    const at = text.indexOf('quantum');
    const { phrase, sentence } = lookupTarget(text, at, at);
    expect(phrase).toBe('quantum');
    expect(sentence).toContain('quantum');
    expect(sentence.length).toBeLessThanOrEqual(420);
    expect(lookupPrompt({ phrase, sentence })).toContain(sentence);
  });
  it('reads the sentence around a word in English as before', () => {
    const text = 'First sentence. The quantum computer is fast. Another one follows here.';
    const at = text.indexOf('quantum');
    expect(lookupTarget(text, at, at + 7)).toEqual({ phrase: 'quantum', sentence: 'The quantum computer is fast.' });
    expect(lookupTarget('One line\nquantum leap\nnext', 9, 9)).toEqual({ phrase: 'quantum', sentence: 'quantum leap' });
  });
});
