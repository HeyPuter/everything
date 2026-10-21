// @vitest-environment happy-dom
// Dope Sheet ▸ Mask: mask layers' shape keys as keyframes; moving, deleting and duplicating keys
// changes the shape keys (written back before undo steps are stored).
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import type { MaskData, MaskLayer } from '../../src/mask/types';
import { maskTable } from '../../src/mask/types';
import { buildChannels } from '../../src/animation/channels';
import { writeBackMaskKeys, insertMaskKeys } from '../../src/animation/maskmode';
import { duplicateSelected as duplicateKeys, deleteSelected as deleteKeys, setKeySelected } from '../../src/animation/keyedit';

const layer = (name: string, frames: number[]): MaskLayer => ({
  name,
  splines: [{ use_cyclic: true, use_fill: true, points: [{ co: [0, 0], handle_left: [0, 0], handle_right: [0, 0], handle_left_type: 'AUTO', handle_right_type: 'AUTO', weight: 1 } as never] }],
  alpha: 1,
  blend: 'MERGE_ADD',
  invert: false,
  falloff: 'SMOOTH',
  hide: false,
  hide_render: false,
  hide_select: false,
  active_spline: 0,
  shape_keys: frames.map((frame) => ({ frame, data: [frame, 0, 0, 0, 0, 0, 1] })),
});
let mask: MaskData;
const filter = () => ({ onlySelected: false, showHidden: true, search: '', isVisible: () => true, activeObject: null });

beforeEach(() => {
  setApp(new App(startupDocument()));
  mask = { id: 'mk1', name: 'Mask', layers: [layer('MaskLayer', [1, 10, 30]), layer('Second', [5, 20])], active_layer_index: 0, frame_start: 1, frame_end: 250 };
  maskTable(app.doc)[mask.id] = mask;
});

describe('Dope Sheet Mask mode', () => {
  it('lists Summary, the mask and its layers (top-most first) with the shape keys as keys', () => {
    const list = buildChannels(app.doc, 'MASK', filter());
    expect(list.rows.map((r) => [r.kind, r.label])).toEqual([
      ['SUMMARY', 'Summary'],
      ['MASK', 'Mask'],
      ['MASK_LAYER', 'Second'],
      ['MASK_LAYER', 'MaskLayer'],
    ]);
    expect(list.rows[3].fc!.keyframe_points.map((k) => k.co[0])).toEqual([1, 10, 30]);
    expect(list.rows[0].curves.length).toBe(2);
  });

  it('moving, deleting and duplicating keys edits the shape keys', () => {
    const list = buildChannels(app.doc, 'MASK', filter());
    const fc = list.rows[3].fc!;
    fc.keyframe_points.forEach((k) => setKeySelected(k, k.co[0] === 10));
    // move the key at 10 to 14
    fc.keyframe_points[1].co[0] = 14;
    writeBackMaskKeys();
    expect(mask.layers[0].shape_keys.map((k) => [k.frame, k.data[0]])).toEqual([[1, 1], [14, 10], [30, 30]]);
    // duplicate it (the copy keeps the data) and move the copy to 40
    duplicateKeys(list.curves);
    const copy = fc.keyframe_points.find((k) => k.select_control_point && k !== fc.keyframe_points.find((x) => x.co[0] === 14 && !x.select_control_point))!;
    copy.co[0] = 40;
    app.pushUndo('Duplicate');
    expect(mask.layers[0].shape_keys.map((k) => [k.frame, k.data[0]])).toEqual([[1, 1], [14, 10], [30, 30], [40, 10]]);
    // delete the selected keys
    deleteKeys(list.curves);
    writeBackMaskKeys();
    expect(mask.layers[0].shape_keys.map((k) => k.frame)).toEqual(expect.arrayContaining([1, 30]));
    expect(mask.layers[1].shape_keys.map((k) => k.frame)).toEqual([5, 20]);
  });

  it('edits made elsewhere win over the stand-in keys', () => {
    buildChannels(app.doc, 'MASK', filter());
    mask.layers[1].shape_keys.push({ frame: 50, data: [50, 0, 0, 0, 0, 0, 1] });
    writeBackMaskKeys();
    expect(mask.layers[1].shape_keys.map((k) => k.frame)).toEqual([5, 20, 50]);
    const list = buildChannels(app.doc, 'MASK', filter());
    expect(list.rows[2].fc!.keyframe_points.map((k) => k.co[0])).toEqual([5, 20, 50]);
  });

  it('I keys the layers of the given channels', () => {
    const list = buildChannels(app.doc, 'MASK', filter());
    expect(insertMaskKeys([list.rows[2].curves[0]], 12)).toBe(1);
    expect(mask.layers[1].shape_keys.map((k) => k.frame)).toEqual([5, 12, 20]);
  });
});
