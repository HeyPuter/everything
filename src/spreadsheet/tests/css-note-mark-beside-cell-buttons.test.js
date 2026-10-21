import { expect, it } from 'vitest';
import { stylesheet, declared } from './helpers/css.js';

// A note's corner mark and a comment's are drawn as the cell's ::after, which a filter button and a chip
// dropdown's chevron also take: a filter header or a dropdown cell holding a note or a comment showed no
// mark at all, so nothing told that it was there. In those cells the mark is a background layer in the
// same corner, in the colour of its kind.
it('marks a note or a comment in a filter header or a dropdown cell with a corner of its own', () => {
  const css = stylesheet('grid.css');
  for (const cell of ['.cell.filter-head', '.cell.list-inline']) {
    for (const mark of ['.has-note', '.has-comment']) {
      const d = declared(css, `${cell}${mark}`, false);
      expect(d['background-image'], `${cell}${mark}`).toMatch(/linear-gradient\(to bottom left, var\(--corner-mark\) 50%, transparent 50%\)/);
      expect(d['background-position']).toBe('top right');
      expect(d['background-repeat']).toBe('no-repeat');
    }
  }
  // The colour is the one each kind's own mark is drawn in.
  expect(declared(css, '.cell.has-note', false)['--corner-mark']).toBe('var(--warn)');
  expect(declared(css, '.cell.has-comment', false)['--corner-mark']).toBe('var(--comment-mark)');
  expect(declared(css, '.cell.has-comment.comment-done', false)['--corner-mark']).toBe('var(--comment-mark-done)');
  // The ordinary marks themselves are unchanged.
  expect(declared(css, '.cell.has-note::after', false)['border-color']).toBe('transparent var(--warn) transparent transparent');
});
