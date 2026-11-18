// The Image Processor encodes a 32-bit document (linear sRGB) for the output
// file even with Convert to sRGB off, as Export As does: its samples would
// otherwise be written as they are and read as sRGB, far too dark.
import { expect, it } from 'vitest';
import type { Editor } from '../src/editor';
import type { DocumentSession } from '../src/app/session';
import { newDocument } from '../src/model/document';
import { runProcessor } from '../src/features/files/automate';
import { decodePng16 } from '../src/features/files/png';

it('converts an open 32-bit document to sRGB with Convert to sRGB off', async () => {
  const doc = { ...newDocument(2, 1, 'HDR'), bitsPerChannel: 32 as const };
  const samples = new Float32Array([0.214, 0.214, 0.214, 1, 1, 0, 0, 1]);
  const e = {
    renderer: { documentPixels: async () => samples },
    message: () => {},
  } as unknown as Editor;
  const session = { doc, assets: undefined } as unknown as DocumentSession;
  const files = await runProcessor(
    e,
    [{ name: 'HDR.photo', session }],
    {
      resize: false,
      w: 0,
      h: 0,
      enlarge: false,
      format: 'png',
      quality: 90,
      srgb: false,
      steps: [],
    },
    () => {},
    () => false,
  );
  expect(files.failed).toEqual([]);
  const png = decodePng16(files[0].bytes)!;
  // Linear 0.214 is sRGB 50%.
  expect(Math.round((png.data16[0] / 65535) * 1000) / 1000).toBeCloseTo(0.5, 2);
  expect([...png.data16.slice(4, 8)]).toEqual([65535, 0, 0, 65535]);
});
