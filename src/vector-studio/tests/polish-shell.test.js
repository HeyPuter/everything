import { describe, it, expect, afterEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { groupStripPanels, stacksToFit, PANEL_GROUPS } from '../src/ui/dock.js';

/** Fake layout sizes on one element (jsdom has no layout). */
function fakeSize(el, sizes) {
  for (const [k, v] of Object.entries(sizes)) Object.defineProperty(el, k, { configurable: true, get: typeof v === 'function' ? v : () => v });
}

describe('collapsed panel strip groups', () => {
  it('groups panels by purpose, unknown panels last', () => {
    const groups = groupStripPanels(['qa', 'swatches', 'align', 'color', 'character']);
    expect(groups.map((g) => g.group.id)).toEqual(['paint', 'arrange', 'type', 'more']);
    expect(groups[0].ids).toEqual(['swatches', 'color']);
    expect(groups.at(-1).ids).toEqual(['qa']);
  });

  it('stacks the largest groups first until the strip fits', () => {
    const groups = groupStripPanels(PANEL_GROUPS.flatMap((g) => g.panels));
    expect(stacksToFit(groups, 0).size).toBe(0); // not laid out: nothing to fit
    expect(stacksToFit(groups, 5000).size).toBe(0);
    const some = stacksToFit(groups, 900);
    expect(some.size).toBeGreaterThan(0);
    expect(some.has('paint')).toBe(true); // the largest group goes first
    expect(stacksToFit(groups, 100).size).toBe(groups.filter((g) => g.ids.length > 1).length);
  });
});

describe('panel strip in the app', () => {
  it('renders groups, stacks them when short, and opens panels from a stack menu by keyboard', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    const strip = document.querySelector('.panel-strip');
    expect(strip.querySelectorAll('.strip-group').length).toBeGreaterThan(3);
    expect(strip.querySelector('.strip-group[aria-label]')?.getAttribute('role')).toBe('group');
    // Exactly one tab stop.
    expect(strip.querySelectorAll('.strip-btn[tabindex="0"]').length).toBe(1);

    fakeSize(strip, { clientHeight: 400 });
    app.dock.fitStrip();
    const stacks = [...strip.querySelectorAll('.strip-stack')];
    expect(stacks.length).toBeGreaterThan(0);
    expect(strip.querySelectorAll('.strip-btn[tabindex="0"]').length).toBe(1);

    const paint = strip.querySelector('.strip-stack[data-group="paint"]');
    expect(paint.getAttribute('aria-haspopup')).toBe('menu');
    paint.click();
    const menu = document.querySelector('.strip-stack-menu[role="menu"]');
    expect(menu).not.toBeNull();
    expect(paint.getAttribute('aria-expanded')).toBe('true');
    const items = [...menu.querySelectorAll('[role="menuitemcheckbox"]')];
    expect(items.map((i) => i.dataset.panel)).toContain('swatches');
    expect(document.activeElement).toBe(items[0]);
    items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    items[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.strip-stack-menu')).toBeNull();
    expect(document.activeElement).toBe(paint);

    paint.click();
    document.querySelector('.strip-stack-menu [data-panel="swatches"]').click();
    expect(app.dock.flyoutId).toBe('swatches');
    expect(paint.classList.contains('active')).toBe(true);
    // Closing the flyout returns focus to the stack that holds the panel.
    app.dock.closeFlyout(true);
    expect(document.activeElement).toBe(paint);
    expect(paint.classList.contains('active')).toBe(false);

    // Arrow keys move between stacks and single buttons.
    paint.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).not.toBe(paint);
    expect(document.activeElement.classList.contains('strip-btn')).toBe(true);

    // Room again: every panel has its own button.
    fakeSize(strip, { clientHeight: 5000 });
    app.dock.fitStrip();
    expect(strip.querySelectorAll('.strip-stack').length).toBe(0);
    expect(strip.querySelector('.strip-btn[data-panel="swatches"]')).not.toBeNull();
  });

  it('keeps workspaces working with groups', async () => {
    const app = await bootAppWithFeatures();
    app.dock.setLayout({ dock: ['properties', 'layers'], strip: ['align', 'color', 'swatches'] });
    expect(app.dock.getLayout().strip).toEqual(['align', 'color', 'swatches']);
    const ids = [...document.querySelectorAll('.panel-strip .strip-btn')].map((b) => b.dataset.panel);
    expect(ids).toEqual(['color', 'swatches', 'align']);
  });
});

describe('tools panel fit', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('uses one column when the tools fit, then two, then compact, then three columns', async () => {
    const app = await bootAppWithFeatures();
    const el = app.toolbar.el;
    const scroller = el.querySelector('.toolbar-scroll');
    // Needed height shrinks with columns and compact mode, like the real layout.
    const need = () => {
      const cols = el.classList.contains('three-col') ? 3 : el.classList.contains('two-col') ? 2 : 1;
      return Math.ceil(1100 / cols) - (el.classList.contains('compact') ? 120 : 0);
    };
    let room = 1200;
    fakeSize(scroller, { scrollHeight: need, clientHeight: () => room });
    app.toolbar.refit();
    expect(el.className).not.toMatch(/two-col|three-col|compact/);
    room = 600;
    app.toolbar.refit();
    expect(el.classList.contains('two-col')).toBe(true);
    expect(el.classList.contains('compact')).toBe(false);
    expect(app.root.classList.contains('tools-two-col')).toBe(true);
    room = 440;
    app.toolbar.refit();
    expect([...el.classList]).toEqual(expect.arrayContaining(['two-col', 'compact']));
    room = 300;
    app.toolbar.refit();
    expect([...el.classList]).toEqual(expect.arrayContaining(['three-col', 'compact']));
    expect(app.root.classList.contains('tools-three-col')).toBe(true);
    expect(el.classList.contains('overflowing')).toBe(false);
    room = 100;
    app.toolbar.refit();
    expect(el.classList.contains('overflowing')).toBe(true);

    // A fixed single column stays single and goes compact (then scrolls) when short.
    app.prefs.set('toolbarColumns', 1);
    room = 1000;
    app.toolbar.refit();
    expect([...el.classList]).toEqual(expect.arrayContaining(['compact']));
    expect(el.classList.contains('two-col')).toBe(false);
  });
});
