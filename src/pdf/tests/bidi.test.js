import { expect, it } from 'vitest';
import { readingOrder, reorderSegments, reorderText, textDirection } from '../src/core/bidi.js';

// Reading order and the visual order a browser (or a PDF writer) lays the line out in.
const lines = [
  ['שלום עולם', 'rtl', 'םלוע םולש'],
  ['שלום 123', 'rtl', '123 םולש'],
  ['מחיר: 1,000.50 ₪', 'rtl', '₪ 1,000.50 :ריחמ'],
  ['שלום עולם Hello', 'rtl', 'Hello םלוע םולש'],
  ['50% הנחה', 'rtl', 'החנה 50%'],
  ['טלפון 03-1234567', 'rtl', '03-1234567 ןופלט'],
  ['مرحبا بالعالم 123', 'rtl', '123 ملاعلاب ابحرم'],
  ['السعر ١٢٣ دينار', 'rtl', 'رانيد ١٢٣ رعسلا'],
  ['Hello שלום עולם there', 'ltr', 'Hello םלוע םולש there'],
  ['שָׁלוֹם', 'rtl', 'םוֹלשָׁ'],
];

it('lays out right-to-left lines as the bidirectional algorithm does, and back', () => {
  for (const [reading, direction, visual] of lines) {
    expect(textDirection(visual)).toBe(direction);
    expect(reorderText(reading, direction)).toBe(visual);
    expect(reorderText(visual, direction)).toBe(reading);
  }
  expect(reorderText('שלום\nעולם 2', 'rtl')).toBe('םולש\n2 םלוע');
});

it('leaves text without right-to-left letters alone', () => {
  expect(textDirection('Hello world 42')).toBe(null);
  expect(readingOrder('Hello world 42')).toBe(null);
});

it('keeps each character with its own text fragment', () => {
  const visual = [
    { text: 'םלוע', part: 0 },
    { text: ' ', part: 0, gap: [4, 0] },
    { text: 'םולש', part: 1 },
  ];
  const shown = readingOrder('םלוע םולש', visual);
  expect(shown).toEqual({
    direction: 'rtl',
    text: 'שלום עולם',
    segments: [
      { text: 'שלום', part: 1 },
      { text: ' ', part: 0, gap: [4, 0] },
      { text: 'עולם', part: 0 },
    ],
  });
  expect(reorderSegments(shown.segments, 'rtl')).toEqual(visual);
});
