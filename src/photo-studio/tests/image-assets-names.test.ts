import { describe, expect, it } from 'vitest';
import { cleanPath, isDefaultsName, outputDims, parseAssetName, parseDefaults, parseSize } from '../src/features/image-assets/names';

const outputs = (name: string, ppi?: number) => parseAssetName(name, ppi)?.outputs ?? null;
const errors = (name: string) => parseAssetName(name)?.errors ?? null;

describe('Image Assets names: ordinary names', () => {
  it.each(['Layer 1', 'Background', 'Group 2 copy', 'v2.final', 'Layer 1.5', 'notes, ideas', '50% gray', 'a.png 2x', '', '   ', 'release 1.0', 'logo.ai'])('“%s” is not an asset name', (name) => {
    expect(parseAssetName(name)).toBeNull();
  });
});

describe('Image Assets names: outputs', () => {
  it('reads a plain file name', () => {
    expect(outputs('red.png')).toEqual([{ path: 'red.png', folder: '', stem: 'red', ext: 'png', format: 'png' }]);
  });
  it('keeps spaces in file names and trims around them', () => {
    expect(outputs('  my icon.png ')?.[0]).toMatchObject({ path: 'my icon.png', stem: 'my icon' });
    expect(outputs('my   wide  icon.png')?.[0].path).toBe('my wide icon.png');
  });
  it('lists several outputs separated by commas or plus signs', () => {
    expect(outputs('a.png, b.jpg,c.webp')?.map((o) => o.path)).toEqual(['a.png', 'b.jpg', 'c.webp']);
    expect(outputs('a.png + b.gif')?.map((o) => o.format)).toEqual(['png', 'gif']);
  });
  it('knows every format and its options', () => {
    expect(outputs('a.jpg')?.[0]).toMatchObject({ format: 'jpeg', ext: 'jpg' });
    expect(outputs('a.jpeg')?.[0]).toMatchObject({ format: 'jpeg', ext: 'jpeg' });
    expect(outputs('a.JPG')?.[0]).toMatchObject({ format: 'jpeg', ext: 'jpg', path: 'a.jpg' });
    expect(outputs('a.jpg80')?.[0]).toMatchObject({ format: 'jpeg', quality: 80, path: 'a.jpg' });
    expect(outputs('a.jpg80%')?.[0]).toMatchObject({ quality: 80 });
    expect(outputs('a.jpg100')?.[0]).toMatchObject({ quality: 100 });
    expect(outputs('a.jpg1')?.[0]).toMatchObject({ quality: 1 });
    expect(outputs('a.webp')?.[0]).toMatchObject({ format: 'webp' });
    expect(outputs('a.webp60')?.[0]).toMatchObject({ format: 'webp', quality: 60, path: 'a.webp' });
    expect(outputs('a.png8')?.[0]).toMatchObject({ format: 'png8', path: 'a.png' });
    expect(outputs('a.png24')?.[0]).toMatchObject({ format: 'png', path: 'a.png' });
    expect(outputs('a.png32')?.[0]).toMatchObject({ format: 'png' });
    expect(outputs('a.gif')?.[0]).toMatchObject({ format: 'gif' });
    expect(outputs('a.svg')?.[0]).toMatchObject({ format: 'svg' });
  });
  it('reads size prefixes', () => {
    expect(outputs('200% a.png')?.[0].size).toEqual({ kind: 'scale', factor: 2 });
    expect(outputs('50% a.png')?.[0].size).toEqual({ kind: 'scale', factor: 0.5 });
    expect(outputs('2x a.png')?.[0].size).toEqual({ kind: 'scale', factor: 2 });
    expect(outputs('0.5x a.png')?.[0].size).toEqual({ kind: 'scale', factor: 0.5 });
    expect(outputs('.5x a.png')?.[0].size).toEqual({ kind: 'scale', factor: 0.5 });
    expect(outputs('48x48 icon.png')?.[0].size).toEqual({ kind: 'box', width: 48, height: 48 });
    expect(outputs('48X32 icon.png')?.[0].size).toEqual({ kind: 'box', width: 48, height: 32 });
    expect(outputs('48x? icon.png')?.[0].size).toEqual({ kind: 'box', width: 48 });
    expect(outputs('?x32 icon.png')?.[0].size).toEqual({ kind: 'box', height: 32 });
    expect(outputs('64pxx32px icon.png')?.[0].size).toEqual({ kind: 'box', width: 64, height: 32 });
  });
  it('converts physical units with the document resolution', () => {
    expect(outputs('1inx1in a.png', 300)?.[0].size).toEqual({ kind: 'box', width: 300, height: 300 });
    expect(outputs('2.54cmx? a.png', 100)?.[0].size).toEqual({ kind: 'box', width: 100 });
    expect(outputs('?x25.4mm a.png')?.[0].size).toEqual({ kind: 'box', height: 72 });
  });
  it('reads folders', () => {
    expect(outputs('icons/close.png')?.[0]).toMatchObject({ path: 'icons/close.png', folder: 'icons/', stem: 'close' });
    expect(outputs('2x a/b/c.png')?.[0]).toMatchObject({ path: 'a/b/c.png', folder: 'a/b/' });
    expect(outputs('200% blue.jpg80, icons/blue.webp')).toEqual([
      { path: 'blue.jpg', folder: '', stem: 'blue', ext: 'jpg', format: 'jpeg', quality: 80, size: { kind: 'scale', factor: 2 } },
      { path: 'icons/blue.webp', folder: 'icons/', stem: 'blue', ext: 'webp', format: 'webp' },
    ]);
  });
  it('mixes sizes and formats per output', () => {
    const list = outputs('100% a.png, 200% a@2x.png, 48x48 small/a.jpg70');
    expect(list?.map((o) => [o.path, o.size, o.quality])).toEqual([
      ['a.png', { kind: 'scale', factor: 1 }, undefined],
      ['a@2x.png', { kind: 'scale', factor: 2 }, undefined],
      ['small/a.jpg', { kind: 'box', width: 48, height: 48 }, 70],
    ]);
  });
});

describe('Image Assets names: errors', () => {
  it.each([
    ['icon.pngg', /not a supported extension/],
    ['48x48 icon.pngg', /not a supported extension/],
    ['a.jpgx', /not a supported extension/],
    ['a.svgz', /not a supported extension/],
    ['150%% a.png', /not a size/],
    ['0% a.png', /between 0% and 10000%/],
    ['20000% a.png', /between/],
    ['0x a.png', /between 0x and 100x/],
    ['200x a.png', /between 0x and 100x/],
    ['0x48 a.png', /1 to 8192/],
    ['9000x10 a.png', /1 to 8192/],
    ['?x? a.png', /at least one number/],
    ['2xx a.png', /not a size/],
    ['a.jpg101', /1 to 100/],
    ['a.jpg0', /1 to 100/],
    ['a.webp0100', /1 to 100/],
    ['a.jpg%', /without a quality/],
    ['a.png16', /\.png8, \.png24/],
    ['a.png50%', /\.png8/],
    ['a.gif80', /takes no quality/],
    ['a.svg2', /takes no quality/],
    ['.png', /no file name/],
    ['icons/.png', /no file name/],
    ['../up.png', /“\.” or “\.\.”/],
    ['a/../b.png', /“\.” or “\.\.”/],
    ['./a.png', /“\.” or “\.\.”/],
    ['/abs.png', /relative path/],
    ['C:/x.png', /relative path/],
    ['a\\b.png', /Use “\/”/],
    ['a//b.png', /empty folder/],
    ['a:b.png', /character/],
    ['a?b.png', /character/],
    ['a/b/c/d/e/f/g/h/i/j.png', /nested too deeply/],
  ])('“%s” is reported', (name, re) => {
    const r = parseAssetName(name);
    expect(r).not.toBeNull();
    expect(r!.outputs).toEqual([]);
    expect(r!.errors.join(' ')).toMatch(re);
  });
  it('reports plain words mixed into outputs and keeps the good outputs', () => {
    const r = parseAssetName('a.png, foo, b.jpg');
    expect(r!.outputs.map((o) => o.path)).toEqual(['a.png', 'b.jpg']);
    expect(r!.errors).toEqual(['“foo” is not a file name (add an extension such as .png).']);
  });
  it('ignores empty items from stray separators', () => {
    expect(parseAssetName('a.png,, b.png,')).toEqual({ outputs: expect.any(Array), errors: [] });
  });
  it('reports a path listed twice (case-insensitive) once', () => {
    const r = parseAssetName('a.png, 2x A.png');
    expect(r!.outputs.map((o) => o.path)).toEqual(['a.png']);
    expect(r!.errors).toEqual(['“A.png” is listed twice.']);
  });
  it('rejects overly long paths', () => {
    expect(errors(`${'x'.repeat(250)}.png`)?.join()).toMatch(/too long/);
  });
});

describe('Image Assets names: sizes and paths', () => {
  it('parses sizes directly', () => {
    expect(parseSize('150%')).toEqual({ kind: 'scale', factor: 1.5 });
    expect(parseSize('3x')).toEqual({ kind: 'scale', factor: 3 });
    expect(parseSize('10x20')).toEqual({ kind: 'box', width: 10, height: 20 });
    expect(typeof parseSize('big')).toBe('string');
  });
  it('cleans relative paths', () => {
    expect(cleanPath(' a / b .png')).toEqual(['a', 'b .png']);
    expect(typeof cleanPath('a/<b>.png')).toBe('string');
  });
  it('computes output pixel sizes', () => {
    expect(outputDims(100, 50, undefined)).toEqual([100, 50]);
    expect(outputDims(100, 50, { kind: 'scale', factor: 2 })).toEqual([200, 100]);
    expect(outputDims(100, 50, { kind: 'box', width: 48, height: 48 })).toEqual([48, 48]);
    expect(outputDims(100, 50, { kind: 'box', width: 40 })).toEqual([40, 20]);
    expect(outputDims(100, 50, { kind: 'box', height: 10 })).toEqual([20, 10]);
    expect(outputDims(100, 50, { kind: 'box', width: 48, height: 48 }, 2)).toEqual([96, 96]);
    expect(outputDims(100, 50, undefined, 0.5)).toEqual([50, 25]);
    expect(outputDims(3, 3, { kind: 'scale', factor: 0.01 })).toEqual([1, 1]);
    expect(outputDims(8000, 10, { kind: 'scale', factor: 4 })).toEqual([8192, 40]);
  });
});

describe('Image Assets names: defaults layer', () => {
  it('recognizes defaults names', () => {
    expect(isDefaultsName('default 2x hd/')).toBe(true);
    expect(isDefaultsName('Default')).toBe(true);
    expect(isDefaultsName('defaults.png')).toBe(false);
    expect(isDefaultsName('default.png')).toBe(false);
    expect(parseAssetName('default 2x hd/, 1x')).toBeNull();
    expect(parseDefaults('a.png')).toBeNull();
  });
  it('reads scales, folders and suffixes', () => {
    expect(parseDefaults('default 2x hd/, 1x')).toEqual({ variants: [{ scale: 2, folder: 'hd/', suffix: '' }, { scale: 1, folder: '', suffix: '' }], errors: [] });
    expect(parseDefaults('default @2x hd/, 1x')!.variants).toEqual([{ scale: 2, folder: 'hd/', suffix: '@2x' }, { scale: 1, folder: '', suffix: '' }]);
    expect(parseDefaults('default 2x hd/ + 50% lo/')!.variants).toEqual([{ scale: 2, folder: 'hd/', suffix: '' }, { scale: 0.5, folder: 'lo/', suffix: '' }]);
    expect(parseDefaults('default @3x, @2x, @1x')!.variants.map((v) => [v.scale, v.suffix])).toEqual([[3, '@3x'], [2, '@2x'], [1, '@1x']]);
    expect(parseDefaults('default 150% @big')!.variants).toEqual([{ scale: 1.5, folder: '', suffix: '@big' }]);
    expect(parseDefaults('default hd/retina/ 2x')!.variants).toEqual([{ scale: 2, folder: 'hd/retina/', suffix: '' }]);
    expect(parseDefaults('default')).toEqual({ variants: [], errors: [] });
  });
  it('reports bad defaults', () => {
    expect(parseDefaults('default 48x48')!.errors.join()).toMatch(/not a scale, folder or suffix/);
    expect(parseDefaults('default ../up/')!.errors.join()).toMatch(/“\.\.”/);
    expect(parseDefaults('default @a/b')!.errors.join()).toMatch(/suffix/);
    expect(parseDefaults('default 0x')!.errors.join()).toMatch(/between/);
    expect(parseDefaults('default 2x, 2x')!.errors.join()).toMatch(/same files/);
    expect(parseDefaults('default 2x, bogus, 1x hd/')!.variants).toHaveLength(2);
  });
});
