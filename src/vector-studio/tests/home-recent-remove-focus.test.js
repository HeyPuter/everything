import { afterEach, expect, it, vi } from 'vitest';
import { installHome } from '../src/ui/home.js';
import { Prefs } from '../src/prefs.js';
import { RecentFiles } from '../src/features/files/recent.js';
import { memoryBackend } from '../src/features/files/backends.js';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function setup(names = ['Alpha', 'Beta', 'Gamma']) {
  const prefs = new Prefs(null), cache = memoryBackend();
  const recent = new RecentFiles(prefs, { cache });
  for (const name of names.slice().reverse()) await recent.add({ kind: 'puter', path: `/u/${name}.vstudio`, name, thumb: 'data:image/png;base64,PREVIEW' });
  const host = document.createElement('div');
  document.body.append(host);
  const pending = [];
  const remove = cache.remove;
  vi.spyOn(cache, 'remove').mockImplementation(async (...args) => {
    await new Promise((resolve) => { pending.push(resolve); });
    return remove(...args);
  });
  const app = { prefs, editors: [], commands: { get: () => null, run: vi.fn() },
    newDocument: vi.fn(), recentFiles: async () => recent.list(),
    removeRecent: (entry) => recent.remove(entry), openRecent: vi.fn(),
  };
  installHome(app);
  await app.renderHome(host);
  const removeButton = (name) => host.querySelector(`[aria-label="Remove ${name} from recent"]`);
  const openButton = (name) => [...host.querySelectorAll('.recent-item')].find((button) => button.querySelector('.recent-name').textContent === name);
  const begin = async (name, focus = true) => {
    const count = pending.length;
    const button = removeButton(name);
    if (focus) button.focus();
    button.click();
    await vi.waitFor(() => expect(pending).toHaveLength(count + 1));
  };
  const finish = async () => { pending.shift()(); await tick(); };
  return { app, host, recent, pending, removeButton, openButton, begin, finish };
}

it('does not take focus from the filter after a slow thumbnail deletion finishes', async () => {
  const { host, begin, finish, openButton } = await setup();
  await begin('Alpha');
  const filter = host.querySelector('.home-filter');
  filter.focus();
  filter.value = 'Beta';
  filter.dispatchEvent(new Event('input'));
  await finish();
  expect(document.activeElement).toBe(filter);
  expect(openButton('Beta')).toBeDefined();
  expect(openButton('Alpha')).toBeUndefined();
});

it.each(['open', 'remove'])('preserves the newly focused %s control on a different file', async (control) => {
  const { app, begin, finish, removeButton, openButton } = await setup();
  await begin('Alpha');
  const target = control === 'open' ? openButton('Beta') : removeButton('Gamma');
  target.focus();
  await finish();
  expect(document.activeElement).toBe(target);
  expect(removeButton('Alpha')).toBeNull();
  if (control === 'open') {
    target.click();
    expect(app.openRecent).toHaveBeenCalledWith(expect.objectContaining({ name: 'Beta' }));
  }
});

it('preserves focus moved to another file even when removal did not initially take focus', async () => {
  const { begin, finish, openButton } = await setup();
  await begin('Alpha', false);
  const target = openButton('Beta');
  target.focus();
  await finish();
  expect(document.activeElement).toBe(target);
});

it('does not let an obsolete Home render focus controls in its replacement', async () => {
  const { app, host, begin, finish } = await setup(['Alpha']);
  await begin('Alpha');
  await app.renderHome(host);
  const target = host.querySelector('.preset-card');
  target.focus();
  await finish();
  expect(document.activeElement).toBe(target);
});

it.each([['Alpha', 'Beta'], ['Gamma', 'Beta']])('moves focus from removed %s to the nearest remaining file %s', async (name, next) => {
  const { begin, finish, removeButton, recent } = await setup();
  await begin(name);
  await finish();
  expect(document.activeElement).toBe(removeButton(next));
  expect(recent.list().some((entry) => entry.name === name)).toBe(false);
});

it('moves focus to New file when the final focused recent entry is removed', async () => {
  const { host, begin, finish } = await setup(['Alpha']);
  await begin('Alpha');
  await finish();
  expect(document.activeElement).toBe(host.querySelector('.home-side .btn'));
  expect(host.querySelector('.recent-list').hasAttribute('role')).toBe(false);
  expect(host.querySelector('.recent-list').textContent).toContain('Files you open or save appear here');
});

it('uses the currently displayed row after sorting replaces a pending removal button', async () => {
  const { host, begin, finish, removeButton } = await setup(['Gamma', 'Alpha', 'Beta']);
  await begin('Gamma');
  const sort = host.querySelector('.home-sort');
  sort.value = 'name';
  sort.dispatchEvent(new Event('change'));
  removeButton('Gamma').focus();
  await finish();
  expect(document.activeElement).toBe(removeButton('Beta'));
  expect(removeButton('Gamma')).toBeNull();
});

it('keeps focus on another pending removal until that operation finishes', async () => {
  const { begin, finish, removeButton, pending, host } = await setup();
  await begin('Alpha');
  await begin('Gamma');
  const gamma = removeButton('Gamma');
  await finish();
  expect(document.activeElement).toBe(gamma);
  expect(pending).toHaveLength(1);
  await finish();
  expect(document.activeElement).toBe(removeButton('Beta'));
  expect(host.querySelectorAll('.recent-cell')).toHaveLength(1);
});

it('preserves the filter and shows its empty state after removing the final matching row', async () => {
  const { host, begin, finish, openButton } = await setup();
  const filter = host.querySelector('.home-filter');
  filter.value = 'Alpha';
  filter.dispatchEvent(new Event('input'));
  await begin('Alpha');
  filter.focus();
  await finish();
  expect(document.activeElement).toBe(filter);
  expect(host.querySelector('.recent-list').textContent).toContain('No recent files match the filter');
  expect(host.querySelector('.recent-list').hasAttribute('role')).toBe(false);
  filter.value = '';
  filter.dispatchEvent(new Event('input'));
  expect(openButton('Beta')).toBeDefined();
  expect(openButton('Gamma')).toBeDefined();
  expect(openButton('Alpha')).toBeUndefined();
});

it('keeps the Open control type when focus moved within the removed row', async () => {
  const { begin, finish, openButton } = await setup();
  await begin('Alpha');
  openButton('Alpha').focus();
  await finish();
  expect(document.activeElement).toBe(openButton('Beta'));
});
