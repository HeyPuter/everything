import { describe, it, expect } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { arrangeRecent } from '../src/ui/home.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ITEMS = [
  { name: 'zebra.vstudio', when: 'now' },
  { name: 'Apple 10.vstudio', when: '1 h ago' },
  { name: 'apple 2.vstudio', when: '2 h ago' },
];

describe('Home screen', () => {
  it('sorts and filters recent files', () => {
    expect(arrangeRecent(ITEMS).map((i) => i.name)).toEqual(ITEMS.map((i) => i.name));
    expect(arrangeRecent(ITEMS, { sort: 'name' }).map((i) => i.name)).toEqual(['apple 2.vstudio', 'Apple 10.vstudio', 'zebra.vstudio']);
    expect(arrangeRecent(ITEMS, { filter: 'APP' })).toHaveLength(2);
  });

  it('filters, sorts and switches the recent list view', async () => {
    const app = await bootAppWithFeatures();
    app.recentFiles = async () => ITEMS;
    await app.renderHome(app.home);
    await tick();
    const home = app.home;
    const names = () => [...home.querySelectorAll('.recent-list .recent-name')].map((n) => n.textContent);
    expect(names()).toHaveLength(3);
    const filter = home.querySelector('.home-filter');
    filter.value = 'zeb';
    filter.dispatchEvent(new Event('input'));
    expect(names()).toEqual(['zebra.vstudio']);
    filter.value = 'nothing';
    filter.dispatchEvent(new Event('input'));
    expect(home.querySelector('.recent-list').hasAttribute('role')).toBe(false);
    filter.value = '';
    filter.dispatchEvent(new Event('input'));
    const sort = home.querySelector('.home-sort');
    sort.value = 'name';
    sort.dispatchEvent(new Event('change'));
    expect(names()[0]).toBe('apple 2.vstudio');
    expect(app.prefs.get('homeRecentSort')).toBe('name');
    home.querySelector('.home-view[data-mode="list"]').click();
    expect(home.querySelector('.recent-list').classList.contains('list-view')).toBe(true);
    expect(app.prefs.get('homeRecentView')).toBe('list');
  });

  it('hides the quick start presets and offers more presets', async () => {
    const app = await bootAppWithFeatures();
    app.recentFiles = async () => [];
    await app.renderHome(app.home);
    const toggle = app.home.querySelector('.home-toggle');
    toggle.click();
    expect(app.home.querySelector('#home-presets').hidden).toBe(true);
    expect(app.prefs.get('homeHidePresets')).toBe(true);
    // The recent tools only show when there are recent files.
    expect(app.home.querySelector('.home-recent-tools').hidden).toBe(true);
    let ran = null;
    const run = app.commands.run.bind(app.commands);
    app.commands.run = (id, args) => ((ran = id), id === 'file.new' ? null : run(id, args));
    app.home.querySelector('.preset-more').click();
    expect(ran).toBe('file.new');
  });
});
