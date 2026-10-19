import { expect, it } from 'vitest';
import { stylesheet, parseRules, declarations } from './helpers/css.js';

// A reply's wide table scrolls in its frame, its cells whole: the reply's text breaks anywhere (a long name or address
// must not widen the panel), and the cells took that from it, so a table of nine months squeezed into the panel one
// or two characters a line ("1, / 23 / 4, / 56 / 7"), and the frame never scrolled.
it('keeps the words and numbers of a reply’s table whole, for its frame to scroll', () => {
  const rules = parseRules(stylesheet('aipanel.css'));
  const wrap = (selector) => rules.filter((r) => r.media.length === 0 && r.selectors.includes(selector))
    .map((r) => declarations(r.body)['overflow-wrap']).filter(Boolean).at(-1);
  expect(wrap('.md')).toBe('anywhere');
  expect(wrap('.md .md-table td')).toBe('normal');
  expect(wrap('.md .md-table th')).toBe('normal');
  const frame = rules.find((r) => r.selectors.includes('.md .md-table-wrap'));
  expect(declarations(frame.body)['overflow-x']).toBe('auto');
});
