// What saving as a PSD would lose: the list Save shows before writing one.
import { describe, expect, it } from 'vitest';
import { layer, newDocument, type Layer, type PhotoDocument } from '../src/model/document';
import { describePsdLosses, flatLosses, psdLosses } from '../src/model/psd-losses';
import { defaultParams } from '../src/imaging/adjust/model';

const doc = (...layers: Layer[]): PhotoDocument => ({ ...newDocument(64, 48), layers });
const ids = (d: PhotoDocument, extras?: { comments?: boolean }) => psdLosses(d, extras).map((l) => l.id);
const adjustment = (kind: Parameters<typeof defaultParams>[0]): Layer => ({ ...layer('adjustment', kind, 64, 48), adjustment: { kind, params: defaultParams(kind) as unknown as Record<string, unknown> } });

describe('PSD losses', () => {
  it('finds nothing to lose in pixel layers, groups and adjustments a PSD stores', () => {
    const group = { ...layer('group', 'Group', 64, 48), children: [layer('pixel', 'Inside', 64, 48)] };
    const d = doc(layer('pixel', 'Background', 64, 48), group, adjustment('levels'), adjustment('curves'));
    expect(psdLosses(d)).toEqual([]);
    expect(describePsdLosses([])).toBe('');
  });

  it('lists features that are baked into pixels', () => {
    const styled = { ...layer('pixel', 'Styled', 64, 48), style: { dropShadow: [{ enabled: true }] } };
    const off = { ...layer('pixel', 'Style off', 64, 48), style: { enabled: false, dropShadow: [{ enabled: true }] } };
    const scaled = { ...layer('image', 'Scaled', 32, 24), asset: 'a', transform: { x: 0, y: 0, width: 64, height: 48, rotation: 0 } };
    const placed = { ...layer('image', 'Placed', 32, 24), asset: 'b' };
    expect(ids(doc(off, placed))).toEqual([]);
    expect(ids(doc(styled, layer('solid', 'Fill', 64, 48), scaled))).toEqual(['styles', 'fills', 'resampled']);
  });

  it('names adjustments that have no PSD record', () => {
    const losses = psdLosses(doc(adjustment('levels'), adjustment('clarity-dehaze'), adjustment('grain')));
    expect(losses).toEqual([{ id: 'adjustments', kind: 'omitted', label: 'Clarity & Dehaze and Grain adjustments' }]);
  });

  it('lists document data and comments that are left out', () => {
    const d = doc(layer('pixel', 'Background', 64, 48));
    d.slices = [{ id: 's', rect: { x: 0, y: 0, width: 8, height: 8 } }];
    d.mode = 'cmyk';
    d.variables = { layers: {}, sets: [] };
    d.annotations = { samplers: [] };
    expect(ids(d)).toEqual(['slices', 'mode']);
    expect(ids(d, { comments: true })).toEqual(['slices', 'mode', 'comments']);
  });

  it('keeps canvas guides but not the guides of artboards', () => {
    const d = doc(layer('pixel', 'Background', 64, 48));
    d.guides = [{ orientation: 'vertical', position: 10 }];
    expect(ids(d)).toEqual([]);
    const board = { ...layer('group', 'Artboard', 64, 48), artboard: { rect: { x: 0, y: 0, width: 64, height: 48 }, guides: [{ orientation: 'horizontal' as const, position: 4 }] } } as Layer;
    expect(psdLosses(doc(board))).toEqual([{ id: 'guides', kind: 'omitted', label: 'artboard guides' }]);
  });

  it('describes both kinds of loss in one sentence', () => {
    const styled = { ...layer('pixel', 'Styled', 64, 48), style: { stroke: [{ enabled: true }] } };
    const d = doc(styled, layer('solid', 'Fill', 64, 48));
    d.slices = [{ id: 's', rect: { x: 0, y: 0, width: 8, height: 8 } }];
    expect(describePsdLosses(psdLosses(d))).toBe('A PSD flattens layer styles and fill layers into pixels and leaves out slices.');
    expect(describePsdLosses(psdLosses(doc(styled)))).toBe('A PSD flattens layer styles into pixels.');
    d.layers = [];
    expect(describePsdLosses(psdLosses(d, { comments: true }))).toBe('A PSD leaves out slices and review comments.');
  });
});

// What saving back to a PNG, JPEG or other single image would lose.
describe('Image file losses', () => {
  const flatIds = (d: PhotoDocument, opts?: Parameters<typeof flatLosses>[1]) => flatLosses(d, opts).map((l) => l.id);

  it('finds nothing to lose in one plain pixel layer, or an image layer at its own size', () => {
    expect(flatLosses(doc(layer('pixel', 'Background', 64, 48)))).toEqual([]);
    const image = { ...layer('image', 'Background', 64, 48), asset: 'a' };
    expect(flatLosses({ ...doc(image), bitsPerChannel: 16 }, { deep: true })).toEqual([]);
  });

  it('flattens more than one layer, or a layer with settings the file cannot hold', () => {
    expect(flatIds(doc(layer('pixel', 'Background', 64, 48), layer('text', 'Title', 64, 48)))).toEqual(['layers']);
    const faded = { ...layer('pixel', 'Background', 64, 48), opacity: 0.5 };
    const hidden = { ...layer('pixel', 'Background', 64, 48), visible: false };
    const masked = { ...layer('pixel', 'Background', 64, 48), mask: { x: 0, y: 0, width: 8, height: 8 } };
    for (const l of [faded, hidden, masked, layer('text', 'Title', 64, 48)]) expect(flatIds(doc(l))).toEqual(['layer-settings']);
  });

  it('lists document data, guides, channels and depth the file leaves out', () => {
    const d = doc(layer('pixel', 'Background', 64, 48));
    d.slices = [{ id: 's', rect: { x: 0, y: 0, width: 8, height: 8 } }];
    d.guides = [{ orientation: 'vertical', position: 10 }];
    d.info = { title: 'Poster' };
    d.bitsPerChannel = 16;
    expect(flatIds(d)).toEqual(['depth', 'slices', 'info', 'guides']);
    // A PNG keeps 16 bits and File Info.
    expect(flatIds(d, { deep: true, text: true })).toEqual(['slices', 'guides']);
    d.bitsPerChannel = 32;
    expect(flatLosses(d, { deep: true, text: true })[0]).toEqual({ id: 'depth', kind: 'omitted', label: '32-bit color (written as 16-bit)' });
  });

  it('names the format in the sentence', () => {
    const d = doc(layer('pixel', 'Background', 64, 48), layer('pixel', 'Top', 64, 48));
    d.slices = [{ id: 's', rect: { x: 0, y: 0, width: 8, height: 8 } }];
    expect(describePsdLosses(flatLosses(d), 'PNG')).toBe('A PNG flattens the layers into pixels and leaves out slices.');
    expect(describePsdLosses(flatLosses(d), 'AVIF')).toBe('An AVIF flattens the layers into pixels and leaves out slices.');
  });
});
