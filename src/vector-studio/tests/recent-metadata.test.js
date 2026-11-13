import { afterEach, expect, it, vi } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { Prefs } from '../src/prefs.js';
import { RecentFiles } from '../src/features/files/recent.js';
import { memoryBackend } from '../src/features/files/backends.js';
import { openMenu } from '../src/ui/menubar.js';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
const cloud = { kind: 'puter', path: '/u/Drawing.vstudio', when: 1000 };
function setup(entries) {
  const prefs = new Prefs({ getItem: () => JSON.stringify({ recentFiles: entries }), setItem() {} });
  return { prefs, recent: new RecentFiles(prefs, { cache: memoryBackend() }) };
}

it.each([
  [{ html: '<span data-injected>Unexpected markup</span>' }],
  [{ class: 'unexpected-class' }],
  [null], [42], [[]], [''],
])('keeps an addressable cloud entry usable with a malformed stored name %j', async (name) => {
  const app = await bootAppWithFeatures();
  app.prefs.set('recentFiles', [{ ...cloud, name }]);
  await app.renderHome(app.home);
  expect(app.home.querySelector('[data-injected]')).toBeNull();
  expect(app.home.querySelector('.recent-name')?.textContent).toBe('Drawing.vstudio');
  const entries = app.recentMenuItems();
  expect(entries[0].label).toBe('Drawing.vstudio');
  const menu = openMenu(app, entries, { x: 0, y: 0 });
  try {
    expect(document.querySelector('.menu [data-injected]')).toBeNull();
    expect(document.querySelector('.menu-label').textContent).toBe('Drawing.vstudio');
    const opening = vi.spyOn(app.files.service, 'openPath').mockResolvedValue(null);
    await entries[0].run();
    expect(opening).toHaveBeenCalledWith(cloud.path, { name: 'Drawing.vstudio' });
  } finally { menu.close(); }
});

it('excludes unusable cloud paths and local identifiers while preserving valid neighboring entries', () => {
  const valid = { ...cloud, name: 'Drawing.vstudio' };
  const local = { kind: 'local', name: 'Local.vstudio', handleId: 'handle-1' };
  const { recent } = setup([
    { ...valid, path: '' }, { ...valid, path: {} },
    ...[[], ['handle-1'], {}, true, 42, ''].map((handleId) => ({ ...local, handleId })),
    valid, local,
  ]);
  expect(recent.list().map((entry) => entry.name)).toEqual(['Drawing.vstudio', 'Local.vstudio']);
});

it('keeps normalized local entries removable and retains valid literal names and previews', async () => {
  const local = { kind: 'local', name: { html: 'bad' }, handleId: 'handle-1' };
  const literal = { ...cloud, name: '<span>Literal filename</span>' };
  const { recent } = setup([local, literal]);
  const entries = recent.list();
  expect(entries.map((entry) => entry.name)).toEqual(['Untitled', literal.name]);
  await recent.setThumb(entries[0], 'data:image/png;base64,LOCAL');
  expect(await recent.thumb(recent.list()[0])).toBe('data:image/png;base64,LOCAL');
  await recent.remove(recent.list()[0]);
  expect(recent.list().map((entry) => entry.name)).toEqual([literal.name]);
});

it('validates normalized entries without losing their identity between list reads', async () => {
  const { recent } = setup([{ ...cloud, name: {} }]);
  const entry = recent.list()[0];
  expect(recent.list()[0] === entry).toBe(true);
  const removed = await recent.validate(async () => { throw { code: 'not_found' }; }, { force: true });
  expect(removed.map((item) => item.path)).toEqual([cloud.path]);
  expect(recent.list()).toEqual([]);
});

it.each(['when', 'path'])('keeps Recent files visible when a local entry has malformed %s metadata', async (field) => {
  const app = await bootAppWithFeatures();
  const local = { kind: 'local', name: 'Local.vstudio', handleId: 'handle-1', when: 1000,
    [field]: { toString: 'invalid', valueOf: 'invalid' } };
  app.prefs.set('recentFiles', [local, { ...cloud, name: 'Drawing.vstudio' }]);
  await app.renderHome(app.home);
  expect([...app.home.querySelectorAll('.recent-name')].map((node) => node.textContent)).toEqual(['Local.vstudio', 'Drawing.vstudio']);
});

it('refreshes normalized metadata after source changes without applying an earlier validation result', async () => {
  const { prefs, recent } = setup([{ ...cloud, name: {} }]);
  const raw = prefs.get('recentFiles')[0], original = JSON.stringify(raw);
  const storing = vi.spyOn(prefs, 'set');
  const first = recent.list()[0];
  expect(JSON.stringify(raw)).toBe(original);
  expect(storing).not.toHaveBeenCalled();
  let reject;
  const checking = recent.validate(() => new Promise((resolve, no) => { reject = no; }), { force: true });
  raw.path = '/u/Moved.vstudio';
  const changed = recent.list()[0];
  expect(changed.path).toBe(raw.path);
  expect(changed.name).toBe('Moved.vstudio');
  expect(changed === first).toBe(false);
  expect(recent.list()[0] === changed).toBe(true);
  reject({ code: 'not_found' });
  expect(await checking).toEqual([]);
  expect(recent.list()[0] === changed).toBe(true);
  recent.rename(changed, { name: 'Renamed.vstudio' });
  expect(recent.list()[0].name).toBe('Renamed.vstudio');
});

it('renders valid markup-looking names literally in both Home and Open Recent', async () => {
  const app = await bootAppWithFeatures();
  const name = '<span data-injected>Literal filename</span>';
  app.prefs.set('recentFiles', [{ ...cloud, name }]);
  await app.renderHome(app.home);
  expect(app.home.querySelector('.recent-name').textContent).toBe(name);
  expect(app.home.querySelector('[data-injected]')).toBeNull();
  const menu = openMenu(app, app.recentMenuItems(), { x: 0, y: 0 });
  try {
    expect(document.querySelector('.menu-label').textContent).toBe(name);
    expect(document.querySelector('.menu [data-injected]')).toBeNull();
  } finally { menu.close(); }
});
