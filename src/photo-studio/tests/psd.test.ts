import { describe, expect, it } from 'vitest';
import { validatePsdHeader, savePsd } from '../src/model/psd';
import { newDocument, layer } from '../src/model/document';

function header() {
  const bytes = new Uint8Array(26);
  bytes.set(new TextEncoder().encode('8BPS'));
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1);
  view.setUint16(12, 3);
  view.setUint32(14, 100);
  view.setUint32(18, 200);
  view.setUint16(22, 8);
  view.setUint16(24, 3);
  return bytes;
}

describe('PSD preflight', () => {
  it('accepts supported RGB depths and PSD/PSB versions including typed array offsets', () => {
    for (const depth of [8, 16, 32])
      for (const version of [1, 2]) {
        const bytes = new Uint8Array(30);
        bytes.set(header(), 4);
        const view = new DataView(bytes.buffer, 4);
        view.setUint16(4, version);
        view.setUint16(22, depth);
        expect(() => validatePsdHeader(bytes.subarray(4))).not.toThrow();
      }
  });
  it('rejects truncated files, invalid versions/depths and channel counts, CMYK and oversized documents', () => {
    expect(() => validatePsdHeader(new Uint8Array(25))).toThrow('Invalid PSD');
    for (const [offset, value, message] of [
      [4, 3, 'version'],
      [22, 24, 'This file has 24 bits per channel. Only 8, 16 and 32-bit RGB files open'],
      [24, 4, 'This file is in CMYK color mode. Only RGB files open; convert it to RGB Color'],
      [24, 1, 'This file is in Grayscale color mode.'],
      [12, 2, 'Invalid PSD channel count.'],
      [12, 57, 'Invalid PSD channel count.'],
    ] as const) {
      const bytes = header();
      new DataView(bytes.buffer).setUint16(offset, value);
      expect(() => validatePsdHeader(bytes)).toThrow(message);
    }
    const bytes = header();
    new DataView(bytes.buffer).setUint32(14, 9000);
    expect(() => validatePsdHeader(bytes)).toThrow('dimensions');
  });
});

describe('PSD raster source export', () => {
  it('rejects lossy byte callbacks when exporting a high-depth document', async () => {
    const doc = newDocument(2, 3);
    for (const depth of [16, 32] as const) {
      doc.bitsPerChannel = depth;
      await expect(
        savePsd(doc, async () => new Uint8Array(2 * 3 * 4)),
      ).rejects.toThrow('typed floating-point readback');
    }
  });
  it('rejects unrepresentable layer coordinates and inconsistent source dimensions', async () => {
    const doc = newDocument(2, 2);
    const l = layer('image', 'Pixels', 2, 2);
    l.asset = 'source';
    doc.layers = [l];
    const render = async () => new Uint8Array(16);
    const source = async () => ({
      width: 2,
      height: 2,
      data: new Uint8Array(16),
    });
    for (const x of [-0x80000001, 0x7fffffff]) {
      l.transform.x = x;
      await expect(savePsd(doc, render, source)).rejects.toThrow(
        'signed 32-bit',
      );
    }
    l.transform.x = 0;
    await expect(
      savePsd(doc, render, async () => ({
        width: 3,
        height: 2,
        data: new Uint8Array(24),
      })),
    ).rejects.toThrow('source dimensions');
  });
});
