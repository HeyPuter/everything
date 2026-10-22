import { expect, it } from 'vitest';
import { xlsxAttr } from '../src/core/xlsx-styles.js';

// Saving reads attributes off every cell's tag of the sheet's XML (its address and style), and opening a file reads
// them off every record; each read made its pattern afresh, a fifth of the time of saving a sheet of 200,000 cells
// (1,000 -> 560 ms to save it, 950 -> 600 ms to open it again). Each attribute's pattern is now made once.
it('reads attributes with one pattern per attribute name, and reads them as before', () => {
  const Real = globalThis.RegExp;
  let made = 0;
  globalThis.RegExp = new Proxy(Real, { construct(target, args) { made++; return new target(...args); } });
  try {
    for (let i = 0; i < 1000; i++) {
      expect(xlsxAttr(`<c r="A${i + 1}" s="3" t="s">`, 'r')).toBe(`A${i + 1}`);
      expect(xlsxAttr(`<c r="A${i + 1}" s="3" t="s">`, 's')).toBe('3');
    }
  } finally { globalThis.RegExp = Real; }
  expect(made).toBeLessThanOrEqual(2);
  expect(xlsxAttr('<c r="B2" t="inlineStr">', 's')).toBeUndefined();
  expect(xlsxAttr('<a text="Tom &amp; Jerry">', 'text')).toBe('Tom & Jerry');
});
