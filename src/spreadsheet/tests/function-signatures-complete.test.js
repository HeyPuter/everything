import { expect, it } from 'vitest';
import { FUNCTION_NAMES } from '../src/core/formula/functions.js';
import { signatureFor } from '../src/core/formula/hints.js';

// 180 functions had no entry in the signature table, MAXIFS, ROWS, CONCATENATE, TRUNC, HOUR and
// RANDBETWEEN among them, so typing one showed "..." for its arguments and Insert Function said
// "No description is available". Every function now names its arguments and says what it does.
it('names the arguments and describes every function', () => {
  const missing = FUNCTION_NAMES.filter((name) => signatureFor(name).params === '...' || !signatureFor(name).description);
  expect(missing).toEqual([]);
  expect(signatureFor('MAXIFS').params).toBe('max_range, criteria_range1, criteria1, ...');
  expect(signatureFor('ROWS').params).toBe('range');
  expect(signatureFor('PI').params).toBe('');
});
