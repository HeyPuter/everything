// Every menu entry and default shortcut points at a registered command with a label, so
// features changed in parallel cannot leave dead menu items or keys behind.
import { describe, it, expect, beforeAll } from 'vitest';
import { MENUS, WAVEFORM_CONTEXT, effectMenuSpec } from '../src/ui/menus.js';
import { DEFAULT_KEYS } from '../src/commands/keymap.js';
import { VIDEO_CONTEXT } from '../src/video/video-lane.js';
import { CLIP_CONTEXT, TRACK_CONTEXT, LANE_CONTEXT } from '../src/multitrack/menus.js';

let app;
beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { FEATURES } = await import('../src/features.js');
  app = new App();
  for (const install of FEATURES) install(app);
});

/** Command ids named by a menu spec, with the path to each (expanding computed parts). */
function menuIds(items, path, out = []) {
  for (const it of items) {
    if (it === '-' || it == null) continue;
    if (typeof it === 'string') out.push({ id: it, path });
    else if (it.submenu) menuIds(it.submenu, `${path} > ${it.label}`, out);
    else if (it.expand) menuIds(it.expand(app), path, out);
    else if (it.id) out.push({ id: it.id, path });
  }
  return out;
}

describe('menus and keymap', () => {
  it('every menu bar entry is a registered command with a label', () => {
    const ids = MENUS.flatMap((m) => menuIds(m.submenu || [], m.label));
    expect(ids.length).toBeGreaterThan(300);
    const missing = ids.filter(({ id }) => !app.commands.get(id)).map(({ id, path }) => `${path}: ${id}`);
    expect(missing).toEqual([]);
    const unlabeled = ids.filter(({ id }) => {
      const label = app.commands.label(id);
      return typeof label !== 'string' || !label.trim() || label === id;
    });
    expect(unlabeled.map((x) => x.id)).toEqual([]);
  });

  it('every context menu entry is a registered command', () => {
    const lists = { WAVEFORM_CONTEXT, VIDEO_CONTEXT, CLIP_CONTEXT, TRACK_CONTEXT, LANE_CONTEXT };
    const missing = Object.entries(lists).flatMap(([name, items]) => menuIds(items, name).filter(({ id }) => !app.commands.get(id)).map(({ id, path }) => `${path}: ${id}`));
    expect(missing).toEqual([]);
  });

  it('the effect menus by name list registered effects', () => {
    app.prefs.set('fxMenuSort', 'name');
    const ids = menuIds(effectMenuSpec(app), 'Effects');
    app.prefs.set('fxMenuSort', 'category');
    expect(ids.filter(({ id }) => !app.commands.get(id))).toEqual([]);
  });

  it('every default shortcut belongs to a registered command, and no key runs two commands', () => {
    expect(Object.keys(DEFAULT_KEYS).filter((id) => !app.commands.get(id))).toEqual([]);
    const owners = new Map();
    const clashes = [];
    for (const id of app.commands.commands.keys()) {
      for (const k of app.commands.keysFor(id)) {
        const key = k.toLowerCase();
        if (owners.has(key) && owners.get(key) !== id) clashes.push(`${k}: ${owners.get(key)} and ${id}`);
        else owners.set(key, id);
      }
    }
    expect(clashes).toEqual([]);
  });
});
