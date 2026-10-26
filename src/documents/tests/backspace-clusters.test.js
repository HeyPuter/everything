import { it, expect } from 'vitest';
import { TextDocument, paragraph, boundaries } from '../src/engine/model.js';

/** Backspace at the end of `text`, as the editor's key does. */
function backspace(text, { at = text.length, track = false } = {}) {
  const doc = new TextDocument([paragraph(text)], undefined, undefined, undefined, [], {}, { trackChanges: track });
  doc.select(at);
  doc.delete(-1);
  return { doc, text: doc.paragraphs[0].runs.filter(r => r.revision?.type !== 'del').map(r => r.text).join(''), caret: doc.selection.focus };
}

it('Backspace takes back the last character of a syllable or accented letter, as text fields do', () => {
  // A vowel sign, a virama's consonant, a Thai vowel or tone mark, an Arabic mark, a combining accent.
  for (const [text, left] of [['कि', 'क'], ['क्षि', 'क्ष'], ['ক্ষ', 'ক্'], ['நி', 'ந'], ['สวัสดี', 'สวัสด'], ['مَرْحَبًا', 'مَرْحَبً'], ['é', 'e'], ['한국', '한']]) {
    const result = backspace(text);
    expect(result.text, text).toBe(left);
    expect(result.caret, text).toBe(left.length);
  }
  // Symbols made of several code points go whole: emoji with a skin tone, flags, keycaps, ZWJ sequences, variation sequences.
  for (const text of ['👍🏽', '🇫🇷', '1️⃣', '👩‍💻', '☺️']) expect(backspace(`a${text}`).text, text).toBe('a');
  // Undo puts the whole syllable back.
  const { doc } = backspace('नमस्ते');
  expect(doc.paragraphs[0].runs.map(r => r.text).join('')).toBe('नमस्त');
  doc.undo();
  expect(doc.paragraphs[0].runs.map(r => r.text).join('')).toBe('नमस्ते');
});

it('a cluster whose remainder would join the next character, or one tracked as deleted, goes whole', () => {
  // Wherever the caret is left, it is between two characters, never inside one.
  for (const [text, at] of [['क्षत', 3], ['क्षि', 4], ['स्त्री', 6]]) {
    const { doc, caret } = backspace(text, { at });
    expect(boundaries(doc.text), text).toContain(caret);
  }
  // With Track Changes on, the struck-out mark would stay inside the cluster: the whole cluster is marked deleted.
  const tracked = backspace('कि', { track: true });
  expect(tracked.text).toBe('');
  expect(tracked.doc.paragraphs[0].runs.find(r => r.revision?.type === 'del')?.text).toBe('कि');
});
