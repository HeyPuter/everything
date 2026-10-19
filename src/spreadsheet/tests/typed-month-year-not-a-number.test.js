import { describe, expect, it } from 'vitest';
import { detectType, parseTyped } from '../src/core/queries.js';
import { typedNumber } from '../src/ui/typed-number.js';

// A month and year ("Feb 2024", "3/2024") or an elapsed time ("25:30") reads as a date or a time with a custom
// format of its own (mmm-yy, [h]:mm:ss), and the readers that take numbers only looked for the named date and
// time formats: a Power Query column of months was typed as decimal numbers (Feb 2024 became 45323), and a
// Solver or forecast field took "Feb 2024" as that serial. Such text is now a date or time to them, as a plain
// date already was; a typed fraction (1 1/2) is still a number.
describe('text that reads as a month and year or a duration', () => {
  it('is not a number column in a query', () => {
    expect(detectType(['Feb 2024', 'Mar 2024'])).not.toBe('decimal');
    expect(detectType(['3/2024', '4/2024'])).not.toBe('int');
    expect(detectType(['25:30', '26:00'])).not.toBe('decimal');
    expect(detectType(['1 1/2', '2 1/4'])).toBe('decimal');
    expect(parseTyped('Feb 2024', 'decimal')).toBe('Feb 2024');
  });

  it('is not a number in a what-if field', () => {
    expect(typedNumber('Feb 2024')).toBeNull();
    expect(typedNumber('3/2024')).toBeNull();
    expect(typedNumber('25:30')).toBeNull();
    expect(typedNumber('1 1/2')).toBe(1.5);
    expect(typedNumber('12%')).toBe(0.12);
  });
});
