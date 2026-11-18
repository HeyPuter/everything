// Canvas guides travel through PSD files: a PSD's guides open as the
// document's guides, and saving writes the current ones (moved, added or
// removed) instead of the guides the file had.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createCanvas, createImageData, initializeCanvas } from 'ag-psd/dist/helpers';
import type { Assets } from '../src/model/assets';
import { newDocument, type PhotoDocument } from '../src/model/document';
import { openPsd, savePsd } from '../src/model/psd';
import { psdLosses } from '../src/model/psd-losses';

const previous = { canvas: createCanvas, imageData: createImageData };
beforeEach(() =>
  initializeCanvas(
    previous.canvas,
    (width, height) =>
      ({
        width,
        height,
        colorSpace: 'srgb',
        data: new Uint8ClampedArray(width * height * 4),
      }) as ImageData,
  ),
);
afterEach(() => initializeCanvas(previous.canvas, previous.imageData));

const save = (doc: PhotoDocument, assets?: Assets) =>
  savePsd(
    doc,
    async () => new Float32Array(doc.width * doc.height * 4).fill(1),
    undefined,
    (id) => assets!.blob(id),
  );

it('opens the guides of a PSD and saves edited guides back', async () => {
  // 16 bits per channel: the composite opens without the image worker.
  const doc: PhotoDocument = { ...newDocument(40, 30, 'Guides'), bitsPerChannel: 16 };
  doc.guides = [
    { orientation: 'vertical', position: 10 },
    { orientation: 'horizontal', position: 7.5 },
    { orientation: 'vertical', position: -4 },
  ];
  expect(psdLosses(doc).map((l) => l.id)).not.toContain('guides');
  const opened = await openPsd(await save(doc), 'guides.psd');
  expect(opened.document.guides).toEqual(doc.guides);
  // A guide removed and one moved: the original file's guides do not come back.
  const edited = {
    ...opened.document,
    guides: [{ orientation: 'horizontal' as const, position: 20 }],
  };
  const reopened = await openPsd(await save(edited, opened.assets), 'guides.psd');
  expect(reopened.document.guides).toEqual([{ orientation: 'horizontal', position: 20 }]);
  const cleared = { ...opened.document, guides: undefined };
  expect(
    (await openPsd(await save(cleared, opened.assets), 'guides.psd')).document.guides,
  ).toBeUndefined();
});
