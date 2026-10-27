import { it, expect } from 'vitest';
import { checkAccessibility } from '../src/lib/accessibility.js';

// The accessibility check runs a moment after each pause in typing. Its table rules looked through
// every paragraph for each row, which took over a second in a document with long tables.
let n = 0;
const para = (text, cellId) => ({ id: `p${n++}`, runs: [{ text }], format: {}, ...(cellId ? { cellId } : {}) });
function document(rows) {
  n = 0;
  const paragraphs = [para('Intro')], tables = [];
  for (let t = 0; t < 3; t++) {
    const table = { rows: [] };
    for (let r = 0; r < rows; r++) {
      const cells = [];
      for (let c = 0; c < 4; c++) {
        const id = `t${t}r${r}c${c}`;
        cells.push({ id });
        paragraphs.push(para(r % 7 === 3 ? '' : `cell ${r} ${c}`, id));
        if (c === 2 && r % 11 === 0) paragraphs.push(para('', id));
      }
      table.rows.push({ cells, ...(t === 1 && r === 0 ? { header: true } : {}) });
    }
    tables.push(table);
    paragraphs.push(para('Between   tables'));
  }
  // A table nested in a cell of the first table's second row.
  const nested = { rows: [{ cells: [{ id: 'n0' }, { id: 'n1' }] }, { cells: [{ id: 'n2' }] }] };
  const at = paragraphs.findIndex(p => p.cellId === 't0r1c1');
  paragraphs.splice(at + 1, 0, para('', 'n0'), para('', 'n1'), para('nested', 'n2'));
  tables.push(nested);
  return { paragraphs, tables, pageSettings: {} };
}

// The table rules as they read the document before: each row's paragraphs in document order.
function referenceTableIssues({ paragraphs, tables }) {
  const issues = [], starts = [];
  let at = 0; for (const p of paragraphs) { starts.push(at); at += p.runs.reduce((s, r) => s + r.text.length, 0) + 1; }
  const tableOf = new Map(); for (const table of tables) for (const row of table.rows) for (const cell of row.cells) tableOf.set(cell.id, table);
  for (const table of tables) {
    const first = paragraphs.findIndex(p => p.cellId && tableOf.get(p.cellId) === table);
    if (first < 0) continue;
    if (!table.rows.some(row => row.header) && table.rows.length > 1) issues.push(['tableHeader', starts[first]]);
    for (const row of table.rows) {
      const ids = new Set(row.cells.map(c => c.id));
      const own = paragraphs.map((p, i) => [p, i]).filter(([p]) => ids.has(p.cellId));
      if (own.length && own.every(([p]) => !p.runs.map(r => r.text).join('').trim())) issues.push(['blankRows', starts[own[0][1]], own[0][0].cellId]);
    }
  }
  return issues.sort((a, b) => a[1] - b[1]);
}
const tableIssues = issues => issues.filter(i => ['tableHeader', 'blankRows'].includes(i.rule)).map(i => i.rule === 'blankRows' ? [i.rule, i.start, i.fix.cellId] : [i.rule, i.start]);

it('reports header and blank-row issues of long and nested tables as it did', () => {
  const doc = document(200);
  const found = tableIssues(checkAccessibility(doc));
  expect(found.filter(([rule]) => rule === 'blankRows').length).toBeGreaterThan(20);
  expect(found.filter(([rule]) => rule === 'tableHeader')).toHaveLength(3);
  expect(found).toEqual(referenceTableIssues(doc));
});

it('checks a document with long tables in time proportional to its length', () => {
  const doc = document(2000);
  const started = performance.now();
  const issues = checkAccessibility(doc);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(issues.filter(i => i.rule === 'blankRows').length).toBeGreaterThan(800);
});
