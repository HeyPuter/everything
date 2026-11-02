// Merge field switches: seconds in a date picture (§17.16.4.1) and the CardText, OrdText and Hex formats (§17.16.4.3)
// were left as they were (2:07:ss, 3); merge fields now share the DATE field's pictures and the general formats.
import { it, expect } from 'vitest';
import { formatDatePicture, formatValue, evaluateField, mergeContext } from '../src/engine/merge-fields.js';

// §17.16.4.1: s / ss are seconds in a date-time picture (the body DATE/TIME evaluator supports them).
it('MERGEFIELD date pictures format seconds', () => {
  expect(formatDatePicture('2026-03-05 14:07', 'h:mm:ss')).toBe('2:07:00');
  expect(formatDatePicture('2026-03-05 14:07', 'HH:mm:ss')).toBe('14:07:00');
});

// §17.16.4.3 general formatting: CardText / OrdText / Hex apply to any numeric result, merge fields included.
it('MERGEFIELD applies the CardText, OrdText and Hex number formats', () => {
  expect(formatValue('5', { '\\*': ['CardText'] })).toBe('five');
  expect(formatValue('21', { '\\*': ['OrdText'] })).toBe('twenty-first');
  expect(formatValue('255', { '\\*': ['Hex'] })).toBe('FF');
  const ctx = mergeContext({ data: [{ number: 1, values: { Qty: '3' } }] });
  expect(evaluateField(' MERGEFIELD Qty \\* CardText ', ctx)).toBe('three');
});
