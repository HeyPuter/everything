import { describe, it, expect } from 'vitest';
import type { PanelLocation } from '../src/app/registry';
import { sanitizeDockLayout } from '../src/app/dock';
import {
  baseSnapshot, deleteWorkspace, presetDockLayout, sanitizeWorkspaceState, saveWorkspace, switchWorkspace, workspacePresets,
  type WorkspaceSnapshot,
} from '../src/features/workspace/layouts';
import { EXTRA_SLOT, assignTool, sanitizeToolbarLayout, slotOrder, slotTools, toolSlot } from '../src/app/toolbar-layout';
import { customizeItem, isHiddenInMenus, menuTag, sanitizeMenuCustomization } from '../src/app/menu-custom';
import { moveItem, parsePresetFile, presetFile, uniqueName } from '../src/features/workspace/preset-file';

const registered: [string, PanelLocation][] = [
  ['color', 'dock-top'], ['swatches', 'dock-top'], ['properties', 'dock-middle'], ['adjustments', 'dock-middle'],
  ['layers', 'dock-bottom'], ['channels', 'dock-bottom'], ['paths', 'dock-bottom'],
  ['history', 'strip'], ['navigator', 'strip'], ['info', 'strip'], ['histogram', 'strip'], ['brushes', 'strip'],
];
const preset = (id: string) => workspacePresets.find((p) => p.id === id)!;
const snapshot = (dock = sanitizeDockLayout({})): WorkspaceSnapshot => ({ dock, optionsBar: true, toolsPanel: true });

describe('workspace presets', () => {
  it('Essentials keeps every panel where it registered', () => {
    expect(presetDockLayout(preset('essentials'), registered)).toEqual({ active: {}, collapsed: [], sizes: {} });
  });
  it('places listed panels in their groups and the rest in the strip', () => {
    const l = presetDockLayout(preset('photography'), registered);
    expect(l.active).toEqual({ 'dock-top': 'histogram', 'dock-middle': 'adjustments', 'dock-bottom': 'layers' });
    expect(l.placement).toMatchObject({ histogram: 'dock-top', navigator: 'dock-top', info: 'dock-top', history: 'dock-bottom', color: 'strip', swatches: 'strip' });
    // Panels already in their registered location need no override.
    expect(l.placement).not.toHaveProperty('layers');
    expect(l.placement).not.toHaveProperty('adjustments');
    expect(l.placement).not.toHaveProperty('brushes');
    // Unregistered panels named by a preset are skipped; every registered one is ordered once.
    expect(l.order).not.toContain('tool-presets');
    expect(new Set(l.order).size).toBe(registered.length);
    expect(l.order!.slice(0, 3)).toEqual(['histogram', 'navigator', 'info']);
    expect(l.sizes['dock-bottom']).toBe(380);
  });
  it('panels registered under the canvas stay out of the side dock; Motion opens the Timeline there', () => {
    const withTimeline: [string, PanelLocation][] = [...registered, ['timeline', 'bottom']];
    for (const p of workspacePresets) {
      const l = presetDockLayout(p, withTimeline);
      expect(l.placement ?? {}, p.id).not.toHaveProperty('timeline');
      expect(l.order ?? [], p.id).not.toContain('timeline');
      expect(Object.values(l.active), p.id).not.toContain('timeline');
    }
    expect(baseSnapshot({ saved: [] }, 'motion', withTimeline).bottom).toBe('timeline');
    expect(baseSnapshot({ saved: [] }, 'photography', withTimeline).bottom).toBeUndefined();
    // Without a Timeline panel there is nothing to open.
    expect(baseSnapshot({ saved: [] }, 'motion', registered).bottom).toBeUndefined();
  });
  it('every preset produces a valid layout', () => {
    for (const p of workspacePresets) {
      const l = presetDockLayout(p, registered);
      expect(sanitizeDockLayout(l)).toEqual(l);
    }
  });
});

describe('workspace state', () => {
  it('remembers changes per workspace and restores them when switching back', () => {
    let state = sanitizeWorkspaceState(null);
    expect(state.current).toBe('essentials');
    const moved = snapshot(sanitizeDockLayout({ placement: { layers: 'strip' } }));
    const a = switchWorkspace(state, moved, 'painting', registered);
    state = a.state;
    expect(state.current).toBe('painting');
    expect(a.show.dock.active['dock-top']).toBe('color');
    expect(state.modified.essentials.dock.placement).toEqual({ layers: 'strip' });
    const b = switchWorkspace(state, a.show, 'essentials', registered);
    expect(b.show.dock.placement).toEqual({ layers: 'strip' });
    // Reset restores the preset itself.
    expect(baseSnapshot(b.state, 'essentials', registered).dock).toEqual(sanitizeDockLayout({}));
  });
  it('saves, replaces by name and deletes workspaces', () => {
    let state = sanitizeWorkspaceState(null);
    state = saveWorkspace(state, ' Retouch ', { ...snapshot(), shortcuts: { 'edit.undo': 'Mod+U' } }, 'user-1');
    expect(state.current).toBe('user-1');
    expect(state.saved).toEqual([{ id: 'user-1', name: 'Retouch', snapshot: { ...snapshot(), shortcuts: { 'edit.undo': 'Mod+U' } } }]);
    state = saveWorkspace(state, 'retouch', { ...snapshot(), optionsBar: false }, 'user-2');
    expect(state.saved).toHaveLength(1);
    expect(state.saved[0].snapshot.optionsBar).toBe(false);
    expect(baseSnapshot(state, 'user-1', registered).optionsBar).toBe(false);
    state = deleteWorkspace(state, 'user-1');
    expect(state.saved).toEqual([]);
    expect(state.current).toBe('essentials');
  });
  it('drops malformed stored state', () => {
    const state = sanitizeWorkspaceState({
      current: 'gone',
      locked: true,
      saved: [{ id: 'a', name: 'A', snapshot: { dock: { collapsed: ['dock-top', 'nowhere'], placement: { layers: 'moon' } } } }, { id: 'b', name: '', snapshot: {} }, 'junk'],
      modified: { a: { dock: {} }, zzz: { dock: {} } },
    });
    expect(state.current).toBe('essentials');
    expect(state.locked).toBe(true);
    expect(state.saved.map((s) => s.id)).toEqual(['a']);
    expect(state.saved[0].snapshot.dock.collapsed).toEqual(['dock-top']);
    expect(state.saved[0].snapshot.dock.placement).toBeUndefined();
    expect(Object.keys(state.modified)).toEqual(['a']);
  });
});

describe('toolbar customization', () => {
  const tools = [
    { id: 'move', group: 'move' }, { id: 'marquee', group: 'marquee' }, { id: 'ellipse', group: 'marquee' }, { id: 'zoom', group: 'zoom' },
  ];
  it('orders slots, keeping slots the layout does not mention near their default place', () => {
    expect(slotOrder(['a', 'b', 'c', 'd'], {})).toEqual(['a', 'b', 'c', 'd']);
    expect(slotOrder(['a', 'b', 'c', 'd'], { order: ['c', 'a'] })).toEqual(['c', 'd', 'a', 'b']);
    expect(slotOrder(['a', 'b'], { order: ['x', 'b', 'b'] })).toEqual(['a', 'b']);
  });
  it('moves tools between slots and to the extra tools', () => {
    let layout = assignTool({}, tools[2], EXTRA_SLOT);
    expect(slotTools(tools, 'marquee', layout).map((t) => t.id)).toEqual(['marquee']);
    expect(slotTools(tools, EXTRA_SLOT, layout).map((t) => t.id)).toEqual(['ellipse']);
    layout = assignTool(layout, tools[3], 'move');
    expect(toolSlot(tools[3], layout)).toBe('move');
    // Returning tools to their own slots leaves no trace.
    layout = assignTool(assignTool(layout, tools[2], 'marquee'), tools[3], 'zoom');
    expect(layout).toEqual({});
  });
  it('sanitizes stored layouts', () => {
    expect(sanitizeToolbarLayout({ order: ['a', 3], assign: { x: 'extra', y: 5 } })).toEqual({ order: ['a'], assign: { x: 'extra' } });
    expect(sanitizeToolbarLayout('nope')).toEqual({});
  });
});

describe('menu customization', () => {
  it('hides and colors commands', () => {
    let c = customizeItem({}, 'edit.fade', { hidden: true });
    c = customizeItem(c, 'edit.fill', { color: 'green' });
    expect(isHiddenInMenus(c, 'edit.fade')).toBe(true);
    expect(isHiddenInMenus(c, 'edit.fill')).toBe(false);
    expect(menuTag(c, 'edit.fill')).toBe('green');
    c = customizeItem(customizeItem(c, 'edit.fade', { hidden: false }), 'edit.fill', { color: null });
    expect(c).toEqual({});
  });
  it('ignores unknown colors and malformed data', () => {
    expect(sanitizeMenuCustomization({ hidden: ['a', 'a', 7], colors: { a: 'red', b: 'plaid' } })).toEqual({ hidden: ['a'], colors: { a: 'red' } });
    expect(sanitizeMenuCustomization(null)).toEqual({});
  });
});

describe('preset files', () => {
  const valid = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
  it('round-trips presets of one kind and skips invalid items', () => {
    const text = JSON.stringify(presetFile('swatches', ['#112233', 'red', '#abcdef']));
    expect(parsePresetFile(text, 'swatches', valid)).toEqual({ items: ['#112233', '#abcdef'], skipped: 1 });
  });
  it('rejects other files and kinds', () => {
    expect(() => parsePresetFile('{', 'swatches', valid)).toThrow(/not a preset file/);
    expect(() => parsePresetFile('{"items":[]}', 'swatches', valid)).toThrow(/not a preset file/);
    expect(() => parsePresetFile(JSON.stringify(presetFile('brushes', [])), 'swatches', valid)).toThrow(/brushes presets/);
    expect(() => parsePresetFile(JSON.stringify({ ...presetFile('swatches', []), version: 2 }), 'swatches', valid)).toThrow(/newer/);
  });
  it('reorders and names', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
    expect(uniqueName('Brush', ['brush', 'Brush 2'])).toBe('Brush 3');
    expect(uniqueName('  ', [])).toBe('Preset');
  });
});
