import { describe, it, expect } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef } from '../src/core/cell.js';
import { ymdToSerial, todaySerial } from '../src/core/format.js';
import { criteriaMatcher, FUNCTIONS, FUNCTION_NAMES } from '../src/core/formula/functions.js';

const DATA = {
  A1: 'Fruit', B1: 'Qty', C1: 'Price',
  A2: 'Apple', B2: '10', C2: '1.5',
  A3: 'Banana', B3: '5', C3: '0.25',
  A4: 'Cherry', B4: '20', C4: '4',
  A5: 'apple', B5: '3', C5: '1.5',
  A6: '', B6: 'n/a', C6: 'TRUE',
};

function calc(formula, cells = DATA) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (const [a1, text] of Object.entries(cells)) {
    const { r, c } = parseCellRef(a1);
    wb.setInput(id, r, c, text);
  }
  wb.setInput(id, 99, 25, `=${formula}`);
  return wb.getValue(id, 99, 25);
}

const E = (code) => ({ error: code });

describe('math & statistics', () => {
  it('finds all modes across more distinct values than the engine argument limit', () => {
    expect(calc('INDEX(MODE.MULT(SEQUENCE(10000,10),SEQUENCE(10000,10,100001),42,43),1,1)', {})).toBe(42);
    expect(calc('INDEX(MODE.MULT(SEQUENCE(10000,10),SEQUENCE(10000,10,100001),42,43),2,1)', {})).toBe(43);
    expect(calc('MODE.MULT(SEQUENCE(10000,10),SEQUENCE(10000,10,100001))', {})).toEqual(E('#N/A'));
  });

  it('counts rows from a large TEXTSPLIT result without overflowing function arguments', () => {
    // Longer than any entry may be, so the value arrives as a loaded book does.
    const wb = new Workbook({ sheets: [{ name: 'Sheet1', cells: { '0,0': { v: `${'1\n'.repeat(149999)}1` } } }] });
    const id = wb.sheets[0].id;
    wb.setInput(id, 99, 25, '=ROWS(TEXTSPLIT(A1,",",CHAR(10)))');
    expect(wb.getValue(id, 99, 25)).toBe(150000);
  });

  it.each([['MIN', 1], ['MAX', 100000], ['MINA', 1], ['MAXA', 100000]])('%s accepts large numeric inputs without exhausting the call stack', (fn, expected) => {
    expect(calc(`${fn}(SEQUENCE(10000,10),SEQUENCE(10000,10))`, {})).toBe(expected);
  });

  it('SUM / AVERAGE / MIN / MAX / PRODUCT / COUNT', () => {
    expect(calc('SUM(B2:B5)')).toBe(38);
    expect(calc('SUM(B2:B6)')).toBe(38); // text in a range is skipped
    expect(calc('SUM(1,"2",TRUE)')).toBe(4); // direct args coerce
    expect(calc('SUM("x")')).toEqual(E('#VALUE!'));
    expect(calc('AVERAGE(B2:B5)')).toBe(9.5);
    expect(calc('AVERAGE(D1:D3)')).toEqual(E('#DIV/0!'));
    expect(calc('MIN(B2:B5)')).toBe(3);
    expect(calc('MAX(B2:B5)')).toBe(20);
    expect(calc('MAX(D1:D2)')).toBe(0);
    expect(calc('PRODUCT(2,3,4)')).toBe(24);
    expect(calc('COUNT(B1:B6)')).toBe(4);
    expect(calc('COUNTA(A1:A6)')).toBe(5);
    expect(calc('COUNTBLANK(A1:A6)')).toBe(1);
  });

  it('MEDIAN / STDEV / VAR', () => {
    expect(calc('MEDIAN(1,3,2)')).toBe(2);
    expect(calc('MEDIAN(1,2,3,4)')).toBe(2.5);
    expect(calc('STDEV(2,4,4,4,5,5,7,9)')).toBeCloseTo(2.138, 3);
    expect(calc('STDEV.P(2,4,4,4,5,5,7,9)')).toBe(2);
    expect(calc('VAR(1,2,3,4)')).toBeCloseTo(1.6667, 4);
    expect(calc('STDEV(1)')).toEqual(E('#DIV/0!'));
  });

  it('rounding family', () => {
    expect(calc('ROUND(2.5)')).toBe(3);
    expect(calc('ROUND(-2.5)')).toBe(-3);
    expect(calc('ROUND(1.005,2)')).toBe(1.01);
    expect(calc('ROUND(1234.567,-2)')).toBe(1200);
    expect(calc('ROUNDUP(1.231,2)')).toBe(1.24);
    expect(calc('ROUNDDOWN(-1.239,2)')).toBe(-1.23);
    expect(calc('INT(-1.5)')).toBe(-2);
    expect(calc('TRUNC(-1.5)')).toBe(-1);
    expect(calc('FLOOR(7,3)')).toBe(6);
    expect(calc('CEILING(7,3)')).toBe(9);
    expect(calc('MOD(-7,3)')).toBe(2);
    expect(calc('MOD(7,0)')).toEqual(E('#DIV/0!'));
  });

  it('powers and logs', () => {
    expect(calc('POWER(2,10)')).toBe(1024);
    expect(calc('SQRT(16)')).toBe(4);
    expect(calc('EXP(0)')).toBe(1);
    expect(calc('LN(EXP(2))')).toBeCloseTo(2);
    expect(calc('LOG(8,2)')).toBe(3);
    expect(calc('LOG10(1000)')).toBe(3);
    expect(calc('LOG(0)')).toEqual(E('#NUM!'));
    expect(calc('ABS(-3)')).toBe(3);
    expect(calc('SIGN(-3)')).toBe(-1);
    expect(calc('ROUND(PI(),4)')).toBe(3.1416);
  });

  it('RAND / RANDBETWEEN stay in range', () => {
    const r = calc('RAND()');
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
    const rb = calc('RANDBETWEEN(5,7)');
    expect([5, 6, 7]).toContain(rb);
  });

  it('SUMPRODUCT', () => {
    expect(calc('SUMPRODUCT(B2:B5,C2:C5)')).toBe(10 * 1.5 + 5 * 0.25 + 20 * 4 + 3 * 1.5);
    expect(calc('SUMPRODUCT(B2:B5,C2:C4)')).toEqual(E('#VALUE!'));
  });
});

describe('conditional aggregates', () => {
  it('SUMIF / COUNTIF / AVERAGEIF with criteria strings', () => {
    expect(calc('SUMIF(A2:A5,"apple",B2:B5)')).toBe(13); // case-insensitive
    expect(calc('SUMIF(B2:B5,">5")')).toBe(30);
    expect(calc('SUMIF(A2:A5,"*an*",B2:B5)')).toBe(5);
    expect(calc('COUNTIF(B2:B5,">=5")')).toBe(3);
    expect(calc('COUNTIF(A1:A6,"")')).toBe(1);
    expect(calc('COUNTIF(A2:A5,"<>apple")')).toBe(2);
    expect(calc('AVERAGEIF(B2:B5,">4")')).toBeCloseTo(35 / 3);
    expect(calc('AVERAGEIF(B2:B5,">100")')).toEqual(E('#DIV/0!'));
  });

  it('SUMIFS / COUNTIFS / MAXIFS / MINIFS', () => {
    expect(calc('SUMIFS(B2:B5,A2:A5,"apple",C2:C5,1.5)')).toBe(13);
    expect(calc('COUNTIFS(B2:B5,">3",C2:C5,"<2")')).toBe(2);
    expect(calc('MAXIFS(B2:B5,C2:C5,1.5)')).toBe(10);
    expect(calc('MINIFS(B2:B5,C2:C5,1.5)')).toBe(3);
  });

  it('criteriaMatcher handles numbers, wildcards, and escapes', () => {
    expect(criteriaMatcher(5)(5)).toBe(true);
    expect(criteriaMatcher('5')('5')).toBe(true); // a number stored as text matches a numeric criterion
    expect(criteriaMatcher('a?c')('abc')).toBe(true);
    expect(criteriaMatcher('a~*')('a*')).toBe(true);
    expect(criteriaMatcher('a~*')('ab')).toBe(false);
    expect(criteriaMatcher('<=10')(10)).toBe(true);
    expect(criteriaMatcher('<=10')('10')).toBe(false);
    expect(criteriaMatcher('<=10')('x')).toBe(false);
    expect(criteriaMatcher('TRUE')(true)).toBe(true);
  });
});

describe('logical', () => {
  it('IF / IFS / AND / OR / NOT / XOR', () => {
    expect(calc('IF(B2>5,"big","small")')).toBe('big');
    expect(calc('IFS(B2>50,"huge",B2>5,"big",TRUE,"small")')).toBe('big');
    expect(calc('IFS(B2>50,"huge")')).toEqual(E('#N/A'));
    expect(calc('AND(TRUE,1,"TRUE")')).toBe(true);
    expect(calc('AND(TRUE,0)')).toBe(false);
    expect(calc('OR(FALSE,0,B2>5)')).toBe(true);
    expect(calc('NOT(TRUE)')).toBe(false);
    expect(calc('XOR(TRUE,TRUE,TRUE)')).toBe(true);
    expect(calc('AND(A2:A5)')).toEqual(E('#VALUE!')); // text only, nothing to test
  });

  it('IFERROR / IFNA / SWITCH / CHOOSE', () => {
    expect(calc('IFERROR(1/0,"n/a")')).toBe('n/a');
    expect(calc('IFERROR(5,"n/a")')).toBe(5);
    expect(calc('IFNA(NA(),0)')).toBe(0);
    expect(calc('IFNA(1/0,0)')).toEqual(E('#DIV/0!'));
    expect(calc('SWITCH(2,1,"one",2,"two","many")')).toBe('two');
    expect(calc('SWITCH(9,1,"one","many")')).toBe('many');
    expect(calc('CHOOSE(2,"a","b","c")')).toBe('b');
    expect(calc('CHOOSE(5,"a")')).toEqual(E('#VALUE!'));
  });
});

describe('information', () => {
  it('IS* functions inspect without propagating errors', () => {
    expect(calc('ISBLANK(A6)')).toBe(true);
    expect(calc('ISBLANK(A2)')).toBe(false);
    expect(calc('ISNUMBER(B2)')).toBe(true);
    expect(calc('ISNUMBER(A2)')).toBe(false);
    expect(calc('ISTEXT(A2)')).toBe(true);
    expect(calc('ISLOGICAL(C6)')).toBe(true);
    expect(calc('ISERROR(1/0)')).toBe(true);
    expect(calc('ISERR(NA())')).toBe(false);
    expect(calc('ISNA(NA())')).toBe(true);
    expect(calc('ISEVEN(4)')).toBe(true);
    expect(calc('ISODD(4)')).toBe(false);
    expect(calc('N("x")')).toBe(0);
    expect(calc('TYPE("x")')).toBe(2);
    expect(calc('TYPE(A1:B2)')).toBe(64);
  });
});

describe('text', () => {
  it('builds and slices strings', () => {
    expect(calc('CONCAT(A2," x",B2)')).toBe('Apple x10');
    expect(calc('CONCATENATE("a","b")')).toBe('ab');
    expect(calc('TEXTJOIN(", ",TRUE,A2:A6)')).toBe('Apple, Banana, Cherry, apple');
    expect(calc('LEN("héllo")')).toBe(5);
    expect(calc('UPPER("abc")')).toBe('ABC');
    expect(calc('LOWER("ABC")')).toBe('abc');
    expect(calc('PROPER("hello wORLD-x")')).toBe('Hello World-X');
    expect(calc('TRIM("  a   b  ")')).toBe('a b');
    expect(calc('LEFT("hello",2)')).toBe('he');
    expect(calc('RIGHT("hello",3)')).toBe('llo');
    expect(calc('RIGHT("hello",0)')).toBe('');
    expect(calc('MID("hello",2,3)')).toBe('ell');
    expect(calc('REPT("ab",3)')).toBe('ababab');
    expect(calc('EXACT("a","A")')).toBe(false);
    expect(calc('CHAR(65)')).toBe('A');
    expect(calc('CODE("A")')).toBe(65);
  });

  it('searches and replaces', () => {
    expect(calc('FIND("l","hello")')).toBe(3);
    expect(calc('FIND("L","hello")')).toEqual(E('#VALUE!'));
    expect(calc('SEARCH("L","hello")')).toBe(3);
    expect(calc('SEARCH("l?o","hello")')).toBe(3);
    expect(calc('SUBSTITUTE("a-b-c","-","+")')).toBe('a+b+c');
    expect(calc('SUBSTITUTE("a-b-c","-","+",2)')).toBe('a-b+c');
    expect(calc('REPLACE("hello",1,2,"J")')).toBe('Jllo');
  });

  it('VALUE and TEXT', () => {
    expect(calc('VALUE("1,234.5")')).toBe(1234.5);
    expect(calc('VALUE("12%")')).toBe(0.12);
    expect(calc('VALUE("abc")')).toEqual(E('#VALUE!'));
    expect(calc('TEXT(1234.5,"#,##0.00")')).toBe('1,234.50');
    expect(calc('TEXT(0.256,"0.0%")')).toBe('25.6%');
    expect(calc('TEXT(45306,"yyyy-mm-dd")')).toBe('2024-01-15');
    expect(calc('TEXT(45306,"mmm d, yyyy")')).toBe('Jan 15, 2024');
    expect(calc('TEXT(45306,"dddd")')).toBe('Monday');
    expect(calc('TEXT(7,"000")')).toBe('007');
    expect(calc('TEXT(0.5,"0%")')).toBe('50%');
    expect(calc('TEXT("abc","0")')).toBe('abc');
  });
});

describe('lookup', () => {
  const TABLE = {
    A1: 'id', B1: 'name', C1: 'score',
    A2: '1', B2: 'Ann', C2: '90',
    A3: '2', B3: 'Bob', C3: '75',
    A4: '3', B4: 'Cid', C4: '60',
  };

  it('VLOOKUP exact and approximate', () => {
    expect(calc('VLOOKUP(2,A2:C4,2,FALSE)', TABLE)).toBe('Bob');
    expect(calc('VLOOKUP("bob",B2:C4,2,FALSE)', TABLE)).toBe(75);
    expect(calc('VLOOKUP(9,A2:C4,2,FALSE)', TABLE)).toEqual(E('#N/A'));
    expect(calc('VLOOKUP(2.5,A2:C4,3)', TABLE)).toBe(75); // largest <= 2.5
    expect(calc('VLOOKUP(2,A2:C4,5,FALSE)', TABLE)).toEqual(E('#REF!'));
  });

  it('HLOOKUP / INDEX / MATCH / XLOOKUP', () => {
    expect(calc('HLOOKUP("name",A1:C4,3,FALSE)', TABLE)).toBe('Bob');
    expect(calc('INDEX(A1:C4,2,3)', TABLE)).toBe(90);
    expect(calc('INDEX(B2:B4,3)', TABLE)).toBe('Cid');
    expect(calc('INDEX(A1:C1,2)', TABLE)).toBe('name');
    expect(calc('INDEX(A1:C4,9,1)', TABLE)).toEqual(E('#REF!'));
    expect(calc('MATCH("Cid",B1:B4,0)', TABLE)).toBe(4);
    expect(calc('MATCH(80,C4:C2,-1)', TABLE)).toBe(1);
    expect(calc('MATCH("zzz",B1:B4,0)', TABLE)).toEqual(E('#N/A'));
    expect(calc('XLOOKUP("Bob",B2:B4,C2:C4)', TABLE)).toBe(75);
    expect(calc('XLOOKUP("Zed",B2:B4,C2:C4,"none")', TABLE)).toBe('none');
    expect(calc('INDEX(B2:B4,MATCH(MAX(C2:C4),C2:C4,0))', TABLE)).toBe('Ann');
  });

  it('ROW / COLUMN / ROWS / COLUMNS / ADDRESS', () => {
    expect(calc('ROW()')).toBe(100);
    expect(calc('COLUMN()')).toBe(26);
    expect(calc('ROW(B7)')).toBe(7);
    expect(calc('COLUMN(B7)')).toBe(2);
    expect(calc('ROWS(A1:C4)')).toBe(4);
    expect(calc('COLUMNS(A1:C4)')).toBe(3);
    expect(calc('ADDRESS(2,3)')).toBe('$C$2');
  });
});

describe('date & time', () => {
  it('builds and takes apart dates', () => {
    expect(calc('DATE(2024,1,15)')).toBe(ymdToSerial(2024, 1, 15));
    expect(calc('DATE(2024,13,1)')).toBe(ymdToSerial(2025, 1, 1));
    expect(calc('YEAR(DATE(2024,1,15))')).toBe(2024);
    expect(calc('MONTH(DATE(2024,1,15))')).toBe(1);
    expect(calc('DAY(DATE(2024,1,15))')).toBe(15);
    expect(calc('WEEKDAY(DATE(2024,1,15))')).toBe(2); // Monday
    expect(calc('WEEKDAY(DATE(2024,1,15),2)')).toBe(1);
    expect(calc('DAYS(DATE(2024,3,1),DATE(2024,2,1))')).toBe(29);
    expect(calc('EDATE(DATE(2024,1,31),1)')).toBe(ymdToSerial(2024, 2, 29));
    expect(calc('EOMONTH(DATE(2024,1,15),0)')).toBe(ymdToSerial(2024, 1, 31));
    expect(calc('TODAY()')).toBe(todaySerial());
    expect(calc('HOUR(TIME(13,45,0))')).toBe(13);
    expect(calc('MINUTE(TIME(13,45,0))')).toBe(45);
    expect(calc('SECOND(TIME(13,45,7))')).toBe(7);
  });

  it('NOW is a fraction beyond today', () => {
    const now = calc('NOW()');
    expect(now).toBeGreaterThanOrEqual(todaySerial());
    expect(now).toBeLessThan(todaySerial() + 1);
  });
});

describe('more statistics', () => {
  it('AVERAGEIFS / LARGE / SMALL / RANK', () => {
    expect(calc('AVERAGEIFS(B2:B5,A2:A5,"apple",C2:C5,1.5)')).toBe(6.5);
    expect(calc('AVERAGEIFS(B2:B5,A2:A5,"zzz")')).toEqual(E('#DIV/0!'));
    expect(calc('LARGE(B2:B5,1)')).toBe(20);
    expect(calc('LARGE(B2:B5,2)')).toBe(10);
    expect(calc('SMALL(B2:B5,1)')).toBe(3);
    expect(calc('SMALL(B2:B5,9)')).toEqual(E('#NUM!'));
    expect(calc('RANK(10,B2:B5)')).toBe(2);
    expect(calc('RANK(10,B2:B5,1)')).toBe(3);
    expect(calc('RANK.EQ(20,B2:B5)')).toBe(1);
    expect(calc('RANK(7,B2:B5)')).toEqual(E('#N/A'));
    expect(calc('RANK.AVG(2,A1:A3)', { A1: '2', A2: '2', A3: '1' })).toBe(1.5);
  });

  it('PERCENTILE / QUARTILE / PERCENTRANK / MODE', () => {
    expect(calc('PERCENTILE(B2:B5,0.5)')).toBe(7.5);
    expect(calc('PERCENTILE(B2:B5,0)')).toBe(3);
    expect(calc('PERCENTILE(B2:B5,1.5)')).toEqual(E('#NUM!'));
    expect(calc('QUARTILE(B2:B5,2)')).toBe(7.5);
    expect(calc('QUARTILE(B2:B5,4)')).toBe(20);
    expect(calc('PERCENTRANK(B2:B5,10)')).toBeCloseTo(0.666, 3);
    expect(calc('MODE(1,2,2,3)')).toBe(2);
    expect(calc('MODE(1,2,3)')).toEqual(E('#N/A'));
  });

  it('SUMSQ / COUNTUNIQUE / GEOMEAN / HARMEAN / AVEDEV / VAR.P', () => {
    expect(calc('SUMSQ(1,2,3)')).toBe(14);
    expect(calc('COUNTUNIQUE(A2:A5)')).toBe(3); // Apple and apple match
    expect(calc('COUNTUNIQUE(1,"1",1,TRUE)')).toBe(3);
    expect(calc('GEOMEAN(2,8)')).toBe(4);
    expect(calc('GEOMEAN(0,8)')).toEqual(E('#NUM!'));
    expect(calc('HARMEAN(1,4,4)')).toBe(2);
    expect(calc('AVEDEV(1,2,3,4)')).toBe(1);
    expect(calc('VAR.P(1,2,3,4)')).toBe(1.25);
    expect(calc('VARP(1,2,3,4)')).toBe(1.25);
    expect(calc('STDEVP(2,4,4,4,5,5,7,9)')).toBe(2);
  });

  it('regression statistics', () => {
    const XY = { A1: '1', B1: '2', A2: '2', B2: '4', A3: '3', B3: '6.5', A4: 'x', B4: '9' };
    expect(calc('SLOPE(B1:B3,A1:A3)', XY)).toBeCloseTo(2.25);
    expect(calc('INTERCEPT(B1:B3,A1:A3)', XY)).toBeCloseTo(-0.3333, 3);
    expect(calc('FORECAST(4,B1:B3,A1:A3)', XY)).toBeCloseTo(8.6667, 3);
    expect(calc('CORREL(A1:A4,B1:B4)', XY)).toBeCloseTo(0.99795, 4); // the text pair is skipped
    expect(calc('RSQ(B1:B3,A1:A3)', XY)).toBeCloseTo(0.9959, 3);
    expect(calc('COVARIANCE.P(A1:A3,B1:B3)', XY)).toBeCloseTo(1.5);
    expect(calc('CORREL(A1:A3,B1:B2)', XY)).toEqual(E('#N/A'));
  });

  it('MROUND / QUOTIENT / GCD / LCM / FACT / COMBIN / PERMUT / EVEN / ODD', () => {
    expect(calc('MROUND(10,3)')).toBe(9);
    expect(calc('MROUND(1.3,0.2)')).toBeCloseTo(1.4);
    expect(calc('MROUND(-10,3)')).toEqual(E('#NUM!'));
    expect(calc('QUOTIENT(-7,2)')).toBe(-3);
    expect(calc('QUOTIENT(1,0)')).toEqual(E('#DIV/0!'));
    expect(calc('GCD(12,18,30)')).toBe(6);
    expect(calc('LCM(4,6)')).toBe(12);
    expect(calc('FACT(5)')).toBe(120);
    expect(calc('FACT(-1)')).toEqual(E('#NUM!'));
    expect(calc('COMBIN(5,2)')).toBe(10);
    expect(calc('COMBIN(52,5)')).toBe(2598960);
    expect(calc('PERMUT(5,2)')).toBe(20);
    expect(calc('EVEN(1.5)')).toBe(2);
    expect(calc('EVEN(-1)')).toBe(-2);
    expect(calc('ODD(2)')).toBe(3);
    expect(calc('ODD(-2.5)')).toBe(-3);
  });

  it('trigonometry', () => {
    expect(calc('SIN(PI()/2)')).toBe(1);
    expect(calc('COS(0)')).toBe(1);
    expect(calc('TAN(PI()/4)')).toBeCloseTo(1);
    expect(calc('ASIN(2)')).toEqual(E('#NUM!'));
    expect(calc('ROUND(ACOS(0.5),6)')).toBe(1.047198);
    expect(calc('ATAN2(1,1)')).toBeCloseTo(Math.PI / 4);
    expect(calc('ATAN2(0,0)')).toEqual(E('#DIV/0!'));
    expect(calc('DEGREES(PI())')).toBe(180);
    expect(calc('RADIANS(180)')).toBe(Math.PI);
    expect(calc('SINH(0)')).toBe(0);
    expect(calc('TANH(0)')).toBe(0);
  });

  it('SUBTOTAL skips filtered rows, and hidden rows for 101+', () => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    wb.setInput(id, 0, 0, 'k');
    wb.setInput(id, 0, 1, 'v');
    [['a', 1], ['b', 2], ['a', 3], ['b', 4]].forEach(([k, v], i) => { wb.setInput(id, i + 1, 0, k); wb.setInput(id, i + 1, 1, String(v)); });
    wb.setInput(id, 6, 1, '=SUBTOTAL(9,B2:B5)');
    wb.setInput(id, 7, 1, '=SUBTOTAL(109,B2:B5)');
    wb.setInput(id, 8, 1, '=SUBTOTAL(3,A2:A5)');
    wb.setInput(id, 9, 1, '=SUBTOTAL(12,B2:B5)');
    expect(wb.getValue(id, 6, 1)).toBe(10);
    expect(wb.getValue(id, 9, 1)).toEqual(E('#VALUE!'));
    wb.setHidden(id, 'row', [4], true); // hide the last data row by hand
    expect(wb.getValue(id, 6, 1)).toBe(10);
    expect(wb.getValue(id, 7, 1)).toBe(6);
    wb.setFilterRange(id, { r1: 0, c1: 0, r2: 4, c2: 1 });
    wb.setFilterCriteria(id, 0, { values: ['a'] });
    expect(wb.getValue(id, 6, 1)).toBe(4);
    expect(wb.getValue(id, 8, 1)).toBe(2);
  });
});

describe('more dates', () => {
  const D = (y, m, d) => `DATE(${y},${m},${d})`;
  it('DATEDIF in every unit', () => {
    expect(calc(`DATEDIF(${D(2020, 1, 15)},${D(2024, 3, 10)},"Y")`)).toBe(4);
    expect(calc(`DATEDIF(${D(2020, 1, 15)},${D(2024, 3, 10)},"M")`)).toBe(49);
    expect(calc(`DATEDIF(${D(2020, 1, 15)},${D(2024, 3, 10)},"D")`)).toBe(1516);
    expect(calc(`DATEDIF(${D(2020, 1, 15)},${D(2024, 3, 10)},"YM")`)).toBe(1);
    expect(calc(`DATEDIF(${D(2020, 1, 15)},${D(2024, 3, 10)},"MD")`)).toBe(24);
    expect(calc(`DATEDIF(${D(2020, 1, 15)},${D(2024, 3, 10)},"YD")`)).toBe(55);
    expect(calc(`DATEDIF(${D(2024, 3, 10)},${D(2020, 1, 15)},"D")`)).toEqual(E('#NUM!'));
    expect(calc(`DATEDIF(${D(2020, 1, 15)},${D(2024, 3, 10)},"W")`)).toEqual(E('#NUM!'));
  });

  it('DATEVALUE / TIMEVALUE / WEEKNUM / ISOWEEKNUM', () => {
    expect(calc('DATEVALUE("2024-01-15")')).toBe(ymdToSerial(2024, 1, 15));
    expect(calc('DATEVALUE("1/15/2024")')).toBe(ymdToSerial(2024, 1, 15));
    expect(calc('DATEVALUE("2024-01-15 13:45")')).toBe(ymdToSerial(2024, 1, 15));
    expect(calc('DATEVALUE("nope")')).toEqual(E('#VALUE!'));
    expect(calc('TIMEVALUE("13:45")')).toBeCloseTo(13.75 / 24);
    expect(calc('TIMEVALUE("2024-01-15 6:00 am")')).toBeCloseTo(0.25);
    expect(calc(`WEEKNUM(${D(2024, 1, 1)})`)).toBe(1);
    expect(calc(`WEEKNUM(${D(2024, 1, 7)})`)).toBe(2); // Sunday starts week 2 (system 1)
    expect(calc(`WEEKNUM(${D(2024, 1, 7)},2)`)).toBe(1); // Monday weeks: still week 1
    expect(calc(`WEEKNUM(${D(2024, 12, 31)})`)).toBe(53);
    expect(calc(`ISOWEEKNUM(${D(2024, 12, 30)})`)).toBe(1); // ISO week 1 of 2025
    expect(calc(`ISOWEEKNUM(${D(2021, 1, 3)})`)).toBe(53);
    expect(calc(`WEEKNUM(${D(2021, 1, 3)},21)`)).toBe(53);
  });

  it('NETWORKDAYS / WORKDAY with holidays', () => {
    const H = { A1: '2024-01-15' }; // a Monday holiday
    expect(calc(`NETWORKDAYS(${D(2024, 1, 1)},${D(2024, 1, 31)})`)).toBe(23);
    expect(calc(`NETWORKDAYS(${D(2024, 1, 1)},${D(2024, 1, 31)},A1)`, H)).toBe(22);
    expect(calc(`NETWORKDAYS(${D(2024, 1, 31)},${D(2024, 1, 1)})`)).toBe(-23);
    expect(calc(`WORKDAY(${D(2024, 1, 12)},1)`)).toBe(ymdToSerial(2024, 1, 15)); // Friday → Monday
    expect(calc(`WORKDAY(${D(2024, 1, 12)},1,A1)`, H)).toBe(ymdToSerial(2024, 1, 16));
    expect(calc(`WORKDAY(${D(2024, 1, 15)},-1)`)).toBe(ymdToSerial(2024, 1, 12));
  });

  it('YEARFRAC / DAYS360', () => {
    expect(calc(`DAYS360(${D(2024, 1, 30)},${D(2024, 3, 31)})`)).toBe(60);
    expect(calc(`DAYS360(${D(2024, 1, 31)},${D(2024, 3, 31)},TRUE)`)).toBe(60);
    expect(calc(`YEARFRAC(${D(2024, 1, 1)},${D(2024, 7, 1)})`)).toBe(0.5);
    expect(calc(`YEARFRAC(${D(2024, 1, 1)},${D(2025, 1, 1)},1)`)).toBe(1);
    expect(calc(`YEARFRAC(${D(2023, 3, 1)},${D(2024, 3, 1)},1)`)).toBe(1);
    expect(calc(`YEARFRAC(${D(2023, 1, 1)},${D(2025, 7, 1)},1)`)).toBeCloseTo(912 / (1096 / 3), 6);
    expect(calc(`YEARFRAC(${D(2024, 1, 1)},${D(2024, 12, 31)},3)`)).toBeCloseTo(365 / 365);
    expect(calc(`YEARFRAC(${D(2024, 1, 1)},${D(2024, 7, 1)},2)`)).toBeCloseTo(182 / 360);
    expect(calc(`YEARFRAC(${D(2024, 1, 1)},${D(2024, 7, 1)},9)`)).toEqual(E('#NUM!'));
  });
});

describe('financial', () => {
  it('PMT / IPMT / PPMT / FV / PV / NPER / RATE agree with each other', () => {
    expect(calc('PMT(0.05/12,360,200000)')).toBeCloseTo(-1073.64, 2);
    expect(calc('PMT(0,12,1200)')).toBe(-100);
    expect(calc('PMT(0.05/12,360,200000,0,1)')).toBeCloseTo(-1069.19, 2);
    expect(calc('IPMT(0.05/12,1,360,200000)')).toBeCloseTo(-833.33, 2);
    expect(calc('IPMT(0.05/12,1,360,200000)+PPMT(0.05/12,1,360,200000)')).toBeCloseTo(-1073.64, 2);
    expect(calc('IPMT(0.1,3,3,1000)')).toBeCloseTo(-36.56, 2);
    expect(calc('IPMT(0.1,1,3,1000,0,1)')).toBe(0);
    expect(calc('FV(0.06/12,120,-100)')).toBeCloseTo(16387.93, 2);
    expect(calc('FV(0,10,-100)')).toBe(1000);
    expect(calc('PV(0.08,10,-1000)')).toBeCloseTo(6710.08, 2);
    expect(calc('NPER(0.05/12,-1073.64,200000)')).toBeCloseTo(360, 0);
    expect(calc('NPER(0,-100,1200)')).toBe(12);
    expect(calc('RATE(360,-1073.64,200000)*12')).toBeCloseTo(0.05, 4);
    expect(calc('RATE(10,0,-1000,2000)')).toBeCloseTo(0.0718, 4);
  });

  it('NPV / IRR / XNPV / XIRR', () => {
    const CF = { A1: '-1000', A2: '300', A3: '400', A4: '500', B1: '2024-01-01', B2: '2024-07-01', B3: '2025-01-01', B4: '2025-07-01' };
    expect(calc('NPV(0.1,300,400,500)')).toBeCloseTo(978.96, 2);
    expect(calc('NPV(0.1,A2:A4)+A1', CF)).toBeCloseTo(-21.04, 2);
    expect(calc('IRR(A1:A4)', CF)).toBeCloseTo(0.08896, 4);
    expect(calc('IRR(A2:A4)', CF)).toEqual(E('#NUM!'));
    expect(calc('XNPV(0.1,A1:A4,B1:B4)', CF)).toBeCloseTo(83.07, 1);
    const x = calc('XIRR(A1:A4,B1:B4)', CF);
    expect(x).toBeGreaterThan(0.15);
    expect(x).toBeLessThan(0.25);
  });

  it('depreciation and rate conversion', () => {
    expect(calc('SLN(10000,1000,5)')).toBe(1800);
    expect(calc('SYD(10000,1000,5,1)')).toBe(3000);
    expect(calc('SYD(10000,1000,5,5)')).toBe(600);
    expect(calc('DDB(10000,1000,5,1)')).toBe(4000);
    expect(calc('DDB(10000,1000,5,2)')).toBe(2400);
    expect(calc('DDB(10000,1000,5,6)')).toEqual(E('#NUM!'));
    expect(calc('EFFECT(0.12,12)')).toBeCloseTo(0.1268, 4);
    expect(calc('NOMINAL(0.1268,12)')).toBeCloseTo(0.12, 3);
    expect(calc('EFFECT(0,12)')).toEqual(E('#NUM!'));
  });
});

describe('more lookup, text, and information', () => {
  const TABLE = { A1: '1', B1: 'Ann', C1: '90', A2: '2', B2: 'Bob', C2: '75', A3: '3', B3: 'Cid', C3: '60' };

  it('LOOKUP / INDIRECT / OFFSET', () => {
    expect(calc('LOOKUP(2,A1:C3)', TABLE)).toBe(75);
    expect(calc('LOOKUP(2.5,A1:A3,B1:B3)', TABLE)).toBe('Bob');
    expect(calc('LOOKUP(0,A1:A3,B1:B3)', TABLE)).toEqual(E('#N/A'));
    expect(calc('INDIRECT("B2")', TABLE)).toBe('Bob');
    expect(calc('INDIRECT("B"&2)', TABLE)).toBe('Bob');
    expect(calc('SUM(INDIRECT("C1:C3"))', TABLE)).toBe(225);
    expect(calc('INDIRECT("Sheet1!C1")', TABLE)).toBe(90);
    expect(calc('INDIRECT("Nope!C1")', TABLE)).toEqual(E('#REF!'));
    expect(calc('INDIRECT("hello")', TABLE)).toEqual(E('#REF!'));
    expect(calc('OFFSET(A1,1,1)', TABLE)).toBe('Bob');
    expect(calc('SUM(OFFSET(A1,0,2,3,1))', TABLE)).toBe(225);
    expect(calc('OFFSET(A1,-1,0)', TABLE)).toEqual(E('#REF!'));
    expect(calc('OFFSET(A1,0,0,0,1)', TABLE)).toEqual(E('#REF!'));
    expect(calc('COUNTA(OFFSET(A1:A3,0,1))', TABLE)).toBe(3);
  });

  it('HYPERLINK / SHEET / SHEETS / ISFORMULA / FORMULATEXT / ERROR.TYPE', () => {
    expect(calc('HYPERLINK("https://puter.com","Puter")')).toBe('Puter');
    expect(calc('HYPERLINK("https://puter.com")')).toBe('https://puter.com');
    expect(calc('SHEET()')).toBe(1);
    expect(calc('SHEET("Sheet1")')).toBe(1);
    expect(calc('SHEET("Other")')).toEqual(E('#N/A'));
    expect(calc('SHEETS()')).toBe(1);
    expect(calc('ISFORMULA(A1)', { A1: '=1+1' })).toBe(true);
    expect(calc('ISFORMULA(A1)', { A1: '2' })).toBe(false);
    expect(calc('FORMULATEXT(A1)', { A1: '=1+1' })).toBe('=1+1');
    expect(calc('FORMULATEXT(A1)', { A1: '2' })).toEqual(E('#N/A'));
    expect(calc('ERROR.TYPE(1/0)')).toBe(2);
    expect(calc('ERROR.TYPE(NA())')).toBe(7);
    expect(calc('ERROR.TYPE(5)')).toEqual(E('#N/A'));
  });

  it('regular expressions and text splitting', () => {
    expect(calc('REGEXMATCH("hello 42","\\d+")')).toBe(true);
    expect(calc('REGEXMATCH("hello","\\d+")')).toBe(false);
    expect(calc('REGEXEXTRACT("order #4521 shipped","\\d+")')).toBe('4521');
    expect(calc('REGEXEXTRACT("a=b","(\\w)=")')).toBe('a');
    expect(calc('REGEXEXTRACT("abc","\\d")')).toEqual(E('#N/A'));
    expect(calc('REGEXREPLACE("a1b22c","\\d+","-")')).toBe('a-b-c');
    expect(calc('REGEXREPLACE("john smith","(\\w+) (\\w+)","$2, $1")')).toBe('smith, john');
    expect(calc('REGEXMATCH("x","(")')).toEqual(E('#VALUE!'));
    expect(calc('JOIN("-",1,"a",TRUE)')).toBe('1-a-TRUE');
    expect(calc('JOIN(", ",A1:A3)', TABLE)).toBe('1, 2, 3');
    expect(calc('TEXTBEFORE("a.b.c",".")')).toBe('a');
    expect(calc('TEXTBEFORE("a.b.c",".",2)')).toBe('a.b');
    expect(calc('TEXTBEFORE("a.b.c",".",-1)')).toBe('a.b');
    expect(calc('TEXTBEFORE("abc",".")')).toEqual(E('#N/A'));
    expect(calc('TEXTAFTER("a.b.c",".")')).toBe('b.c');
    expect(calc('TEXTAFTER("a.b.c",".",-1)')).toBe('c');
  });

  it('NUMBERVALUE / DOLLAR / FIXED / UNICHAR / UNICODE / T', () => {
    expect(calc('NUMBERVALUE("1.234,56",",",".")')).toBe(1234.56);
    expect(calc('NUMBERVALUE("1,234.5")')).toBe(1234.5);
    expect(calc('NUMBERVALUE("12%")')).toBe(0.12);
    expect(calc('NUMBERVALUE("abc")')).toEqual(E('#VALUE!'));
    expect(calc('DOLLAR(1234.567)')).toBe('$1,234.57');
    expect(calc('DOLLAR(-1234.567,0)')).toBe('($1,235)');
    expect(calc('DOLLAR(1234.567,-2)')).toBe('$1,200');
    expect(calc('FIXED(1234.567,1)')).toBe('1,234.6');
    // Decimal counts beyond 127 are refused rather than thrown; large legal ones pad with zeros.
    expect(calc('DOLLAR(1,400)')).toEqual({ error: '#VALUE!' });
    expect(calc('FIXED(1,400)')).toEqual({ error: '#VALUE!' });
    expect(calc('FIXED(1,-400)')).toEqual({ error: '#VALUE!' });
    expect(calc('DOLLAR(1,"1e999")')).toEqual({ error: '#VALUE!' }); // native text-conversion failure, as with VALUE("1e999")
    expect(calc('FIXED(1.5,127)')).toBe(`1.5${'0'.repeat(126)}`);
    expect(calc('DOLLAR(-2,110)')).toBe(`($2.${'0'.repeat(110)})`);
    expect(calc('FIXED(1234.567,1,TRUE)')).toBe('1234.6');
    expect(calc('UNICHAR(9731)')).toBe('☃');
    expect(calc('UNICODE("☃")')).toBe(9731);
    expect(calc('UNICHAR(0)')).toEqual(E('#VALUE!'));
    expect(calc('T("x")')).toBe('x');
    expect(calc('T(5)')).toBe('');
  });
});

describe('arrays', () => {
  const T = { A1: 'b', B1: '2', A2: 'a', B2: '1', A3: 'b', B3: '3', A4: 'c', B4: '2' };
  const arr = (formula, cells) => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    for (const [a1, text] of Object.entries(cells || T)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); }
    wb.setInput(id, 0, 9, `=${formula}`);
    const range = wb.spillRangeAt(id, 0, 9) || { r1: 0, c1: 9, r2: 0, c2: 9 };
    return wb.rangeValues(id, range);
  };

  it('UNIQUE / SORT / FILTER / SEQUENCE / TRANSPOSE', () => {
    expect(arr('UNIQUE(A1:A4)')).toEqual([['b'], ['a'], ['c']]);
    expect(arr('UNIQUE(A1:B4)')).toEqual([['b', 2], ['a', 1], ['b', 3], ['c', 2]]);
    expect(arr('UNIQUE(A1:A4,FALSE,TRUE)')).toEqual([['a'], ['c']]);
    expect(arr('UNIQUE(A1:B1,TRUE)')).toEqual([['b', 2]]);
    expect(arr('SORT(A1:B4)')).toEqual([['a', 1], ['b', 2], ['b', 3], ['c', 2]]);
    expect(arr('SORT(A1:B4,2,FALSE)')).toEqual([['b', 3], ['b', 2], ['c', 2], ['a', 1]]);
    expect(arr('SORT(A1:B4,2,-1,1,TRUE)')).toEqual([['b', 3], ['b', 2], ['c', 2], ['a', 1]]);
    expect(arr('SORT(A1:A4,B1:B4,TRUE)')).toEqual([['a'], ['b'], ['c'], ['b']]);
    expect(arr('SORT(A1:B1,1,TRUE,TRUE)')).toEqual([[2, 'b']]); // by column
    expect(arr('FILTER(A1:B4,B1:B4>1)')).toEqual([['b', 2], ['b', 3], ['c', 2]]);
    expect(arr('FILTER(A1:A4,B1:B4>1,A1:A4="b")')).toEqual([['b'], ['b']]);
    expect(arr('FILTER(A1:A4,B1:B4>9,"none")')).toEqual([['none']]);
    expect(calc('FILTER(A1:A4,B1:B4>9)', T)).toEqual(E('#CALC!'));
    expect(arr('FILTER(A1:B1,A1:B1<>"b")')).toEqual([[2]]); // by column
    expect(arr('SEQUENCE(3)')).toEqual([[1], [2], [3]]);
    expect(arr('SEQUENCE(2,3,10,5)')).toEqual([[10, 15, 20], [25, 30, 35]]);
    expect(calc('SEQUENCE(0)')).toEqual(E('#CALC!'));
    expect(arr('TRANSPOSE(A1:B2)')).toEqual([['b', 'a'], [2, 1]]);
    expect(arr('FLATTEN(A1:B2)')).toEqual([['b'], [2], ['a'], [1]]);
    expect(arr('CHOOSECOLS(A1:B4,2)')).toEqual([[2], [1], [3], [2]]);
    expect(arr('CHOOSEROWS(A1:B4,1,-1)')).toEqual([['b', 2], ['c', 2]]);
  });

  it('SPLIT / TEXTSPLIT / ARRAYFORMULA', () => {
    expect(arr('SPLIT("a,b;;c",",;")')).toEqual([['a', 'b', 'c']]);
    expect(arr('SPLIT("a,b;;c",";",FALSE,FALSE)')).toEqual([['a,b', '', 'c']]);
    expect(arr('SPLIT("1, 2, 3",", ",FALSE)')).toEqual([[1, 2, 3]]);
    expect(calc('SUM(SPLIT("1,2,3",","))')).toBe(6);
    expect(arr('TEXTSPLIT("a,b|c",",","|")')).toEqual([['a', 'b'], ['c', E('#N/A')]]);
    expect(arr('ARRAYFORMULA(B1:B4*2)')).toEqual([[4], [2], [6], [4]]);
  });

  it('operators and IF broadcast over ranges', () => {
    expect(arr('B1:B4*10')).toEqual([[20], [10], [30], [20]]);
    expect(arr('-B1:B2')).toEqual([[-2], [-1]]);
    expect(arr('B1:B2%')).toEqual([[0.02], [0.01]]);
    expect(arr('A1:A4&"-"&B1:B4')).toEqual([['b-2'], ['a-1'], ['b-3'], ['c-2']]);
    expect(arr('B1:B2*B1:B2')).toEqual([[4], [1]]);
    expect(arr('B1:B2+TRANSPOSE(B1:B2)')).toEqual([[4, 3], [3, 2]]); // column × row → grid
    expect(arr('B1:B2+B1:B3')).toEqual([[4], [2], [E('#N/A')]]);
    expect(arr('IF(B1:B4>1,"big","small")')).toEqual([['big'], ['small'], ['big'], ['big']]);
    expect(arr('IF(B1:B4>1,B1:B4)')).toEqual([[2], [false], [3], [2]]);
    expect(calc('SUM(B1:B4*2)', T)).toBe(16);
    expect(calc('SUMPRODUCT((A1:A4="b")*B1:B4)', T)).toBe(5);
    expect(calc('COUNTA(UNIQUE(A1:A4))', T)).toBe(3);
    expect(calc('INDEX(SORT(A1:B4,2,FALSE),1,1)', T)).toBe('b');
    expect(calc('MAX(FILTER(B1:B4,A1:A4="b"))', T)).toBe(3);
    expect(calc('IF(TRUE,1,2)')).toBe(1); // scalar IF untouched
  });
});

describe('SPARKLINE', () => {
  it('returns a drawable value with the numbers and options', () => {
    const v = calc('SPARKLINE(B2:B5)');
    expect(v).toMatchObject({ sparkline: true, type: 'line', values: [10, 5, 20, 3], color: null });
    expect(calc('SPARKLINE(B2:B5,"column","red")')).toMatchObject({ type: 'column', color: 'red' });
    expect(calc('SPARKLINE(B2:B5,"pie")')).toEqual(E('#VALUE!'));
    expect(calc('SPARKLINE(A2:A5)')).toEqual(E('#N/A'));
    const opts = { A1: 'charttype', B1: 'winloss', A2: 'color', B2: '#ff0000', C1: '3', C2: '-1' };
    expect(calc('SPARKLINE(C1:C2,A1:B2)', opts)).toMatchObject({ type: 'winloss', color: '#ff0000', values: [3, -1] });
    expect(calc('SPARKLINE(B2:B5)&""')).toEqual(E('#VALUE!'));
  });
});

describe('library shape', () => {
  it('resolves aliases and lists names sorted', () => {
    expect(FUNCTIONS['STDEV.S']).toBe(FUNCTIONS.STDEV);
    expect(FUNCTION_NAMES).toEqual([...FUNCTION_NAMES].sort());
    expect(FUNCTION_NAMES.length).toBeGreaterThan(90);
  });
});

describe('LET and LAMBDA', () => {
  const arr = (formula, cells = {}) => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    for (const [a1, text] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); }
    wb.setInput(id, 0, 9, `=${formula}`);
    const range = wb.spillRangeAt(id, 0, 9) || { r1: 0, c1: 9, r2: 0, c2: 9 };
    return wb.rangeValues(id, range);
  };

  it('LET binds names in order', () => {
    expect(calc('LET(x, 2, x*3)')).toBe(6);
    expect(calc('LET(x, 2, y, x+1, x*y)')).toBe(6);
    expect(calc('LET(total, SUM(B2:B5), total/2)')).toBe(19);
    expect(calc('LET(x, 1)')).toEqual(E('#VALUE!'));
    expect(calc('LET(A1, 1, A1)')).toEqual(E('#VALUE!'));
    expect(arr('LET(v, B2:B3, v*2)', DATA)).toEqual([[20], [10]]);
  });

  it('LAMBDA values are called through LET names and helpers', () => {
    expect(calc('LET(double, LAMBDA(n, n*2), double(21))')).toBe(42);
    expect(calc('LET(add, LAMBDA(a, b, a+b), add(1, 2) + add(3, 4))')).toBe(10);
    expect(calc('LET(fact, LAMBDA(n, IF(n<=1, 1, n*fact(n-1))), fact(5))')).toBe(120);
    expect(calc('LAMBDA(x, x)')).toEqual(E('#CALC!'));
    expect(calc('LET(f, LAMBDA(x, x), f(1, 2))')).toEqual(E('#VALUE!'));
    expect(calc('LET(f, 3, f(1))')).toEqual(E('#VALUE!'));
    expect(calc('LET(loop, LAMBDA(n, loop(n)), loop(1))')).toEqual(E('#NUM!'));
  });

  it('MAP / REDUCE / SCAN / BYROW / BYCOL / MAKEARRAY', () => {
    expect(arr('MAP(B2:B4, LAMBDA(v, v*10))', DATA)).toEqual([[100], [50], [200]]);
    expect(arr('MAP(B2:B4, C2:C4, LAMBDA(q, p, q*p))', DATA)).toEqual([[15], [1.25], [80]]);
    expect(arr('MAP({1,2,3}, LAMBDA(x, x^2))')).toEqual([[1, 4, 9]]);
    expect(calc('REDUCE(0, B2:B5, LAMBDA(acc, v, acc+v))')).toBe(38);
    expect(calc('REDUCE(1, {1,2,3,4}, LAMBDA(a, b, a*b))')).toBe(24);
    expect(arr('SCAN(0, {1,2,3}, LAMBDA(a, b, a+b))')).toEqual([[1, 3, 6]]);
    expect(arr('BYROW(B2:C4, LAMBDA(row, SUM(row)))', DATA)).toEqual([[11.5], [5.25], [24]]);
    expect(arr('BYCOL(B2:C4, LAMBDA(col, MAX(col)))', DATA)).toEqual([[20, 4]]);
    expect(arr('MAKEARRAY(2, 3, LAMBDA(r, c, r*10+c))')).toEqual([[11, 12, 13], [21, 22, 23]]);
    expect(calc('SUM(MAP(B2:B4, LAMBDA(v, v*2)))')).toBe(70);
    expect(calc('MAP(B2:B4, 5)')).toEqual(E('#VALUE!'));
    expect(arr('BYROW(B2:C3, LAMBDA(row, row))', DATA)).toEqual([[E('#CALC!')], [E('#CALC!')]]);
  });
});

describe('array shaping and XMATCH', () => {
  const arr = (formula, cells = {}) => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    for (const [a1, text] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); }
    wb.setInput(id, 0, 9, `=${formula}`);
    const range = wb.spillRangeAt(id, 0, 9) || { r1: 0, c1: 9, r2: 0, c2: 9 };
    return wb.rangeValues(id, range);
  };
  const NA = E('#N/A');

  it('XMATCH and XLOOKUP match modes', () => {
    expect(calc('XMATCH("Banana",A2:A5)')).toBe(2);
    expect(calc('XMATCH("apple",A2:A5)')).toBe(1);
    expect(calc('XMATCH("apple",A2:A5,0,-1)')).toBe(4);
    expect(calc('XMATCH("Ban*",A2:A5,2)')).toBe(2);
    expect(calc('XMATCH("Ban*",A2:A5,0)')).toEqual(NA);
    expect(calc('XMATCH(7,B2:B5,-1)')).toBe(2); // largest <= 7 is 5
    expect(calc('XMATCH(7,B2:B5,1)')).toBe(1); // smallest >= 7 is 10
    expect(calc('XMATCH(50,B2:B5,1)')).toEqual(NA);
    expect(calc('XMATCH(1,B2:B5,5)')).toEqual(E('#VALUE!'));
    expect(calc('XLOOKUP(7,B2:B5,A2:A5,"none",-1)')).toBe('Banana');
    expect(calc('XLOOKUP(99,B2:B5,A2:A5,"none")')).toBe('none');
    expect(calc('XLOOKUP("apple",A2:A5,B2:B5,,0,-1)')).toBe(3);
    expect(arr('XLOOKUP("Cherry",A2:A5,B2:C5)', DATA)).toEqual([[20, 4]]);
  });

  it('VSTACK / HSTACK / TAKE / DROP / EXPAND', () => {
    expect(arr('VSTACK({1,2},{3,4})')).toEqual([[1, 2], [3, 4]]);
    expect(arr('VSTACK({1,2,3},{4})')).toEqual([[1, 2, 3], [4, NA, NA]]);
    expect(arr('HSTACK({1;2},{3;4})')).toEqual([[1, 3], [2, 4]]);
    expect(arr('HSTACK({1;2;3},{9})')).toEqual([[1, 9], [2, NA], [3, NA]]);
    expect(arr('TAKE(A2:C5,2)', DATA)).toEqual([['Apple', 10, 1.5], ['Banana', 5, 0.25]]);
    expect(arr('TAKE(A2:C5,-1,2)', DATA)).toEqual([['apple', 3]]);
    expect(arr('TAKE(A2:C5,,1)', DATA)).toEqual([['Apple'], ['Banana'], ['Cherry'], ['apple']]);
    expect(calc('TAKE(A2:C5,0)')).toEqual(E('#CALC!'));
    expect(arr('DROP(A2:C5,3)', DATA)).toEqual([['apple', 3, 1.5]]);
    expect(arr('DROP(A2:C5,-3,-1)', DATA)).toEqual([['Apple', 10]]);
    expect(arr('DROP(A2:C5,0,1)', DATA)).toEqual([[10, 1.5], [5, 0.25], [20, 4], [3, 1.5]]);
    expect(arr('EXPAND({1,2},2,3,0)')).toEqual([[1, 2, 0], [0, 0, 0]]);
    expect(arr('EXPAND({1,2},1,3)')).toEqual([[1, 2, NA]]);
    expect(calc('EXPAND({1,2},1,1)')).toEqual(E('#VALUE!'));
  });

  it('WRAPROWS / WRAPCOLS / TOCOL / TOROW / RANDARRAY', () => {
    expect(arr('WRAPROWS({1,2,3,4,5},2)')).toEqual([[1, 2], [3, 4], [5, NA]]);
    expect(arr('WRAPROWS({1,2,3,4,5},2,"x")')).toEqual([[1, 2], [3, 4], [5, 'x']]);
    expect(arr('WRAPCOLS({1,2,3,4,5},2)')).toEqual([[1, 3, 5], [2, 4, NA]]);
    expect(calc('WRAPROWS({1,2;3,4},2)')).toEqual(E('#VALUE!'));
    expect(arr('TOCOL({1,2;3,4})')).toEqual([[1], [2], [3], [4]]);
    expect(arr('TOCOL({1,2;3,4},0,TRUE)')).toEqual([[1], [3], [2], [4]]);
    expect(arr('TOROW(A5:C6,1)', DATA)).toEqual([['apple', 3, 1.5, 'n/a', true]]);
    expect(arr('TOCOL(B2:B4,,FALSE)', DATA)).toEqual([[10], [5], [20]]);
    expect(calc('TOROW(D1:D2,1)')).toEqual(E('#CALC!'));
    const rnd = arr('RANDARRAY(2,3,5,9,TRUE)');
    expect(rnd.length).toBe(2);
    expect(rnd[0].length).toBe(3);
    for (const v of rnd.flat()) { expect(Number.isInteger(v)).toBe(true); expect(v >= 5 && v <= 9).toBe(true); }
    expect(calc('RANDARRAY(1,1,3,1)')).toEqual(E('#VALUE!'));
  });
});

describe('statistics and distributions', () => {
  const near = (v, expected, digits = 6) => expect(v).toBeCloseTo(expected, digits);
  const arr = (formula, cells = {}) => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    for (const [a1, text] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); }
    wb.setInput(id, 0, 9, `=${formula}`);
    const range = wb.spillRangeAt(id, 0, 9) || { r1: 0, c1: 9, r2: 0, c2: 9 };
    return wb.rangeValues(id, range);
  };

  it('A-variants, spread, and percentiles', () => {
    expect(calc('AVERAGEA(B2:B6)')).toBe(38 / 5); // "n/a" counts as 0
    expect(calc('MAXA(C2:C6)')).toBe(4);
    expect(calc('MINA(C2:C6)')).toBe(0.25);
    expect(calc('MINA({2,TRUE})')).toBe(2); // logical values in an array are ignored
    expect(calc('MINA(2,TRUE)')).toBe(1); // direct arguments still coerce
    expect(calc('DEVSQ({1,2,3,4})')).toBe(5);
    near(calc('SKEW({3,4,5,2,3,4,5,6,4,7})'), 0.359543, 5);
    near(calc('KURT({3,4,5,2,3,4,5,6,4,7})'), -0.151799, 5);
    near(calc('TRIMMEAN({4,5,6,7,2,3,4,5,1,2,3},0.2)'), 3.777778, 5);
    expect(calc('STANDARDIZE(42,40,1.5)')).toBeCloseTo(1.333333, 5);
    near(calc('PERCENTILE.EXC({1,2,3,4},0.25)'), 1.25);
    expect(calc('PERCENTILE.EXC({1,2,3,4},0.1)')).toEqual(E('#NUM!'));
    near(calc('QUARTILE.EXC({1,2,3,4,5,6,7,8},1)'), 2.25);
    expect(arr('FREQUENCY({79,85,78,85,50,81,95,88,97},{70,79,89})')).toEqual([[1], [2], [4], [2]]);
    expect(calc('SUMX2MY2({2,3,9,1,8,7,5},{6,5,11,7,5,4,4})')).toBe(-55);
    expect(calc('SUMX2PY2({2,3,9,1,8,7,5},{6,5,11,7,5,4,4})')).toBe(521);
    expect(calc('SUMXMY2({2,3,9,1,8,7,5},{6,5,11,7,5,4,4})')).toBe(79);
    near(calc('STEYX({2,3,9,1,8,7,5},{6,5,11,7,5,4,4})'), 3.305719, 5);
  });

  it('regression: TREND / GROWTH / LINEST', () => {
    expect(arr('LINEST({3,5,7},{1,2,3})')).toEqual([[2, 1]]);
    expect(arr('TREND({3,5,7},{1,2,3},{4;5})')).toEqual([[9], [11]]);
    expect(arr('TREND({3,5,7})')).toEqual([[3, 5, 7]]);
    const g = arr('GROWTH({2,4,8},{1,2,3},{4})');
    near(g[0][0], 16);
    const l = arr('LOGEST({2,4,8},{1,2,3})');
    near(l[0][0], 2); near(l[0][1], 1);
    expect(arr('LINEST({1,2},{1,1})')).toEqual([[0, 1.5]]);
  });

  it('normal family', () => {
    near(calc('NORM.S.DIST(1.96,TRUE)'), 0.975002, 5);
    near(calc('NORM.S.DIST(0,FALSE)'), 0.398942, 5);
    near(calc('NORM.DIST(42,40,1.5,TRUE)'), 0.908789, 5);
    near(calc('NORM.DIST(42,40,1.5,FALSE)'), 0.109340, 5);
    near(calc('NORM.INV(0.908789,40,1.5)'), 42, 4);
    near(calc('NORM.S.INV(0.975)'), 1.959964, 5);
    near(calc('NORMSINV(0.01)'), -2.326348, 5);
    expect(calc('NORM.S.INV(1)')).toEqual(E('#NUM!'));
    near(calc('LOGNORM.DIST(4,3.5,1.2,TRUE)'), 0.039084, 5);
    near(calc('LOGNORM.INV(0.039084,3.5,1.2)'), 4, 3);
    near(calc('CONFIDENCE.NORM(0.05,2.5,50)'), 0.692952, 5);
    near(calc('CONFIDENCE.T(0.05,1,50)'), 0.284197, 5);
    near(calc('Z.TEST({3,6,7,8,6,5,4,2,1,9},4)'), 0.090574, 5);
    near(calc('FISHER(0.75)'), 0.972955, 5);
    near(calc('FISHERINV(0.972955)'), 0.75, 5);
    near(calc('STANDARDIZE(NORM.INV(0.5,10,2),10,2)'), 0);
  });

  it('discrete and other distributions', () => {
    near(calc('BINOM.DIST(6,10,0.5,FALSE)'), 0.205078, 5);
    near(calc('BINOM.DIST(6,10,0.5,TRUE)'), 0.828125, 5);
    near(calc('POISSON.DIST(2,5,TRUE)'), 0.124652, 5);
    near(calc('POISSON.DIST(2,5,FALSE)'), 0.084224, 5);
    near(calc('EXPON.DIST(0.2,10,TRUE)'), 0.864665, 5);
    near(calc('EXPON.DIST(0.2,10,FALSE)'), 1.353353, 5);
    near(calc('WEIBULL.DIST(105,20,100,TRUE)'), 0.929581, 5);
    near(calc('WEIBULL.DIST(105,20,100,FALSE)'), 0.035589, 5);
    near(calc('GAMMA.DIST(10.00001131,9,2,TRUE)'), 0.068094, 5);
    near(calc('GAMMA.DIST(10.00001131,9,2,FALSE)'), 0.032639, 5);
    near(calc('GAMMA(2.5)'), 1.329340, 5);
    near(calc('GAMMALN(4.5)'), 2.453737, 5);
    expect(calc('GAMMA(0)')).toEqual(E('#NUM!'));
  });

  it('t, chi-squared, and F', () => {
    near(calc('T.DIST(60,1,TRUE)'), 0.994695, 5);
    near(calc('T.DIST(8,3,FALSE)'), 0.000738, 5);
    near(calc('T.DIST.2T(1.959999998,60)'), 0.054645, 5);
    near(calc('T.DIST.RT(1.959999998,60)'), 0.027322, 5);
    near(calc('TDIST(1.959999998,60,2)'), 0.054645, 5);
    near(calc('T.INV(0.75,2)'), 0.816497, 5);
    near(calc('T.INV.2T(0.546449,60)'), 0.606533, 4);
    near(calc('CHISQ.DIST(0.5,1,TRUE)'), 0.520500, 5);
    near(calc('CHISQ.DIST(2,3,FALSE)'), 0.207554, 5);
    near(calc('CHISQ.DIST.RT(18.307,10)'), 0.050001, 4);
    near(calc('CHISQ.INV(0.93,1)'), 3.283020, 4);
    near(calc('CHISQ.INV.RT(0.05,10)'), 18.307038, 4);
    near(calc('CHISQ.TEST({58,35;11,25;10,23},{45.35,47.65;17.56,18.44;16.09,16.91})'), 0.000308, 5);
    near(calc('F.DIST(15.2069,6,4,TRUE)'), 0.99, 4);
    near(calc('F.DIST(15.2069,6,4,FALSE)'), 0.001224, 5);
    near(calc('F.DIST.RT(15.2069,6,4)'), 0.01, 4);
    near(calc('T.TEST({3,4,5,8,9,1,2,4,5},{6,19,3,2,14,4,5,17,1},2,1)'), 0.196016, 5);
    near(calc('T.TEST({3,4,5,8,9,1,2,4,5},{6,19,3,2,14,4,5,17,1},2,2)'), 0.191996, 5);
    near(calc('T.TEST({3,4,5,8,9,1,2,4,5},{6,19,3,2,14,4,5,17,1},1,3)'), 0.101147, 5);
    expect(calc('T.TEST({1,2},{1,2,3},2,1)')).toEqual(E('#N/A'));
  });
});

describe('math and engineering', () => {
  const near = (v, expected, digits = 6) => expect(v).toBeCloseTo(expected, digits);
  const arr = (formula, cells = {}) => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    for (const [a1, text] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); }
    wb.setInput(id, 0, 9, `=${formula}`);
    const range = wb.spillRangeAt(id, 0, 9) || { r1: 0, c1: 9, r2: 0, c2: 9 };
    return wb.rangeValues(id, range);
  };

  it('CEILING.MATH / FLOOR.MATH and trig', () => {
    expect(calc('CEILING.MATH(24.3,5)')).toBe(25);
    expect(calc('CEILING.MATH(-8.1)')).toBe(-8);
    expect(calc('CEILING.MATH(-5.5,2,-1)')).toBe(-6);
    expect(calc('FLOOR.MATH(-8.1)')).toBe(-9);
    expect(calc('FLOOR.MATH(-5.5,2,-1)')).toBe(-4);
    expect(calc('FLOOR.MATH(6.7)')).toBe(6);
    expect(calc('CEILING.PRECISE(-4.1,2)')).toBe(-4);
    near(calc('ACOSH(10)'), 2.993223, 5);
    near(calc('ASINH(-2.5)'), -1.647231, 5);
    near(calc('ATANH(0.76159416)'), 1, 5);
    near(calc('COT(30)'), -0.156119952, 6);
    near(calc('SEC(45)'), 1.90359, 4);
    near(calc('CSC(15)'), 1.5377806, 5);
    near(calc('ACOT(2)'), 0.4636, 4);
    near(calc('COTH(2)'), 1.0373147, 5);
    expect(calc('ATANH(1)')).toEqual(E('#NUM!'));
    expect(calc('FACTDOUBLE(7)')).toBe(105);
    expect(calc('FACTDOUBLE(6)')).toBe(48);
    expect(calc('MULTINOMIAL(2,3,4)')).toBe(1260);
    expect(calc('COMBINA(4,3)')).toBe(20);
    expect(calc('PERMUTATIONA(3,2)')).toBe(9);
    near(calc('SQRTPI(2)'), 2.506628, 5);
    expect(calc('SERIESSUM(2,1,1,{1,2,3})')).toBe(2 + 2 * 4 + 3 * 8);
  });

  it('matrices', () => {
    expect(arr('MMULT({1,2;3,4},{5,6;7,8})')).toEqual([[19, 22], [43, 50]]);
    expect(arr('MMULT({1,2,3},{1;2;3})')).toEqual([[14]]);
    expect(calc('MMULT({1,2},{1,2})')).toEqual(E('#VALUE!'));
    expect(calc('MDETERM({1,2;3,4})')).toBe(-2);
    near(calc('MDETERM({3,6,1;1,1,0;3,10,2})'), 1);
    expect(calc('MDETERM({1,2,3;4,5,6})')).toEqual(E('#VALUE!'));
    const inv = arr('MINVERSE({4,7;2,6})');
    near(inv[0][0], 0.6); near(inv[0][1], -0.7); near(inv[1][0], -0.2); near(inv[1][1], 0.4);
    expect(calc('MINVERSE({1,2;2,4})')).toEqual(E('#NUM!'));
    expect(arr('MUNIT(2)')).toEqual([[1, 0], [0, 1]]);
    expect(calc('MDETERM(MMULT({1,2;3,4},MINVERSE({1,2;3,4})))')).toBeCloseTo(1, 9);
  });

  it('base conversion, bits, Roman numerals', () => {
    expect(calc('BASE(255,16)')).toBe('FF');
    expect(calc('BASE(15,2,8)')).toBe('00001111');
    expect(calc('DECIMAL("FF",16)')).toBe(255);
    expect(calc('DECIMAL("zap",36)')).toBe(45745);
    expect(calc('DECIMAL("129",2)')).toEqual(E('#NUM!'));
    expect(calc('BIN2DEC(1100100)')).toBe(100);
    expect(calc('BIN2DEC(1111111111)')).toBe(-1);
    expect(calc('DEC2BIN(9,4)')).toBe('1001');
    expect(calc('DEC2BIN(-100)')).toBe('1110011100');
    expect(calc('DEC2BIN(9,3)')).toEqual(E('#NUM!'));
    expect(calc('DEC2HEX(100,4)')).toBe('0064');
    expect(calc('DEC2HEX(-54)')).toBe('FFFFFFFFCA');
    expect(calc('HEX2DEC("A5")')).toBe(165);
    expect(calc('HEX2DEC("FFFFFFFF5B")')).toBe(-165);
    expect(calc('DEC2OCT(58,3)')).toBe('072');
    expect(calc('OCT2DEC(54)')).toBe(44);
    expect(calc('OCT2DEC(7777777533)')).toBe(-165);
    expect(calc('BIN2HEX(11111011,4)')).toBe('00FB');
    expect(calc('HEX2BIN("F",8)')).toBe('00001111');
    expect(calc('OCT2BIN(3,3)')).toBe('011');
    expect(calc('BITAND(13,25)')).toBe(9);
    expect(calc('BITOR(23,10)')).toBe(31);
    expect(calc('BITXOR(5,3)')).toBe(6);
    expect(calc('BITLSHIFT(4,2)')).toBe(16);
    expect(calc('BITRSHIFT(13,2)')).toBe(3);
    expect(calc('BITAND(-1,1)')).toEqual(E('#NUM!'));
    expect(calc('DELTA(5,4)')).toBe(0);
    expect(calc('DELTA(5,5)')).toBe(1);
    expect(calc('GESTEP(5,4)')).toBe(1);
    expect(calc('GESTEP(-4,-5)')).toBe(1);
    expect(calc('GESTEP(-1)')).toBe(0);
    expect(calc('ROMAN(499)')).toBe('CDXCIX');
    expect(calc('ROMAN(2024)')).toBe('MMXXIV');
    expect(calc('ROMAN(4000)')).toEqual(E('#VALUE!'));
    expect(calc('ARABIC("LVII")')).toBe(57);
    expect(calc('ARABIC("mcmxii")')).toBe(1912);
    expect(calc('ARABIC("-MMXXIV")')).toBe(-2024);
    expect(calc('ARABIC("abc")')).toEqual(E('#VALUE!'));
  });

  it('CONVERT', () => {
    near(calc('CONVERT(1,"lbm","kg")'), 0.453592, 5);
    near(calc('CONVERT(68,"F","C")'), 20);
    near(calc('CONVERT(100,"C","K")'), 373.15);
    expect(calc('CONVERT(2.5,"ft","sec")')).toEqual(E('#N/A'));
    near(calc('CONVERT(1,"mi","km")'), 1.609344, 5);
    near(calc('CONVERT(1,"gal","l")'), 3.785412, 5);
    near(calc('CONVERT(1,"hr","mn")'), 60);
    near(calc('CONVERT(1,"day","hr")'), 24);
    near(calc('CONVERT(1,"Mbyte","kbyte")'), 1000);
    near(calc('CONVERT(1,"Gibyte","byte")'), 1073741824);
    near(calc('CONVERT(1,"atm","kPa")'), 101.325, 3);
    near(calc('CONVERT(1,"mph","m/s")'), 0.44704, 5);
    near(calc('CONVERT(1,"km2","m2")'), 1e6, 0);
    near(calc('CONVERT(1,"in","cm")'), 2.54, 5);
    near(calc('CONVERT(1,"HP","W")'), 745.699871, 4);
    expect(calc('CONVERT(1,"foo","bar")')).toEqual(E('#N/A'));
  });
});

describe('more finance', () => {
  const near = (v, expected, digits = 2) => expect(v).toBeCloseTo(expected, digits);
  it('depreciation: DB and VDB', () => {
    near(calc('DB(1000000,100000,6,1,7)'), 186083.33);
    near(calc('DB(1000000,100000,6,2,7)'), 259639.42);
    near(calc('DB(1000000,100000,6,7,7)'), 15845.10);
    expect(calc('DB(1000000,100000,6,8,7)')).toEqual(E('#NUM!'));
    near(calc('VDB(2400,300,10,0,1)'), 480);
    expect(calc('VDB(2400,300,10,6,18)')).toEqual(E('#NUM!'));
    near(calc('VDB(2400,300,10,0,0.875,1.5)'), 315);
    near(calc('VDB(2400,300,10,1,2)'), 384);
  });
  it('cumulative payments and rates', () => {
    near(calc('CUMIPMT(0.09/12,30*12,125000,13,24,0)'), -11135.23);
    near(calc('CUMIPMT(0.09/12,30*12,125000,1,1,0)'), -937.5);
    near(calc('CUMPRINC(0.09/12,30*12,125000,13,24,0)'), -934.11);
    near(calc('CUMPRINC(0.09/12,30*12,125000,1,1,0)'), -68.28);
    expect(calc('CUMIPMT(0.09/12,360,125000,0,1,0)')).toEqual(E('#NUM!'));
    near(calc('ISPMT(0.1/12,1,3*12,8000000)'), -64814.81);
    near(calc('MIRR({-120000,39000,30000,21000,37000,46000},0.1,0.12)'), 0.1261, 4);
    near(calc('MIRR({-120000,39000,30000,21000,37000,46000},0.1,0.14)'), 0.1348, 4);
    near(calc('PDURATION(0.025,2000,2200)'), 3.86, 2);
    near(calc('RRI(96,10000,11000)'), 0.0009933, 6);
    near(calc('FVSCHEDULE(1,{0.09,0.11,0.1})'), 1.33089, 4);
    near(calc('DOLLARDE(1.02,16)'), 1.125, 4);
    near(calc('DOLLARDE(1.1,32)'), 1.3125, 4);
    near(calc('DOLLARFR(1.125,16)'), 1.02, 4);
    near(calc('DOLLARFR(1.125,32)'), 1.04, 4);
    expect(calc('DOLLARDE(1.02,0)')).toEqual(E('#DIV/0!'));
  });
});

describe('information, text, and date extras', () => {
  const arr = (formula, cells = {}) => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    for (const [a1, text] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); }
    wb.setInput(id, 0, 9, `=${formula}`);
    const range = wb.spillRangeAt(id, 0, 9) || { r1: 0, c1: 9, r2: 0, c2: 9 };
    return wb.rangeValues(id, range);
  };
  it('IS functions and text helpers', () => {
    expect(calc('ISNONTEXT(B2)')).toBe(true);
    expect(calc('ISNONTEXT(A2)')).toBe(false);
    expect(calc('ISNONTEXT(D9)')).toBe(true);
    expect(calc('ISREF(A1)')).toBe(true);
    expect(calc('ISREF(A1:B2)')).toBe(true);
    expect(calc('ISREF("A1")')).toBe(false);
    expect(calc('ISREF(1+1)')).toBe(false);
    expect(calc('ISEMAIL("nj@puter.com")')).toBe(true);
    expect(calc('ISEMAIL("not an email")')).toBe(false);
    expect(calc('ISURL("https://puter.com/x")')).toBe(true);
    expect(calc('ISURL("puter.com")')).toBe(true);
    expect(calc('ISURL("hello world")')).toBe(false);
    expect(calc('ISBETWEEN(5,1,10)')).toBe(true);
    expect(calc('ISBETWEEN(10,1,10,TRUE,FALSE)')).toBe(false);
    expect(calc('ISBETWEEN("b","a","c")')).toBe(true);
    expect(calc('ENCODEURL("a b&c/d")')).toBe('a%20b%26c%2Fd');
    expect(calc('ARRAYTOTEXT({1,"a";TRUE,2})')).toBe('1, a, TRUE, 2');
    expect(calc('ARRAYTOTEXT({1,"a";TRUE,2},1)')).toBe('{1,"a";TRUE,2}');
    expect(calc('ARRAYTOTEXT(A2:B3)')).toBe('Apple, 10, Banana, 5');
    expect(calc('VALUETOTEXT("x",1)')).toBe('"x"');
    expect(calc('VALUETOTEXT(12)')).toBe('12');
    expect(calc('VALUETOTEXT(1/0)')).toBe('#DIV/0!');
    expect(calc('CELL("address",B3)')).toBe('$B$3');
    expect(calc('CELL("row",B3)')).toBe(3);
    expect(calc('CELL("col",B3)')).toBe(2);
    expect(calc('CELL("contents",B3)')).toBe(5);
    expect(calc('CELL("type",A2)')).toBe('l');
    expect(calc('CELL("type",B2)')).toBe('v');
    expect(calc('CELL("type",D9)')).toBe('b');
    expect(calc('CELL("address")')).toBe('$Z$100');
    expect(calc('CELL("nope",A1)')).toEqual(E('#VALUE!'));
    expect(arr('ARRAY_CONSTRAIN(A1:C6,2,2)', DATA)).toEqual([['Fruit', 'Qty'], ['Apple', 10]]);
  });
  it('custom weekends and epochs', () => {
    // 2026-08-03 (Mon) to 2026-08-14 (Fri): 10 weekdays.
    expect(calc('NETWORKDAYS.INTL(DATE(2026,8,3),DATE(2026,8,14))')).toBe(10);
    expect(calc('NETWORKDAYS.INTL(DATE(2026,8,3),DATE(2026,8,14),11)')).toBe(11); // Sunday only
    expect(calc('NETWORKDAYS.INTL(DATE(2026,8,3),DATE(2026,8,14),"0000011")')).toBe(10);
    expect(calc('NETWORKDAYS.INTL(DATE(2026,8,3),DATE(2026,8,14),"1111100")')).toBe(2);
    expect(calc('NETWORKDAYS.INTL(DATE(2026,8,3),DATE(2026,8,14),1,DATE(2026,8,5))')).toBe(9);
    expect(calc('NETWORKDAYS.INTL(DATE(2026,8,3),DATE(2026,8,14),"010")')).toEqual(E('#VALUE!'));
    expect(calc('NETWORKDAYS.INTL(DATE(2026,8,3),DATE(2026,8,14),9)')).toEqual(E('#NUM!'));
    // Friday + 1 working day with Fri/Sat weekend (7) lands on Sunday.
    expect(calc('WORKDAY.INTL(DATE(2026,8,7),1,7)')).toBe(calc('DATE(2026,8,9)'));
    expect(calc('WORKDAY.INTL(DATE(2026,8,7),1)')).toBe(calc('DATE(2026,8,10)'));
    expect(calc('WORKDAY.INTL(DATE(2026,8,7),1,"1111111")')).toEqual(E('#VALUE!'));
    expect(calc('EPOCHTODATE(0)')).toBe(25569);
    expect(calc('EPOCHTODATE(86400000,2)')).toBe(25570);
    expect(calc('EPOCHTODATE(1,9)')).toEqual(E('#VALUE!'));
  });
});

describe('database functions', () => {
  const DB = {
    A1: 'Tree', B1: 'Height', C1: 'Age', D1: 'Yield',
    A2: 'Apple', B2: '18', C2: '20', D2: '14',
    A3: 'Pear', B3: '12', C3: '12', D3: '10',
    A4: 'Cherry', B4: '13', C4: '14', D4: '9',
    A5: 'Apple', B5: '14', C5: '15', D5: '10',
    A6: 'Pear', B6: '9', C6: '8', D6: '8',
    A7: 'Apple', B7: '8', C7: '9', D7: '6',
    // criteria table
    F1: 'Tree', G1: 'Height', H1: 'Height',
    F2: 'Apple', G2: '>10', H2: '<16',
    F3: 'Pear', G3: '', H3: '',
    // a second criteria table with one row
    J1: 'Yield', J2: '>10',
  };
  it('DSUM / DAVERAGE / DCOUNT / DMAX / DMIN / DGET / DPRODUCT', () => {
    expect(calc('DSUM(A1:D7,"Yield",F1:H3)', DB)).toBe(28);      // Apple 14 + Pear 10 + Pear 8... Apple(14, >10,<16) → 10; Pears → 10, 8
    expect(calc('DSUM(A1:D7,4,F1:H3)', DB)).toBe(28);
    expect(calc('DSUM(A1:D7,"Yield",J1:J2)', DB)).toBe(14);
    expect(calc('DCOUNT(A1:D7,"Age",F1:H3)', DB)).toBe(3);
    expect(calc('DCOUNT(A1:D7,,F1:H3)', DB)).toBe(3);
    expect(calc('DCOUNTA(A1:D7,"Tree",F1:H3)', DB)).toBe(3);
    expect(calc('DMAX(A1:D7,"Height",F1:H3)', DB)).toBe(14);
    expect(calc('DMIN(A1:D7,"Height",F1:H3)', DB)).toBe(9);
    expect(calc('DAVERAGE(A1:D7,"Yield",J1:J2)', DB)).toBe(14);
    expect(calc('DGET(A1:D7,"Tree",J1:J2)', DB)).toBe('Apple');
    expect(calc('DGET(A1:D7,"Tree",F1:H3)', DB)).toEqual(E('#NUM!'));
    expect(calc('DPRODUCT(A1:D7,"Yield",J1:J2)', DB)).toBe(14);
    expect(calc('DSTDEV(A1:D7,"Yield",F1:H3)', DB)).toBeCloseTo(1.1547, 3);
    expect(calc('DVARP(A1:D7,"Yield",F1:H3)', DB)).toBeCloseTo(0.8889, 3);
    expect(calc('DSUM(A1:D7,"Nope",F1:H3)', DB)).toEqual(E('#VALUE!'));
    expect(calc('DSUM(A1:D7,"Yield",F1:H1)', DB)).toEqual(E('#VALUE!'));
    expect(calc('DGET(A1:D7,"Tree",{"Tree";"Plum"})', DB)).toEqual(E('#VALUE!'));
  });
});

describe('IMAGE', () => {
  it('returns a picture value for web and data URLs only', () => {
    expect(calc('IMAGE("https://example.com/a.png")')).toEqual({ image: 'https://example.com/a.png', fit: 'contain' });
    expect(calc('IMAGE("https://example.com/a.png",2)')).toEqual({ image: 'https://example.com/a.png', fit: 'stretch' });
    expect(calc('IMAGE("data:image/png;base64,iVBOR",3)').fit).toBe('original');
    expect(calc('IMAGE("not a url")')).toEqual(E('#VALUE!'));
    expect(calc('IMAGE("https://example.com/a.png",9)')).toEqual(E('#VALUE!'));
  });
});

describe('SORTBY, AGGREGATE, MODE.MULT, and more distributions', () => {
  it('SORTBY orders rows by other ranges', () => {
    expect(calc('TEXTJOIN(",",TRUE,SORTBY(A2:A5,B2:B5))')).toBe('apple,Banana,Apple,Cherry');
    expect(calc('TEXTJOIN(",",TRUE,SORTBY(A2:A5,B2:B5,-1))')).toBe('Cherry,Apple,Banana,apple');
    expect(calc('TEXTJOIN(",",TRUE,SORTBY(A2:A5,C2:C5,1,B2:B5,-1))')).toBe('Banana,Apple,apple,Cherry');
    expect(calc('SORTBY(A2:A5,B2:B3)')).toEqual({ error: '#VALUE!' });
  });

  it('AGGREGATE skips errors when asked and takes k for LARGE-style functions', () => {
    const cells = { A1: '1', A2: '=1/0', A3: '3', A4: '5' };
    expect(calc('AGGREGATE(9,6,A1:A4)', cells)).toBe(9);
    expect(calc('AGGREGATE(9,4,A1:A4)', cells)).toEqual({ error: '#DIV/0!' });
    expect(calc('AGGREGATE(14,6,A1:A4,1)', cells)).toBe(5);
    expect(calc('AGGREGATE(15,6,A1:A4,2)', cells)).toBe(3);
    expect(calc('AGGREGATE(1,6,A1:A4)', cells)).toBe(3);
    expect(calc('AGGREGATE(20,6,A1:A4)', cells)).toEqual({ error: '#VALUE!' });
  });

  it('MODE.MULT, STDEVA, VARA', () => {
    const cells = { A1: '1', A2: '2', A3: '2', A4: '3', A5: '3', B1: '1', B2: 'TRUE', B3: 'x' };
    expect(calc('ROWS(MODE.MULT(A1:A5))', cells)).toBe(2);
    expect(calc('INDEX(MODE.MULT(A1:A5),2,1)', cells)).toBe(3);
    expect(calc('MODE.MULT(A1:A1)', cells)).toEqual({ error: '#N/A' });
    expect(calc('STDEVA(B1:B3)', cells)).toBeCloseTo(Math.sqrt(1 / 3), 9);
    expect(calc('VARA(B1:B3)', cells)).toBeCloseTo(1 / 3, 9);
    expect(calc('VARPA(B1:B3)', cells)).toBeCloseTo(2 / 9, 9);
  });

  it('GAUSS, PHI, F.INV, F.TEST, BINOM.INV, GAMMA.INV, BETA, HYPGEOM, NEGBINOM', () => {
    expect(calc('GAUSS(1)')).toBeCloseTo(0.341345, 5);
    expect(calc('PHI(0)')).toBeCloseTo(0.398942, 5);
    expect(calc('F.INV(0.95,5,10)')).toBeCloseTo(3.325835, 4);
    expect(calc('F.INV.RT(0.05,5,10)')).toBeCloseTo(3.325835, 4);
    expect(calc('F.DIST(F.INV(0.3,4,7),4,7,TRUE)')).toBeCloseTo(0.3, 8);
    const ft = calc('F.TEST(B2:B5,C2:C5)');
    expect(ft).toBeGreaterThan(0);
    expect(ft).toBeLessThanOrEqual(1);
    expect(calc('BINOM.INV(10,0.5,0.5)')).toBe(5);
    expect(calc('BINOM.INV(6,0.5,0.75)')).toBe(4);
    expect(calc('GAMMA.INV(0.5,2,1)')).toBeCloseTo(1.678347, 5);
    expect(calc('GAMMA.DIST(GAMMA.INV(0.8,3,2),3,2,TRUE)')).toBeCloseTo(0.8, 8);
    expect(calc('BETA.DIST(0.5,2,3,TRUE)')).toBeCloseTo(0.6875, 9);
    expect(calc('BETA.DIST(0.5,2,3,FALSE)')).toBeCloseTo(1.5, 9);
    expect(calc('BETA.INV(0.6875,2,3)')).toBeCloseTo(0.5, 8);
    expect(calc('BETA.DIST(3,2,3,TRUE,1,5)')).toBeCloseTo(0.6875, 9);
    expect(calc('HYPGEOM.DIST(1,4,8,20,FALSE)')).toBeCloseTo(0.363261, 5);
    expect(calc('HYPGEOM.DIST(1,4,8,20,TRUE)')).toBeCloseTo(0.465428, 5);
    expect(calc('NEGBINOM.DIST(10,5,0.25,FALSE)')).toBeCloseTo(0.0550487, 6);
    expect(calc('NEGBINOM.DIST(10,5,0.25,TRUE)')).toBeCloseTo(0.3135141, 6);
  });
});

describe('engineering: error function and complex numbers', () => {
  it('ERF / ERFC', () => {
    expect(calc('ERF(1)')).toBeCloseTo(0.8427008, 6);
    expect(calc('ERF(0.5,1)')).toBeCloseTo(0.8427008 - 0.5204999, 6);
    expect(calc('ERFC(1)')).toBeCloseTo(0.1572992, 6);
    expect(calc('ERF.PRECISE(-1)')).toBeCloseTo(-0.8427008, 6);
  });

  it('COMPLEX and IM* arithmetic', () => {
    expect(calc('COMPLEX(3,4)')).toBe('3+4i');
    expect(calc('COMPLEX(0,-1,"j")')).toBe('-j');
    expect(calc('COMPLEX(2,0)')).toBe('2');
    expect(calc('COMPLEX(1,1,"k")')).toEqual(E('#VALUE!'));
    expect(calc('IMREAL("3-4i")')).toBe(3);
    expect(calc('IMAGINARY("3-4i")')).toBe(-4);
    expect(calc('IMABS("3+4i")')).toBe(5);
    expect(calc('IMARGUMENT("i")')).toBeCloseTo(Math.PI / 2, 12);
    expect(calc('IMCONJUGATE("3+4i")')).toBe('3-4i');
    expect(calc('IMSUM("3+4i","1-2i",2)')).toBe('6+2i');
    expect(calc('IMSUB("3+4i","1-2i")')).toBe('2+6i');
    expect(calc('IMPRODUCT("1+2i","3+4i")')).toBe('-5+10i');
    expect(calc('IMDIV("-5+10i","3+4i")')).toBe('1+2i');
    expect(calc('IMDIV("1","0")')).toEqual(E('#NUM!'));
    expect(calc('IMPOWER("1+i",2)')).toBe('2i');
    expect(calc('IMSQRT("-4")')).toBe('2i');
    expect(calc('IMREAL(IMEXP(COMPLEX(0,PI())))')).toBeCloseTo(-1, 8);
    expect(calc('IMAGINARY(IMEXP(COMPLEX(0,PI())))')).toBeCloseTo(0, 8);
    expect(calc('IMLN("1")')).toBe('0');
    expect(calc('IMREAL(IMLOG10("100"))')).toBeCloseTo(2, 9);
    expect(calc('IMREAL(IMLOG2("8"))')).toBeCloseTo(3, 9);
    expect(calc('IMREAL(IMSIN("1"))')).toBeCloseTo(Math.sin(1), 9);
    expect(calc('IMREAL(IMCOS("1"))')).toBeCloseTo(Math.cos(1), 9);
    expect(calc('IMREAL(IMTAN("1"))')).toBeCloseTo(Math.tan(1), 8);
    expect(calc('IMSUM("abc")')).toEqual(E('#NUM!'));
  });
});

describe('more statistics', () => {
  it('PROB / PERCENTRANK.EXC / LOGINV / MARGINOFERROR / COUNTUNIQUEIFS / AREAS', () => {
    const cells = { A1: '0', A2: '1', A3: '2', A4: '3', B1: '0.2', B2: '0.3', B3: '0.1', B4: '0.4', C1: 'x', C2: 'y', C3: 'x', C4: 'z', D1: 'a', D2: 'a', D3: 'a', D4: 'b' };
    expect(calc('PROB(A1:A4,B1:B4,2)', cells)).toBeCloseTo(0.1, 12);
    expect(calc('PROB(A1:A4,B1:B4,1,3)', cells)).toBeCloseTo(0.8, 12);
    expect(calc('PROB(A1:A4,B1:B3,1)', cells)).toEqual(E('#N/A'));
    expect(calc('PERCENTRANK.EXC({1,2,3,4},2)')).toBeCloseTo(0.4, 6);
    expect(calc('PERCENTRANK.EXC({1,2,3,4},2.5)')).toBeCloseTo(0.5, 6);
    expect(calc('PERCENTRANK.EXC({1,1,2,3},1)')).toBeCloseTo(0.2, 6); // ties take the first position
    expect(calc('PERCENTRANK.EXC({1,2,3},5)')).toEqual(E('#N/A'));
    // PERCENTRANK (inclusive), the documented example, including a tie at the bottom.
    expect(calc('PERCENTRANK({13,12,11,8,4,3,2,1,1,1},2)')).toBeCloseTo(0.333, 6);
    expect(calc('PERCENTRANK({13,12,11,8,4,3,2,1,1,1},5)')).toBeCloseTo(0.583, 6);
    expect(calc('PERCENTRANK({13,12,11,8,4,3,2,1,1,1},1)')).toBe(0);
    expect(calc('LOGINV(0.5,1,0.5)')).toBeCloseTo(Math.E, 6);
    expect(calc('MARGINOFERROR({2,4,4,4,5,5,7,9},0.95)')).toBeCloseTo(1.959964 * Math.sqrt(32 / 7) / Math.sqrt(8), 5);
    expect(calc('COUNTUNIQUEIFS(C1:C4,D1:D4,"a")', cells)).toBe(2);
    expect(calc('COUNTUNIQUEIFS(C1:C4,D1:D4,"b")', cells)).toBe(1);
    expect(calc('AREAS(A1:B4)', cells)).toBe(1);
  });
});

describe('discount securities and T-bills', () => {
  it('DISC / INTRATE / RECEIVED / PRICEDISC / YIELDDISC / TBILL*', () => {
    const s = 'DATE(2018,1,25)';
    const m = 'DATE(2018,6,15)';
    expect(calc(`DISC(${s},${m},97.975,100,1)`)).toBeCloseTo(0.052420, 5);
    expect(calc(`INTRATE(DATE(2008,2,15),DATE(2008,5,15),1000000,1014420,2)`)).toBeCloseTo(0.05768, 5);
    expect(calc(`RECEIVED(DATE(2008,2,15),DATE(2008,5,15),1000000,0.0575,2)`)).toBeCloseTo(1014584.65, 1);
    expect(calc(`PRICEDISC(DATE(2008,2,16),DATE(2008,3,1),0.0525,100,2)`)).toBeCloseTo(99.7958, 3);
    expect(calc(`YIELDDISC(DATE(2008,2,16),DATE(2008,3,1),99.795,100,2)`)).toBeCloseTo(0.052823, 5);
    expect(calc('TBILLEQ(DATE(2008,3,31),DATE(2008,6,1),0.0914)')).toBeCloseTo(0.09415, 4);
    expect(calc('TBILLPRICE(DATE(2008,3,31),DATE(2008,6,1),0.09)')).toBeCloseTo(98.45, 2);
    expect(calc('TBILLYIELD(DATE(2008,3,31),DATE(2008,6,1),98.45)')).toBeCloseTo(0.09142, 4);
    expect(calc(`DISC(${m},${s},97,100)`)).toEqual(E('#NUM!'));
    expect(calc('TBILLEQ(DATE(2008,3,31),DATE(2010,6,1),0.09)')).toEqual(E('#NUM!'));
  });

  it('coupon dates and day counts', () => {
    const args = 'DATE(2011,1,25),DATE(2011,11,15),2,1';
    expect(calc(`COUPPCD(${args})`)).toBe(ymdToSerial(2010, 11, 15));
    expect(calc(`COUPNCD(${args})`)).toBe(ymdToSerial(2011, 5, 15));
    expect(calc(`COUPNUM(${args})`)).toBe(2);
    expect(calc(`COUPDAYBS(${args})`)).toBe(71);
    expect(calc(`COUPDAYS(${args})`)).toBe(181);
    expect(calc(`COUPDAYSNC(${args})`)).toBe(110);
    expect(calc('COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),2,0)')).toBe(180);
    expect(calc('COUPDAYS(DATE(2011,1,25),DATE(2011,11,15),4,3)')).toBeCloseTo(91.25, 6);
    // Month-end maturities keep to month ends.
    expect(calc('COUPPCD(DATE(2024,1,15),DATE(2025,2,28),2)')).toBe(ymdToSerial(2023, 8, 31));
    expect(calc('COUPNUM(DATE(2011,1,25),DATE(2011,11,15),3)')).toEqual(E('#NUM!'));
    expect(calc('COUPNUM(DATE(2012,1,25),DATE(2011,11,15),2)')).toEqual(E('#NUM!'));
  });

  it('PRICE / YIELD / DURATION / MDURATION / ACCRINT / ACCRINTM / PRICEMAT / YIELDMAT', () => {
    expect(calc('PRICE(DATE(2008,2,15),DATE(2017,11,15),0.0575,0.065,100,2,0)')).toBeCloseTo(94.63436162, 6);
    expect(calc('YIELD(DATE(2008,2,15),DATE(2016,11,15),0.0575,95.04287,100,2,0)')).toBeCloseTo(0.065, 6);
    // One coupon left: the closed form, and PRICE and YIELD agree.
    expect(calc('YIELD(DATE(2011,1,25),DATE(2011,5,15),0.05,99.5,100,2,1)')).toBeCloseTo(calc('YIELD(DATE(2011,1,25),DATE(2011,5,15),0.05,PRICE(DATE(2011,1,25),DATE(2011,5,15),0.05,YIELD(DATE(2011,1,25),DATE(2011,5,15),0.05,99.5,100,2,1),100,2,1),100,2,1)'), 8);
    expect(calc('DURATION(DATE(2008,1,1),DATE(2016,1,1),0.08,0.09,2,1)')).toBeCloseTo(5.993775, 5);
    expect(calc('MDURATION(DATE(2008,1,1),DATE(2016,1,1),0.08,0.09,2,1)')).toBeCloseTo(5.73567, 5);
    expect(calc('ACCRINT(DATE(2008,3,1),DATE(2008,8,31),DATE(2008,5,1),0.1,1000,2,0)')).toBeCloseTo(16.666667, 5);
    expect(calc('ACCRINTM(DATE(2008,4,1),DATE(2008,6,15),0.1,1000,3)')).toBeCloseTo(20.54795, 4);
    expect(calc('PRICEMAT(DATE(2008,2,15),DATE(2008,4,13),DATE(2007,11,11),0.061,0.061,0)')).toBeCloseTo(99.98449888, 6);
    expect(calc('YIELDMAT(DATE(2008,3,15),DATE(2008,11,3),DATE(2007,11,8),0.0625,100.0123,0)')).toBeCloseTo(0.060954, 5);
    expect(calc('PRICE(DATE(2008,2,15),DATE(2017,11,15),0.0575,0.065,100,3)')).toEqual(E('#NUM!'));
    expect(calc('PRICE(DATE(2008,2,15),DATE(2017,11,15),0.0575,0.065,0,2)')).toEqual(E('#NUM!'));
    expect(calc('ACCRINTM(DATE(2008,6,15),DATE(2008,4,1),0.1,1000)')).toEqual(E('#NUM!'));
  });

  it('conversions and byte aliases', () => {
    expect(calc('TO_TEXT(12.5)')).toBe('12.5');
    expect(calc('TO_PURE_NUMBER("12%")')).toBe(0.12);
    expect(calc('TO_DATE(45306)')).toBe(45306);
    expect(calc('LENB("héllo")')).toBe(5);
    expect(calc('LEFTB("hello",2)')).toBe('he');
    expect(calc('FINDB("l","hello")')).toBe(3);
    expect(FUNCTION_NAMES).toContain('IMSUM');
  });
});

describe('implicit intersection and optional LAMBDA parameters', () => {
  it('@range picks the value on the formula\'s row or column', () => {
    const cells = { A1: '10', A2: '20', A3: '30', B1: '1', C1: '2', D1: '3' };
    // calc() puts the formula in row 100, column Z: use explicit cells instead.
    const { Workbook } = require('../src/core/workbook.js');
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    for (const [a1, text] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); }
    wb.setInput(id, 1, 5, '=@A1:A3*2'); // F2: row 2 of the column → 20
    wb.setInput(id, 5, 2, '=@B1:D1'); // C6: column C of the row → 2
    wb.setInput(id, 6, 0, '=@A1:D3'); // a block: nothing to intersect
    wb.setInput(id, 7, 0, '=@A1');
    wb.setInput(id, 8, 0, '=@INDEX(A1:A3,2)');
    expect(wb.getValue(id, 1, 5)).toBe(40);
    expect(wb.getValue(id, 5, 2)).toBe(2);
    expect(wb.getValue(id, 6, 0)).toEqual(E('#VALUE!'));
    expect(wb.getValue(id, 7, 0)).toBe(10);
    expect(wb.getValue(id, 8, 0)).toBe(20);
  });

  it('LAMBDA([x], ...) and ISOMITTED', () => {
    expect(calc('LAMBDA(a,[b],IF(ISOMITTED(b),a*10,a+b))(4)')).toBe(40);
    expect(calc('LAMBDA(a,[b],IF(ISOMITTED(b),a*10,a+b))(4,1)')).toBe(5);
    expect(calc('LET(f,LAMBDA([x],ISOMITTED(x)),f())')).toBe(true);
    expect(calc('LET(f,LAMBDA([x],ISOMITTED(x)),f(0))')).toBe(false);
    expect(calc('LAMBDA([x],x)(7)')).toBe(7);
    expect(calc('LAMBDA(x,x+1)(4)')).toBe(5);
    expect(calc('LAMBDA(x,y,x*y)(3,4)')).toBe(12);
    expect(calc('SUM(LAMBDA(n,SEQUENCE(n))(4))')).toBe(10);
    expect(calc('(1+2)(4)')).toEqual(E('#ERROR!')); // only a call's result can be called
    expect(calc('ISOMITTED(1)')).toEqual(E('#VALUE!'));
    expect(FUNCTION_NAMES).toContain('ISOMITTED');
  });
});

describe('GROUPBY, PIVOTBY, and friends', () => {
  const SALES = {
    A1: 'Region', B1: 'Product', C1: 'Amount', D1: 'Keep',
    A2: 'East', B2: 'Pen', C2: '10', D2: 'TRUE',
    A3: 'West', B3: 'Ink', C3: '5', D3: 'TRUE',
    A4: 'East', B4: 'Ink', C4: '20', D4: 'TRUE',
    A5: 'West', B5: 'Pen', C5: '7', D5: 'FALSE',
    A6: 'east', B6: 'Pen', C6: '3', D6: 'TRUE',
  };
  const arr = (formula, cells = SALES) => {
    const wb = new Workbook();
    const id = wb.sheets[0].id;
    for (const [a1, text] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); }
    wb.setInput(id, 0, 9, `=${formula}`);
    const range = wb.spillRangeAt(id, 0, 9) || { r1: 0, c1: 9, r2: 0, c2: 9 };
    return wb.rangeValues(id, range);
  };

  it('passes a built-in by name as a function, while zero-argument names still call', () => {
    expect(arr('MAP({" a ","b "}, TRIM)')).toEqual([['a', 'b']]);
    expect(arr('BYROW({1,2;3,4}, MAX)')).toEqual([[2], [4]]);
    expect(calc('REDUCE(0, {1,2,3}, LAMBDA(a, v, ADD(a, v)))')).toBe(6);
    expect(calc('PI')).toBeCloseTo(Math.PI, 10);
    expect(calc('SUM')).toEqual(E('#CALC!'));
  });

  it('GROUPBY groups, summarizes, totals, sorts, filters, and reads headers', () => {
    expect(arr('GROUPBY(A2:A6, C2:C6, SUM)')).toEqual([['East', 33], ['West', 12], ['Total', 45]]);
    expect(arr('GROUPBY(A2:A6, C2:C6, AVERAGE, 0, 0)')).toEqual([['East', 11], ['West', 6]]);
    expect(arr('GROUPBY(A2:A6, C2:C6, COUNT, 0, -1)')).toEqual([['Total', 5], ['East', 3], ['West', 2]]);
    expect(arr('GROUPBY(A2:A6, C2:C6, SUM, 0, 0, -2)')).toEqual([['East', 33], ['West', 12]]);
    expect(arr('GROUPBY(A2:A6, C2:C6, SUM, 0, 0, 2)')).toEqual([['West', 12], ['East', 33]]);
    expect(arr('GROUPBY(A2:A6, C2:C6, SUM, 0, 1, , D2:D6)')).toEqual([['East', 33], ['West', 5], ['Total', 38]]);
    expect(arr('GROUPBY(A1:A6, C1:C6, SUM, 3)')).toEqual([['Region', 'Amount'], ['East', 33], ['West', 12], ['Total', 45]]);
    expect(arr('GROUPBY(A2:A6, C2:C6, SUM, 2, 0)')).toEqual([['Column1', 'Column2'], ['East', 33], ['West', 12]]);
    expect(arr('GROUPBY(A2:A6, C2:C6, LAMBDA(x, PERCENTOF(x, C2:C6)), 0, 0)')).toEqual([['East', 33 / 45], ['West', 12 / 45]]);
    // Two row fields with subtotals, and two value columns.
    expect(arr('GROUPBY(A2:B6, C2:C6, SUM, 0, 2)')).toEqual([
      ['East', 'Ink', 20], ['East', 'Pen', 13], ['East Total', '', 33],
      ['West', 'Ink', 5], ['West', 'Pen', 7], ['West Total', '', 12],
      ['Grand Total', '', 45],
    ]);
    expect(arr('GROUPBY(B2:B6, HSTACK(C2:C6, C2:C6*2), SUM)')).toEqual([['Ink', 25, 50], ['Pen', 20, 40], ['Total', 45, 90]]);
    expect(calc('GROUPBY(A2:A6, C2:C5, SUM)')).toEqual(E('#VALUE!'));
    expect(calc('GROUPBY(A2:A6, C2:C6, 5)')).toEqual(E('#VALUE!'));
  });

  it('PIVOTBY crosses two fields with row and column totals', () => {
    expect(arr('PIVOTBY(A2:A6, B2:B6, C2:C6, SUM)')).toEqual([
      ['', 'Ink', 'Pen', 'Total'],
      ['East', 20, 13, 33],
      ['West', 5, 7, 12],
      ['Total', 25, 20, 45],
    ]);
    expect(arr('PIVOTBY(A1:A6, B1:B6, C1:C6, COUNT, 3, 0, , 0)')).toEqual([
      ['Region', 'Ink', 'Pen'],
      ['East', 1, 2],
      ['West', 1, 1],
    ]);
    expect(arr('PIVOTBY(A2:A6, B2:B6, C2:C6, SUM, 0, 1, -1, 1, -1)')).toEqual([
      ['', 'Pen', 'Ink', 'Total'],
      ['West', 7, 5, 12],
      ['East', 13, 20, 33],
      ['Total', 20, 25, 45],
    ]);
  });

  it('TRIMRANGE, REGEXTEST, and the operator functions', () => {
    const cells = { B2: '1', C2: '2', B3: '3', C3: '' };
    expect(arr('TRIMRANGE(A1:D5)', cells)).toEqual([[1, 2], [3, 0]]);
    expect(arr('TRIMRANGE(A1:D5, 1, 0)', cells)).toEqual([[0, 1, 2, 0], [0, 3, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    expect(calc('TRIMRANGE(A1:D5)', {})).toEqual(E('#CALC!'));
    expect(calc('REGEXTEST("Hello", "^h")')).toBe(false);
    expect(calc('REGEXTEST("Hello", "^h", 1)')).toBe(true);
    expect(calc('REGEXTEST("a1", "\\d$")')).toBe(true);
    expect(calc('ADD(2, 3)')).toBe(5);
    expect(calc('MINUS(2, 3)')).toBe(-1);
    expect(calc('MULTIPLY(2, "3")')).toBe(6);
    expect(calc('DIVIDE(1, 0)')).toEqual(E('#DIV/0!'));
    expect(calc('POW(2, 10)')).toBe(1024);
    expect(calc('UMINUS(4)')).toBe(-4);
    expect(calc('UNARY_PERCENT(50)')).toBe(0.5);
    expect(calc('EQ("a", "A")')).toBe(true);
    expect(calc('NE(1, 2)')).toBe(true);
    expect(calc('GT(2, 1)')).toBe(true);
    expect(calc('GTE(1, 1)')).toBe(true);
    expect(calc('LT("apple", "banana")')).toBe(true);
    expect(calc('LTE(2, 1)')).toBe(false);
    expect(calc('EQ(A7, 0)')).toBe(true); // a blank reads as 0 against a number
  });
});

describe('Bessel, complex hyperbolics, binomial ranges, INFO, and FILTERXML', () => {
  it('evaluates the Bessel functions to their documented values', () => {
    expect(calc('BESSELJ(1.9, 2)')).toBeCloseTo(0.329926, 5);
    expect(calc('BESSELJ(2.5, 0)')).toBeCloseTo(-0.048384, 5);
    expect(calc('BESSELJ(1.5, 1)')).toBeCloseTo(0.557937, 5);
    expect(calc('BESSELJ(3, 6)')).toBeCloseTo(0.011394, 5);
    expect(calc('BESSELY(2.5, 1)')).toBeCloseTo(0.145918, 5);
    expect(calc('BESSELY(1.5, 0)')).toBeCloseTo(0.382449, 5);
    expect(calc('BESSELI(1.5, 1)')).toBeCloseTo(0.981666, 5);
    expect(calc('BESSELI(2, 3)')).toBeCloseTo(0.212740, 5);
    expect(calc('BESSELK(1.5, 1)')).toBeCloseTo(0.277388, 5);
    expect(calc('BESSELK(2, 2)')).toBeCloseTo(0.253760, 5);
    expect(calc('BESSELY(-1, 0)')).toEqual(E('#NUM!'));
    expect(calc('BESSELJ(1, -1)')).toEqual(E('#NUM!'));
  });

  it('evaluates complex hyperbolic and reciprocal trigonometric functions', () => {
    const parts = (t) => { const m = /^(-?[\d.]+)([+-][\d.]+)i$/.exec(t); return [Number(m[1]), Number(m[2])]; };
    const near = (t, re, im) => { const [a, b] = parts(t); expect(a).toBeCloseTo(re, 6); expect(b).toBeCloseTo(im, 6); };
    near(calc('IMCOSH("4+3i")'), -27.0349456030742, 3.85115333481178);
    near(calc('IMSINH("4+3i")'), -27.0168132580039, 3.85373803791938);
    near(calc('IMSEC("4+3i")'), -0.0652940278579471, -0.0752249603027732);
    near(calc('IMCSC("4+3i")'), -0.0754898329158637, 0.0648774713706355);
    near(calc('IMCOT("4+3i")'), 0.00490118239430447, -0.999266927805902);
    near(calc('IMSECH("4+3i")'), -0.0362534969158689, -0.00516434460775318);
    near(calc('IMCSCH("4+3i")'), -0.036275889628626, -0.0051744731840194);
  });

  it('BINOM.DIST.RANGE sums the binomial probabilities between two counts', () => {
    expect(calc('BINOM.DIST.RANGE(60, 0.75, 48)')).toBeCloseTo(0.083975, 5);
    expect(calc('BINOM.DIST.RANGE(60, 0.75, 45, 50)')).toBeCloseTo(0.523630, 5);
    expect(calc('BINOM.DIST.RANGE(10, 0.5, 0, 10)')).toBeCloseTo(1, 10);
    expect(calc('BINOM.DIST.RANGE(10, 0.5, 6, 4)')).toEqual(E('#NUM!'));
  });

  it('INFO answers the documented questions', () => {
    expect(calc('INFO("recalc")')).toBe('Automatic');
    expect(calc('INFO("numfile")')).toBe(1);
    expect(calc('INFO("origin")')).toBe('$A:$A$1');
    expect(calc('INFO("nope")')).toEqual(E('#VALUE!'));
  });
});

describe('lookup arrays with two dimensions', () => {
  it('are refused instead of being read as one flattened list', () => {
    const data = { A1: 'a', B1: 'x', C1: 'r1', A2: 'b', B2: 'y', C2: 'r2', A3: 'c', B3: 'z', C3: 'r3' };
    expect(calc('XLOOKUP("b",A1:B3,C1:C3)', data)).toEqual({ error: '#VALUE!' });
    expect(calc('XMATCH("y",A1:B3)', data)).toEqual({ error: '#VALUE!' });
    expect(calc('MATCH("y",A1:B3,0)', data)).toEqual({ error: '#N/A' });
    expect(calc('XLOOKUP("b",A1:A3,C1:C3)', data)).toBe('r2');
    expect(calc('MATCH("y",B1:B3,0)', data)).toBe(2);
    expect(calc('MATCH(2,{1,2,3},0)', data)).toBe(2);
    expect(calc('XMATCH(2,{1;2;3})', data)).toBe(2);
    // A tall bounded range is still one column, however far past its data it reaches.
    expect(calc('XLOOKUP("b",A1:A3000,C1:C3000)', data)).toBe('r2');
    expect(calc('MATCH("b",A1:A3000,0)', data)).toBe(2);
  });
});

describe('an empty lookup value', () => {
  it('matches nothing in the approximate modes, rather than standing in for zero', () => {
    const data = { B1: '0', B2: '1', C1: 'z', C2: 'y' };
    expect(calc('VLOOKUP(A5,B1:C2,2,TRUE)', data)).toEqual({ error: '#N/A' });
    expect(calc('HLOOKUP(A5,{0,1;"z","y"},2)', data)).toEqual({ error: '#N/A' });
    expect(calc('MATCH(A5,B1:B2,1)', data)).toEqual({ error: '#N/A' });
    expect(calc('XLOOKUP(A5,B1:B2,C1:C2,,-1)', data)).toEqual({ error: '#N/A' });
    expect(calc('LOOKUP(A5,B1:B2)', data)).toEqual({ error: '#N/A' });
    expect(calc('VLOOKUP(A5,B1:C2,2,FALSE)', data)).toEqual({ error: '#N/A' });
    // A real zero still finds the zero.
    expect(calc('MATCH(0,B1:B2,1)', data)).toBe(1);
    expect(calc('XLOOKUP(0,B1:B2,C1:C2,,-1)', data)).toBe('z');
  });
});
