import { describe, expect, it } from 'vitest';
import type { KeyItem } from '../../src/app/keymap';
import { KeyconfigState, emptyKeyconfig, normalizeKeyconfig, type PresetDef } from '../../src/prefs/keyconfig_core';

function fresh(presets: PresetDef[] = []) {
  const menu = () => [];
  const when = () => true;
  const keymaps: Record<string, KeyItem[]> = {
    Window: [
      { key: 'S', ctrl: true, op: 'wm.save_mainfile' },
      { key: 'F3', op: 'wm.search_menu' },
      { key: 'SPACE', shift: true, op: 'wm.toolbar' },
    ],
    Frames: [{ key: 'SPACE', op: 'screen.animation_play' }],
    'Object Mode': [
      { key: 'A', op: 'object.select_all', props: { action: 'SELECT' }, when },
      { key: 'A', alt: true, op: 'object.select_all', props: { action: 'DESELECT' }, when },
      { key: 'A', shift: true, menu, menuTitle: 'Add', when },
      { key: 'X', op: 'object.delete', when },
      { key: 'X', op: 'object.delete', when },
    ],
  };
  const kc = new KeyconfigState(keymaps, [{ id: 'DEFAULT', label: 'Default', description: '', rules: [], add: [] }, ...presets]);
  kc.snapshot();
  kc.load(emptyKeyconfig());
  return { kc, keymaps, menu, when };
}

describe('key configuration', () => {
  it('gives every factory item a stable unique id', () => {
    const { kc, keymaps } = fresh();
    const ids = Object.values(keymaps).flat().map((k) => kc.idOf(k));
    expect(new Set(ids).size).toBe(ids.length);
    expect(kc.idOf(keymaps['Object Mode'][4])).toMatch(/#1$/);
  });

  it('rebinds an item and restores it', () => {
    const { kc, keymaps } = fresh();
    const save = keymaps.Window[0];
    kc.edit(save, { key: 'W', alt: true });
    expect(save).toMatchObject({ key: 'W', ctrl: true, alt: true });
    expect(kc.isModified(save)).toBe(true);
    expect(Object.values(kc.data.edits)[0]).toEqual({ key: 'W', alt: true });
    kc.restore(save);
    expect(save).toMatchObject({ key: 'S', ctrl: true });
    expect(save.alt).toBeUndefined();
    expect(kc.isModified(save)).toBe(false);
  });

  it('edits value, repeat and operator properties; clearing them drops the edit', () => {
    const { kc, keymaps } = fresh();
    const k = keymaps['Object Mode'][0];
    kc.edit(k, { value: 'DOUBLE_CLICK', repeat: false, props: { action: 'TOGGLE' } });
    expect(k.value).toBe('DOUBLE_CLICK');
    expect(k.repeat).toBe(false);
    expect(k.props).toEqual({ action: 'TOGGLE' });
    kc.edit(k, { value: 'PRESS', repeat: true, props: { action: 'SELECT' } });
    expect(kc.data.edits).toEqual({});
  });

  it('turns a menu item into an operator and back', () => {
    const { kc, keymaps, menu } = fresh();
    const k = keymaps['Object Mode'][2];
    kc.edit(k, { op: 'mesh.primitive_cube_add' });
    expect(k.menu).toBeUndefined();
    expect(k.op).toBe('mesh.primitive_cube_add');
    kc.restore(k);
    expect(k.menu).toBe(menu);
    expect(k.op).toBeUndefined();
  });

  it('disables, removes and restores items', () => {
    const { kc, keymaps } = fresh();
    const k = keymaps.Window[1];
    kc.edit(k, { active: false });
    expect(k.inactive).toBe(true);
    kc.edit(k, { active: true });
    expect(k.inactive).toBeUndefined();
    kc.remove(k);
    expect(kc.isRemoved(k)).toBe(true);
    expect(k.inactive).toBe(true);
    kc.restoreKeymap('Window');
    expect(kc.isRemoved(k)).toBe(false);
    expect(k.inactive).toBeUndefined();
  });

  it('adds user items at the front of a keymap, edits and deletes them', () => {
    const { kc, keymaps } = fresh();
    const k = kc.addItem('Window', { key: 'P', op: 'render.render' });
    expect(keymaps.Window[0]).toBe(k);
    expect(kc.isUserItem(k)).toBe(true);
    kc.edit(k, { ctrl: true, op: 'wm.search_menu' });
    expect(keymaps.Window[0]).toMatchObject({ key: 'P', ctrl: true, op: 'wm.search_menu' });
    expect(kc.data.added[0]).toMatchObject({ key: 'P', ctrl: true, op: 'wm.search_menu', props: {} });
    kc.remove(keymaps.Window[0]);
    expect(kc.data.added).toEqual([]);
    expect(keymaps.Window).toHaveLength(3);
  });

  it('applies keyconfig options (spacebar action, select-all toggle)', () => {
    const { kc, keymaps } = fresh();
    kc.data.options.spacebar_action = 'SEARCH';
    kc.data.options.use_select_all_toggle = true;
    kc.apply();
    expect(keymaps.Frames[0]).toMatchObject({ key: 'SPACE', shift: true, op: 'screen.animation_play' });
    expect(keymaps.Window[0]).toMatchObject({ key: 'SPACE', op: 'wm.search_menu' });
    expect(keymaps.Window.find((k) => k.op === 'wm.toolbar')!.inactive).toBe(true);
    expect(keymaps['Object Mode'][0].props).toEqual({ action: 'TOGGLE' });
    kc.data.options.spacebar_action = 'PLAY';
    kc.data.options.use_select_all_toggle = false;
    kc.apply();
    expect(keymaps.Frames[0].shift).toBeUndefined();
    expect(keymaps.Window).toHaveLength(3);
    expect(keymaps['Object Mode'][0].props).toEqual({ action: 'SELECT' });
  });

  it('applies preset rules and cloned items; user edits sit on top of the preset', () => {
    const preset: PresetDef = {
      id: 'TEST',
      label: 'Test',
      description: '',
      rules: [{ km: 'Object Mode', match: { op: 'object.select_all', props: { action: 'SELECT' }, key: 'A' }, set: { ctrl: true } }],
      add: [{ km: 'Object Mode', like: { op: 'object.select_all', props: { action: 'SELECT' } }, set: { key: 'F', ctrl: false, op: 'view3d.view_selected', props: {} } }],
    };
    const { kc, keymaps, when } = fresh([preset]);
    kc.load({ ...emptyKeyconfig('TEST') });
    const sel = keymaps['Object Mode'].find((k) => k.op === 'object.select_all' && k.props?.action === 'SELECT')!;
    expect(sel.ctrl).toBe(true);
    const added = keymaps['Object Mode'][0];
    expect(added).toMatchObject({ key: 'F', op: 'view3d.view_selected' });
    expect(added.when).toBe(when);
    expect(added.props).toBeUndefined();
    // restoring under a preset goes back to the preset's binding
    kc.edit(sel, { key: 'Q' });
    expect(sel.key).toBe('Q');
    kc.restore(sel);
    expect(sel).toMatchObject({ key: 'A', ctrl: true });
    // switching back to the default preset removes the cloned item
    kc.load(emptyKeyconfig());
    expect(keymaps['Object Mode'][0].op).toBe('object.select_all');
    expect(sel.ctrl).toBeUndefined();
  });

  it('round-trips through export / import and rejects foreign files', () => {
    const { kc, keymaps } = fresh();
    kc.edit(keymaps.Window[0], { key: 'K' });
    kc.addItem('Frames', { key: 'P', op: 'screen.animation_play', props: { reverse: true } });
    const text = JSON.stringify(kc.export('mine'));
    kc.restoreAll();
    expect(keymaps.Window[0].key).toBe('S');
    kc.load(normalizeKeyconfig(JSON.parse(text)));
    expect(keymaps.Window[0].key).toBe('K');
    expect(keymaps.Frames[0]).toMatchObject({ key: 'P', props: { reverse: true } });
    expect(() => normalizeKeyconfig({ hello: 1 })).toThrow();
    expect(() => normalizeKeyconfig(null)).toThrow();
    const cleaned = normalizeKeyconfig({ format: 'p3d-keyconfig', preset: 'DEFAULT', edits: { x: { key: 5, ctrl: true, value: 'BOGUS', evil: 1 } }, added: [{ km: 'Window', key: 'Q', op: 'wm.search_menu', value: 'CLICK' }, { key: 'Z' }] });
    expect(cleaned.edits.x).toEqual({ ctrl: true });
    expect(cleaned.added).toHaveLength(1);
    expect(cleaned.added[0].value).toBe('CLICK');
  });

  it('records items added after startup as factory defaults', () => {
    const { kc, keymaps } = fresh();
    const late: KeyItem = { key: 'L', op: 'late.op' };
    keymaps.Window.push(late);
    kc.snapshot('Window', [late]);
    kc.edit(late, { shift: true });
    expect(late.shift).toBe(true);
    kc.restore(late);
    expect(late.shift).toBeUndefined();
  });
});

describe('keyconfig options', () => {
  it('Tool Keys turn the transform keys into tool switches', () => {
    const keymaps: Record<string, KeyItem[]> = { '3D View': [{ key: 'G', op: 'transform.translate' }, { key: 'R', op: 'transform.rotate' }, { key: 'S', op: 'transform.resize' }] };
    const kc = new KeyconfigState(keymaps, []);
    kc.snapshot();
    kc.load({ ...emptyKeyconfig(), options: { spacebar_action: 'PLAY', use_select_all_toggle: false, use_v3d_tab_menu: false, use_key_activate_tools: true } });
    expect(keymaps['3D View'].map((k) => [k.op, k.props?.name])).toEqual([
      ['wm.tool_set_by_id', 'builtin.move'],
      ['wm.tool_set_by_id', 'builtin.rotate'],
      ['wm.tool_set_by_id', 'builtin.scale'],
    ]);
  });
});

describe('item priority', () => {
  it('puts user items before preset items before factory items', () => {
    const keymaps: Record<string, KeyItem[]> = { Window: [{ key: 'A', op: 'factory.op' }] };
    const preset: PresetDef = { id: 'P', label: 'P', description: '', rules: [], add: [{ km: 'Window', set: { key: 'A', op: 'preset.op' } }] };
    const kc = new KeyconfigState(keymaps, [preset]);
    kc.snapshot();
    kc.load({ ...emptyKeyconfig('P') });
    kc.addItem('Window', { key: 'A', op: 'user.op' });
    expect(keymaps.Window.map((k) => k.op)).toEqual(['user.op', 'preset.op', 'factory.op']);
  });
});
