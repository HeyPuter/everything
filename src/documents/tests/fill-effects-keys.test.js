// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openFillEffects } from '../src/views/design-dialogs.js';
import { GRADIENT_STYLES } from '../src/views/page-fill-effects.js';
import { closeAllModals } from '../src/ui/modal.js';
import { el } from '../src/ui/dom.js';

describe('Fill Effects tiles', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    // jsdom draws nothing; the tiles and the sample only need a context-less canvas.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    document.body.replaceChildren(el('div', { id: 'app' }));
  });
  afterEach(() => {
    closeAllModals();
    vi.runAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const press = (node, key) => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  it('are one Tab stop per group, on the chosen tile, and the arrow keys choose another', async () => {
    const apply = vi.fn(() => true);
    openFillEffects({ page: { width: 12240, height: 15840 }, apply });
    for (const group of document.querySelectorAll('.design-tile-grid')) {
      const tiles = [...group.querySelectorAll('[role="radio"]')];
      expect(tiles.filter(tile => tile.tabIndex === 0)).toHaveLength(1);
    }
    const styles = [...document.querySelector('[role="radiogroup"][aria-label="Shading style"]').querySelectorAll('[role="radio"]')];
    const at = styles.findIndex(tile => tile.getAttribute('aria-checked') === 'true');
    styles[at].focus();
    press(styles[at], 'ArrowRight');
    expect(document.activeElement).toBe(styles[at + 1]);
    expect(styles[at + 1].getAttribute('aria-checked')).toBe('true');
    expect(styles.filter(tile => tile.tabIndex === 0)).toEqual([styles[at + 1]]);
    document.querySelector('form.design-dialog').requestSubmit();
    await vi.runAllTimersAsync();
    expect(apply.mock.calls[0][0].style).toBe(GRADIENT_STYLES[at + 1][0]);
  });
});
