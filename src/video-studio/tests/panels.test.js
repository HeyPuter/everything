// Shared asset-panel UX: favorites, category groups, tiles, and the media bin.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isFavorite, toggleFavorite, setFavorite, favoriteIds, onFavoritesChange, itemsFor } from '../src/ui/panels/favorites.js';
import { tabLayout, tileGrid, tile, categoryIds } from '../src/ui/panels/common.js';
import { prefs, setPref } from '../src/ui/prefs.js';
import { mediaTab, assetFacts } from '../src/ui/panels/media.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { createBin, moveAssets } from '../src/model/bins.js';
import { allClips, mainTrack } from '../src/model/timeline.js';
import { makeClip } from '../src/model/project.js';
import { createCompound } from '../src/model/compound.js';
import { fixture } from './helpers.js';

const KEY = 'video-studio:prefs';
const stored = () => JSON.parse(localStorage.getItem(KEY) || '{}');

beforeEach(() => {
  setPref('favorites', []);
  setPref('catGroups', {});
  setPref('assetCats', {});
  document.body.replaceChildren();
});

describe('favorites', () => {
  it('toggles per tab and id, newest first, and persists to the device', () => {
    expect(isFavorite('stickers', 'star')).toBe(false);
    expect(toggleFavorite('stickers', 'star')).toBe(true);
    toggleFavorite('stickers', 'heart');
    toggleFavorite('effects', 'star');
    expect(favoriteIds('stickers')).toEqual(['heart', 'star']);
    expect(favoriteIds('effects')).toEqual(['star']);
    expect(stored().favorites).toEqual(['effects:star', 'stickers:heart', 'stickers:star']);
    expect(toggleFavorite('stickers', 'star')).toBe(false);
    expect(favoriteIds('stickers')).toEqual(['heart']);
    // Re-favoriting moves an item to the front without duplicates.
    setFavorite('stickers', 'star', true);
    setFavorite('stickers', 'heart', true);
    expect(favoriteIds('stickers')).toEqual(['heart', 'star']);
  });

  it('ignores corrupt stored values', () => {
    setPref('favorites', 'nope');
    expect(favoriteIds('x')).toEqual([]);
    setPref('favorites', ['x:a', 5, null]);
    expect(favoriteIds('x')).toEqual(['a']);
  });

  it('notifies listeners until they unsubscribe', () => {
    const seen = [];
    const off = onFavoritesChange((e) => seen.push(e));
    toggleFavorite('audio', 'sfx:pop');
    off();
    toggleFavorite('audio', 'sfx:pop');
    expect(seen).toEqual([{ tab: 'audio', id: 'sfx:pop', on: true }]);
  });

  it('lists items for all, favorites (in favorite order), a category and a query', () => {
    const items = [{ id: 'a', label: 'Apple', cat: 'fruit' }, { id: 'b', label: 'Bean', cat: 'veg' }, { id: 'c', label: 'Cherry', cat: 'fruit' }];
    setFavorite('t', 'a', true);
    setFavorite('t', 'c', true);
    setFavorite('t', 'gone', true);
    expect(itemsFor(items, 'all').map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(itemsFor(items, 'favorites', { tab: 't' }).map((x) => x.id)).toEqual(['c', 'a']);
    expect(itemsFor(items, 'fruit').map((x) => x.id)).toEqual(['a', 'c']);
    expect(itemsFor(items, 'all', { query: 'ER' }).map((x) => x.id)).toEqual(['c']);
  });
});

describe('tab layout', () => {
  const categories = [
    { id: 'all', label: 'All' },
    { id: 'g', label: 'Group', children: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] },
  ];

  it('flattens category ids', () => {
    expect(categoryIds(categories)).toEqual(['all', 'one', 'two']);
  });

  it('adds a Favorites category that refreshes when favorites change', () => {
    const render = vi.fn((cat) => document.createTextNode(`${cat}:${favoriteIds('demo').join(',')}`));
    const layout = tabLayout({ title: 'Demo', categories, favorites: 'demo', render });
    document.body.append(layout.el);
    const cats = [...layout.el.querySelectorAll('.asset-cat')].map((b) => b.textContent);
    expect(cats).toEqual(['Favorites', 'All', 'One', 'Two']);
    // Starts on the first real category, not Favorites.
    expect(layout.category).toBe('all');
    layout.select('favorites');
    expect(layout.el.querySelector('.asset-content').textContent).toBe('favorites:');
    toggleFavorite('demo', 'x');
    expect(layout.el.querySelector('.asset-content').textContent).toBe('favorites:x');
    layout.dispose();
    toggleFavorite('demo', 'y');
    expect(layout.el.querySelector('.asset-content').textContent).toBe('favorites:x');
  });

  it('collapses groups, remembers it per device, and reopens for a selected child', () => {
    const layout = tabLayout({ title: 'Demo', categories, render: () => document.createTextNode('') });
    const head = layout.el.querySelector('.asset-cat-group');
    const kids = layout.el.querySelector('.asset-cat-children');
    expect(head.getAttribute('aria-expanded')).toBe('true');
    head.click();
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(kids.hidden).toBe(true);
    expect(prefs().catGroups['demo:g']).toBe(false);
    const again = tabLayout({ title: 'Demo', categories, render: () => document.createTextNode('') });
    expect(again.el.querySelector('.asset-cat-group').getAttribute('aria-expanded')).toBe('false');
    again.select('two');
    expect(again.el.querySelector('.asset-cat-group').getAttribute('aria-expanded')).toBe('true');
    expect(again.el.querySelector('[data-cat="two"]').getAttribute('aria-current')).toBe('true');
    // The last category is remembered for next time.
    expect(tabLayout({ title: 'Demo', categories, render: () => document.createTextNode('') }).category).toBe('two');
  });

  it('offers a sort and filter menu button', () => {
    const layout = tabLayout({ title: 'Demo', categories, render: () => document.createTextNode(''), menu: () => [{ label: 'Name', onSelect() {} }], menuActive: () => true });
    const btn = layout.el.querySelector('.asset-menu-btn');
    expect(btn.getAttribute('aria-label')).toBe('Sort and filter');
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.classList.contains('on')).toBe(true);
  });
});

describe('tiles', () => {
  it('adds a keyboard-accessible favorite star next to the tile', () => {
    const t = tile({ label: 'Star', preview: document.createElement('span'), onAdd() {}, favorite: { tab: 'g', id: 'star' } });
    const grid = tileGrid([t], { label: 'Graphics' });
    const star = grid.querySelector('.tile-fav');
    expect(star.tagName).toBe('BUTTON');
    expect(star.closest('.tile')).toBe(null); // not nested inside the tile button
    expect(star.getAttribute('aria-pressed')).toBe('false');
    star.click();
    expect(star.getAttribute('aria-pressed')).toBe('true');
    expect(star.getAttribute('aria-label')).toBe('Remove Star from favorites');
    expect(isFavorite('g', 'star')).toBe(true);
  });

  it('with onSelect, click selects, Enter and the + button add', () => {
    const onAdd = vi.fn();
    const onSelect = vi.fn();
    const t = tile({ label: 'Clip', preview: document.createElement('span'), onAdd, onSelect });
    const grid = tileGrid([t], { label: 'Media' });
    t.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onAdd).not.toHaveBeenCalled();
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    grid.querySelector('.tile-plus').click();
    t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(onAdd).toHaveBeenCalledTimes(3);
  });
});

describe('media tab', () => {
  let tab;
  let store;
  let actions;

  function mount(p = fixture()) {
    store = new EditorStore(p);
    const ctx = { store, player: null, library: { backend: { kind: 'memory' } }, media: { poster: () => Promise.resolve(null) } };
    ctx.actions = createActions(ctx);
    actions = ctx.actions;
    tab = mediaTab(ctx);
    document.body.append(tab.el);
    return tab;
  }

  afterEach(() => {
    tab?.dispose();
    tab = null;
    setPref('mediaView', 'grid');
    setPref('mediaSort', null);
    setPref('mediaTypes', []);
  });

  const flush = () => new Promise((r) => setTimeout(r, 5));
  const tileNames = () => [...tab.el.querySelectorAll('.tile:not(.folder-tile) .tile-label')].map((x) => x.textContent);

  it('shows folders first and opens them with a breadcrumb', async () => {
    const p = fixture();
    const f = createBin(p, 'Shots');
    moveAssets(p, ['vid', 'img'], f.id);
    mount(p);
    tab.el.querySelector('[data-cat="project"]').click();
    const folderTile = tab.el.querySelector('.folder-tile');
    expect(folderTile.getAttribute('aria-label')).toMatch(/Folder Shots, 2 items/);
    expect(tileNames().sort()).toEqual(['aud', 'silent']);
    folderTile.click();
    expect(tileNames().sort()).toEqual(['img', 'vid']);
    const crumbs = [...tab.el.querySelectorAll('.media-crumb')].map((c) => c.textContent);
    expect(crumbs).toEqual(['All media', 'Shots']);
    tab.el.querySelector('.media-crumb').click();
    expect(tab.el.querySelector('.folder-tile')).toBeTruthy();
  });

  it('remembers grid or list view, sort and type filter', () => {
    mount();
    tab.el.querySelector('[data-cat="project"]').click();
    tab.el.querySelector('.media-view-btn').click();
    expect(prefs().mediaView).toBe('list');
    const rows = [...tab.el.querySelectorAll('.media-row')];
    expect(rows).toHaveLength(4);
    expect(rows[0].getAttribute('aria-label')).toMatch(/·/);
    setPref('mediaSort', { key: 'name', dir: 'asc' });
    setPref('mediaTypes', ['video']);
    tab.el.querySelector('[data-cat="image"]').click();
    tab.el.querySelector('[data-cat="project"]').click();
    expect([...tab.el.querySelectorAll('.media-row-name')].map((x) => x.textContent)).toEqual(['silent', 'vid']);
    expect(tab.el.querySelector('.asset-menu-btn').classList.contains('on')).toBe(true);
  });

  it('selects several items with Cmd and Shift click and adds them in order as one undo step', async () => {
    mount();
    setPref('mediaSort', { key: 'name', dir: 'asc' });
    tab.el.querySelector('[data-cat="video"]').click();
    tab.el.querySelector('[data-cat="project"]').click();
    const byName = (n) => [...tab.el.querySelectorAll('.tile')].find((t) => t.querySelector('.tile-label')?.textContent === n);
    byName('img').click();
    byName('vid').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await flush();
    expect(tab.el.querySelector('.media-selcount').textContent).toBe('3 selected');
    byName('silent').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    await flush();
    expect(tab.el.querySelector('.media-selcount').textContent).toBe('2 selected');
    const before = store.history.undoStack.length;
    [...tab.el.querySelectorAll('.media-selbar .btn')].find((b) => /Add 2/.test(b.textContent)).click();
    expect(mainTrack(store.project).clips.map((c) => c.assetId)).toEqual(['img', 'vid']);
    expect(store.history.undoStack.length).toBe(before + 1);
    store.undo();
    expect(allClips(store.project)).toHaveLength(0);
  });

  it('will not delete media from inside a compound clip when clips outside it use the media', async () => {
    const p = fixture();
    const [a, b] = [makeClip('video', { assetId: 'vid', start: 0, duration: 5e6 }), makeClip('video', { assetId: 'silent', start: 5e6, duration: 5e6 })];
    mainTrack(p).clips.push(a, b);
    const comp = createCompound(p, [b.id], { ripple: true, linkOverlays: true });
    mount(p);
    store.openCompound(comp.id);
    tab.el.querySelector('[data-cat="project"]').click();
    const byName = (n) => [...tab.el.querySelectorAll('.tile')].find((t) => t.querySelector('.tile-label')?.textContent === n);
    byName('vid').click();
    await flush();
    tab.el.querySelector('.media-selbar [data-tip="Delete"]').click();
    await flush();
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(document.querySelector('.toast')?.textContent).toContain('vid is also used outside this compound clip');
    expect(store.project.assets.vid).toBeTruthy();
  });

  it('describes media facts', () => {
    expect(assetFacts({ kind: 'video', duration: 12e6, width: 1920, height: 1080, size: 3_400_000 })).toBe('Video · 00:12 · 1920×1080 · 3.4 MB');
    expect(assetFacts({ kind: 'image', width: 800, height: 600, size: 0 })).toBe('Photo · 800×600');
  });

  it('imports into the open folder', async () => {
    const p = fixture();
    const f = createBin(p, 'Inbox');
    mount(p);
    const lib = { backend: { kind: 'memory' }, importFile: async (file) => ({ id: 'new', kind: 'image', name: file.name, added: Date.now() }) };
    const ctx = { store, library: lib };
    const acts = createActions(ctx);
    const [asset] = await acts.importFiles([new File(['x'], 'a.png', { type: 'image/png' })], { folder: f.id });
    expect(asset.folder).toBe(f.id);
    const [other] = await acts.importFiles([new File(['x'], 'b.png', { type: 'image/png' })], { folder: 'missing' });
    expect(other.folder).toBeUndefined();
    void actions;
  });
});
