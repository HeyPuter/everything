import { describe, it, expect } from 'vitest';
import { toDelimited, parseDelimited, parseClipboard } from '../src/core/tsv.js';

describe('delimited text', () => {
  it('quotes only what needs quoting', () => {
    expect(toDelimited([['a', 'b'], ['c\td', 'say "hi"'], [null, 'x\ny']]))
      .toBe('a\tb\n"c\td"\t"say ""hi"""\n\t"x\ny"');
    expect(toDelimited([['1,2', 'x']], ',')).toBe('"1,2",x');
  });

  it('parses quotes, escaped quotes, and embedded newlines', () => {
    expect(parseDelimited('a\tb\n"c\td"\t"say ""hi"""\n', '\t'))
      .toEqual([['a', 'b'], ['c\td', 'say "hi"']]);
    expect(parseDelimited('"x\ny",2', ',')).toEqual([['x\ny', '2']]);
    expect(parseDelimited('a\r\nb\r\n', ',')).toEqual([['a'], ['b']]);
    expect(parseDelimited('', ',')).toEqual([]);
    expect(parseDelimited('a,,c', ',')).toEqual([['a', '', 'c']]);
  });

  it('round-trips', () => {
    const rows = [['plain', '1', ''], ['"quoted"', 'multi\nline', 'tab\there']];
    expect(parseDelimited(toDelimited(rows), '\t')).toEqual(rows);
  });

  it.each([',', '\t'])('preserves quoted carriage returns and CRLF when round-tripping %j', (delimiter) => {
    const rows = [['one\rtwo', 'three\r\nfour'], ['five\nsix', 'last']];
    expect(parseDelimited(toDelimited(rows, delimiter), delimiter)).toEqual(rows);
    expect(parseDelimited(`"one\rtwo"${delimiter}"three\r\nfour"\r\nlast${delimiter}row\r`, delimiter))
      .toEqual([rows[0], ['last', 'row']]);
  });

  it('preserves an explicitly quoted empty final record', () => {
    expect(parseDelimited('""', ',')).toEqual([['']]);
    expect(parseDelimited('first\n""', ',')).toEqual([['first'], ['']]);
    expect(parseDelimited('first\r\n""', '\t')).toEqual([['first'], ['']]);
    expect(parseClipboard('first\n""')).toEqual([['first'], ['']]);
    expect(parseDelimited('first\n', ',')).toEqual([['first']]);
  });

  it('detects tabs first, then commas, for clipboard text', () => {
    expect(parseClipboard('1\t2\n3\t4')).toEqual([['1', '2'], ['3', '4']]);
    expect(parseClipboard('1,2\n3,4')).toEqual([['1', '2'], ['3', '4']]);
    expect(parseClipboard('hello, world')).toEqual([['hello, world']]); // one line is one cell
    expect(parseClipboard('just text')).toEqual([['just text']]);
    expect(parseClipboard('a,b\nplain')).toEqual([['a,b'], ['plain']]);
  });

  it('bounds a parallel table by parsed rows and columns, not separators inside quoted fields', () => {
    const bounds = {maxRows:2,maxColumns:2};
    expect(parseDelimited('"a\tb\nc"\tx\r\ny\t\r\n', '\t', bounds)).toEqual([['a\tb\nc','x'],['y','']]);
    for (const text of ['a\tb\tc', 'a\tb\t', 'a\nb\nc', 'a\nb\nc\n']) expect(parseDelimited(text,'\t',bounds)).toBeNull();
    expect(parseDelimited('a\tb\nc\td', '\t', bounds)).toEqual([['a','b'],['c','d']]);
    expect(parseDelimited('\t'.repeat(100000), '\t', bounds)).toBeNull();
  });
  it('can reject malformed quoted fields without changing permissive text import', () => {
    for (const text of ['"unfinished', '"closed"extra']) expect(parseDelimited(text,'\t',{strict:true})).toBeNull();
    // A quote inside an unquoted field is Excel's own text for a cell such as 12" pipe.
    expect(parseDelimited('unquoted"quote','\t',{strict:true})).toEqual([['unquoted"quote']]);
    expect(parseDelimited('"unfinished','\t')).toEqual([['unfinished']]);
    expect(parseDelimited('""\t"a""b"\r\n','\t',{strict:true})).toEqual([['','a"b']]);
  });
});
