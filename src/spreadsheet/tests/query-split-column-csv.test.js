import { expect, it } from 'vitest';
import { applyStep, stepFormula } from '../src/core/queries.js';

// Split Column by Delimiter said Splitter.SplitTextByDelimiter(",", QuoteStyle.Csv) in its formula but cut inside
// quotes ("Smith, John",NY gave "Smith | John",NY) and joined the parts past the columns asked for into the last one
// (a,b,c into two columns gave a | b,c). Power Query keeps a quoted part whole and drops the extra parts.
const table = { columns: ['s', 'n'], types: ['text', 'int'], rows: [['"Smith, John",NY', 1], ['a,b,c', 2], ['solo', 3], [null, 4], ['"say ""hi""",x', 5]] };

it('keeps quoted parts whole and drops parts past the column count', () => {
  const step = { type: 'splitColumn', column: 's', delimiter: ',', mode: 'each', count: 2 };
  expect(stepFormula({ source: { kind: 'blank' }, steps: [step] }, 1)).toContain('QuoteStyle.Csv');
  const out = applyStep(table, step, {});
  expect(out.columns).toEqual(['s.1', 's.2', 'n']);
  expect(out.rows).toEqual([['Smith, John', 'NY', 1], ['a', 'b', 2], ['solo', null, 3], [null, null, 4], ['say "hi"', 'x', 5]]);
});

it('splits into as many columns as the longest row needs when no count is given', () => {
  const out = applyStep(table, { type: 'splitColumn', column: 's', delimiter: ',', mode: 'each' }, {});
  expect(out.columns).toEqual(['s.1', 's.2', 's.3', 'n']);
  expect(out.rows[1]).toEqual(['a', 'b', 'c', 2]);
});
