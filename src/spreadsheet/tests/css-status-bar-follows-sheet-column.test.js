import { expect, it } from 'vitest';
import { stylesheet, declared, rulesFor, parseRules } from './helpers/css.js';

// On a 768px tablet the assistant opens beside the sheet and leaves its column about 390px wide, but the status
// bar laid itself out by the window's width: it kept the view buttons and the selection's statistics, and the
// zoom slider, the + button and the percentage were cut off past the column's edge. The bar now follows the
// width of the sheet's column, as it does on a phone of that width.
it('makes the sheet\'s column a size container', () => {
  expect(declared(stylesheet('aipanel.css'), '.editor-main', false).container).toBe('sheet-column / inline-size');
});

it('drops the status bar\'s extras by the column\'s width, not the window\'s', () => {
  const editor = stylesheet('editor.css');
  expect(declared(editor, '.status-extra', '@container sheet-column (max-width: 900px)').display).toBe('none');
  expect(declared(editor, '.status-right', '@container sheet-column (max-width: 640px)').display).toBe('none');
  expect(declared(editor, '.status-views', '@container sheet-column (max-width: 640px)').display).toBe('none');
  expect(declared(editor, '.status-mode', '@container sheet-column (max-width: 640px)').display).toBe('none');
  expect(declared(stylesheet('ribbon.css'), '.status-right-wrap', '@container sheet-column (max-width: 640px)').flex).toBe('none');
  // No rule left that hides them by the window's width alone.
  for (const [file, selectors] of [['editor.css', ['.status-extra', '.status-right', '.status-views', '.status-mode']], ['ribbon.css', ['.status-right-wrap']]]) {
    for (const selector of selectors) {
      expect(rulesFor(stylesheet(file), selector, '@media').filter((r) => /max-width: (640|900)px/.test(r.media.join(' '))), `${file} ${selector}`).toEqual([]);
    }
  }
  expect(parseRules(editor).some((r) => r.media.some((m) => m.startsWith('@container sheet-column')))).toBe(true);
});
