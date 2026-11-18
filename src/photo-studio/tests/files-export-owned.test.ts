// A 16-bit export handed to the export worker (Quick Export) is prepared in
// place instead of in a copy; a cached source (Export As previews) is left
// unchanged. Both give the same pixels.
import { expect, it } from 'vitest';
import { newDocument } from '../src/model/document';
import { encodeIccProfile } from '../src/model/psd-resources';
import { serializeIcc } from '../src/color/icc-write';
import { builtinProfile } from '../src/color/builtin-profiles';
import { defaultSettings, prepareExport } from '../src/features/files/encode';
import { effectiveSettings, exportContext } from '../src/features/files/pipeline';

const doc = {
  ...newDocument(2, 2),
  iccProfile: encodeIccProfile(serializeIcc(builtinProfile('compatible-rgb-1998'))),
};
const pixels = () =>
  new Uint16Array([
    50000, 9000, 4000, 65535, 3000, 40000, 9000, 30000, 1000, 2000, 60000, 65535, 0, 0, 0, 0,
  ]);

it('prepares an owned 16-bit source in place with the same result', () => {
  const s = effectiveSettings(doc, {
    ...defaultSettings,
    format: 'png',
    depth: 16,
    convertSrgb: true,
    transparency: false,
  });
  const ctx = exportContext(doc);
  const cached = { width: 2, height: 2, data: pixels() };
  const copy = prepareExport(cached, s, ctx);
  expect(cached.data).toEqual(pixels());
  expect(copy.data).not.toBe(cached.data);
  const owned = { width: 2, height: 2, data: pixels() };
  const inPlace = prepareExport(owned, s, ctx, true);
  expect(inPlace.data).toBe(owned.data);
  expect(inPlace.data).toEqual(copy.data);
  expect(copy.data).not.toEqual(pixels());
});
