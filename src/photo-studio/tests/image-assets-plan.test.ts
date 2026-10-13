import { describe, expect, it } from 'vitest';
import { layer, newDocument, type Layer } from '../src/model/document';
import { assetsFolder, documentPpi, hasAssetNames, planAssets, svgEligible } from '../src/features/image-assets/plan';

function doc(layers: Layer[]) {
  const d = newDocument(400, 300, 'Poster');
  d.layers = layers;
  return d;
}
const L = (kind: Layer['kind'], name: string, children: Layer[] = []) => {
  const l = layer(kind, name, 100, 100);
  l.children = children;
  return l;
};

describe('Image Assets planning', () => {
  it('lists outputs of nested layers and groups, skipping ordinary names', () => {
    const d = doc([L('pixel', 'Background'), L('pixel', 'red.png'), L('group', '48x48 icon.png', [L('vector', 'shape'), L('pixel', '200% blue.jpg80, icons/blue.webp')])]);
    const p = planAssets(d);
    expect(p.issues).toEqual([]);
    expect(p.assets.map((a) => [a.layerName, a.path, a.format, a.quality, a.size, a.scale])).toEqual([
      ['red.png', 'red.png', 'png', undefined, undefined, 1],
      ['48x48 icon.png', 'icon.png', 'png', undefined, { kind: 'box', width: 48, height: 48 }, 1],
      ['200% blue.jpg80, icons/blue.webp', 'blue.jpg', 'jpeg', 80, { kind: 'scale', factor: 2 }, 1],
      ['200% blue.jpg80, icons/blue.webp', 'icons/blue.webp', 'webp', undefined, undefined, 1],
    ]);
    expect(hasAssetNames(d)).toBe(true);
    expect(hasAssetNames(doc([L('pixel', 'Layer 1')]))).toBe(false);
  });

  it('reports bad names with the offending layer', () => {
    const bad = L('pixel', 'icon.pngg');
    const p = planAssets(doc([bad, L('pixel', 'ok.png')]));
    expect(p.assets.map((a) => a.path)).toEqual(['ok.png']);
    expect(p.issues).toEqual([{ layerId: bad.id, layerName: 'icon.pngg', message: expect.stringMatching(/not a supported extension/) }]);
  });

  it('reports duplicate paths across layers, naming the first layer', () => {
    const a = L('pixel', 'logo.png'),
      b = L('pixel', 'Logo.png, other.png');
    const p = planAssets(doc([a, b]));
    expect(p.assets.map((x) => [x.layerName, x.path])).toEqual([
      ['logo.png', 'logo.png'],
      ['Logo.png, other.png', 'other.png'],
    ]);
    expect(p.issues).toEqual([{ layerId: b.id, layerName: 'Logo.png, other.png', message: '“Logo.png” is also written by the layer “logo.png”.' }]);
  });

  it('applies the defaults layer to every asset', () => {
    const defaults = L('pixel', 'default 2x hd/, 1x');
    const p = planAssets(doc([defaults, L('pixel', 'a.png'), L('pixel', '48x? icons/b.jpg')]));
    expect(p.defaultsLayer).toBe(defaults.id);
    expect(p.assets.map((a) => [a.path, a.scale])).toEqual([
      ['hd/a.png', 2],
      ['a.png', 1],
      ['hd/icons/b.jpg', 2],
      ['icons/b.jpg', 1],
    ]);
  });

  it('adds suffixes from the defaults layer', () => {
    const p = planAssets(doc([L('pixel', 'default @2x, 1x'), L('pixel', 'a.png')]));
    expect(p.assets.map((a) => [a.path, a.scale])).toEqual([
      ['a@2x.png', 2],
      ['a.png', 1],
    ]);
  });

  it('uses only the first defaults layer and only top-level ones', () => {
    const second = L('pixel', 'default 3x');
    const p = planAssets(doc([L('pixel', 'default 2x'), second, L('group', 'g', [L('pixel', 'default 4x')]), L('pixel', 'a.png')]));
    expect(p.assets.map((a) => a.scale)).toEqual([2]);
    expect(p.issues).toEqual([{ layerId: second.id, layerName: 'default 3x', message: expect.stringMatching(/Only one defaults layer/) }]);
  });

  it('reports errors in the defaults layer and keeps its good variants', () => {
    const d = L('pixel', 'default 2x hd/, 48x48');
    const p = planAssets(doc([d, L('pixel', 'a.png')]));
    expect(p.assets.map((a) => a.path)).toEqual(['hd/a.png']);
    expect(p.issues[0]).toMatchObject({ layerId: d.id, message: expect.stringMatching(/not a scale/) });
  });

  it('allows SVG only for shape and text content', () => {
    const pixel = L('pixel', 'p.svg');
    const p = planAssets(doc([pixel, L('vector', 'shape.svg'), L('text', 'title.svg'), L('group', 'g.svg', [L('vector', 'a'), L('group', 'inner', [L('text', 't')])])]));
    expect(p.assets.map((a) => a.path)).toEqual(['shape.svg', 'title.svg', 'g.svg']);
    expect(p.issues).toEqual([{ layerId: pixel.id, layerName: 'p.svg', message: expect.stringMatching(/SVG needs a shape or text layer/) }]);
    expect(svgEligible(L('group', 'empty'))).toBe(false);
    expect(svgEligible(L('group', 'mixed', [L('vector', 'a'), L('pixel', 'b')]))).toBe(false);
  });

  it('uses the document resolution for physical units', () => {
    const d = doc([L('pixel', '1inx? a.png')]);
    d.resolution = { horizontalResolution: 118.11, horizontalResolutionUnit: 'PPCM', verticalResolution: 118.11, verticalResolutionUnit: 'PPCM', widthUnit: 'Centimeters', heightUnit: 'Centimeters' };
    expect(Math.round(documentPpi(d))).toBe(300);
    expect(planAssets(d).assets[0].size).toEqual({ kind: 'box', width: 300 });
  });

  it('names the folder beside a saved document', () => {
    expect(assetsFolder('/user/Documents/Poster.photo')).toBe('/user/Documents/Poster-assets');
    expect(assetsFolder('/user/My.Poster.v2.photo')).toBe('/user/My.Poster.v2-assets');
  });
});
