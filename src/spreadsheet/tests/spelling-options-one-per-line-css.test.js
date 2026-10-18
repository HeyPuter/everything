import { expect, it } from 'vitest';
import { stylesheet, declared, rulesFor } from './helpers/css.js';

// Spelling ▸ Options: Chrome lays out a <details> as a block whatever display it is given, so the flex column
// set on the open Options left its checkboxes running on in one line, a box sitting between two labels
// ("Ignore words in UPPERCASE ☑ Ignore words with numbers"). Each option is now a line of its own.
it('puts each spelling option on a line of its own', () => {
  const css = stylesheet('components.css');
  expect(rulesFor(css, '.spell-options[open]')).toEqual([]);
  expect(declared(css, '.spell-options > label.check').display).toBe('flex');
  expect(declared(css, '.spell-options > .btn').display).toBe('flex');
});
