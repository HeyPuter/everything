import { describe, expect, it } from 'vitest';
import {
  pinnedAt,
  placeBar,
  quickCommandIds,
  quickExtras,
  quickItems,
  quickState,
  validPinned,
  type QuickContext,
} from '../src/features/retouch/taskbar-actions';

const base: QuickContext = {
  hasDocument: true,
  selection: false,
  quickMask: false,
  editingMask: false,
  layers: [],
};
const labels = (s: Parameters<typeof quickItems>[0]) => quickItems(s).map((i) => i.label);

describe('Quick Actions Bar state', () => {
  it('follows the selection, the mask target and the layer kind', () => {
    expect(quickState({ ...base, hasDocument: false })).toBe('none');
    expect(quickState(base)).toBe('empty');
    expect(quickState({ ...base, layers: [{ kind: 'pixel' }] })).toBe('pixel');
    expect(quickState({ ...base, layers: [{ kind: 'image' }] })).toBe('pixel');
    expect(quickState({ ...base, layers: [{ kind: 'image', embedded: true }] })).toBe('embedded');
    expect(quickState({ ...base, layers: [{ kind: 'text' }] })).toBe('type');
    expect(quickState({ ...base, layers: [{ kind: 'vector' }] })).toBe('shape');
    expect(quickState({ ...base, layers: [{ kind: 'adjustment' }] })).toBe('adjustment');
    expect(quickState({ ...base, layers: [{ kind: 'solid' }] })).toBe('fill');
    expect(quickState({ ...base, layers: [{ kind: 'group' }] })).toBe('group');
    expect(quickState({ ...base, layers: [{ kind: 'pixel' }, { kind: 'text' }] })).toBe('multiple');
  });
  it('puts a selection first, and a quick mask before that', () => {
    const layers = [{ kind: 'text' }];
    expect(quickState({ ...base, layers, selection: true })).toBe('selection');
    expect(quickState({ ...base, layers, selection: true, quickMask: true })).toBe('quick-mask');
  });
  it('offers mask actions only while a mask is the edit target', () => {
    expect(
      quickState({ ...base, editingMask: true, layers: [{ kind: 'pixel', hasMask: true }] }),
    ).toBe('mask');
    // A target without a mask (just deleted) falls back to the layer.
    expect(quickState({ ...base, editingMask: true, layers: [{ kind: 'pixel' }] })).toBe('pixel');
    expect(
      quickState({ ...base, editingMask: false, layers: [{ kind: 'pixel', hasMask: true }] }),
    ).toBe('pixel');
  });
});

describe('Quick Actions Bar contents', () => {
  it('lists the likely next steps per state', () => {
    expect(labels('selection')).toEqual([
      'AI Fill',
      'Context Fill',
      'Modify',
      'Invert',
      'Mask',
      'Copy to Layer',
      'Deselect',
    ]);
    expect(labels('pixel')).toEqual([
      'Select Subject',
      'Remove Background',
      'Add Mask',
      'Transform',
    ]);
    expect(labels('mask')).toContain('Invert Mask');
    expect(labels('type')).toContain('Warp Text');
    expect(labels('multiple')).toEqual(['Group', 'Merge', 'Align', 'Link', 'Transform']);
    expect(quickItems('none')).toEqual([]);
  });
  it('opens the selection modifiers from one menu button', () => {
    const modify = quickItems('selection').find((i) => i.label === 'Modify');
    expect(modify?.kind).toBe('menu');
    expect(modify?.kind === 'menu' && modify.items).toEqual(
      expect.arrayContaining([
        'select.modify-feather',
        'select.modify-expand',
        'select.modify-contract',
        'select.modify-smooth',
        'select.mask-refine',
      ]),
    );
  });
  it('switches to a tool where the next step is a tool', () => {
    expect(quickItems('shape')[0]).toMatchObject({ kind: 'tool', tool: 'direct-select' });
  });
  it('names the mask toggle by what it will do', () => {
    expect(
      quickItems('mask').find((i) => i.kind === 'command' && i.id === 'layer.mask-toggle'),
    ).toMatchObject({ label: 'Disable', checkedLabel: 'Enable' });
  });
  it('lists every command once per state, separators excluded', () => {
    for (const s of ['selection', 'pixel', 'type', 'multiple'] as const) {
      const ids = quickCommandIds(s);
      expect(ids).not.toContain('-');
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(quickExtras('selection')).toContain('edit.fill');
  });
});

describe('Quick Actions Bar placement', () => {
  const vp = { width: 1000, height: 700 },
    bar = { width: 400, height: 34 };
  it('centers under the selection, and above it without room below', () => {
    expect(placeBar(vp, bar, { left: 300, right: 500, top: 100, bottom: 300 })).toEqual({
      left: 200,
      top: 314,
    });
    expect(placeBar(vp, bar, { left: 300, right: 500, top: 400, bottom: 680 })).toEqual({
      left: 200,
      top: 352,
    });
  });
  it('stays inside the canvas area', () => {
    expect(placeBar(vp, bar, { left: -500, right: -300, top: 0, bottom: 10 }).left).toBe(8);
    expect(placeBar(vp, bar, { left: 1200, right: 1400, top: 0, bottom: 10 }).left).toBe(592);
  });
  it('sits near the bottom center without a selection', () => {
    expect(placeBar(vp, bar)).toEqual({ left: 300, top: 638 });
  });
  it('keeps a pinned place relative to the canvas area size', () => {
    const p = pinnedAt(vp, bar, 592, 8);
    expect(p).toEqual({ fx: 1, fy: 0 });
    expect(placeBar(vp, bar, { left: 0, right: 10, top: 0, bottom: 10 }, p)).toEqual({
      left: 592,
      top: 8,
    });
    // A larger window keeps it at the right edge.
    expect(placeBar({ width: 1400, height: 900 }, bar, undefined, p)).toEqual({
      left: 992,
      top: 8,
    });
    const mid = pinnedAt(vp, bar, 300, 333);
    expect(placeBar(vp, bar, undefined, mid)).toEqual({ left: 300, top: 333 });
  });
  it('accepts only valid stored places', () => {
    expect(validPinned({ fx: 0.5, fy: 1 })).toEqual({ fx: 0.5, fy: 1 });
    expect(validPinned({ fx: 2, fy: 0 })).toBeUndefined();
    expect(validPinned({ fx: 'a', fy: 0 })).toBeUndefined();
    expect(validPinned(null)).toBeUndefined();
  });
});
