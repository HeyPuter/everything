import { describe, it, expect } from 'vitest';
import { missingImages, matchMissing, baseName } from '../../src/io/externaldata';
import type { ImageData } from '../../src/data/types';

const im = (name: string, filepath: string, bytes: Uint8Array | null, source: ImageData['source'] = 'FILE') => ({ id: name, name, filepath, bytes, mime: 'image/png', width: 1, height: 1, source, colorspace: 'sRGB' }) as ImageData;

describe('external data', () => {
  it('finds images without pixels', () => {
    const imgs = { a: im('a', '//tex/wood.png', null), b: im('b', 'b.png', new Uint8Array(4)), c: im('c', '', null, 'GENERATED') };
    expect(missingImages(imgs).map((i) => i.name)).toEqual(['a']);
  });
  it('matches picked files by file name', () => {
    const a = im('Wood', 'C:\\textures\\Wood.PNG', null);
    const b = im('metal.jpg', '', null);
    const m = matchMissing([a, b], [{ name: 'metal.jpg' }, { name: 'wood.png' }]);
    expect(m.get(a)).toBe(1);
    expect(m.get(b)).toBe(0);
    expect(baseName('/x/y/Z.png')).toBe('z.png');
  });
});
