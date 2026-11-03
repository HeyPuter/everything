import { expect, it } from 'vitest';
import { buildCall, functionParams } from '../src/ui/insertfunction.js';

it('reads required, optional and repeating arguments from a signature', () => {
  expect(functionParams('TRUNC')).toEqual({ params: [{ name: 'number', optional: false }, { name: 'digits', optional: true }], repeat: false });
  const sum = functionParams('SUM');
  expect(sum.params[0]).toEqual({ name: 'number1', optional: false });
  expect(sum.repeat).toBe(true);
});

it('falls back to the function arity when no signature is documented', () => {
  const { params } = functionParams('ACOS');
  expect(params.length).toBeGreaterThan(0);
  expect(params[0].optional).toBe(false);
});

it('drops trailing empty optional arguments but keeps inner blanks', () => {
  expect(buildCall('PMT', ['0.05/12', '36', '-10000', '', ''])).toBe('PMT(0.05/12, 36, -10000)');
  expect(buildCall('IF', ['A1>0', '', '"no"'])).toBe('IF(A1>0, , "no")');
  expect(buildCall('NOW', [])).toBe('NOW()');
});
