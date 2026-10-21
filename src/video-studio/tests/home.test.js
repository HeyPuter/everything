import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Library, TRASH_DAYS } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { Home, daysLeft, formatSize } from '../src/ui/home.js';
import { TEMPLATES } from '../src/model/templates.js';
import { setPref } from '../src/ui/prefs.js';

const DAY = 24 * 60 * 60 * 1000;
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let root;
let home;
beforeEach(() => {
  document.body.replaceChildren();
  history.replaceState(null, '', '/');
  root = document.createElement('div');
  document.body.append(root, Object.assign(document.createElement('div'), { id: 'live-region' }));
});
afterEach(() => {
  home?.dispose();
  home = null;
  document.querySelectorAll('dialog').forEach((d) => d.remove());
  vi.restoreAllMocks();
});

function mount(lib, extra = {}) {
  home = new Home(root, { library: lib, account: { user: { username: 'sam' } }, onOpen: vi.fn(), onCreate: vi.fn(), onImportFiles: vi.fn(), ...extra });
  return home;
}

const navLabels = () => [...root.querySelectorAll('.nav-item')].map((a) => a.textContent);
const titles = () => [...root.querySelectorAll('.project-title')].map((e) => e.textContent);

describe('home screen', () => {
  it('shows the sidebar, the new project banner, quick starts and recent projects', async () => {
    const lib = new Library(memoryBackend());
    await lib.createProject({ name: 'Holiday' });
    mount(lib);
    await settle();
    expect(navLabels()).toEqual(['Home', 'Templates', 'Trash']);
    expect(root.querySelector('.nav-item[aria-current="page"]').textContent).toBe('Home');
    expect(root.querySelector('.new-banner').textContent).toContain('New project');
    const ratios = [...root.querySelectorAll('.ratio-grid .quick-card strong')].map((e) => e.textContent);
    expect(ratios).toEqual(['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '21:9']);
    expect(root.querySelectorAll('.tpl-strip .tpl-card').length).toBe(6);
    expect(titles()).toEqual(['Holiday']);
    expect(root.querySelector('.side-user').textContent).toBe('sam');
    expect(root.querySelector('.storage-usage').textContent).toContain('1 project');
  });

  it('starts blank projects by shape', async () => {
    const h = mount(new Library(memoryBackend()));
    await settle();
    root.querySelector('.new-banner').click();
    [...root.querySelectorAll('.ratio-grid .quick-card')][1].click();
    expect(h.onCreate.mock.calls).toEqual([[{ ratio: 'original' }], [{ ratio: '9:16' }]]);
  });

  it('names template cards starting with their visible text', async () => {
    mount(new Library(memoryBackend()));
    await settle();
    const cards = root.querySelectorAll('.tpl-strip .tpl-card');
    expect(cards.length).toBeGreaterThan(0);
    const words = (t) => t.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    for (const card of cards) {
      const visible = [card.querySelector('.tpl-badge'), card.querySelector('.tpl-name'), card.querySelector('.tpl-sub')].map((e) => e.textContent).join(' ');
      expect(words(card.getAttribute('aria-label')).startsWith(words(visible))).toBe(true);
    }
  });

  it('names shape cards starting with their visible text', async () => {
    mount(new Library(memoryBackend()));
    await settle();
    for (const card of root.querySelectorAll('.ratio-grid .quick-card')) {
      const [label, hint] = [...card.querySelectorAll('.quick-text > *')].map((e) => e.textContent);
      const name = card.getAttribute('aria-label') || `${label} ${hint}`;
      expect(name.startsWith(hint ? `${label} ${hint}` : label)).toBe(true);
      expect(name).toMatch(/new project/i);
    }
  });

  it('moves a deleted project to the Trash, restores it and deletes it for good', async () => {
    const lib = new Library(memoryBackend());
    const p = await lib.createProject({ name: 'Doomed' });
    await lib.createProject({ name: 'Keeper' });
    const h = mount(lib);
    await settle();
    await h.remove({ id: p.id, name: 'Doomed' });
    expect(titles()).toEqual(['Keeper']);
    expect(root.querySelector('.nav-count').textContent).toBe('1');

    h.show('trash');
    expect(location.hash).toBe('#trash');
    expect(root.querySelector('.view-title').textContent).toBe('Trash');
    expect(titles()).toEqual(['Doomed']);
    expect(root.querySelector('.trashed .project-sub').textContent).toContain(`${TRASH_DAYS} days left`);

    root.querySelector('.trash-actions .btn').click(); // Restore
    await settle();
    expect(titles()).toEqual([]);
    expect((await lib.listProjects()).map((x) => x.name).sort()).toEqual(['Doomed', 'Keeper']);

    await lib.trashProject(p.id);
    await h.refreshLists();
    root.querySelector('.trash-actions .danger-text').click();
    await settle();
    [...document.querySelectorAll('dialog .btn')].find((b) => b.textContent === 'Delete forever').click();
    await settle();
    expect(await lib.listTrash()).toEqual([]);
    expect(lib.backend.files.has(`projects/${p.id}.json`)).toBe(false);
    expect(root.textContent).toContain('The Trash is empty.');
  });

  it('purges projects that have been in the Trash too long when it opens', async () => {
    const lib = new Library(memoryBackend());
    const old = await lib.createProject({ name: 'Old' });
    const recent = await lib.createProject({ name: 'Recent' });
    await lib.trashProject(old.id, Date.now() - (TRASH_DAYS + 1) * DAY);
    await lib.trashProject(recent.id, Date.now() - DAY);
    history.replaceState(null, '', '#trash');
    mount(lib);
    await settle();
    expect(titles()).toEqual(['Recent']);
    expect(lib.backend.files.has(`projects/${old.id}.json`)).toBe(false);
  });

  it('lists every template in the Templates view and filters by category and search', async () => {
    const h = mount(new Library(memoryBackend()));
    await settle();
    h.show('templates');
    const names = () => [...root.querySelectorAll('.tpl-grid .tpl-name')].map((e) => e.textContent);
    expect(names()).toEqual(TEMPLATES.map((t) => t.name));
    [...root.querySelectorAll('.home-chip')].find((c) => c.textContent === 'Slideshows').click();
    expect(names()).toEqual(TEMPLATES.filter((t) => t.category === 'slideshow').map((t) => t.name));
    const search = root.querySelector('.home-search');
    search.value = 'countdown';
    search.dispatchEvent(new Event('input'));
    expect(names()).toEqual([]);
    [...root.querySelectorAll('.home-chip')].find((c) => c.textContent === 'All').click();
    expect(names()).toEqual(['Countdown']);
  });

  it('opens a template preview with what it contains', async () => {
    const h = mount(new Library(memoryBackend()));
    await settle();
    h.show('templates');
    root.querySelector('.tpl-grid .tpl-card').click();
    const dlg = document.querySelector('dialog');
    expect(dlg.querySelector('.dialog-title').textContent).toBe(TEMPLATES[0].name);
    expect(dlg.textContent).toContain('Use template');
  });

  it('formats sizes and days left', () => {
    expect(formatSize(0)).toBe('0 KB');
    expect(formatSize(1536)).toBe('2 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
    const now = Date.UTC(2026, 2, 1);
    expect(daysLeft(now, now)).toBe(TRASH_DAYS);
    expect(daysLeft(now - 29.5 * DAY, now)).toBe(1);
    expect(daysLeft(now - 40 * DAY, now)).toBe(0);
  });
});

describe('home project list', () => {
  afterEach(() => setPref('homeSort', null));

  it('sorts by name the way people count', async () => {
    const lib = new Library(memoryBackend());
    for (const n of ['Project 10', 'project 2', 'Project 1', 'Álbum']) await lib.createProject({ name: n });
    setPref('homeSort', 'name');
    mount(lib);
    await settle();
    expect(titles()).toEqual(['Álbum', 'Project 1', 'project 2', 'Project 10']);
  });

  it('looks for a missing cover once, not on every search keystroke', async () => {
    const lib = new Library(memoryBackend());
    await lib.createProject({ name: 'No cover' });
    const reads = vi.spyOn(lib, 'coverBlob');
    mount(lib);
    await settle();
    const search = root.querySelector('.home-search');
    for (const q of ['n', 'no', 'no ', 'no c']) {
      search.value = q;
      search.dispatchEvent(new Event('input'));
      await settle(5);
    }
    expect(reads).toHaveBeenCalledTimes(1);
  });
});

