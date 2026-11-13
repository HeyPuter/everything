import { it, expect } from 'vitest';
import { Shell } from '../src/ui/shell.js';
import { ProjectFiles } from '../src/storage/files.js';
import { Prefs, DEFAULTS } from '../src/lib/prefs.js';

it.each(['true', '42', '"old preferences"', '[]'])('recovers from a non-object preferences payload: %s', (raw) => {
  let saved = raw;
  const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
  const prefs = new Prefs(storage);
  expect(prefs.get('theme')).toBe(DEFAULTS.theme);
  prefs.set('theme', 'dark');
  expect(new Prefs(storage).get('theme')).toBe('dark');
});

it('preserves valid stored preferences and merges newly added default fields', () => {
  const prefs = new Prefs({ getItem: () => JSON.stringify({ theme: 'dark', layout: { browser: 300 }, customSetting: 7 }) });
  expect(prefs.get('theme')).toBe('dark');
  expect(prefs.get('layout')).toEqual({ ...DEFAULTS.layout, browser: 300 });
  expect(prefs.get('customSetting')).toBe(7);
});

it.each([null, [], { dockPanels: {} }, { dockPanels: null }].map((value) => [value]))('opens the workspace with malformed saved layout %j', (layout) => {
  const prefs = new Prefs({ getItem: () => JSON.stringify({ theme: 'dark', layout }) });
  const app = { prefs, emit() {} };
  const root = document.createElement('div');
  const shell = new Shell(app, root);
  expect(() => shell.layout()).not.toThrow();
  expect(shell.openSet().has('rack')).toBe(true);
  expect(prefs.get('theme')).toBe('dark');
});

it('keeps valid recent projects when damaged entries are present', () => {
  const prefs = new Prefs({ getItem: () => JSON.stringify({ recent: [null, 1, {}, { path: 42 }, { local: 'local-id', name: 'Local song' }, { path: '/song.msproj', name: 'Cloud song' }] }) });
  const app = { prefs };
  const files = { app, signedIn: () => true };
  let items;
  expect(() => { items = ProjectFiles.prototype.recentMenuItems.call(files); }).not.toThrow();
  expect(items.filter((i) => i.type === 'cmd').map((i) => i.label)).toEqual(['Local song', 'Cloud song', 'Clear recent projects']);
  ProjectFiles.prototype.addRecent.call(files, { local: 'next', name: 'Next song' });
  expect(prefs.get('recent')).toHaveLength(3);
});

it('recovers collection and object settings without losing unrelated preferences', () => {
  const prefs = new Prefs({ getItem: () => JSON.stringify({ browserExpanded: {}, snap: null, dismissedNotices: {}, noteDefaults: { len: 'bad', vel: 0.5 }, theme: 'dark' }) });
  expect(() => new Set(prefs.get('browserExpanded') || [])).not.toThrow();
  expect(prefs.get('snap').playlist).toBe('line');
  expect(prefs.get('dismissedNotices').includes('localSave')).toBe(false);
  expect(prefs.get('noteDefaults')).toEqual({ len: 24, vel: 0.5 });
  expect(prefs.get('theme')).toBe('dark');
});

it('preserves deliberate empty collections, unknown settings, and partial layout values', () => {
  const prefs = new Prefs({ getItem: () => JSON.stringify({ layout: { dockPanels: [], browser: 310, dockSizes: { rack: 2 } }, browserExpanded: [], recent: [], extra: { future: true } }) });
  expect(prefs.get('layout').dockPanels).toEqual([]);
  expect(prefs.get('layout').browser).toBe(310);
  expect(prefs.get('layout').dockSizes).toEqual({ rack: 2, mixer: 1.3 });
  expect(prefs.get('browserExpanded')).toEqual([]);
  expect(prefs.get('extra')).toEqual({ future: true });
});
