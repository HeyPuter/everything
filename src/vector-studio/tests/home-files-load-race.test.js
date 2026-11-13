import { afterEach, expect, it, vi } from 'vitest';
import { installHomeFiles } from '../src/features/files/home-files.js';
import { installHome } from '../src/ui/home.js';
import { Prefs } from '../src/prefs.js';
import { RecentFiles } from '../src/features/files/recent.js';
import { memoryBackend } from '../src/features/files/backends.js';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const item = (name, format = 'svg') => ({ name, path: `/u/${name}`, format, size: 10, modified: 1 });
function setup({ realHome = false } = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const pending = [];
  const app = { home: host, user: { uuid: 'user' }, onSignIn: vi.fn(),
    editors: [], commands: { get: () => null, run: vi.fn() }, newDocument: vi.fn(),
    puter: { fs: { read: vi.fn(async () => new Blob(['{}'])) } },
    renderHome: (root) => { const main = document.createElement('main'); main.className = 'home-main'; root.replaceChildren(main); },
  };
  const files = { cloud: true, recent: { list: () => [], thumb: vi.fn(async () => null) },
    service: { openLocal: vi.fn(), openPath: vi.fn(), listYourFiles: vi.fn(() => { const request = deferred(); pending.push(request); return request.promise; }) },
  };
  if (realHome) installHome(app);
  installHomeFiles(app, files);
  app.renderHome(host);
  return { app, files, host, pending, refresh: () => host.querySelector('[aria-label="Refresh Your files"]').click(),
    names: () => [...host.querySelectorAll('.files-list .recent-name')].map((node) => node.textContent) };
}

it.each(['files', 'empty', 'error'])('ignores an older %s result after a newer refresh succeeds', async (oldResult) => {
  const { host, files, pending, refresh, names } = setup();
  refresh();
  pending[1].resolve([item('Current.svg')]);
  await tick();
  expect(names()).toEqual(['Current.svg']);
  if (oldResult === 'error') pending[0].reject(new Error('Old failure'));
  else pending[0].resolve(oldResult === 'empty' ? [] : [item('Old.svg')]);
  await tick();
  expect(names()).toEqual(['Current.svg']);
  expect(host.querySelector('.files-list').getAttribute('role')).toBe('list');
  expect(files.recent.thumb.mock.calls.map(([entry]) => entry.path)).toEqual(['/u/Current.svg']);
  host.querySelector('.files-list .recent-item').click();
  expect(files.service.openPath).toHaveBeenCalledWith('/u/Current.svg', { name: 'Current.svg' });
});

it('preserves the latest error and allows retry even if an older request later succeeds', async () => {
  const { host, pending, refresh, names } = setup();
  refresh();
  pending[1].reject(new Error('Current failure'));
  await tick();
  pending[0].resolve([item('Stale.svg')]);
  await tick();
  expect(host.querySelector('.files-list').textContent).toContain('unavailable right now');
  expect(host.querySelector('.files-list').hasAttribute('role')).toBe(false);
  host.querySelector('.files-list button').click();
  pending[2].resolve([item('Retried.svg')]);
  await tick();
  expect(names()).toEqual(['Retried.svg']);
});

it('does not load thumbnails for an obsolete Home section after rerender', async () => {
  const { app, files, host, pending, names } = setup();
  app.renderHome(host);
  pending[1].resolve([item('Fresh.svg')]);
  await tick();
  pending[0].resolve([item('Obsolete-native.vstudio', 'native')]);
  await tick();
  expect(names()).toEqual(['Fresh.svg']);
  expect(files.recent.thumb.mock.calls.map(([entry]) => entry.path)).toEqual(['/u/Fresh.svg']);
  expect(app.puter.fs.read).not.toHaveBeenCalled();
});

it('stops a deferred thumbnail lookup when sign-out replaces the Home section', async () => {
  const { app, files, host, pending } = setup();
  const thumb = deferred();
  files.recent.thumb.mockReturnValueOnce(thumb.promise);
  pending[0].resolve([item('Before-signout.vstudio', 'native')]);
  await tick();
  expect(files.recent.thumb).toHaveBeenCalledOnce();
  files.cloud = false;
  app.user = null;
  app.renderHome(host);
  thumb.resolve(null);
  await tick();
  expect(host.querySelector('.files-signin-card')).not.toBeNull();
  expect(app.puter.fs.read).not.toHaveBeenCalled();
});

it('keeps sign-in content when an earlier file request finishes after cloud access changes', async () => {
  const { app, files, host, pending, refresh } = setup();
  files.cloud = false;
  app.user = null;
  refresh();
  pending[0].resolve([item('Old-account.svg')]);
  await tick();
  expect(host.querySelector('.files-signin-card')).not.toBeNull();
  expect(host.querySelector('.files-list').hasAttribute('role')).toBe(false);
  expect(files.recent.thumb).not.toHaveBeenCalled();
});

it('renders current native thumbnails and preserves file actions', async () => {
  const { app, files, host, pending } = setup();
  const thumbnail = 'data:image/png;base64,CURRENT';
  app.puter.fs.read.mockResolvedValue(new Blob([JSON.stringify({ meta: { thumbnail } })]));
  pending[0].resolve([item('Current-native-control.vstudio', 'native')]);
  await vi.waitFor(() => expect(host.querySelector('.files-list img')?.getAttribute('src')).toBe(thumbnail));
  expect(app.puter.fs.read).toHaveBeenCalledOnce();
  host.querySelector('.files-list .recent-item').click();
  expect(files.service.openPath).toHaveBeenCalledWith('/u/Current-native-control.vstudio', { name: 'Current-native-control.vstudio' });
});

it('skips queued thumbnail downloads after a Home section is replaced', async () => {
  const { app, host, pending } = setup();
  const reads = [];
  app.puter.fs.read.mockImplementation(() => { const request = deferred(); reads.push(request); return request.promise; });
  pending[0].resolve(Array.from({ length: 5 }, (_, i) => item(`Queued-native-${i}.vstudio`, 'native')));
  try {
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    app.renderHome(host);
    pending[1].resolve([]);
    for (const read of reads) read.resolve(new Blob(['{}']));
    await tick();
    expect(app.puter.fs.read).toHaveBeenCalledTimes(3);
    expect(host.querySelector('.files-list').textContent).toContain('Files you save with Save As appear here');
  } finally { for (const read of reads) read.resolve(new Blob(['{}'])); await tick(); }
});

it('loads current files alongside the real asynchronous Home renderer', async () => {
  const { host, pending, names } = setup({ realHome: true });
  pending[0].resolve([item('Real-home.svg')]);
  await tick();
  expect(names()).toEqual(['Real-home.svg']);
  expect(host.querySelector('[aria-label="Recent files"]').textContent).toContain('Files you open or save appear here');
  expect(host.querySelector('.preset-card')).not.toBeNull();
});


it.each(['recent', 'native', 'missing'])('shows a newly saved preview despite an unchanged timestamp and a cached %s preview', async (source) => {
  const { app, files, host, pending, refresh } = setup();
  const entry = item(`Preview-freshness-${source}.vstudio`, 'native');
  const oldThumb = 'data:image/png;base64,OLD', newThumb = 'data:image/png;base64,NEW';
  files.cache = memoryBackend();
  files.recent = new RecentFiles(new Prefs(null), { cache: files.cache });
  if (source === 'recent') await files.recent.add({ ...entry, kind: 'puter', thumb: oldThumb });
  app.puter.fs.read.mockResolvedValue(new Blob([JSON.stringify({ meta: { thumbnail: source === 'missing' ? null : oldThumb } })]));
  pending[0].resolve([entry]);
  await tick();
  expect(host.querySelector('.files-list img')?.getAttribute('src') ?? null).toBe(source === 'missing' ? null : oldThumb);
  if (source !== 'recent') expect(app.puter.fs.read).toHaveBeenCalledOnce();
  await files.recent.add({ ...entry, kind: 'puter', thumb: newThumb });
  const reading = vi.spyOn(files.cache, 'readJSON');
  app.puter.fs.read.mockClear();
  refresh();
  pending[1].resolve([entry]);
  await tick();
  expect(host.querySelector('.files-list img')?.getAttribute('src')).toBe(newThumb);
  expect(reading).not.toHaveBeenCalled();
  expect(app.puter.fs.read).not.toHaveBeenCalled();
});

it('reuses unchanged native previews without repeated cache reads or downloads', async () => {
  const { app, files, host, pending, refresh } = setup();
  const entry = item('Preview-cache-fast-path.vstudio', 'native');
  const thumbnail = 'data:image/png;base64,UNCHANGED';
  files.cache = memoryBackend();
  files.recent = new RecentFiles(new Prefs(null), { cache: files.cache });
  app.puter.fs.read.mockResolvedValue(new Blob([JSON.stringify({ meta: { thumbnail } })]));
  pending[0].resolve([entry]);
  await vi.waitFor(() => expect(host.querySelector('.files-list img')?.getAttribute('src')).toBe(thumbnail));
  const reading = vi.spyOn(files.cache, 'readJSON');
  refresh();
  pending[1].resolve([entry]);
  await tick();
  expect(host.querySelector('.files-list img')?.getAttribute('src')).toBe(thumbnail);
  expect(reading).not.toHaveBeenCalled();
  expect(app.puter.fs.read).toHaveBeenCalledOnce();
});
