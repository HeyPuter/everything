// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openSymbolDialog, DEFAULT_RECENT } from '../src/views/insert-dialogs.js';
import { closeAllModals } from '../src/ui/modal.js';
import { el } from '../src/ui/dom.js';

describe('Symbol dialog keyboard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    localStorage.clear();
    document.body.replaceChildren(el('div', { id: 'app' }));
  });
  afterEach(() => {
    closeAllModals();
    vi.runAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const press = (node, key) => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  it('reaches the recently used symbols with Tab and moves along them with the arrows', async () => {
    const onInsert = vi.fn();
    const modal = openSymbolDialog({ onInsert });
    const cells = [...modal.panel.querySelectorAll('[aria-label="Recently used symbols"] button')];
    expect(cells.map(c => c.textContent)).toEqual(DEFAULT_RECENT);
    expect(cells.filter(c => c.tabIndex === 0)).toEqual([cells[0]]);
    cells[0].focus();
    press(cells[0], 'ArrowRight');
    expect(document.activeElement).toBe(cells[1]);
    expect(cells.filter(c => c.tabIndex === 0)).toEqual([cells[1]]);
    expect(modal.panel.querySelector('.insert-symbol-preview').textContent).toBe(DEFAULT_RECENT[1]);
    press(cells[1], 'End');
    expect(document.activeElement).toBe(cells.at(-1));
    modal.panel.querySelector('form').requestSubmit();
    await vi.runAllTimersAsync();
    expect(onInsert).toHaveBeenCalledWith(DEFAULT_RECENT.at(-1), null);
  });
});
