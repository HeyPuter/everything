import { describe, it, expect } from 'vitest';
import { onePage, leaves } from './interop-helpers.js';
import { pdfToDocument } from '../src/features/interop/pdf/import.js';
import { parseFontName } from '../src/features/interop/pdf/fonts.js';
import { parseType1 } from '../src/features/interop/pdf/type1.js';
import { parseCFF } from '../src/features/interop/pdf/cff.js';
import { glyphNameToUnicode } from '../src/features/interop/pdf/encodings.js';

const FAMILIES = ['Inter', 'Roboto'];

/** Charstring number encoding (shared by Type 1 and Type 2 for small values). */
function num(v) {
  if (v >= -107 && v <= 107) return [v + 139];
  if (v >= 108 && v <= 1131) return [((v - 108) >> 8) + 247, (v - 108) & 255];
  if (v >= -1131 && v <= -108) return [((-v - 108) >> 8) + 251, (-v - 108) & 255];
  throw new Error('out of range');
}
const prog = (items) => items.flatMap((x) => (typeof x === 'number' ? num(x) : [x.op]));
const op = (o) => ({ op: o });

function encrypt(bytes, r, lead = 4) {
  const out = [];
  const plain = [...new Array(lead).fill(0), ...bytes];
  for (const p of plain) {
    const c = p ^ (r >> 8);
    out.push(c);
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
  return out;
}

/** A Type 1 font whose /A is a 600x700 box. */
function type1Font() {
  const A = prog([0, 600, op(13), 0, 0, op(21), 600, 0, op(5), 0, 700, op(5), -600, 0, op(5), op(9), op(14)]);
  const notdef = prog([0, 500, op(13), op(14)]);
  const encA = encrypt(A, 4330);
  const encN = encrypt(notdef, 4330);
  const latin = (arr) => String.fromCharCode(...arr);
  const priv = `dup /Private 8 dict dup begin /RD{string currentfile exch readstring pop}executeonly def /lenIV 4 def /Subrs 0 array\n2 index /CharStrings 2 dict dup begin\n/.notdef ${encN.length} RD ${latin(encN)} ND\n/A ${encA.length} RD ${latin(encA)} ND\nend end\nmark currentfile closefile\n`;
  const clear = '%!PS-AdobeFont-1.0: Qwerty 001\n/FontName /Qwerty def\n/FontMatrix [0.001 0 0 0.001 0 0] readonly def\n/Encoding StandardEncoding def\ncurrentfile eexec\n';
  const body = encrypt([...priv].map((c) => c.charCodeAt(0)), 55665);
  return { bytes: Uint8Array.from([...[...clear].map((c) => c.charCodeAt(0)), ...body]), length1: clear.length };
}

/** A bare CFF font (Type1C) whose /A is a 600x700 box. */
function cffFont() {
  const b = [];
  const index = (items) => {
    const out = [0, items.length];
    if (!items.length) return out;
    out.push(1);
    let off = 1;
    out.push(off);
    for (const it of items) {
      off += it.length;
      out.push(off);
    }
    for (const it of items) out.push(...it);
    return out;
  };
  const int5 = (v) => [29, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const glyphs = [[14], prog([0, 0, op(21), 600, 0, op(5), 0, 700, op(5), -600, 0, op(5), op(14)])];
  const header = [1, 0, 4, 1];
  const name = index([[...'Test'].map((c) => c.charCodeAt(0))]);
  // Top DICT with fixed-size operands so offsets can be filled in afterwards.
  const top = (cs, charset, priv) => [...int5(charset), 15, ...int5(cs), 17, ...int5(0), ...int5(priv), 18];
  const probe = index([top(0, 0, 0)]);
  const strings = index([]);
  const gsubrs = index([]);
  const charsetAt = header.length + name.length + probe.length + strings.length + gsubrs.length;
  const charset = [0, 0, 34];
  const csAt = charsetAt + charset.length;
  const cs = index(glyphs);
  const privAt = csAt + cs.length;
  b.push(...header, ...name, ...index([top(csAt, charsetAt, privAt)]), ...strings, ...gsubrs, ...charset, ...cs);
  return Uint8Array.from(b);
}

describe('embedded font programs', () => {
  it('parses Type 1 fonts (eexec, charstrings) into outlines', () => {
    const { bytes, length1 } = type1Font();
    const f = parseType1(bytes, { length1 });
    expect(f.encoding.get(65)).toBe('A');
    const path = f.glyphPath('A');
    expect(path[0]).toEqual(['M', 0, 0]);
    expect(path.filter((c) => c[0] === 'L')).toHaveLength(3);
    expect(path[path.length - 1]).toEqual(['Z']);
  });

  it('parses CFF fonts into outlines', () => {
    const f = parseCFF(cffFont());
    expect(f.nGlyphs).toBe(2);
    expect(f.nameToGid.get('A')).toBe(1);
    expect(f.encoding.get(65)).toBe(1);
    expect(f.glyphPath(1)).toEqual([['M', 0, 0], ['L', 600, 0], ['L', 600, 700], ['L', 0, 700], ['Z']]);
  });

  it('imports text in embedded Type 1 and CFF fonts as outlines', async () => {
    const t1 = type1Font();
    for (const [sub, file, data] of [['FontFile', '/Length1 ' + t1.length1, t1.bytes], ['FontFile3', '/Subtype /Type1C', cffFont()]]) {
      const doc = await pdfToDocument(
        onePage('BT /F0 10 Tf 0 0 Td (A) Tj ET', {
          resources: '<< /Font << /F0 5 0 R >> >>',
          extra: ['<< /Type /Font /Subtype /Type1 /BaseFont /Qwerty /FirstChar 65 /LastChar 65 /Widths [600] /FontDescriptor 6 0 R >>', `<< /Type /FontDescriptor /FontName /Qwerty /Flags 32 /${sub} 7 0 R >>`, { dict: `<< ${file} >>`, stream: data }],
        }),
        { families: FAMILIES },
      );
      const p = leaves(doc)[0];
      expect(p.type).toBe('path');
      const xs = p.anchors.map((a) => a.x);
      const ys = p.anchors.map((a) => a.y);
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(6);
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(7);
    }
  });
});

describe('font names', () => {
  it('splits families, weights and styles', () => {
    expect(parseFontName('ABCDEF+OpenSans-SemiBoldItalic')).toMatchObject({ family: 'Open Sans', weight: 600, style: 'italic' });
    expect(parseFontName('Arial,Bold')).toMatchObject({ family: 'Arial', weight: 700, standard: false });
    expect(parseFontName('Times-BoldItalic')).toMatchObject({ category: 'serif', weight: 700, style: 'italic', standard: true });
    expect(parseFontName('MinionPro-Regular')).toMatchObject({ family: 'Minion Pro', weight: 400, style: 'normal' });
  });

  it('maps glyph names to text', () => {
    expect(glyphNameToUnicode('A')).toBe('A');
    expect(glyphNameToUnicode('quoteright')).toBe('’');
    expect(glyphNameToUnicode('uni20AC')).toBe('€');
    expect(glyphNameToUnicode('f_f_i')).toBe('ffi');
    expect(glyphNameToUnicode('a.sc')).toBe('a');
    expect(glyphNameToUnicode('Euro')).toBe('€');
  });
});
