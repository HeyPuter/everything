import { describe, expect, it } from 'vitest';
import { completionContext } from '../src/core/formula/hints.js';

// A quoted sheet name may hold a comma or a parenthesis; neither separates nor opens an argument.
const call = (text) => {
  const c = completionContext(text);
  return c && { name: c.name, argIndex: c.argIndex };
};

describe('argument hints after a quoted sheet name', () => {
  it('counts arguments past commas and parentheses inside the name', () => {
    expect(call("=SUMIF('Sales, 2024'!A:A,\"x\",")).toEqual({ name: 'SUMIF', argIndex: 2 });
    expect(call("=SUM('a,b'!A1,")).toEqual({ name: 'SUM', argIndex: 1 });
    expect(call("=IF('Q1 (draft)'!A1>0,")).toEqual({ name: 'IF', argIndex: 1 });
    expect(call("=IF('Q1 (x'!A1>0,")).toEqual({ name: 'IF', argIndex: 1 });
    expect(call("=MAX(1,SUM('a,b'!A1:'a,b'!B2,")).toEqual({ name: 'SUM', argIndex: 1 });
  });

  it('reads a doubled quote as part of the name', () => {
    expect(call("=SUM('It''s, ok'!A1,")).toEqual({ name: 'SUM', argIndex: 1 });
    expect(call("=SUM('''x,'!A1,B1,")).toEqual({ name: 'SUM', argIndex: 2 });
    expect(call("=SUM('a'''!A1,")).toEqual({ name: 'SUM', argIndex: 1 });
  });

  it('still counts unquoted names and strings as before', () => {
    expect(call('=SUMIF(Data!A:A,"x",')).toEqual({ name: 'SUMIF', argIndex: 2 });
    expect(call('=CONCAT("it\'s, ok",')).toEqual({ name: 'CONCAT', argIndex: 1 });
  });
});
