import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store, snippet, foldWithOffsets } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';
import { App } from '../src/ui/app.js';
import { closeAllMenus, openMenu } from '../src/ui/menu.js';
import { setPref } from '../src/ui/prefs.js';

// App shell and navigation: panes, routing, search, menus and dialogs.

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let mounted = [];

async function mount() {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  localStorage.clear();
  const store = new Store(memoryBackend(), { saveDelay: 0 });
  await store.load({ defaultName: "sam's Notebook" });
  const app = new App(document.getElementById('app'), { store, user: { username: 'sam' }, env: 'web', onSignOut: () => {} });
  await app.start();
  mounted.push(app);
  return { app, store };
}

function keydown(target, key, opts = {}) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(e);
  return e;
}

describe('App shell', () => {
  let app;
  let store;
  beforeEach(async () => {
    ({ app, store } = await mount());
  });
  afterEach(() => {
    closeAllMenus();
    document.querySelectorAll('dialog').forEach((d) => d.remove());
    for (const a of mounted) a.destroy();
    mounted = [];
    history.replaceState(null, '', location.pathname);
  });

  it('puts the label back after renaming the open page from the page list', async () => {
    const row = app.nav.pagesList.querySelector('.row[aria-selected="true"]');
    row.focus();
    keydown(row, 'F2');
    const input = app.nav.pagesList.querySelector('input.row-rename');
    expect(input).toBeTruthy();
    input.value = 'Renamed';
    keydown(input, 'Enter');
    await tick();
    expect(app.nav.pagesList.querySelector('input.row-rename')).toBeNull();
    expect(app.nav.pagesList.querySelector('.row[aria-selected="true"]').textContent).toBe('Renamed');
    expect(store.findPage(app.state.pageId).meta.title).toBe('Renamed');
  });

  it('keeps focus in the page list after deleting a page with the Delete key', async () => {
    app.newPage({ title: 'Two' });
    app.newPage({ title: 'Three' });
    await tick();
    const rows = () => [...app.nav.pagesList.querySelectorAll('.row')];
    rows()[1].focus();
    keydown(rows()[1], 'Delete');
    await tick();
    expect(rows().map((r) => r.textContent)).toEqual(['Untitled Page', 'Three']);
    expect(document.activeElement).toBe(app.nav.pagesList.querySelector('.row[aria-selected="true"]'));
  });

  it('steps to the next and previous page in the order the page list shows', async () => {
    const section = store.section(app.state.sectionId);
    store.createPage(section.id, { title: 'C' });
    store.createPage(section.id, { title: 'A' });
    store.createPage(section.id, { title: 'B' });
    setPref('pageSort', 'alpha');
    app.renderNav();
    const a = section.pages.find((p) => p.title === 'A');
    await app.openPage(a.id);
    const titles = [];
    for (let i = 0; i < 3; i++) {
      app.runCommand('nextPage');
      await tick();
      titles.push(store.findPage(app.state.pageId).meta.title || 'Untitled Page');
    }
    expect(titles).toEqual(['B', 'C', 'Untitled Page']);
    app.runCommand('prevPage');
    await tick();
    expect(store.findPage(app.state.pageId).meta.title).toBe('C');
    setPref('pageSort', 'manual');
  });

  it('opens the top result for what is typed, not for the previous search, on a quick Enter', async () => {
    const budget = app.newPage({ title: 'Budget plan' });
    const travel = app.newPage({ title: 'Travel ideas' });
    await tick();
    app.setRailView('search', { focus: true });
    const input = app.search.input;
    input.value = 'budget';
    input.dispatchEvent(new Event('input'));
    await tick(300);
    await app.openPage(budget.id);
    input.value = 'travel';
    input.dispatchEvent(new Event('input'));
    keydown(input, 'Enter');
    await tick(50);
    expect(app.state.pageId).toBe(travel.id);
  });

  it('puts focus back where it was when Search or Recent Notes closes', () => {
    app.railButtons.search.focus();
    app.railButtons.search.click();
    expect(document.activeElement).toBe(app.search.input);
    keydown(app.search.input, 'Escape');
    expect(app.state.railView).toBe('notebooks');
    expect(document.activeElement).toBe(app.railButtons.search);
    app.railButtons.recent.focus();
    app.railButtons.recent.click();
    app.recent.el.querySelector('[aria-label="Close recent notes"]').click();
    expect(document.activeElement).toBe(app.railButtons.recent);
  });

  it('moves from the pages list to the page with F6', () => {
    // jsdom has no layout; treat everything outside a hidden subtree as shown.
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.isConnected && !this.closest('[hidden]') ? document.body : null; } });
    try {
      app.nav.sectionsList.querySelector('.row[tabindex="0"]').focus();
      keydown(document.activeElement, 'F6');
      expect(app.nav.pagesList.contains(document.activeElement)).toBe(true);
      keydown(document.activeElement, 'F6');
      expect(app.editor.scroller.contains(document.activeElement)).toBe(true);
      keydown(document.activeElement, 'F6', { shiftKey: true });
      expect(app.nav.pagesList.contains(document.activeElement)).toBe(true);
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', desc);
    }
  });

  it('follows a page link pasted into the address bar of the open app', async () => {
    const first = app.state.pageId;
    app.newPage({ title: 'Second' });
    await tick();
    expect(app.state.pageId).not.toBe(first);
    location.hash = `#page=${first}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await tick();
    expect(app.state.pageId).toBe(first);
  });
});

describe('search folding', () => {
  it('maps folded matches back to the text when folding changes its length', () => {
    const text = '오늘 회의는 café';
    const { flat, from, to } = foldWithOffsets(text);
    const i = flat.indexOf(foldWithOffsets('회의').flat);
    expect(text.slice(from(i), to(i + foldWithOffsets('회의').flat.length))).toBe('회의');
    const j = flat.indexOf('cafe');
    expect(text.slice(from(j), to(j + 4))).toBe('café');
  });

  it('centres snippets on the match in Korean text', () => {
    const text = `${'가'.repeat(200)} 목표 ${'나'.repeat(200)}`;
    expect(snippet(text, [foldWithOffsets('목표').flat])).toContain('목표');
  });
});

describe('Find on Page', () => {
  afterEach(() => {
    for (const a of mounted) a.destroy();
    mounted = [];
  });

  it('finds words in Korean notes and accented words next to them', async () => {
    const { app } = await mount();
    app.newPage({ title: '회의 노트', outlines: [{ id: 'o1', x: 48, y: 140, w: 600, html: '<p>오늘 회의는 취소 café</p>' }] });
    await tick(10);
    app.find.open('회의는');
    expect(app.find.ranges.map((r) => r.toString())).toEqual(['회의는']);
    app.find.input.value = 'cafe';
    app.find.run();
    expect(app.find.ranges.map((r) => r.toString())).toEqual(['café']);
    app.find.close();
  });
});

describe('menus', () => {
  afterEach(() => {
    closeAllMenus();
    document.body.innerHTML = '';
  });

  it('returns to the submenu item when Escape or Left Arrow closes its submenu', async () => {
    document.body.innerHTML = '<button id="opener">Open</button>';
    const opener = document.getElementById('opener');
    opener.focus();
    openMenu(opener, [
      { label: 'First', run: () => {} },
      { label: 'Colors', submenu: () => [{ label: 'Red', run: () => {} }, { label: 'Blue', run: () => {} }] },
    ]);
    const item = [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Colors'));
    item.focus();
    keydown(item, 'ArrowRight');
    expect(document.querySelectorAll('.menu')).toHaveLength(2);
    expect(document.activeElement.textContent).toBe('Red');
    keydown(document.activeElement, 'Escape');
    expect(document.querySelectorAll('.menu')).toHaveLength(1);
    expect(document.activeElement).toBe(item);
    keydown(item, 'ArrowRight');
    keydown(document.activeElement, 'ArrowLeft');
    expect(document.querySelectorAll('.menu')).toHaveLength(1);
    expect(document.activeElement).toBe(item);
    keydown(item, 'Escape');
    expect(document.querySelectorAll('.menu')).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
  });
});
