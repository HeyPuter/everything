// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';
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
