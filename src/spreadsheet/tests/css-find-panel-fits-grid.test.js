// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { stylesheet, declared, declarations, parseRules } from './helpers/css.js';

const editor = stylesheet('editor.css');
const chrome = stylesheet('chrome.css');

// The Find panel sat 24px in from the grid's right edge but was sized to the grid less 16px, so on a grid narrower
// than the panel (a tablet with the Assistant open) it ran 8px off the left edge, and with a task pane open
// (Selection, Accessibility, Language) it was pushed a pane's width further: 24px off on a tablet, and on a phone
// it shrank to an 18px sliver. Its width now leaves room for its own offset, and beside a pane it keeps at least
// 280px, over the pane, when the grid has no room for both.
// The rule for a grid with a task pane open (its :has() list holds commas, so it is found by its prelude).
const paneRule = () => declarations(parseRules(chrome).find((r) => r.selectors.join(',').includes('.selpane:not([hidden])') && r.selectors.at(-1).endsWith('> .find-panel')).body);

describe('the Find panel', () => {
  it('is sized to what its right offset leaves of the grid', () => {
    const panel = declared(editor, '.find-panel', false);
    expect(panel.right).toBe('var(--find-right, 24px)');
    expect(panel.width).toBe('min(440px, calc(100% - var(--find-right, 24px) - 8px))');
    expect(declared(editor, '.find-panel.find-expanded', false).width).toBe('min(640px, calc(100% - var(--find-right, 24px) - 8px))');
  });

  it('moves aside for a task pane only as far as leaves it 280px, and then sits above the pane', () => {
    const rule = paneRule();
    expect(rule.right).toBeUndefined(); // the offset goes through the variable, so a phone's full-width rule still wins
    expect(rule['--find-right']).toBe('min(calc(min(340px, 100% - 24px) + 24px), calc(100% - 288px))');
    const paneZ = Number(declared(chrome, '.a11y-pane')['z-index']);
    expect(Number(rule['z-index'])).toBeGreaterThan(paneZ);
  });
});
