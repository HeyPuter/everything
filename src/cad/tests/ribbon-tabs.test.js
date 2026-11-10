// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { buildRegistry } from '../src/editor/commands/index.js';
import { DEFAULT_SETTINGS } from '../src/editor/editor.js';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

async function ribbon() {
  const { Ribbon } = await import('../src/ui/ribbon.js');
  const app = { commands: buildRegistry(), settings: { ...DEFAULT_SETTINGS }, themePref: 'system', doc: null, run() {} };
  const rb = new Ribbon(app);
  document.body.append(rb.el);
  return rb;
}
const tab = (rb, id) => rb.tablist.querySelector(`#rbtab-${id}`);

describe('ribbon tabs', () => {
  it('keep keyboard focus when one is activated', async () => {
    const rb = await ribbon();
    tab(rb, 'insert').focus();
    tab(rb, 'insert').click();
    expect(rb.active).toBe('insert');
    expect(document.activeElement).toBe(tab(rb, 'insert'));
    rb.el.remove();
  });

  it('keep keyboard focus when a tab opens the minimized ribbon', async () => {
    const rb = await ribbon();
    rb.setCollapsed(true);
    tab(rb, 'annotate').focus();
    tab(rb, 'annotate').click();
    expect(rb.flyoutOpen).toBe(true);
    expect(document.activeElement).toBe(tab(rb, 'annotate'));
    rb.el.remove();
  });

  it('do not take focus that is elsewhere', async () => {
    const rb = await ribbon();
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    rb.select('view');
    expect(document.activeElement).toBe(other);
    other.remove();
    rb.el.remove();
  });
});

describe('ribbon in a short window', () => {
  /** A stand-in for matchMedia whose answer the test changes, as turning a phone does. */
  function shortWindow(matches) {
    const mq = { matches, listeners: [], addEventListener: (type, fn) => mq.listeners.push(fn) };
    vi.stubGlobal('matchMedia', () => mq);
    const turn = (to) => {
      mq.matches = to;
      for (const fn of mq.listeners) fn();
    };
    return turn;
  }

  it('is minimized while the window is short and expands again when it is tall', async () => {
    const turn = shortWindow(true);
    const rb = await ribbon();
    expect(rb.collapsed).toBe(true);
    turn(false);
    expect(rb.collapsed).toBe(false);
    turn(true);
    expect(rb.collapsed).toBe(true);
    rb.el.remove();
    vi.unstubAllGlobals();
  });

  it('leaves the ribbon as the user set it', async () => {
    const turn = shortWindow(true);
    const rb = await ribbon();
    // Expanded by hand on the short window: stays expanded.
    rb.collapseBtn.click();
    expect(rb.collapsed).toBe(false);
    turn(false);
    expect(rb.collapsed).toBe(false);
    // Minimized by hand on the tall window: stays minimized after a short spell.
    rb.collapseBtn.click();
    turn(true);
    turn(false);
    expect(rb.collapsed).toBe(true);
    rb.el.remove();
    vi.unstubAllGlobals();
  });
});

