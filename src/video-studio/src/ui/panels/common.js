/**
 * Shared layout for asset tabs: an optional category sidebar (with
 * collapsible groups and an opt-in Favorites category), a search box with an
 * optional sort/filter menu, and a responsive grid of item tiles with
 * keyboard navigation, favorite stars and add buttons.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { menuButton } from '../menu.js';
import { prefs, setPref } from '../prefs.js';
import { isFavorite, toggleFavorite, onFavoritesChange } from './favorites.js';
import '../../styles/panels.css';

export const FAVORITES_CATEGORY = { id: 'favorites', label: 'Favorites', icon: 'star' };

/** Flat list of selectable category ids (group children included). */
export function categoryIds(categories = []) {
  const out = [];
  for (const c of categories) {
    if (c.children) out.push(...categoryIds(c.children));
    else out.push(c.id);
  }
  return out;
}

const groupKey = (tab, id) => `${tab}:${id}`;

function groupOpen(tab, id, fallback = true) {
  const v = prefs().catGroups?.[groupKey(tab, id)];
  return typeof v === 'boolean' ? v : fallback;
}

function setGroupOpen(tab, id, open) {
  setPref('catGroups', { ...(prefs().catGroups || {}), [groupKey(tab, id)]: open });
}

/**
 * categories: [{ id, label, icon? } | { id, label, children: [...], open? }] (optional)
 * render(categoryId, query) -> Node   content for the selected category
 * favorites: tab key; adds a Favorites category on top that refreshes when favorites change
 * menu: () => menu items for a sort/filter button next to the search box
 * menuActive: () => boolean, marks the menu button when a non-default sort/filter is on
 * topbar: a row of actions above the search row; toolbar: extra controls in the search row
 */
export function tabLayout({
  title, id, categories, initial, render, search = true, searchLabel, toolbar = null, topbar = null,
  favorites = null, menu = null, menuLabel = 'Sort and filter', menuIcon = 'filter', menuActive = null,
}) {
  const tabId = id || String(title || 'tab').toLowerCase();
  const cats = categories?.length ? (favorites ? [FAVORITES_CATEGORY, ...categories] : categories) : null;
  const ids = categoryIds(cats || []);
  const remembered = prefs().assetCats?.[tabId];
  let cat = initial && ids.includes(initial) ? initial
    : ids.includes(remembered) && remembered !== 'favorites' ? remembered
      : ids.find((x) => x !== 'favorites') || ids[0] || null;
  let query = '';
  const content = h('div.asset-content');
  const catButtons = new Map(); // id -> button

  function catButton(c, depth) {
    const b = h(`button.asset-cat${depth ? '.child' : ''}`, { type: 'button', 'aria-current': c.id === cat ? 'true' : null, 'data-cat': c.id },
      c.icon ? icon(c.icon, 14) : null, h('span.asset-cat-label', c.label));
    b.addEventListener('click', () => select(c.id));
    catButtons.set(c.id, b);
    return b;
  }

  function groupEl(g) {
    const inside = categoryIds(g.children).includes(cat);
    let open = inside || groupOpen(tabId, g.id, g.open !== false);
    const kids = h('div.asset-cat-children', { id: `cats-${tabId}-${g.id}`, role: 'group', 'aria-label': g.label }, g.children.map((c) => (c.children ? groupEl(c) : catButton(c, 1))));
    const head = h('button.asset-cat-group', { type: 'button', 'aria-expanded': String(open), 'aria-controls': kids.id },
      h('span.asset-cat-label', g.label), icon('chevronDown', 14, 'asset-cat-caret'));
    const setOpen = (v) => {
      open = v;
      head.setAttribute('aria-expanded', String(v));
      kids.hidden = !v;
    };
    setOpen(open);
    head.addEventListener('click', () => {
      setOpen(!open);
      setGroupOpen(tabId, g.id, open);
    });
    return h('div.asset-cat-groupwrap', head, kids);
  }

  const nav = cats
    ? h('nav.asset-cats', { 'aria-label': `${title} categories` }, cats.map((c) => (c.children ? groupEl(c) : catButton(c, 0))))
    : null;

  function select(next) {
    if (!ids.includes(next)) return;
    cat = next;
    setPref('assetCats', { ...(prefs().assetCats || {}), [tabId]: next });
    for (const [cid, b] of catButtons) {
      if (cid === next) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
    // Reveal a category hidden in a collapsed group.
    const b = catButtons.get(next);
    let g = b?.parentElement;
    while (g && g !== nav) {
      if (g.classList.contains('asset-cat-children') && g.hidden) {
        g.hidden = false;
        g.previousElementSibling?.setAttribute('aria-expanded', 'true');
      }
      g = g.parentElement;
    }
    refresh();
  }

  const input = search ? h('input.input.asset-search', { type: 'search', placeholder: searchLabel || `Search ${title.toLowerCase()}`, 'aria-label': searchLabel || `Search ${title.toLowerCase()}` }) : null;
  input?.addEventListener('input', () => {
    query = input.value.trim().toLowerCase();
    refresh();
  });
  let menuBtn = null;
  if (menu) {
    menuBtn = h('button.icon-btn.asset-menu-btn', { type: 'button', 'aria-label': menuLabel, 'data-tip': menuLabel }, icon(menuIcon, 16));
    menuButton(menuBtn, () => menu(), { align: 'end', label: menuLabel });
  }
  const searchRow = input || toolbar || menuBtn ? h('div.asset-toolbar', input ? h('div.search-wrap', icon('search', 14), input) : null, toolbar, menuBtn) : null;
  const main = h('div.asset-main', topbar ? h('div.asset-topbar', topbar) : null, searchRow, content);
  const el = h(`div.asset-tab${nav ? '.with-cats' : ''}`, { 'data-tab': tabId }, nav, main);

  function refresh() {
    menuBtn?.classList.toggle('on', Boolean(menuActive?.()));
    const keep = content.scrollTop;
    content.replaceChildren(render(cat, query));
    content.scrollTop = keep;
  }
  refresh();

  const offFav = favorites ? onFavoritesChange((e) => {
    if (e.tab !== favorites || cat !== 'favorites') return;
    // An item taken out of the list had focus: focus moves to the same control of the item
    // that takes its place (or the one before it), else to the Favorites category.
    const had = content.contains(document.activeElement) ? document.activeElement : null;
    const kind = had?.classList.contains('fav-btn') ? '.fav-btn' : '.tile';
    const at = had ? [...content.querySelectorAll(kind)].indexOf(had) : -1;
    refresh();
    if (!had || had.isConnected) return;
    const list = content.querySelectorAll(kind);
    (list[Math.min(at, list.length - 1)] || catButtons.get('favorites'))?.focus();
  }) : null;

  return {
    el,
    refresh,
    select,
    get category() { return cat; },
    get query() { return query; },
    dispose() { offFav?.(); },
  };
}

/** Grid of tiles with roving focus (arrow keys move between tiles). */
export function tileGrid(items, { label, className = '' } = {}) {
  const grid = h(`div.tile-grid${className ? '.' + className.split(' ').join('.') : ''}`, { role: 'list', 'aria-label': label });
  grid.append(...items.map((it) => h(`div.tile-cell${it.tileExtras?.length ? '.has-extras' : ''}`, { role: 'listitem' }, it, it.tileExtras || null)));
  grid.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const tiles = [...grid.querySelectorAll('.tile')];
    const i = tiles.indexOf(document.activeElement?.closest('.tile'));
    if (i < 0) return;
    const cols = Math.max(1, Math.round(grid.clientWidth / (tiles[0].getBoundingClientRect().width || 100)));
    let j = i;
    if (e.key === 'ArrowRight') j = i + 1;
    if (e.key === 'ArrowLeft') j = i - 1;
    if (e.key === 'ArrowDown') j = i + cols;
    if (e.key === 'ArrowUp') j = i - cols;
    if (j >= 0 && j < tiles.length) {
      e.preventDefault();
      tiles[j].focus();
    }
  });
  grid.setAttribute('data-own-arrows', '');
  return grid;
}

/**
 * A star toggle for a library item. Keyboard accessible (a real button with
 * aria-pressed); state persists per device.
 */
export function favoriteButton(tab, id, label, { className = '' } = {}) {
  const b = h(`button.fav-btn${className ? '.' + className : ''}`, { type: 'button' });
  const sync = () => {
    const on = isFavorite(tab, id);
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? `Remove ${label} from favorites` : `Add ${label} to favorites`);
    b.dataset.tip = on ? 'Remove from favorites' : 'Add to favorites';
    b.classList.toggle('on', on);
  };
  b.append(icon('star', 14));
  sync();
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFavorite(tab, id);
    sync();
  });
  return b;
}

/**
 * A badge or sub line on a tile (a duration, "Added", "3 layers"). Its text
 * is drawn by CSS from data-text: the tile's name already says it, and as
 * text in the button it would sit in the middle of the visible label that
 * the name has to contain (WCAG 2.5.3, label in name).
 */
export function tileNote(kind, text) {
  return h(`span.tile-${kind}`, { 'aria-hidden': 'true', 'data-text': String(text) });
}

/**
 * One asset tile: a preview area plus a label. onAdd runs on click, Enter
 * and the + button; drag data lets it drop onto the timeline.
 *
 * With onSelect, a click selects instead (the event is passed so callers can
 * read Shift/Cmd), double click and Enter add, and the + becomes a real
 * button. favorite: { tab, id } adds a star toggle. Extra buttons are
 * returned on tile.tileExtras and placed next to the tile by tileGrid (a
 * button inside a button is invalid).
 */
export function tile({ label, preview, onAdd, onSelect, drag, badge, sub, active = false, selected = false, addLabel, favorite, plusLabel }) {
  const add = onSelect ? null : h('span.tile-add', { 'aria-hidden': 'true' }, icon('plus', 14));
  const btn = h(`button.tile${active ? '.active' : ''}${selected ? '.selected' : ''}`, {
    type: 'button',
    'aria-label': addLabel || `Add ${label}`,
    'aria-pressed': active || onSelect ? String(Boolean(active || selected)) : null,
    draggable: drag ? 'true' : null,
  },
  h('span.tile-preview', preview, badge ? tileNote('badge', badge) : null, add),
  h('span.tile-label', label),
  sub ? tileNote('sub', sub) : null,
  );
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (onSelect) onSelect(e);
    else onAdd?.();
  });
  if (onSelect) {
    btn.addEventListener('dblclick', (e) => {
      e.preventDefault();
      onAdd?.();
    });
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.repeat) return;
      e.preventDefault();
      onAdd?.();
    });
  }
  if (drag) {
    btn.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'copyMove';
      const data = typeof drag === 'function' ? drag() : drag;
      e.dataTransfer.setData('application/x-video-studio', JSON.stringify(data));
      e.dataTransfer.setData('text/plain', label);
      document.body.classList.add('dragging-asset');
    });
    btn.addEventListener('dragend', () => document.body.classList.remove('dragging-asset'));
  }
  const extras = [];
  if (favorite) extras.push(favoriteButton(favorite.tab, favorite.id, label, { className: 'tile-fav' }));
  if (onSelect && onAdd) {
    const plus = h('button.tile-plus', { type: 'button', 'aria-label': plusLabel || `Add ${label} to timeline`, 'data-tip': 'Add to timeline' }, icon('plus', 14));
    plus.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onAdd();
    });
    extras.push(plus);
  }
  if (extras.length) btn.tileExtras = extras;
  return btn;
}

export function emptyState(iconName, title, text, action) {
  return h('div.empty-state', icon(iconName, 28), h('p.empty-title', title), text ? h('p.empty-text', text) : null, action);
}

/** Empty state for a Favorites category. */
export function emptyFavorites(what = 'items') {
  return emptyState('star', 'No favorites yet', `Hover ${what} and click the star to keep them here.`);
}

/** Empty state for a search with no results. */
export function emptySearch(what = 'items') {
  return emptyState('search', `No ${what} found`, 'Try another word.');
}

/** A small canvas tile preview drawn by fn(ctx2d, w, h). */
export function canvasPreview(draw, w = 160, hgt = 90) {
  const c = h('canvas.tile-canvas', { width: w, height: hgt, 'aria-hidden': 'true' });
  try {
    draw(c.getContext('2d'), w, hgt);
  } catch {
    /* jsdom or no 2D context */
  }
  return c;
}

/**
 * Animate a tile's canvas while it is hovered or focused: draw(ctx, w, h, t)
 * runs every frame with t in seconds; the resting frame is t = rest.
 */
export function hoverPlay(tileEl, canvas, draw, { rest = 0 } = {}) {
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  let raf = 0;
  let t0 = 0;
  const frame = (now) => {
    const g = canvas.getContext('2d');
    if (!g || !canvas.isConnected) {
      raf = 0;
      return;
    }
    draw(g, canvas.width, canvas.height, (now - t0) / 1000);
    raf = requestAnimationFrame(frame);
  };
  const on = () => {
    if (raf) return;
    t0 = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const off = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    const g = canvas.getContext('2d');
    if (g) draw(g, canvas.width, canvas.height, rest);
  };
  tileEl.addEventListener('pointerenter', on);
  tileEl.addEventListener('pointerleave', off);
  tileEl.addEventListener('focus', on);
  tileEl.addEventListener('blur', off);
}
