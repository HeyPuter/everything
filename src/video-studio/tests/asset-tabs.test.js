// Left panel category tabs: compact row, More menu only when they don't fit.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAssetsPanel, fitTabs, ASSET_TABS } from '../src/ui/panels/index.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { setPref } from '../src/ui/prefs.js';
import { closeMenus } from '../src/ui/menu.js';
import { fixture } from './helpers.js';

describe('fitTabs', () => {
  const w = [40, 40, 40, 40, 40];

  it('shows every tab when they fit', () => {
    expect(fitTabs(w, 200, 30)).toEqual([0, 1, 2, 3, 4]);
    expect(fitTabs(w, 208, 30, 0, 2)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps room for More when some do not fit', () => {
    // 150 px: 120 left after More, three tabs.
    expect(fitTabs(w, 150, 30)).toEqual([0, 1, 2]);
  });

  it('keeps the active tab in the row', () => {
    expect(fitTabs(w, 150, 30, 4)).toEqual([0, 1, 4]);
    // A wide active tab can push out more than one.
    expect(fitTabs([40, 40, 40, 40, 90], 150, 30, 4)).toEqual([4]);
  });
});

describe('assets panel tab row', () => {
  let panel;
  let ctx;

  beforeEach(() => {
    setPref('assetsTab', 'media');
    const store = new EditorStore(fixture());
    ctx = { store, player: null, library: { backend: { kind: 'memory' } }, media: { poster: () => Promise.resolve(null) } };
    ctx.actions = createActions(ctx);
    panel = createAssetsPanel(ctx);
    document.body.append(panel.el);
  });

  afterEach(() => {
    closeMenus();
    panel.dispose();
    panel.el.remove();
  });

  /** Fake layout: the row is rowW wide and each tab tabW (jsdom has no layout). */
  function layout(rowW, tabW = 40) {
    const bar = panel.el.querySelector('.asset-tabs-bar');
    Object.defineProperty(bar, 'clientWidth', { configurable: true, get: () => rowW });
    for (const b of panel.el.querySelectorAll('.asset-tabs .tab, .asset-tabs-more')) b.getBoundingClientRect = () => ({ width: tabW, height: 40 });
    panel.relayout();
  }
  const tabs = () => [...panel.el.querySelectorAll('.asset-tabs .tab')];
  const more = () => panel.el.querySelector('.asset-tabs-more');

  it('has every category as a tab with an icon over its label', () => {
    expect(tabs().map((t) => t.textContent)).toEqual(ASSET_TABS.map((t) => t.label));
    for (const t of tabs()) expect(t.querySelector('svg + .tab-label, .icon + .tab-label')).toBeTruthy();
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
  });

  it('shows all tabs and no More button when there is room', () => {
    layout(ASSET_TABS.length * 40);
    expect(tabs().every((t) => !t.hidden)).toBe(true);
    expect(more().hidden).toBe(true);
    expect(panel.el.querySelector('.asset-tabs-bar').classList.contains('is-tight')).toBe(false);
  });

  it('moves what does not fit into More, and a tab picked there joins the row', () => {
    layout(6 * 40);
    const hidden = tabs().filter((t) => t.hidden).map((t) => t.textContent);
    expect(hidden.length).toBe(ASSET_TABS.length - 5);
    expect(more().hidden).toBe(false);
    expect(more().getAttribute('aria-haspopup')).toBe('menu');
    more().click();
    const items = [...document.querySelectorAll('.menu [role^=menuitem]')];
    expect(items.map((i) => i.textContent)).toEqual(hidden);
    items.at(-1).click();
    const last = ASSET_TABS.at(-1);
    const btn = tabs().find((t) => t.textContent === last.label);
    expect(btn.hidden).toBe(false);
    expect(btn.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(btn);
  });

  it('arrow keys skip tabs that moved into More', () => {
    layout(4 * 40);
    const shown = tabs().filter((t) => !t.hidden);
    shown[0].focus();
    shown[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(shown.at(-1));
    expect(document.activeElement.hidden).toBe(false);
    // Roving tabindex: only the selected tab is in the tab order.
    expect(tabs().filter((t) => t.tabIndex === 0)).toHaveLength(1);
  });
});
