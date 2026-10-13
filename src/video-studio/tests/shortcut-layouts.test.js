import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createCommands } from '../src/ui/commands.js';
import { createActions } from '../src/ui/actions.js';
import { openShortcutsDialog } from '../src/ui/shortcuts-dialog.js';
import { KEY_LAYOUTS, layoutKeys, findConflicts, findLayout } from '../src/ui/shortcut-layouts.js';
import { setPref } from '../src/ui/prefs.js';
import { US } from '../src/lib/time.js';
import { makeTrack } from '../src/model/project.js';
import { fixture, clip, onMain } from './helpers.js';

function setup() {
  const p = fixture();
  onMain(p, clip('video', 0, 2), clip('video', 2, 2));
  const store = new EditorStore(p);
  const ctx = { store, player: { toggle: vi.fn(), play: vi.fn(), pause: vi.fn() }, timeline: { setTool: vi.fn() } };
  ctx.actions = createActions(ctx);
  return { store, ctx, commands: createCommands(ctx) };
}

const press = (commands, init) => commands.handleKey(new KeyboardEvent('keydown', init));
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  setPref('shortcuts', {});
  setPref('shortcutLayout', 'default');
});

afterEach(() => {
  document.querySelectorAll('dialog, .dialog, .dialog-backdrop').forEach((n) => n.remove());
});

describe('keyboard layouts', () => {
  it('offers Default and two alternative layouts with generic names', () => {
    expect(KEY_LAYOUTS.map((l) => l.id)).toEqual(['default', 'track', 'left-hand']);
    for (const l of KEY_LAYOUTS) expect(l.description.length).toBeGreaterThan(20);
    expect(findLayout('nope').id).toBe('default');
  });

  it('every layout is free of conflicts and only names real commands', () => {
    const { commands } = setup();
    const ids = new Set(commands.list.map((c) => c.id));
    const factory = Object.fromEntries(commands.list.map((c) => [c.id, [...c.defaultKeys]]));
    for (const l of KEY_LAYOUTS) {
      for (const id of Object.keys(l.keys)) expect(ids.has(id), `${l.id}: ${id}`).toBe(true);
      expect(findConflicts(layoutKeys(l.id, factory)), l.id).toEqual([]);
    }
  });

  it('a layout hands its keys over: others lose them', () => {
    const keys = layoutKeys('track', { splitTool: ['B'], selectTool: ['A'], toggleDisabled: ['V'], other: ['C', 'Y'] });
    expect(keys.splitTool).toEqual(['C']);
    expect(keys.selectTool).toEqual(['V']);
    expect(keys.toggleDisabled).toEqual(['Shift+E']);
    expect(keys.other).toEqual(['Y']);
  });

  it('switches layouts: blade, shuttle, marks and nudge follow the convention', () => {
    const { commands, store, ctx } = setup();
    commands.setLayout('track');
    expect(commands.layout).toBe('track');
    expect(commands.keyFor('splitTool')).toBe('C');
    expect(commands.keyFor('split')).toBe('Mod+K');
    expect(commands.keyFor('markIn')).toBe('I');
    expect(commands.keyFor('nudgeRight')).toBe('Period');
    press(commands, { code: 'KeyC', key: 'c' });
    expect(ctx.timeline.setTool).toHaveBeenCalledWith('split');
    // Comma and period nudge the selection by a frame, as one undo step per run.
    const first = clip('video', 1, 2);
    store.project.tracks.unshift({ ...makeTrack('video'), clips: [first] });
    store.select(first.id);
    const start = first.start;
    press(commands, { code: 'Period', key: '.' });
    press(commands, { code: 'Period', key: '.' });
    const frame = Math.round(US / store.fps);
    const moved = store.project.tracks.flatMap((t) => t.clips).find((c) => c.id === first.id);
    expect(moved.start).toBe(start + 2 * frame);
    // The layout persists for the next editor session.
    expect(setup().commands.layout).toBe('track');
    commands.setLayout('left-hand');
    expect(commands.keyFor('shuttleBack')).toBe('A');
    expect(commands.keyFor('selectTool')).toBe('V');
    expect(commands.keyFor('markIn')).toBe('Z');
  });

  it('keeps custom overrides on top, or drops them, and reports conflicts', () => {
    const { commands } = setup();
    commands.setKeys('marker', ['C']);
    expect(commands.customCount()).toBe(1);
    commands.setLayout('track', { keepCustom: true });
    expect(commands.keyFor('marker')).toBe('C');
    expect(commands.isCustom('marker')).toBe(true);
    // C is the blade in this layout: both commands now share it.
    const clashes = commands.allConflicts();
    expect(clashes).toHaveLength(1);
    expect(clashes[0].key).toBe('C');
    expect(clashes[0].commands.map((c) => c.id).sort()).toEqual(['marker', 'splitTool']);
    commands.setLayout('default', { keepCustom: false });
    expect(commands.customCount()).toBe(0);
    expect(commands.keyFor('marker')).toBe('M');
    expect(commands.allConflicts()).toEqual([]);
  });

  it('drops overrides the new layout already matches', () => {
    const { commands } = setup();
    commands.setKeys('splitTool', ['C']);
    commands.setLayout('track');
    expect(commands.isCustom('splitTool')).toBe(false);
    expect(commands.keyFor('splitTool')).toBe('C');
  });
});

describe('shortcuts dialog layouts', () => {
  const layoutBtn = (label) => [...document.querySelectorAll('.shortcut-layout [role=radio]')].find((b) => b.textContent === label);
  const button = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent === text);

  it('switches layout from the selector and shows its description', async () => {
    const { commands } = setup();
    openShortcutsDialog(commands);
    expect(layoutBtn('Default').getAttribute('aria-checked')).toBe('true');
    layoutBtn('Track editing').click();
    await settle();
    expect(commands.layout).toBe('track');
    expect(document.querySelector('.shortcut-layout-desc').textContent).toMatch(/blade/);
    expect(document.querySelector('.shortcut-conflicts').hidden).toBe(true);
    const row = [...document.querySelectorAll('.shortcut-row')].find((r) => r.textContent.startsWith('Split tool'));
    expect(row.querySelector('.kbd-chip').textContent).toBe('C');
  });

  it('asks about custom shortcuts and lists the conflicts it leaves', async () => {
    const { commands } = setup();
    commands.setKeys('marker', ['C']);
    openShortcutsDialog(commands);
    layoutBtn('Track editing').click();
    await settle();
    // Cancel keeps everything as it was.
    button('Cancel').click();
    await settle();
    expect(commands.layout).toBe('default');
    expect(layoutBtn('Default').getAttribute('aria-checked')).toBe('true');
    layoutBtn('Track editing').click();
    await settle();
    button('Keep mine on top').click();
    await settle();
    expect(commands.layout).toBe('track');
    const box = document.querySelector('.shortcut-conflicts');
    expect(box.hidden).toBe(false);
    expect(box.textContent).toMatch(/Add marker/);
    expect(box.textContent).toMatch(/Split tool/);
    const tab = [...document.querySelectorAll('.shortcut-tab')].find((t) => t.textContent === 'Conflicts');
    tab.click();
    expect([...document.querySelectorAll('.shortcut-row')].map((r) => r.querySelector('.shortcut-label').firstChild.textContent).sort()).toEqual(['Add marker', 'Split tool']);
    expect(document.querySelectorAll('.shortcut-row.has-conflict')).toHaveLength(2);
    // Resetting to the layout clears the conflict and the Conflicts tab.
    const reset = [...document.querySelectorAll('.shortcut-row')].find((r) => r.textContent.startsWith('Add marker')).querySelector('[aria-label^="Reset"]');
    reset.click();
    expect(document.querySelector('.shortcut-conflicts').hidden).toBe(true);
    expect([...document.querySelectorAll('.shortcut-tab')].some((t) => t.textContent === 'Conflicts')).toBe(false);
  });

  it('can switch and drop custom shortcuts', async () => {
    const { commands } = setup();
    commands.setKeys('marker', ['Y']);
    openShortcutsDialog(commands);
    layoutBtn('Left hand').click();
    await settle();
    button('Use the layout only').click();
    await settle();
    expect(commands.layout).toBe('left-hand');
    expect(commands.customCount()).toBe(0);
    expect(commands.keyFor('marker')).toBe('F');
  });
});
