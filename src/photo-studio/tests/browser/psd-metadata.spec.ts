import { test, expect } from '@playwright/test';
import { boot, downloadFrom, idle, menu, openFiles } from './helpers';

for (const backend of ['default', 'WebGL']) {
  test(`opaque PSD globals and layer identities survive edits, native projects and export (${backend})`, async ({
    page,
  }) => {
    if (backend === 'WebGL')
      await page.addInitScript(() =>
        Object.defineProperty(navigator, 'gpu', { value: undefined }),
      );
    await page.route('https://js.puter.com/**', (r) =>
      r.fulfill({
        contentType: 'application/javascript',
        body: 'window.puter={};',
      }),
    );
    await page.goto('/');
    await expect(page.locator('#engine-status')).toHaveText(/WebGPU|WebGL2/);
    const results = await page.evaluate(async () => {
      const { writePsd } = await import('/tests/browser/psd-codec.ts');
      const { writeHighDepthPsd } =
        await import('/src/model/psd-high-depth.ts');
      const { openPsd, savePsd } = await import('/src/model/psd.ts');
      const { readPsdMetadata, restorePsdMetadata, psdMetadataMimeType } =
        await import('/src/model/psd-metadata.ts');
      const { serialize, deserialize } =
        await import('/src/model/serialization.ts');
      const { layer, resizeDocument, cropDocument } =
        await import('/src/model/document.ts');
      const { Renderer } = await import('/src/renderer/renderer.ts');
      const { ImageEngine } = await import('/src/engine/engine.ts');
      const engine = new ImageEngine(),
        renderer = await Renderer.create(
          document.createElement('canvas'),
          engine,
        ),
        results = [];
      const globals = {
        globalMask: new Uint8Array([
          0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 50, 128,
        ]),
        tags: [
          {
            key: 'LMsk',
            data: new Uint8Array([
              0, 0, 123, 45, 67, 89, 10, 11, 0, 0, 0, 50, 128, 0,
            ]),
          },
          {
            key: 'FMsk',
            data: new Uint8Array([0, 0, 12, 34, 56, 78, 90, 123, 0, 0, 0, 75]),
          },
          {
            key: 'zzzz',
            data: new Uint8Array([0, 1, 17, 128, 255]),
            wideLength: true,
          },
        ],
      };
      const normalize = (metadata) => ({
        globalMask: Array.from(metadata.globalMask),
        tags: metadata.tags.map((t) => [
          t.key,
          Array.from(t.data),
          !!t.wideLength,
        ]),
      });
      try {
        for (const depth of [8, 16, 32] as const)
          for (const psb of [false, true]) {
            const width = 7 + depth / 8,
              height = 5 + depth / 8;
            const data =
              depth === 8
                ? new Uint8ClampedArray(width * height * 4)
                : depth === 16
                  ? new Uint16Array(width * height * 4)
                  : new Float32Array(width * height * 4);
            for (let i = 0; i < width * height; i++)
              data.set(
                depth === 8
                  ? [31, 127, 223, 255]
                  : depth === 16
                    ? [1234, 32768, 65432, 65535]
                    : [-0.125, 0.1371234, 1.25, 1],
                i * 4,
              );
            const imageData = { width, height, data };
            const psd = {
              width,
              height,
              bitsPerChannel: depth,
              imageData,
              children: [
                {
                  name: 'Parent',
                  id: 0xffffffff,
                  blendMode: 'normal' as const,
                  children: [{ name: 'Source', id: 1, imageData }],
                },
              ],
            };
            const encoded =
              depth === 8
                ? writePsd(psd, { psb, noBackground: true })
                : writeHighDepthPsd(psd, psb);
            const original = new Uint8Array(
              restorePsdMetadata(new Uint8Array(encoded), globals),
            );
            const expected = normalize(readPsdMetadata(original));
            const loaded = await openPsd(
              new Blob([original]),
              psb ? 'Metadata.psb' : 'Metadata.psd',
              engine,
            );
            let project, reopened;
            try {
              const asset = loaded.document.psdMetadataAsset!;
              const assetType = loaded.assets.blob(asset).type;
              loaded.document.layers[0].children[0].transform.x = -1;
              const added = layer('solid', 'New layer', 2, 3);
              added.color = '#acf123';
              loaded.document.layers.push(added);
              // Document metadata remains independent of raster dimensions/geometry.
              resizeDocument(loaded.document, width * 2, height * 2);
              cropDocument(loaded.document, { x: 1, y: 2, width, height });
              project = await deserialize(
                await serialize(loaded.document, loaded.assets),
              );
              const projectAsset = project.assets.blob(
                project.document.psdMetadataAsset!,
              );
              const originalAsset = new Uint8Array(
                await loaded.assets.blob(asset).arrayBuffer(),
              );
              const assetExact = Array.from(
                new Uint8Array(await projectAsset.arrayBuffer()),
              ).every((v, i) => v === originalAsset[i]);
              await renderer.render(project.document, project.assets);
              const before = await renderer.rawPixels();
              let missingCallback = '';
              try {
                await savePsd(project.document, async () => {
                  throw new Error('render should not run');
                });
              } catch (e) {
                missingCallback = String(e);
              }
              const output = await savePsd(
                project.document,
                async (d) => {
                  await renderer.render(d, project.assets);
                  return renderer.rawPixels();
                },
                (l) => renderer.rawSourcePixels(l, project.assets),
                (id) => project.assets.blob(id),
              );
              const actual = normalize(
                readPsdMetadata(new Uint8Array(await output.arrayBuffer())),
              );
              reopened = await openPsd(output, 'Reopened.psd', engine);
              await renderer.render(reopened.document, reopened.assets);
              const after = await renderer.rawPixels();
              results.push({
                depth,
                psb,
                expected,
                actual,
                assetType,
                expectedType: psdMetadataMimeType,
                assetExact,
                missingCallback,
                maxError: before.reduce(
                  (n, v, i) => Math.max(n, Math.abs(v - after[i])),
                  0,
                ),
                sourceId: reopened.document.layers[0].children[0].psdId,
                parentId: reopened.document.layers[0].psdId,
                newId: reopened.document.layers[1].psdId,
                metadataAsset: !!reopened.document.psdMetadataAsset,
              });
            } finally {
              loaded.assets.clear();
              project?.assets.clear();
              reopened?.assets.clear();
            }
          }
      } finally {
        renderer.dispose();
        engine.dispose();
      }
      return results;
    });
    for (const result of results) {
      expect(result.actual).toEqual(result.expected);
      expect(result.assetType).toBe(result.expectedType);
      expect(result.assetExact).toBe(true);
      expect(result.metadataAsset).toBe(true);
      expect(result.missingCallback).toContain(
        'original document metadata asset',
      );
      expect(result.sourceId).toBe(1);
      expect(result.parentId).toBe(0xffffffff);
      expect(result.newId).toBe(2);
      expect(result.maxError).toBeLessThanOrEqual(
        result.depth === 8 ? 1 : result.depth === 16 ? 1 / 65535 : 1e-6,
      );
    }
  });
}

test('PSD UI duplication assigns a new identity while preserving opaque document data on download', async ({
  page,
}) => {
  await boot(page, 'default', 'window.puter={};');
  const bytes = await page.evaluate(async () => {
    const { writePsd } = await import('/tests/browser/psd-codec.ts');
    const { restorePsdMetadata } = await import('/src/model/psd-metadata.ts');
    const width = 9,
      height = 7,
      data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set([47, 89, 173, 255], i);
    const imageData = { width, height, data };
    const encoded = writePsd(
      {
        width,
        height,
        imageData,
        children: [{ name: 'Original', id: 0xffffffff, imageData }],
      },
      { noBackground: true },
    );
    return Array.from(
      new Uint8Array(
        restorePsdMetadata(new Uint8Array(encoded), {
          globalMask: new Uint8Array(),
          tags: [{ key: 'zzzz', data: new Uint8Array([13, 17, 19]) }],
        }),
      ),
    );
  });
  await openFiles(page, {
    name: 'Identity.psd',
    mimeType: 'image/vnd.adobe.photoshop',
    buffer: Buffer.from(bytes),
  });
  await expect(page.locator('#layers .layer-row')).toHaveCount(1);
  await menu(page, 'Layer', 'Duplicate Layer…');
  await page.locator('#dialog[open]').getByRole('button', { name: 'OK' }).click();
  await idle(page);
  await expect(page.locator('#layers .layer-row')).toHaveCount(2);
  await menu(page, 'Layer', 'Arrange', 'Send Backward');
  // The copy is now first in file order; it must not take the original's ID.
  const { bytes: output } = await downloadFrom(page, () => menu(page, 'File', 'Export', 'Export PSD'));
  const result = await page.evaluate(async (bytes) => {
    const { readPsd } = await import('/tests/browser/psd-codec.ts');
    const { readPsdMetadata } = await import('/src/model/psd-metadata.ts');
    const data = new Uint8Array(bytes),
      psd = readPsd(data, { useImageData: true });
    return {
      layers: psd.children!.map((l) => [l.name, l.id]),
      metadata: readPsdMetadata(data).tags.map((t) => [
        t.key,
        Array.from(t.data),
      ]),
    };
  }, Array.from(output));
  expect(result.layers).toEqual([
    ['Original copy', 1],
    ['Original', 0xffffffff],
  ]);
  expect(result.metadata).toEqual([['zzzz', [13, 17, 19]]]);
});
