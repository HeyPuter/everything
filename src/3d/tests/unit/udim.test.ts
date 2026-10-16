import { describe, it, expect } from 'vitest';
import { tileCell, tileNumberAt, tileGrid, nextFreeTile, udimFileName, detectUdimSets, validTileNumber } from '../../src/render/udim';
import { encodeDocument, decodeDocument } from '../../src/io/native';
import { startupDocument } from '../../src/data/defaults';

describe('UDIM numbering', () => {
  it('maps tiles to UV squares and back', () => {
    expect(tileCell(1001)).toEqual([0, 0]);
    expect(tileCell(1012)).toEqual([1, 1]);
    expect(tileCell(1010)).toEqual([9, 0]);
    expect(tileNumberAt(1.5, 0.2)).toBe(1002);
    expect(tileNumberAt(0.5, 2.5)).toBe(1021);
    expect(tileNumberAt(10.5, 0)).toBeNull();
    expect(tileNumberAt(-0.1, 0)).toBeNull();
    expect(tileGrid([1001, 1003, 1012])).toEqual({ cols: 3, rows: 2 });
    expect(nextFreeTile([1001, 1002, 1004])).toBe(1003);
    expect(validTileNumber(1000)).toBe(false);
  });
  it('names tile files and finds tile sets among files', () => {
    expect(udimFileName('wood.<UDIM>.png', 1004)).toBe('wood.1004.png');
    expect(udimFileName('wood_1001.png', 1012)).toBe('wood_1012.png');
    expect(udimFileName('wood.png', 1002)).toBe('wood.1002.png');
    const sets = detectUdimSets(['skin.1002.png', 'skin.1001.png', 'other.png', 'eye_1001.jpg']);
    expect(sets).toEqual([
      { pattern: 'skin.<UDIM>.png', files: [{ index: 1, number: 1001 }, { index: 0, number: 1002 }] },
      { pattern: 'eye_<UDIM>.jpg', files: [{ index: 3, number: 1001 }] },
    ]);
  });
  it('tiles survive a save and load', () => {
    const doc = startupDocument();
    doc.images.u = { id: 'u', name: 'U', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]), width: 4, height: 4, source: 'TILED', colorspace: 'sRGB', tiles: [{ number: 1001, width: 4, height: 4 }, { number: 1002, label: 'Arm', bytes: new Uint8Array([9, 8]), mime: 'image/png', width: 2, height: 2 }], active_tile_index: 1 };
    const back = decodeDocument(encodeDocument(doc)).doc.images.u;
    expect(back.source).toBe('TILED');
    expect(back.tiles![1].label).toBe('Arm');
    expect(Array.from(back.tiles![1].bytes!)).toEqual([9, 8]);
    expect(back.active_tile_index).toBe(1);
  });
});
