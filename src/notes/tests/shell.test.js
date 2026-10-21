import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store, snippet, foldWithOffsets } from '../src/data/store.js';
import { memoryBackend } from '../src/data/backend.js';
import { App } from '../src/ui/app.js';
import { closeAllMenus } from '../src/ui/menu.js';

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
