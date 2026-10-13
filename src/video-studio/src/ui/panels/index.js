/**
 * Assets panel (top left): a row of category tabs (Media, Audio, Text,
 * Captions, Avatars, Graphics, Transitions, Effects, Filters, Color, Templates)
 * over a sidebar of sub-categories and a grid of items. The tabs are
 * compact (icon over a short label) so they all fit a default-width panel;
 * when the panel is narrower the ones that don't fit go into a More menu.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { tabs } from '../controls.js';
import { menuButton } from '../menu.js';
import { prefs, setPref } from '../prefs.js';
import { mediaTab } from './media.js';
import { audioTab } from './audio.js';
import { textTab } from './text.js';
import { stickersTab } from './stickers.js';
import { effectsTab } from './effects.js';
import { transitionsTab } from './transitions.js';
import { filtersTab } from './filters.js';
import { adjustTab } from './adjust.js';
import { captionsTab } from './captions.js';
import { templatesTab } from './templates.js';
import { avatarsTab } from './avatars.js';

export const ASSET_TABS = [
  { id: 'media', label: 'Media', icon: 'film', make: mediaTab },
  { id: 'audio', label: 'Audio', icon: 'music', make: audioTab },
  { id: 'text', label: 'Text', icon: 'text', make: textTab },
  { id: 'captions', label: 'Captions', icon: 'captions', make: captionsTab },
  { id: 'avatars', label: 'Avatars', icon: 'avatar', make: avatarsTab },
  { id: 'stickers', label: 'Graphics', icon: 'sticker', make: stickersTab },
  { id: 'transitions', label: 'Transitions', icon: 'transition', make: transitionsTab },
  { id: 'effects', label: 'Effects', icon: 'effects', make: effectsTab },
  { id: 'filters', label: 'Filters', icon: 'filters', make: filtersTab },
  { id: 'adjust', label: 'Color', icon: 'adjust', make: adjustTab },
  { id: 'templates', label: 'Templates', icon: 'template', make: templatesTab },
];

/**
 * Indexes of the tabs to show in a row avail px wide: as many as fit in
 * order, with room kept for the More button (moreW) when some don't. The
 * active tab always shows, taking the last place when it would not fit.
 */
export function fitTabs(widths, avail, moreW, active = 0, gap = 0) {
  const total = widths.reduce((a, w) => a + w, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= avail + 0.5) return widths.map((_, i) => i);
  const room = avail - moreW;
  const shown = [];
  let used = 0;
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i] + (shown.length ? gap : 0);
    if (used + w > room + 0.5) break;
    shown.push(i);
    used += w;
  }
  if (active >= 0 && !shown.includes(active)) {
    // Drop tabs from the end until the active one fits.
    while (shown.length && used + widths[active] + gap > room + 0.5) used -= widths[shown.pop()] + (shown.length ? gap : 0);
    shown.push(active);
  }
  return shown;
}

export function createAssetsPanel(ctx) {
  const made = new Map();
  let current = ASSET_TABS.some((t) => t.id === prefs().assetsTab) ? prefs().assetsTab : 'media';
  const body = h('div.assets-body', { role: 'tabpanel', id: 'assets-tabpanel', tabindex: '-1' });
  const bar = tabs({
    label: 'Asset categories',
    className: 'asset-tabs',
    items: ASSET_TABS.map((t) => ({ id: t.id, label: t.label, icon: t.icon, panel: 'assets-tabpanel' })),
    value: current,
    onChange: (id) => show(id),
  });
  const scroller = h('div.asset-tabs-wrap', bar.el);
  // Tabs that don't fit go into a More menu (the active tab always stays in the row).
  const more = h('button.tab.asset-tabs-more', { type: 'button', 'aria-label': 'More categories', hidden: true }, icon('more', 18), h('span.tab-label', 'More'));
  let overflow = [];
  menuButton(more, () => overflow.map((t) => ({ label: t.label, icon: t.icon, checked: t.id === current, onSelect: () => {
    show(t.id);
    bar.buttons.find((b) => b.id === `tab-${t.id}`)?.focus();
  } })), { label: 'More categories', align: 'end' });
  const tabsBar = h('div.asset-tabs-bar', scroller, more);
  const el = h('section.panel.assets-panel', { 'aria-label': 'Media and assets' }, tabsBar, body);

  /**
   * Show every tab at their natural width when they fit; else tighter
   * (smaller label, less padding); else as many as fit and a More menu.
   */
  function fit() {
    const outer = getComputedStyle(tabsBar);
    const avail = tabsBar.clientWidth - (parseFloat(outer.paddingLeft) || 0) - (parseFloat(outer.paddingRight) || 0);
    if (avail <= 0) return;
    tabsBar.classList.add('is-measuring');
    bar.buttons.forEach((b) => (b.hidden = false));
    more.hidden = false;
    const list = getComputedStyle(bar.el);
    const gap = parseFloat(list.columnGap) || 0;
    const pad = (parseFloat(list.paddingLeft) || 0) + (parseFloat(list.paddingRight) || 0);
    const measure = (tight) => {
      tabsBar.classList.toggle('is-tight', tight);
      return bar.buttons.map((b) => b.getBoundingClientRect().width);
    };
    let widths = measure(false);
    const need = widths.reduce((a, w) => a + w, 0) + gap * (widths.length - 1);
    if (need > avail - pad + 0.5) widths = measure(true);
    const moreW = more.getBoundingClientRect().width;
    tabsBar.classList.remove('is-measuring');
    const shown = fitTabs(widths, avail - pad, moreW + gap, ASSET_TABS.findIndex((t) => t.id === current), gap);
    bar.buttons.forEach((b, i) => (b.hidden = !shown.includes(i)));
    overflow = ASSET_TABS.filter((_, i) => !shown.includes(i));
    more.hidden = !overflow.length;
    tabsBar.classList.toggle('has-more', overflow.length > 0);
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => fit()).observe(tabsBar);
  // Label widths change once the UI font has loaded.
  document.fonts?.ready?.then(() => fit());

  function show(id) {
    current = id;
    setPref('assetsTab', id);
    bar.select(id);
    let tab = made.get(id);
    if (!tab) {
      const def = ASSET_TABS.find((t) => t.id === id);
      tab = def.make(ctx);
      made.set(id, tab);
    }
    body.replaceChildren(tab.el);
    // A tab picked from More takes a place in the row.
    if (bar.buttons.find((b) => b.id === `tab-${id}`)?.hidden) fit();
    body.setAttribute('aria-labelledby', `tab-${id}`);
    tab.shown?.();
  }
  show(current);

  return {
    el,
    show,
    /** Re-fit the tab row (the panel was resized). */
    relayout: fit,
    openImport() {
      show('media');
      made.get('media')?.openImport?.();
    },
    dispose() {
      for (const t of made.values()) t.dispose?.();
    },
  };
}
