import { describe, it, expect } from 'vitest';
import { encodeDocument, decodeDocument } from '../../src/io/native';
import { startupDocument } from '../../src/data/defaults';
import type { DocumentData } from '../../src/data/types';

describe('paint data in saved files', () => {
  it('keeps palettes, paint curves, brush curves and stencils', () => {
    const doc = startupDocument() as DocumentData;
    doc.palettes = { pal1: { id: 'pal1', name: 'Palette', colors: [{ color: [1, 0, 0], strength: 1, weight: 1 }], active_index: 0 } };
    doc.paint_curves = { pc1: { id: 'pc1', name: 'PaintCurve', add_index: 0, points: [{ h1: [0, 0], co: [10, 10], h2: [20, 20], select: [false, true, false] }] } };
    const b = Object.values(doc.brushes)[0] as unknown as Record<string, unknown>;
    b.falloff = 'CUSTOM';
    b.falloff_curve = [
      [0, 0],
      [1, 1],
    ];
    b.stencil_pos = [100, 200];
    b.texture_slot = { source: 'NOISE', map_mode: 'STENCIL', angle: 0.5, scale: 1 };
    (doc.scene.tool_settings as unknown as Record<string, unknown>).image_paint = { palette: 'pal1', use_stencil_layer: true };
    const back = decodeDocument(encodeDocument(doc)).doc;
    expect(back.palettes?.pal1.colors[0].color).toEqual([1, 0, 0]);
    expect(back.paint_curves?.pc1.points[0].co).toEqual([10, 10]);
    const b2 = back.brushes[b.id as string] as unknown as Record<string, unknown>;
    expect(b2.falloff_curve).toEqual(b.falloff_curve);
    expect(b2.stencil_pos).toEqual([100, 200]);
    expect((b2.texture_slot as { map_mode: string }).map_mode).toBe('STENCIL');
    expect((back.scene.tool_settings as unknown as Record<string, { palette: string }>).image_paint.palette).toBe('pal1');
  });
});
