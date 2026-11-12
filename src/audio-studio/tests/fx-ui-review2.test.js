import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = (name) => readFileSync(resolve(__dirname, `../src/styles/${name}`), 'utf8');

describe('effect dialog band tables', () => {
  it('keep each column as wide as its values and scroll on narrow screens', () => {
    const rule = css('effects.css').match(/\n\.fx-table \{[^}]*\}/)?.[0] || '';
    // Columns that could shrink to nothing drew neighbouring values over each other on phones.
    expect(rule).toMatch(
      /grid-template-columns: max-content repeat\(var\(--cols\), minmax\(max-content, 1fr\)\);/,
    );
    expect(rule).toMatch(/overflow-x: auto;/);
  });
});
