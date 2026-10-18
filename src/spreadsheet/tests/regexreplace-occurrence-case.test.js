import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// REGEXREPLACE(text, pattern, replacement, [occurrence], [case_sensitivity]): occurrence 0 replaces every
// match, n only the nth and -n the nth from the end; case_sensitivity 1 ignores case.
it('replaces only the occurrence asked for', () => {
  expect(calc('REGEXREPLACE("aaa","a","b",2)')).toBe('aba');
  expect(calc('REGEXREPLACE("aaa","a","b",-1)')).toBe('aab');
  expect(calc('REGEXREPLACE("aaa","a","b",0)')).toBe('bbb');
  expect(calc('REGEXREPLACE("aaa","a","b",4)')).toBe('aaa');
  expect(calc('REGEXREPLACE("aaa","a","b",-5)')).toBe('aaa');
  expect(calc('REGEXREPLACE("a1 b22 c333","(\\d+)","<$1>",2)')).toBe('a1 b<22> c333');
  expect(calc('REGEXREPLACE("x-1 x-2","(?<=x-)\\d","N",-1)')).toBe('x-1 x-N');
});

it('ignores case when case_sensitivity is 1', () => {
  expect(calc('REGEXREPLACE("ABC","b","x",0,1)')).toBe('AxC');
  expect(calc('REGEXREPLACE("ABC","b","x",0,0)')).toBe('ABC');
  expect(calc('REGEXREPLACE("ABC","b","x",0,2)')).toEqual({ error: '#VALUE!' });
  expect(calc('REGEXREPLACE("aAa","a","x",2,1)')).toBe('axa');
});

it('keeps the three-argument form', () => {
  expect(calc('REGEXREPLACE("aaa","a","b")')).toBe('bbb');
  expect(calc('REGEXREPLACE("ab","(a)(b)","$2$1")')).toBe('ba');
});
