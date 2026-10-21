// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderKeys } from '../src/ui/shortcuts.js';
import { stylesheet, declared } from './helpers/css.js';

const views = stylesheet('views.css');

// In the Keyboard shortcuts list each key, "+" and "/" was an item of its own in a wrapping row, and the key column
// shrank before the description did: on a phone 28 chords broke across lines ("⌘ + Shift +" over "U", "Shift +"
// over "F6"), and even on a tablet or desktop "F6 / Shift + F6" ended a line with "Shift +". The keys pressed
// together are now one unbroken chord, the line breaks only between alternatives, and the description wraps first.
describe('the keys of a shortcut', () => {
  it('keep each chord together, breaking only between the alternatives', () => {
    const nodes = renderKeys('F6 / Shift + F6');
    expect(nodes.map((n) => [n.className, n.textContent])).toEqual([['shortcut-chord', 'F6'], ['shortcut-join', '/'], ['shortcut-chord', 'Shift+F6']]);
    const search = renderKeys('⌘ + Shift + P or Alt + /');
    expect(search.map((n) => n.textContent)).toEqual(['⌘+Shift+P', 'or', 'Alt+/']);
    expect(search[0].querySelectorAll('.kbd')).toHaveLength(3);
    expect(declared(views, '.shortcut-chord')['white-space']).toBe('nowrap');
  });

  it('leave the description to wrap before the keys do', () => {
    const keys = declared(views, '.shortcut-keys');
    expect(keys.flex).toBe('0 0 auto');
    expect(keys['max-width']).toBe('52%');
    expect(keys['flex-wrap']).toBe('wrap');
  });
});
