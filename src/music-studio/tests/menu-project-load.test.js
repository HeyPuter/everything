import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { trackMenu, sourceMenu } from '../src/playlist/menus.js';
import { closeMenus } from '../src/ui/menu.js';
import * as E from '../src/model/edits.js';

afterEach(() => {
  closeMenus();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function setup(kind) {
  vi.useFakeTimers();
  const app = new App(document.createElement('div'), { storage: { getItem: () => null, setItem() {} } });
  const store = app.store;
  const view = { app, store, headers: {}, selectTrack: vi.fn(), setSource: vi.fn() };
  if (kind === 'source') sourceMenu(view, { kind: 'pattern', id: store.project.patterns[0].id }, { x: 0, y: 0 });
  else trackMenu(view, 0, { x: 0, y: 0 });
  const item = (label) => [...document.querySelectorAll('.menu button')].find((button) => button.querySelector('.mi-label')?.textContent === label);
  const parent = kind === 'submenu' ? item('Height') : null;
  parent?.click();
  return { store, parent, button: item(kind === 'source' ? 'Clone' : kind === 'submenu' ? 'Large' : 'Mute') };
}

it.each(['track', 'source', 'submenu'])('closes an obsolete %s menu when its project is replaced', (kind) => {
  const { store, parent, button } = setup(kind);
  expect(button).toBeDefined();
  const replacement = structuredClone(store.project);
  store.load(replacement);
  const openAfterLoad = Boolean(document.querySelector('.menu'));
  button.click();
  parent?.dispatchEvent(new MouseEvent('pointerenter'));
  expect(store.project).toBe(replacement);
  expect(store.canUndo).toBe(false);
  expect(openAfterLoad).toBe(false);
  expect(document.querySelector('.menu')).toBeNull();
});

it.each(['track', 'source', 'submenu'])('keeps a %s menu usable after an unrelated tempo edit', (kind) => {
  const { store, button } = setup(kind);
  const patternCount = store.project.patterns.length;
  store.apply('Tempo', (p) => E.setProjectProps(p, { bpm: 99 }));
  expect(document.querySelector('.menu')).not.toBeNull();
  button.click();
  if (kind === 'track') expect(store.project.tracks[0].mute).toBe(true);
  else if (kind === 'source') expect(store.project.patterns).toHaveLength(patternCount + 1);
  else expect(store.project.tracks[0].height).toBe(96);
  expect(store.project.bpm).toBe(99);
  store.undo();
  expect(store.project.tracks[0].mute).toBe(false);
  expect(store.project.patterns).toHaveLength(patternCount);
  expect(store.project.tracks[0].height).toBe(56);
  expect(store.project.bpm).toBe(99);
});
