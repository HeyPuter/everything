import { afterEach, expect, it } from 'vitest';
import { describeValidation, checkValue } from '../src/core/validation.js';
import { setLocale } from '../src/core/format.js';

afterEach(() => setLocale('en-US'));

// The rules list described a Time rule as "Time: between 0.375 and 0.7083333333333334" and a Date rule with a
// comparison as "Date: greater than 45000": the day fractions and serials the rule stores, not the times and dates
// the dialog was given. Bounds now read as they are entered, numbers in the regional format.
it('describes time and date bounds as times and dates', () => {
  expect(describeValidation({ type: 'time', min: 9 / 24, max: 17 / 24 })).toBe('Time: between 09:00:00 and 17:00:00');
  expect(describeValidation({ type: 'date', operator: 'greaterThan', min: 45000 })).toBe('Date: greater than 2023-03-15');
  expect(describeValidation({ type: 'whole', min: 1, max: 10 })).toBe('Whole number: between 1 and 10');
});

it('writes number bounds with the regional decimal mark', () => {
  setLocale('de-DE');
  expect(describeValidation({ type: 'number', min: 0.5, max: 1.5 })).toBe('Number between 0,5 and 1,5');
  expect(checkValue({ type: 'number', min: 0.5 }, 0.25).message).toBe('Enter a number of at least 0,5');
});
