import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { errorCheckAt, setErrorCheckingOptions, ERROR_RULES } from '../src/core/error-checking.js';

afterEach(() => setErrorCheckingOptions({ enabled: true, ...Object.fromEntries(ERROR_RULES.map(([k, , on]) => [k, on])) }));

// A label such as E1 or e5 (a grid square, a room, a size) is text, not a number kept as text: an
// exponent with no digits before it is no number, so it gets no green triangle.
it('text like E49 is not flagged as a number stored as text', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const texts = ['E1', 'E49', 'e5', 'E-3', '+E2', '.E4'];
  texts.forEach((t, r) => wb.setInput(id, r, 0, t));
  expect(texts.map((_, r) => errorCheckAt(wb, id, r, 0)?.key ?? null)).toEqual(texts.map(() => null));
  // Numbers typed as text, with an exponent or not, still are.
  const numbers = ["'1E5", "'2.5e-3", "'.5", "'1,234", "'7%"];
  numbers.forEach((t, r) => wb.setInput(id, r, 1, t));
  expect(numbers.map((_, r) => errorCheckAt(wb, id, r, 1)?.key ?? null)).toEqual(numbers.map(() => 'numberStoredAsText'));
});
