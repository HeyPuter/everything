// Exports to formats that cannot carry a color profile are converted to sRGB,
// whatever the Convert to sRGB setting says: unconverted samples without
// their profile would show the wrong colors everywhere.
import { describe, expect, it } from 'vitest';
import { newDocument } from '../src/model/document';
import { encodeIccProfile } from '../src/model/psd-resources';
import { serializeIcc } from '../src/color/icc-write';
import { builtinProfile } from '../src/color/builtin-profiles';
import { defaultSettings, encodeExport, formatInfo, prepareExport, type ExportFormat } from '../src/features/files/encode';
import { effectiveSettings, exportContext } from '../src/features/files/pipeline';
import { readPngIcc } from '../src/imaging/codecs/png-chunks';

const doc = { ...newDocument(3, 1), iccProfile: encodeIccProfile(serializeIcc(builtinProfile('compatible-rgb-1998'))) };
const src = () => ({ width: 3, height: 1, data: new Uint8ClampedArray([200, 40, 30, 255, 30, 180, 60, 255, 20, 50, 210, 255]) });
const prepared = (format: ExportFormat, convertSrgb: boolean) => {
  const s = effectiveSettings(doc, { ...defaultSettings, format, convertSrgb });
  return { s, img: prepareExport(src(), s, exportContext(doc)) };
};

describe('export color conversion', () => {
  const converted = prepared('png', true).img.data;
  it('is applied for formats without a profile even when Convert to sRGB is off', () => {
    expect(converted).not.toEqual(src().data);
    for (const format of ['webp', 'avif', 'gif', 'bmp', 'tga', 'ico'] as const) {
      expect(formatInfo[format].icc).toBe(false);
      expect(prepared(format, false).img.data, format).toEqual(converted);
    }
  });
  it('can still be turned off where the profile is embedded', async () => {
    const { s, img } = prepared('png', false);
    expect(img.data).toEqual(src().data);
    const png = await encodeExport(img, s, exportContext(doc));
    expect(readPngIcc(png)?.profile.length).toBeGreaterThan(0);
  });
});
