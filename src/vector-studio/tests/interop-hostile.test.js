// Hostile and malformed input for the importers: each case must finish quickly with a
// clear result or message, without exhausting memory or hanging.
import { describe, it, expect } from 'vitest';
import { onePage, leaves, enc } from './interop-helpers.js';
import { pdfToDocument } from '../src/features/interop/pdf/import.js';
import { decodeCCITT } from '../src/features/interop/codec/ccitt.js';

const open = (bytes) => pdfToDocument(bytes, { families: ['Inter'] });

describe('PDF images too large to decode', () => {
  it('become a gray placeholder with a warning instead of a multi-gigabyte decode', async () => {
    const doc = await open(
      onePage('q 100 0 0 50 10 20 cm /I Do Q', {
        resources: '<< /XObject << /I 5 0 R >> >>',
        extra: [{ dict: '<< /Type /XObject /Subtype /Image /Width 40000 /Height 40000 /ColorSpace /DeviceRGB /BitsPerComponent 8 >>', stream: 'abc' }],
      }),
    );
    const [box] = leaves(doc);
    expect(box.type).toBe('path');
    expect(box.name).toBe('Image too large to import');
    const xs = box.anchors.map((a) => a.x);
    const ys = box.anchors.map((a) => a.y);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([10, 110]);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([30, 80]);
    expect(doc.assets.size).toBe(0);
    expect(doc.importWarnings).toContain('Images too large to import were replaced by gray boxes.');
  });

  it('stencil masks and fax images are limited too', async () => {
    const doc = await open(
      onePage('q 10 0 0 10 0 0 cm /I Do Q', {
        resources: '<< /XObject << /I 5 0 R >> >>',
        extra: [{ dict: '<< /Type /XObject /Subtype /Image /Width 100000 /Height 100000 /ImageMask true /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 100000 /Rows 100000 >> >>', stream: enc('\0\0\0\0') }],
      }),
    );
    expect(leaves(doc).map((n) => n.name)).toEqual(['Image too large to import']);
    expect(() => decodeCCITT(new Uint8Array(4), { K: -1, columns: 100000, rows: 100000 })).toThrow(/too large/);
  });
});
