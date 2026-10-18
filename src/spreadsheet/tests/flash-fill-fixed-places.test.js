import { expect, it } from 'vitest';
import { flashFill } from '../src/core/flashfill.js';

// A word with no break inside it (5551234567, 20240315) offered Flash Fill only its first character, so the rest of
// the example was copied as fixed text: (555) 123-4567 taught from 5551234567 filled (555) 123-4567 into every row,
// whatever number was beside it. Characters at a fixed place inside a word are now pieces too.
it.each([
  [['5551234567', '5559876543'], '(555) 123-4567', '(555) 987-6543'],
  [['20240315', '20231201'], '2024-03-15', '2023-12-01'],
  [['98052-6399', '10001-1234'], '98052', '10001'],
  [['John Smith', 'Mary Watson'], 'Smi', 'Wat'],
  [['john smith', 'mary watson'], 'JOH', 'MAR'],
])('learns %j → %s and fills %s', ([first, second], example, expected) => {
  expect(flashFill([{ sources: [first], target: example }, { sources: [second], target: null }])).toEqual([undefined, expected]);
});

it('still prefers whole words to the same letters at a fixed place', () => {
  expect(flashFill([{ sources: ['Mary Jane Watson'], target: 'Mary Jane' }, { sources: ['Ann Lee Ray'], target: null }])).toEqual([undefined, 'Ann Lee']);
  expect(flashFill([{ sources: ['John Smith'], target: 'Smith, John' }, { sources: ['Bo Ek'], target: null }])).toEqual([undefined, 'Ek, Bo']);
});

it('learns quickly from long text', () => {
  const source = 'a'.repeat(3000);
  const started = performance.now();
  flashFill([{ sources: [source], target: 'aa-'.repeat(1000) }, { sources: [source], target: null }]);
  expect(performance.now() - started).toBeLessThan(1000);
});
