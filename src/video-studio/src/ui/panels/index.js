/**
 * Assets panel (top left): a row of category tabs (Media, Audio, Text,
 * Captions, Avatars, Graphics, Transitions, Effects, Filters, Color) over a
 * sidebar of sub-categories and a grid of items.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { tabs } from '../controls.js';
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
  // When the panel is too narrow for every tab, arrows scroll the row.
  const leftBtn = h('button.asset-tabs-arrow.left', { type: 'button', tabindex: '-1', 'aria-hidden': 'true' }, icon('chevronLeft', 14));
  const rightBtn = h('button.asset-tabs-arrow.right', { type: 'button', tabindex: '-1', 'aria-hidden': 'true' }, icon('chevronRight', 14));
  leftBtn.addEventListener('click', () => scroller.scrollBy({ left: -160, behavior: 'smooth' }));
  rightBtn.addEventListener('click', () => scroller.scrollBy({ left: 160, behavior: 'smooth' }));
  const syncArrows = () => {
    leftBtn.hidden = scroller.scrollLeft < 2;
    rightBtn.hidden = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 2;
  };
  scroller.addEventListener('scroll', syncArrows, { passive: true });
  scroller.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    scroller.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });
  new ResizeObserver(syncArrows).observe(scroller);
  const scrollBtn = h('div.asset-tabs-bar', leftBtn, scroller, rightBtn);
  const el = h('section.panel.assets-panel', { 'aria-label': 'Media and assets' }, scrollBtn, body);

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
    bar.el.querySelector(`[aria-selected="true"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    body.setAttribute('aria-labelledby', `tab-${id}`);
    tab.shown?.();
  }
  show(current);

  return {
    el,
    show,
    openImport() {
      show('media');
      made.get('media')?.openImport?.();
    },
    dispose() {
      for (const t of made.values()) t.dispose?.();
    },
  };
}
