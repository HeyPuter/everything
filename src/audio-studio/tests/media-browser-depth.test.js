// Media Browser: file type filters, metadata columns and favorite folders.
import { describe, it, expect, beforeAll } from 'vitest';
import { filterItems, matchesFilter, MEDIA_FILTERS, modifiedText } from '../src/panels/media-browser.js';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

const items = ['a.wav', 'b.mp3', 'c.flac', 'd.mp4', 'e.asesx', 'f.txt', 'g.aif'].map((name) => ({ name, path: `/u/${name}` }));

describe('type filters', () => {
  it('narrow the list to one kind of file', () => {
    const names = (type) => filterItems(items, { type }).map((i) => i.name);
    expect(names('audio')).toEqual(['a.wav', 'b.mp3', 'c.flac', 'd.mp4', 'g.aif']);
    expect(names('wav')).toEqual(['a.wav']);
    expect(names('video')).toEqual(['d.mp4']);
    expect(names('session')).toEqual(['e.asesx']);
    expect(names('all')).toHaveLength(7);
    expect(filterItems(items, { audioOnly: false }).length).toBe(7);
    expect(matchesFilter('X.FLAC', 'flac')).toBe(true);
    expect(MEDIA_FILTERS.at(-1).id).toBe('all');
  });
  it('formats modified times given in seconds or milliseconds alike', () => {
    expect(modifiedText(1700000000)).toBe(modifiedText(1700000000000));
    expect(modifiedText(0)).toBe('');
  });
});

describe('Media Browser panel', () => {
  it('shows chosen columns, filters by type and keeps favorite folders in the tree', async () => {
    const { App } = await import('../src/app.js');
    const { installCore } = await import('../src/features/core.js');
    const { installIo } = await import('../src/features/io.js');
    localStorage.clear();
    const app = new App();
    installCore(app);
    installIo(app);
    app.prefs.set('mediaFavorites', [{ path: '/u/Music', name: 'Music' }]);
    const panel = app.panels.get('media').create(app);
    document.body.replaceChildren(panel.el);
    const heads = () => [...panel.el.querySelectorAll('.media-table th')].map((t) => t.textContent);
    expect(heads()).toEqual(['Name', 'Duration', 'Format', 'Size']);
    const menu = panel.menu();
    menu.find((i) => i.label === 'Columns').items.find((i) => i.label === 'Sample Rate').run();
    expect(heads()).toEqual(['Name', 'Duration', 'Format', 'Sample Rate', 'Size']);
    const show = panel.menu().find((i) => i.label === 'Show');
    show.items.find((i) => i.label === 'Video Files').run();
    expect(app.prefs.get('mediaFilter')).toBe('video');
    expect(panel.el.querySelector('.media-filter-btn').getAttribute('aria-label')).toMatch(/Video Files/);
    panel.show();
    await new Promise((r) => setTimeout(r, 0));
    const fav = panel.el.querySelector('[role=treeitem][data-favorite="true"]');
    expect(fav?.textContent).toBe('Music');
  });
});
