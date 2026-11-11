// Layer styles arrive from hand-editable files (.photo projects, preset files,
// libraries). A style whose effects have the wrong shape used to be accepted
// and then broke every later render and edit of the document, so it is
// refused where it enters; partial effects are completed from the defaults.
import { describe, expect, it } from 'vitest';
import { layer, newDocument, type PhotoDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { validateDocument } from '../src/model/serialization';
import { activeLayerStyle, sanitizeStyle, validGradient, validLayerStyle } from '../src/model/layer-style';
import { styleBoundsExpansion } from '../src/imaging/effects/bounds';
import { stylePatternIds } from '../src/model/fill-layer';
import { presetKinds } from '../src/features/workspace/preset-manager';
import { defaultDropShadow, defaultStroke, type LayerStyle } from '../src/imaging/effects/types';
import { stylePresets } from '../src/imaging/effects/presets';
import { gradientPresets } from '../src/imaging/gradient/presets';

const bad: [string, unknown][] = [
  ['list is a string', { enabled: true, dropShadow: 'x' }],
  ['single is a list', { enabled: true, bevel: [1] }],
  ['entry is not an object', { enabled: true, stroke: [5] }],
  ['enabled is a string', { enabled: 'yes' }],
  ['size is a string', { enabled: true, dropShadow: [{ enabled: true, size: 'big' }] }],
  ['color is not RGB', { enabled: true, colorOverlay: [{ enabled: true, color: 'red' }] }],
  ['stroke fill is a string', { enabled: true, stroke: [{ enabled: true, fill: 'red' }] }],
  ['stroke fill of unknown type', { enabled: true, stroke: [{ enabled: true, fill: { type: 'video' } }] }],
  ['overlay gradient without stops', { enabled: true, gradientOverlay: [{ enabled: true, gradient: { kind: 'solid', colorStops: [5], opacityStops: [] } }] }],
  ['glow gradient fill without stops', { enabled: true, outerGlow: { enabled: true, fill: { type: 'gradient', gradient: { kind: 'solid' } } } }],
  ['contour without points', { enabled: true, satin: { enabled: true, contour: { points: 'x' } } }],
  ['texture without pattern', { enabled: true, bevel: { enabled: true, texture: { scale: 1 } } }],
  ['scale is null', { enabled: true, scale: null }],
];

function docWithStyle(style: unknown): PhotoDocument {
  const doc = newDocument(32, 32, 'Styles');
  const l = newPixelLayer('Layer 1', doc);
  (l as { style?: unknown }).style = style;
  doc.layers = [l, layer('solid', 'Fill', 32, 32)];
  return structuredClone(doc);
}

describe('layer style validation', () => {
  it('refuses projects whose layer styles have the wrong shape', () => {
    for (const [what, style] of bad) expect(() => validateDocument(docWithStyle(style)), what).toThrow(/layer style/i);
  });

  it('accepts every built-in style, complete effects and partial ones', () => {
    for (const p of stylePresets) expect(validLayerStyle(p.style), p.id).toBe(true);
    const ok: LayerStyle[] = [
      { enabled: true, dropShadow: [defaultDropShadow()], stroke: [defaultStroke()] },
      { enabled: true, dropShadow: [{ enabled: true, distance: 5 } as never], bevel: { enabled: true } as never },
      { enabled: false },
    ];
    for (const s of ok) expect(() => validateDocument(docWithStyle(s))).not.toThrow();
  });

  it('keeps malformed styles out of the Preset Manager, and deep-checks gradients there', () => {
    const styles = presetKinds.find((k) => k.id === 'styles')!;
    const gradients = presetKinds.find((k) => k.id === 'gradients')!;
    for (const [what, style] of bad) expect(styles.valid({ id: 'x', name: 'Bad', style }), what).toBe(false);
    expect(styles.valid({ id: 'x', name: 'Good', style: stylePresets[0].style })).toBe(true);
    expect(gradients.valid({ kind: 'solid', colorStops: [5], opacityStops: [] })).toBe(false);
    expect(gradients.valid({ kind: 'solid', colorStops: [{ location: 0, color: 'red' }], opacityStops: [] })).toBe(false);
    expect(gradients.valid({ kind: 'solid', colorStops: [{ location: 0, color: [0, 0, 0] }, { location: 1, color: 'foreground' }], opacityStops: [{ location: 0, opacity: 1 }] })).toBe(true);
    for (const g of gradientPresets.flatMap((f) => f.gradients)) expect(validGradient(g), g.name).toBe(true);
    expect(validGradient({ kind: 'noise', roughness: 50, model: 'rgb', min: [0, 0, 0], max: [100, 100, 100], seed: 1 })).toBe(true);
  });

  it('fills effects that leave settings out from the defaults, so bounds stay finite', () => {
    const partial = { enabled: true, dropShadow: [{ enabled: true, useGlobalLight: false }], stroke: [{ enabled: true }], outerGlow: { enabled: true } } as unknown as LayerStyle;
    const s = sanitizeStyle(partial);
    const e = styleBoundsExpansion(s);
    for (const v of Object.values(e)) expect(Number.isFinite(v)).toBe(true);
    expect(e.left).toBeGreaterThan(0);
    expect(s.stroke![0].fill).toEqual(defaultStroke().fill);
    expect(() => stylePatternIds(s)).not.toThrow();
    const l = docWithStyle(partial).layers[0];
    expect(activeLayerStyle(l)).toBeTruthy();
  });
});
