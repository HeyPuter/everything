import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

// A column of running totals, =SUM($A$1:A1) filled down, reads one range per row, each built from the one before
// and noted against it so that its total carries on. Every array then held the one it was built from, so the last
// held them all: 10,000 rows kept 600 MB of rows alive after the calculation, and 20,000 running totals (or a
// running COUNTIF, the usual first-occurrence check) ran a browser tab out of memory. Each array is now noted
// against the first of its family, and only the arrays the range cache keeps stay alive.
it('calculates 20,000 running totals and running counts within a small heap', () => {
  const script = `
    import assert from 'node:assert/strict';
    const { Workbook } = await import(${JSON.stringify(new URL('../src/core/workbook.js', import.meta.url).href)});
    const n = 20000;
    const wb = new Workbook(), id = wb.activeSheetId;
    for (let r = 0; r < n; r++) {
      wb.setInput(id, r, 0, String(r % 97));
      wb.setInput(id, r, 1, '=SUM($A$1:A' + (r + 1) + ')');
      wb.setInput(id, r, 2, '=COUNTIF($A$1:A' + (r + 1) + ',A' + (r + 1) + ')');
    }
    let total = 0;
    for (let r = 0; r < n; r++) {
      total += r % 97;
      assert.equal(wb.getValue(id, r, 1), total);
      assert.equal(wb.getValue(id, r, 2), Math.floor(r / 97) + 1);
    }
    console.log('settled');
  `;
  const result = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 110_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr.slice(-400)).toBe(0);
  expect(result.stdout.trim()).toBe('settled');
}, 120_000);
