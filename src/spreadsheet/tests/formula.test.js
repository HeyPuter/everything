import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/core/formula/tokenizer.js';
import { parseFormula, FormulaSyntaxError } from '../src/core/formula/parser.js';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef } from '../src/core/cell.js';
import { spillRefsToFile, spillRefsFromFile } from '../src/core/refs.js';
import { toFileFormula, fromFileFormula, XLFN } from '../src/core/xlfn.js';

/** A workbook helper: set('A1', '=1+1'), val('A1'). */
function book(cells = {}, sheetName = 'Sheet1') {
  const wb = new Workbook({ sheets: [{ name: sheetName }] });
  const id = wb.sheets[0].id;
  for (const [a1, text] of Object.entries(cells)) {
    const { r, c } = parseCellRef(a1);
    wb.setInput(id, r, c, text);
  }
  return {
    wb,
    id,
    set: (a1, text) => { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); },
    val: (a1) => { const { r, c } = parseCellRef(a1); return wb.getValue(id, r, c); },
    show: (a1) => { const { r, c } = parseCellRef(a1); return wb.getDisplay(id, r, c); },
  };
}

/** Evaluate one formula in an otherwise empty sheet. */
function calc(formula, cells = {}) {
  const b = book(cells);
  b.set('Z100', `=${formula}`);
  return b.val('Z100');
}

describe('tokenizer', () => {
  it('splits numbers, refs, names, strings, and operators', () => {
    const types = tokenize('SUM(A1:B2, 3.5, "x""y") <> Sheet1!C3 & -1e2%').map((t) => t.type);
    expect(types).toEqual(['name', 'lparen', 'ref', 'comma', 'number', 'comma', 'string', 'rparen', 'op', 'ref', 'op', 'op', 'number', 'op']);
  });

  it('reads sheet-qualified and quoted sheet names', () => {
    const [t] = tokenize("'My Sheet'!A1:A3");
    expect(t).toMatchObject({ type: 'ref', sheet: 'My Sheet', text: 'A1:A3' });
    const [u] = tokenize('Data!B2');
    expect(u).toMatchObject({ type: 'ref', sheet: 'Data', text: 'B2' });
  });

  it('distinguishes whole-row ranges from numbers', () => {
    expect(tokenize('SUM(1:3)')[2]).toMatchObject({ type: 'ref', text: '1:3' });
    expect(tokenize('1+3')[0]).toMatchObject({ type: 'number', value: 1 });
  });

  it('does not read function names like LOG10 as references', () => {
    expect(tokenize('LOG10(100)')[0]).toMatchObject({ type: 'name', value: 'LOG10' });
  });

  it('reports errors with a position', () => {
    expect(() => tokenize('"open')).toThrow(FormulaSyntaxError);
    expect(() => tokenize('1 ~ 2')).toThrow(/Unexpected character/);
  });
});

describe('parser', () => {
  it('respects precedence and associativity', () => {
    const ast = parseFormula('1+2*3^2');
    expect(ast).toMatchObject({ type: 'binary', op: '+', right: { op: '*', right: { op: '^' } } });
    // 2^3^2 groups left: (2^3)^2
    expect(calc('2^3^2')).toBe(64);
    expect(calc('-2^2')).toBe(4); // unary binds tighter than ^, as in Excel
    expect(calc('1+2&3')).toBe('33');
    expect(calc('1+2=3')).toBe(true);
  });

  it('handles empty arguments and bare names', () => {
    const ast = parseFormula('IF(A1,,"x")');
    expect(ast.args[1].type).toBe('empty');
    expect(parseFormula('PI').type).toBe('call');
  });

  it('reads a parenthesized list of references as a union', () => {
    const ast = parseFormula('SUM((A1:A3,C1:C3,E5))');
    expect(ast.args[0].type).toBe('union');
    expect(ast.args[0].parts.map((p) => p.type)).toEqual(['ref', 'ref', 'ref']);
    expect(parseFormula('(1+2)*3').type).toBe('binary');
  });

  it('rejects malformed formulas', () => {
    for (const bad of ['1+', 'SUM(1', '(1))', '1 2', 'A1:', '"a" "b"']) {
      expect(() => parseFormula(bad), bad).toThrow(FormulaSyntaxError);
    }
  });
});

describe('evaluator', () => {
  it('does arithmetic with coercion', () => {
    expect(calc('1+2*3')).toBe(7);
    expect(calc('(1+2)*3')).toBe(9);
    expect(calc('10/4')).toBe(2.5);
    expect(calc('"3"+4')).toBe(7);
    expect(calc('TRUE+1')).toBe(2);
    expect(calc('50%')).toBe(0.5);
    expect(calc('-A1', { A1: '5' })).toBe(-5);
    expect(calc('A1+1')).toBe(1); // empty cell counts as 0
  });

  it('produces spreadsheet errors', () => {
    expect(calc('1/0')).toEqual({ error: '#DIV/0!' });
    expect(calc('"abc"+1')).toEqual({ error: '#VALUE!' });
    expect(calc('NOPE(1)')).toEqual({ error: '#NAME?' });
    expect(calc('Missing!A1')).toEqual({ error: '#REF!' });
    expect(calc('SQRT(-1)')).toEqual({ error: '#NUM!' });
    expect(calc('1+#N/A')).toEqual({ error: '#N/A' });
  });

  it('concatenates and compares', () => {
    expect(calc('"a"&"b"&1')).toBe('ab1');
    expect(calc('"apple"<"banana"')).toBe(true);
    expect(calc('"A"="a"')).toBe(true);
    expect(calc('1="1"')).toBe(false);
    expect(calc('2>1')).toBe(true);
    expect(calc('1<>2')).toBe(true);
    expect(calc('"z"<1')).toBe(false); // text sorts after numbers
    expect(calc('TRUE>100')).toBe(true);
    expect(calc('A1=0')).toBe(true);
    expect(calc('A1=""')).toBe(true);
  });

  it('reads cells and ranges', () => {
    const b = book({ A1: '1', A2: '2', A3: '3', B1: '=SUM(A1:A3)', B2: '=A1:A1*10', B3: '=A1:A3*10' });
    expect(b.val('B1')).toBe(6);
    expect(b.val('B2')).toBe(10);
    expect(b.val('B3')).toBe(10); // an array result spills down from its cell
    expect(b.val('B4')).toBe(20);
    expect(b.val('B5')).toBe(30);
  });

  it('follows references across sheets', () => {
    const wb = new Workbook({ sheets: [{ name: 'Main' }, { name: 'Data Q1' }] });
    const [main, data] = wb.sheets;
    wb.setInput(data.id, 0, 0, '40');
    wb.setInput(data.id, 1, 0, '2');
    wb.setInput(main.id, 0, 0, "='Data Q1'!A1+SUM('Data Q1'!A1:A2)");
    expect(wb.getValue(main.id, 0, 0)).toBe(82);
  });

  it('detects cycles instead of hanging', () => {
    const b = book({ A1: '=B1+1', B1: '=A1+1', C1: '=C1' });
    expect(b.val('A1')).toEqual({ error: '#CYCLE!' });
    expect(b.val('B1')).toEqual({ error: '#CYCLE!' });
    expect(b.val('C1')).toEqual({ error: '#CYCLE!' });
    expect(b.show('A1')).toBe('#CYCLE!');
  });

  it('recomputes dependents after an edit', () => {
    const b = book({ A1: '2', A2: '=A1*10', A3: '=A2+1' });
    expect(b.val('A3')).toBe(21);
    b.set('A1', '5');
    expect(b.val('A3')).toBe(51);
    b.set('A1', '');
    expect(b.val('A3')).toBe(1);
  });

  it('marks unparsable formulas rather than throwing', () => {
    expect(calc('1+')).toEqual({ error: '#ERROR!' });
  });

  it('is lazy in IF branches', () => {
    expect(calc('IF(TRUE,1,1/0)')).toBe(1);
    expect(calc('IF(FALSE,1/0,2)')).toBe(2);
    expect(calc('IF(1/0,1,2)')).toEqual({ error: '#DIV/0!' });
    expect(calc('IF(A1>0,"yes")', { A1: '0' })).toBe(false);
  });

  it('handles long dependency chains', () => {
    const cells = { A1: '1' };
    for (let r = 2; r <= 500; r++) cells[`A${r}`] = `=A${r - 1}+1`;
    const b = book(cells);
    expect(b.val('A500')).toBe(500);
  });
});

describe('array constants', () => {
  it('tokenizes and parses braces', () => {
    expect(tokenize('{1,2;3,4}').map((t) => t.type)).toEqual(['lbrace', 'number', 'comma', 'number', 'comma', 'number', 'comma', 'number', 'rbrace']);
    const ast = parseFormula('{1,"a";TRUE,-4}');
    expect(ast.type).toBe('array');
    expect(ast.rows.length).toBe(2);
    expect(ast.rows[1][1].type).toBe('unary');
    expect(() => parseFormula('{1,2;3}')).toThrow(FormulaSyntaxError);
    expect(() => parseFormula('{}')).toThrow(FormulaSyntaxError);
  });

  it('feeds functions and arithmetic', () => {
    expect(calc('SUM({1,2;3,4})')).toBe(10);
    expect(calc('MAX({1,2;3,4})')).toBe(4);
    expect(calc('INDEX({10,20,30},2)')).toBe(20);
    expect(calc('VLOOKUP("b",{"a",1;"b",2;"c",3},2,FALSE)')).toBe(2);
    expect(calc('SUMPRODUCT({1,2,3},{4,5,6})')).toBe(32);
    expect(calc('SUM({1,2,3}*2)')).toBe(12);
    expect(calc('COUNTA({1,"x",TRUE})')).toBe(3);
  });

  it('spills into neighbouring cells', () => {
    const b = book();
    b.set('A1', '={1,2,3;4,5,6}');
    expect(b.val('A1')).toBe(1);
    expect(b.val('C1')).toBe(3);
    expect(b.val('B2')).toBe(5);
    expect(b.wb.spillRangeAt(b.id, 0, 0)).toEqual({ r1: 0, c1: 0, r2: 1, c2: 2 });
    b.set('E1', '={1,2}+{10,20}');
    expect(b.val('F1')).toBe(22);
    b.set('G1', '={5}');
    expect(b.val('G1')).toBe(5);
    expect(b.wb.spillRangeAt(b.id, 0, 6)).toBeNull();
  });
});

describe('spill reference tokens', () => {
  it('tokenizes A1# as a spill reference and rejects # on a range', () => {
    const t = tokenize('SUM(A1#)+B2');
    expect(t[2]).toMatchObject({ type: 'ref', text: 'A1', spill: true, start: 4, end: 7 });
    expect(t[5]).toMatchObject({ type: 'ref', text: 'B2', spill: false });
    // A1:B2# is the range from A1 to the spill of B2; # still never follows a block.
    expect(tokenize('A1:B2#').map((x) => x.type)).toEqual(['ref', 'colon', 'ref']);
    expect(() => parseFormula('A:B#')).toThrow(FormulaSyntaxError);
    // Error literals right after a reference are still errors, not spills.
    expect(tokenize('A1#REF!').map((x) => x.type)).toEqual(['ref', 'error']);
  });
});

describe('spill references in files', () => {
  it('converts A1# to ANCHORARRAY and back', () => {
    expect(spillRefsToFile('SUM(A1#)+Sheet2!B3#')).toBe('SUM(_xlfn.ANCHORARRAY(A1))+_xlfn.ANCHORARRAY(Sheet2!B3)');
    expect(spillRefsToFile('SUM(A1:A3)')).toBe('SUM(A1:A3)');
    expect(spillRefsFromFile('SUM(_xlfn.ANCHORARRAY(A1))+ANCHORARRAY( Sheet2!B3 )')).toBe('SUM(A1#)+Sheet2!B3#');
  });
});

describe('Excel _xlfn prefixes', () => {
  it('adds prefixes to newer functions on the way out and strips them on the way in', () => {
    expect(toFileFormula('XLOOKUP(A1,B:B,C:C)+SUM(A1:A3)')).toBe('_xlfn.XLOOKUP(A1,B:B,C:C)+SUM(A1:A3)');
    expect(toFileFormula('SORT(FILTER(A1:B9,B1:B9>0))')).toBe('_xlfn._xlws.SORT(_xlfn._xlws.FILTER(A1:B9,B1:B9>0))');
    expect(toFileFormula('IFS(A1>0,"y",TRUE,"n")&CONCAT(B1#)')).toBe('_xlfn.IFS(A1>0,"y",TRUE,"n")&_xlfn.CONCAT(_xlfn.ANCHORARRAY(B1))');
    // A named range that happens to share a function's name is not a call.
    expect(toFileFormula('SUM(DAYS)')).toBe('SUM(DAYS)');
    expect(toFileFormula('IF(A1,1,2)')).toBe('IF(A1,1,2)');
    expect(fromFileFormula('_xlfn._xlws.SORT(_xlfn.UNIQUE(A1:A9))')).toBe('SORT(UNIQUE(A1:A9))');
    expect(fromFileFormula('_xlfn.LAMBDA(_xlpm.x,_xlpm.x*2)(3)')).toBe('LAMBDA(x,x*2)(3)');
    expect(fromFileFormula('SUM(_xlfn.ANCHORARRAY(A1))')).toBe('SUM(A1#)');
    expect(XLFN.has('STDEV.S')).toBe(true);
    expect(XLFN.has('SUM')).toBe(false);
  });
});

describe('reference unions', () => {
  const cells = { A1: '1', A2: '2', A3: '3', C1: '10', C2: '20', C3: 'x', E5: '100' };
  it('feed every cell of every area to aggregate functions', () => {
    expect(calc('SUM((A1:A3,C1:C3))', cells)).toBe(36);
    expect(calc('SUM((A1:A3,C1:C3,E5))', cells)).toBe(136);
    expect(calc('COUNT((A1:A3,C1:C3))', cells)).toBe(5);
    expect(calc('COUNTA((A1:A3,C1:C3))', cells)).toBe(6);
    expect(calc('MAX((A1:A3,C1:C2))', cells)).toBe(20);
    expect(calc('AVERAGE((A1:A2,C1))', cells)).toBe(13 / 3);
    expect(calc('COUNTIF((A1:A3,C1:C3),">2")', cells)).toBe(3);
    expect(calc('SUM((A1:A3,(C1:C2,E5)))', cells)).toBe(136); // nested unions flatten
  });

  it('report their areas and pick one with INDEX, and refuse non-references', () => {
    expect(calc('AREAS((A1:A3,C1:C3,E5))', cells)).toBe(3);
    expect(calc('AREAS(A1:A3)', cells)).toBe(1);
    expect(calc('INDEX((A1:A3,C1:C3),2,1,2)', cells)).toBe(20);
    expect(calc('INDEX((A1:A3,C1:C3),2)', cells)).toBe(2);
    expect(calc('INDEX((A1:A3,C1:C3),1,1,3)', cells)).toEqual({ error: '#REF!' });
    expect(calc('SUM((A1:A3,1+1))', cells)).toEqual({ error: '#VALUE!' });
    expect(calc('SUM((A1:A3,Missing!A1))', cells)).toEqual({ error: '#REF!' });
  });
});

describe('3D references', () => {
  function book() {
    const wb = new Workbook({ sheets: [{ name: 'Jan' }, { name: 'Feb' }, { name: 'Mar' }, { name: 'Summary' }] });
    const [jan, feb, mar, sum] = wb.sheets;
    wb.setInput(jan.id, 0, 0, '10'); wb.setInput(feb.id, 0, 0, '20'); wb.setInput(mar.id, 0, 0, '30');
    wb.setInput(jan.id, 1, 0, '1'); wb.setInput(feb.id, 1, 0, '2'); wb.setInput(mar.id, 1, 0, 'x');
    wb.setSheetHidden(feb.id, true);
    return { wb, jan, feb, mar, sum };
  }
  const at = (wb, sheet, r, c) => wb.getValue(sheet.id, r, c);

  it('read the same cells on every sheet of the span, hidden ones included, either way round', () => {
    const { wb, sum } = book();
    wb.setInput(sum.id, 0, 0, '=SUM(Jan:Mar!A1)');
    wb.setInput(sum.id, 1, 0, '=SUM(Mar:Jan!A1:A2)');
    wb.setInput(sum.id, 2, 0, '=COUNT(Jan:Mar!A1:A2)');
    wb.setInput(sum.id, 3, 0, '=AVERAGE(Jan:Feb!A1)');
    wb.setInput(sum.id, 4, 0, '=AREAS(Jan:Mar!A1)');
    wb.setInput(sum.id, 5, 0, "=MAX('Jan':'Mar'!A1)");
    wb.setInput(sum.id, 6, 0, '=SUM(Jan:Nope!A1)');
    expect(at(wb, sum, 0, 0)).toBe(60);
    expect(at(wb, sum, 1, 0)).toBe(63);
    expect(at(wb, sum, 2, 0)).toBe(5);
    expect(at(wb, sum, 3, 0)).toBe(15);
    expect(at(wb, sum, 4, 0)).toBe(3);
    expect(at(wb, sum, 5, 0)).toBe(30);
    expect(at(wb, sum, 6, 0)).toEqual({ error: '#REF!' });
    // Live: a change on a middle sheet flows through.
    wb.setInput(wb.sheets[1].id, 0, 0, '200');
    expect(at(wb, sum, 0, 0)).toBe(240);
    // A lone 3D reference spills one value per sheet.
    wb.setInput(sum.id, 0, 2, '=Jan:Mar!A1');
    expect(wb.spillRangeAt(sum.id, 0, 2)).toEqual({ r1: 0, c1: 2, r2: 2, c2: 2 });
    expect(at(wb, sum, 1, 2)).toBe(200);
  });

  it('follow renamed sheets and rows inserted on any sheet in the span', () => {
    const { wb, feb, sum } = book();
    wb.setInput(sum.id, 0, 0, '=SUM(Jan:Mar!A2)');
    expect(at(wb, sum, 0, 0)).toBe(3);
    wb.renameSheet(feb.id, 'February');
    expect(wb.getCell(sum.id, 0, 0).f).toBe('SUM(Jan:Mar!A2)');
    wb.renameSheet(wb.sheets[2].id, 'Q1 End');
    expect(wb.getCell(sum.id, 0, 0).f).toBe("SUM('Jan:Q1 End'!A2)");
    expect(at(wb, sum, 0, 0)).toBe(3);
    wb.insertRows(feb.id, 0, 1); // a middle sheet: the span's rows move
    expect(wb.getCell(sum.id, 0, 0).f).toBe("SUM('Jan:Q1 End'!A3)");
    wb.insertRows(sum.id, 0, 1); // the summary sheet itself is outside the span
    expect(wb.getCell(sum.id, 1, 0).f).toBe("SUM('Jan:Q1 End'!A3)");
  });

  it('are written back as typed', () => {
    const { wb, sum } = book();
    wb.setInput(sum.id, 0, 0, "=SUM('Jan':Mar!$A$1:B2)+Feb!A1");
    expect(wb.getCell(sum.id, 0, 0).f).toBe("SUM('Jan':Mar!$A$1:B2)+Feb!A1");
    expect(at(wb, sum, 0, 0)).toBe(83); // 11 + 22 + 30 across the span, plus Feb!A1
  });
});
