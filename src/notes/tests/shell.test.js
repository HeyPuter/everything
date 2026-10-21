import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store, snippet, foldWithOffsets } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';
import { App } from '../src/ui/app.js';
import { closeAllMenus, openMenu } from '../src/ui/menu.js';
import { setPref, prefs } from '../src/ui/prefs.js';

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

  it('follows the open page when it is dragged onto another section', async () => {
    const other = store.notebooks[0].sections.find((n) => n.id !== app.state.sectionId && n.type === 'section');
    const id = app.state.pageId;
    app.drop({ kind: 'page', id }, { into: other.id }, 'section');
    await tick();
    expect(store.findPage(id).section.id).toBe(other.id);
    expect(app.state.sectionId).toBe(other.id);
    expect(app.state.pageId).toBe(id);
    expect(app.nav.sectionsList.querySelector('[aria-selected="true"]').dataset.id).toBe(other.id);
  });

  it('renames a page or section on double-click even though the first click redraws the list', async () => {
    app.newPage({ title: 'Two' });
    await tick();
    // Browsers send no dblclick when the first click replaced the row, only
    // a second click with detail 2.
    const click = (el, detail) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
    let row = app.nav.pagesList.querySelector('.row:not([aria-selected="true"])');
    const id = row.dataset.id;
    click(row, 1);
    row = app.nav.pagesList.querySelector(`.row[data-id="${id}"]`);
    click(row, 2);
    expect(app.nav.pagesList.querySelector(`.row[data-id="${id}"] input.row-rename`)).toBeTruthy();
    keydown(document.activeElement, 'Escape');
    let section = app.nav.sectionsList.querySelector('.row:not([aria-selected="true"])');
    const sid = section.dataset.id;
    click(section, 1);
    section = app.nav.sectionsList.querySelector(`.row[data-id="${sid}"]`);
    click(section, 2);
    expect(app.nav.sectionsList.querySelector(`.row[data-id="${sid}"] input.row-rename`)).toBeTruthy();
    keydown(document.activeElement, 'Escape');
  });

  it('does not reorder pages unseen with Alt+Shift+Arrow while the list is sorted', async () => {
    const section = store.section(app.state.sectionId);
    store.createPage(section.id, { title: 'C' });
    store.createPage(section.id, { title: 'A' });
    setPref('pageSort', 'alpha');
    try {
      app.renderNav();
      const before = section.pages.map((p) => p.id);
      const row = [...app.nav.pagesList.querySelectorAll('.row')].find((r) => r.textContent === 'C');
      row.focus();
      keydown(row, 'ArrowDown', { altKey: true, shiftKey: true });
      await tick();
      expect(section.pages.map((p) => p.id)).toEqual(before);
    } finally {
      setPref('pageSort', 'manual');
    }
  });

  it('keeps focus on a Recent Notes item after opening its page', async () => {
    const first = app.state.pageId;
    app.newPage({ title: 'Two' });
    await tick();
    app.setRailView('recent');
    const item = [...app.recent.el.querySelectorAll('.result')].find((r) => r.querySelector('.result-title').textContent === 'Untitled Page');
    item.focus();
    item.click();
    await tick();
    expect(app.state.pageId).toBe(first);
    expect(document.activeElement.classList.contains('result')).toBe(true);
    expect(document.activeElement.querySelector('.result-title').textContent).toBe('Untitled Page');
  });

  it('offers to add a notebook once the last notebook is deleted', () => {
    store.deleteNotebook(app.state.notebookId);
    app.state.notebookId = null;
    app.ensureSelection();
    const empty = app.canvasCol.querySelector('.canvas-empty');
    expect(empty.querySelector('h2').textContent).toBe('No notebooks yet');
    expect(empty.querySelector('button').textContent).toBe('Add notebook');
    expect(app.nav.sectionsList.textContent).not.toContain('This notebook');
  });

  it('closes the collapsed ribbon panel when KeyTips are cancelled', () => {
    app.ribbon.toggleCollapsed(true);
    try {
      app.keytips.start();
      keydown(document.body, 'h');
      expect(app.ribbon.el.classList.contains('peek')).toBe(true);
      keydown(document.body, 'Escape');
      keydown(document.body, 'Escape');
      expect(app.keytips.active).toBe(false);
      expect(app.ribbon.el.classList.contains('peek')).toBe(false);
    } finally {
      app.ribbon.toggleCollapsed(false);
    }
  });

  it('drops a deleted page from the search results that are showing', async () => {
    const doomed = app.newPage({ title: 'Doomed plan' });
    await tick();
    app.setRailView('search');
    app.search.input.value = 'doomed';
    await app.search.run();
    expect(app.search.results.querySelectorAll('.result')).toHaveLength(1);
    app.deletePage(doomed.id);
    await tick(400);
    expect(app.search.results.querySelectorAll('.result')).toHaveLength(0);
  });

  it('stops resizing a pane when the browser cancels the drag', () => {
    const r = app.nav.sectionsPane.querySelector('.pane-resizer');
    const start = prefs().sectionsWidth;
    r.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 116 }));
    window.dispatchEvent(new MouseEvent('pointercancel', {}));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 }));
    expect(prefs().sectionsWidth).toBe(start + 16);
    expect(r.classList.contains('dragging')).toBe(false);
    setPref('sectionsWidth', start);
  });

  it('runs the Tell Me command for what is typed, not for the results still showing', async () => {
    const input = app.tellMeInput;
    input.focus();
    input.value = 'zoom';
    input.dispatchEvent(new Event('input'));
    await tick(200);
    expect([...document.querySelectorAll('.menu .menu-label')].map((l) => l.textContent)).toEqual(['Zoom Out', 'Zoom In']);
    input.focus();
    input.value = 'zoom in';
    input.dispatchEvent(new Event('input'));
    const before = app.editor.zoom;
    keydown(input, 'Enter');
    await tick();
    expect(app.editor.zoom).toBeGreaterThan(before);
    app.editor.setZoom(before);
  });

  it('keeps the Tags Summary for the scope chosen last when an earlier search finishes later', async () => {
    const section = store.section(app.state.sectionId);
    store.createPage(section.id, { title: 'Tagged', outlines: [{ id: 'o1', x: 0, y: 0, html: '<p><span class="nt-tag" data-tag="todo" data-done="false" contenteditable="false"></span>Buy milk</p>' }] });
    const orig = store.collectTags.bind(store);
    store.collectTags = async (scope) => {
      const r = await orig(scope);
      await tick(scope.startsWith('page') ? 5 : 60);
      return r;
    };
    app.runCommand('findTags');
    const scope = app.taskPanes.el.querySelector('select[aria-label="Search"]');
    scope.value = 'page';
    scope.dispatchEvent(new Event('change'));
    await tick(120);
    expect(app.taskPanes.lastTags).toHaveLength(0);
    expect(app.taskPanes.el.querySelectorAll('[role="listitem"]')).toHaveLength(0);
  });

  it('selects a locked section without asking for its password while arrowing through sections', async () => {
    const nb = store.notebook(app.state.notebookId);
    const secret = store.createSection(nb.id, { name: 'Secret' });
    store.createPage(secret.id, { title: 'hidden' });
    await store.protectSection(secret.id, 'pw');
    await app.lockSection(secret.id);
    const rows = () => [...app.nav.sectionsList.querySelectorAll('.row')];
    const before = rows()[rows().findIndex((r) => r.dataset.id === secret.id) - 1];
    before.focus();
    keydown(before, 'ArrowDown');
    await tick();
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(app.state.sectionId).toBe(secret.id);
    expect(app.state.pageId).toBeNull();
    expect(app.canvasCol.querySelector('.canvas-empty h2').textContent).toBe('This section is password protected');
    expect(document.activeElement.dataset.id).toBe(secret.id);
  });

  it('keeps the pen when Escape is pressed in the Search box or Tell Me', () => {
    app.setPen(app.editor.ink.pen);
    app.setRailView('search', { focus: true });
    app.search.input.value = 'x';
    keydown(app.search.input, 'Escape');
    expect(app.editor.ink.tool).toBe('pen');
    app.tellMeInput.focus();
    keydown(app.tellMeInput, 'Escape');
    expect(app.editor.ink.tool).toBe('pen');
    keydown(document.body, 'Escape');
    expect(app.editor.ink.tool).toBe('type');
  });

  it('says when search shows only the first results of many', async () => {
    const section = store.section(app.state.sectionId);
    for (let i = 0; i < 205; i++) store.createPage(section.id, { title: `Lorem ${i}`, silent: true });
    app.setRailView('search');
    app.search.input.value = 'lorem';
    await app.search.run();
    expect(app.search.results.querySelectorAll('.result')).toHaveLength(200);
    expect(app.search.results.querySelector('.group-label').textContent).toBe('Showing the first 200 of 205 results');
  });

  it('keeps the This Page search scope on the page that is open', async () => {
    const alpha = app.newPage({ title: 'Alpha apple' });
    await tick();
    const beta = app.newPage({ title: 'Beta apple' });
    await tick();
    await app.openPage(alpha.id);
    app.setRailView('search');
    app.search.input.value = 'apple';
    app.search.scope.value = `page:${alpha.id}`;
    await app.search.run();
    await app.openPage(beta.id);
    await tick(10);
    expect(app.search.scope.value).toBe(`page:${beta.id}`);
    expect([...app.search.results.querySelectorAll('.result-title')].map((t) => t.textContent)).toEqual(['Beta apple']);
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

describe('search ranking', () => {
  it('ranks a title match above a page that only repeats the word in its text', async () => {
    const store = new Store(memoryBackend(), { saveDelay: 0 });
    await store.load({ defaultName: 'x' });
    const { section } = [...store.allSections()][0];
    store.createPage(section.id, { title: 'Notes', outlines: [{ id: 'o', x: 0, y: 0, html: `<p>${'budget '.repeat(12)}</p>` }] });
    store.createPage(section.id, { title: 'Budget', outlines: [] });
    const results = await store.search('budget');
    expect(results.map((r) => r.meta.title)).toEqual(['Budget', 'Notes']);
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

  it('goes to the first match of newly typed text on a quick Enter', async () => {
    const { app } = await mount();
    app.newPage({ title: 'Find', outlines: [{ id: 'o1', x: 48, y: 140, w: 600, html: '<p>form fold fox food</p>' }] });
    await tick(10);
    app.find.open('fo');
    expect(app.find.ranges).toHaveLength(4);
    app.find.input.value = 'fox';
    app.find.input.dispatchEvent(new Event('input'));
    keydown(app.find.input, 'Enter');
    expect(app.find.count.textContent).toBe('1 of 1');
    expect(app.find.ranges[app.find.index].toString()).toBe('fox');
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
