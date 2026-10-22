import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// The REGEX functions handed their pattern to JavaScript's engine, which reads some of what Excel's (PCRE) and
// Sheets' (RE2) engines share otherwise: \A and \z were the letters A and z, so REGEXTEST("abc","\Aabc\z")
// was FALSE; [[:digit:]] was a set of the characters [:digt and a ], so REGEXEXTRACT("ab12","[[:digit:]]+")
// was #N/A; []] could match nothing; and the named groups (?P<name>...) were refused as #VALUE!.
it('reads the anchors for the whole text', () => {
  expect(calc('REGEXTEST("abc","\\Aabc\\z")')).toBe(true);
  expect(calc('REGEXTEST("xabc","\\Aabc")')).toBe(false);
  expect(calc('REGEXTEST("a"&CHAR(10)&"b","\\Ab",0)')).toBe(false); // not the start of a line, unlike ^ with (?m)
  expect(calc('REGEXTEST("abc"&CHAR(10),"abc\\Z")')).toBe(true); // \Z allows a final line break, \z does not
  expect(calc('REGEXTEST("abc"&CHAR(10),"abc\\z")')).toBe(false);
  expect(calc('REGEXMATCH("abc","\\Aa")')).toBe(true);
});

it('reads POSIX classes inside brackets', () => {
  expect(calc('REGEXEXTRACT("ab12cd","[[:digit:]]+")')).toBe('12');
  expect(calc('REGEXEXTRACT("ab12cd","[^[:alpha:]]+")')).toBe('12');
  expect(calc('REGEXEXTRACT("a-b!c","[[:punct:][:space:]]+")')).toBe('-');
  expect(calc('REGEXTEST("A","[[:lower:]]",1)')).toBe(true); // case-insensitive, as the engines read it
  expect(calc('REGEXREPLACE("a]b","[]]","x")')).toBe('axb');
  expect(calc('REGEXREPLACE("a]b","[^]]","x")')).toBe('x]x');
});

it('reads named groups written the Python way', () => {
  expect(calc('REGEXEXTRACT("ab12","(?P<d>\\d+)")')).toBe('12');
  expect(calc('REGEXTEST("abab","(?P<x>ab)(?P=x)")')).toBe(true);
  // An escaped backslash before A is still a backslash and an A.
  expect(calc('REGEXTEST("a\\Ab","\\\\A")')).toBe(true);
});
