import { test, expect } from "@playwright/test";

for (const backend of ["default", "WebGL"]) {
  test(`PSD image resources survive native saves and edited exports (${backend})`, async ({
    page,
  }) => {
    if (backend === "WebGL")
      await page.addInitScript(() =>
        Object.defineProperty(navigator, "gpu", { value: undefined }),
      );
    await page.route("https://js.puter.com/**", (r) =>
      r.fulfill({
        contentType: "application/javascript",
        body: "window.puter={};",
      }),
    );
    await page.goto("/");
    await expect(page.locator("#engine-status")).toHaveText(/WebGPU|WebGL2/);
    const results = await page.evaluate(async () => {
      const { writePsd, readPsd } = await import("/tests/browser/psd-codec.ts");
      const { writeHighDepthPsd } =
        await import("/src/model/psd-high-depth.ts");
      const { openPsd, savePsd } = await import("/src/model/psd.ts");
      const { readPsdImageResource, replacePsdImageResource } =
        await import("/src/model/psd-resources.ts");
      const { serialize, deserialize } =
        await import("/src/model/serialization.ts");
      const { layer, resizeDocument, cropDocument } =
        await import("/src/model/document.ts");
      const { Renderer } = await import("/src/renderer/renderer.ts");
      const { ImageEngine } = await import("/src/engine/engine.ts");
      const engine = new ImageEngine();
      const renderer = await Renderer.create(
        document.createElement("canvas"),
        engine,
      );
      const results = [];
      const opaque = [
        [
          1028,
          new Uint8Array([
            0x1c,
            2,
            120,
            0,
            7,
            ...new TextEncoder().encode("Caption"),
          ]),
        ],
        [
          1060,
          new TextEncoder().encode(
            '<x:xmpmeta xmlns:x="urn:example:meta/"><title>Preserved</title></x:xmpmeta>',
          ),
        ],
        [60000, Uint8Array.from({ length: 8193 }, (_, i) => i % 251)],
      ] as const;
      try {
        for (const depth of [8, 16, 32] as const)
          for (const psb of [false, true]) {
            const width = depth / 8 + 5,
              height = depth / 8 + 3;
            const data =
              depth === 8
                ? new Uint8ClampedArray(width * height * 4)
                : depth === 16
                  ? new Uint16Array(width * height * 4)
                  : new Float32Array(width * height * 4);
            for (let i = 0; i < data.length; i += 4)
              data.set(
                depth === 8
                  ? [13, 127, 237, 255]
                  : depth === 16
                    ? [1234, 34567, 64532, 65535]
                    : [-0.25, 0.1234567, 1.25, 1],
                i,
              );
            const imageData = { width, height, data };
            const input = {
              width,
              height,
              bitsPerChannel: depth,
              imageData,
              children: [{ id: 17, name: "Source", imageData }],
              imageResources: { iccUntaggedProfile: true },
            };
            let encoded =
              depth === 8
                ? writePsd(input, { psb, noBackground: true })
                : writeHighDepthPsd(input, psb);
            for (const [id, bytes] of [
              ...opaque,
              [1039, new Uint8Array([1, 2, 3, 4])] as const,
            ])
              encoded = replacePsdImageResource(
                new Uint8Array(encoded),
                id,
                bytes,
              );
            const loaded = await openPsd(
              new Blob([encoded]),
              "Resources.psd",
              engine,
            );
            let project, reopened;
            try {
              const originalAsset = loaded.assets.blob(
                loaded.document.psdResourcesAsset!,
              );
              loaded.document.iccProfile = undefined;
              loaded.document.iccUntaggedProfile = false;
              const added = layer("solid", "Added", width, height);
              added.color = "#7ac54f";
              added.opacity = 0.35;
              added.blend = "multiply";
              loaded.document.layers.push(added);
              resizeDocument(loaded.document, width * 2, height * 2);
              cropDocument(loaded.document, { x: 1, y: 1, width, height });
              project = await deserialize(
                await serialize(loaded.document, loaded.assets),
              );
              const actualAsset = project.assets.blob(
                project.document.psdResourcesAsset!,
              );
              const expected = new Uint8Array(
                await originalAsset.arrayBuffer(),
              );
              const actual = new Uint8Array(await actualAsset.arrayBuffer());
              let missingCallback = "";
              try {
                await savePsd(project.document, async () => {
                  throw new Error("Should not render");
                });
              } catch (error) {
                missingCallback = String(error);
              }
              await renderer.render(project.document, project.assets);
              const nativeOpacity = project.document.layers[1].opacity;
              // PSD layer-record opacity is an unsigned byte at every channel
              // depth. Compare the rendered reopen with independently quantized
              // opacity, rather than claiming float opacity is lossless in PSD.
              const psdOpacity = Math.round(nativeOpacity * 255) / 255;
              const expectedDocument = structuredClone(project.document);
              expectedDocument.layers[1].opacity = psdOpacity;
              await renderer.render(expectedDocument, project.assets);
              const before = await renderer.rawPixels();
              const output = await savePsd(
                project.document,
                async (d) => {
                  await renderer.render(d, project.assets);
                  return renderer.rawPixels();
                },
                (l) => renderer.rawSourcePixels(l, project.assets),
                (id) => project.assets.blob(id),
              );
              const bytes = new Uint8Array(await output.arrayBuffer());
              const decoded = readPsd(bytes, {
                skipLayerImageData: true,
                skipCompositeImageData: true,
                skipThumbnail: true,
              });
              reopened = await openPsd(output, "Again.psd", engine);
              await renderer.render(reopened.document, reopened.assets);
              const after = await renderer.rawPixels();
              results.push({
                depth,
                psb,
                nativeOpacity,
                psdOpacity,
                reopenedOpacity: reopened.document.layers[1].opacity,
                assetExact:
                  expected.length === actual.length &&
                  expected.every((v, i) => v === actual[i]),
                missingCallback,
                retained: opaque.map(([id, data]) => {
                  const out = readPsdImageResource(bytes, id);
                  return (
                    out?.length === data.length &&
                    out.every((v, i) => v === data[i])
                  );
                }),
                profile: !!readPsdImageResource(bytes, 1039),
                untagged: decoded.imageResources?.iccUntaggedProfile,
                version: decoded.imageResources?.versionInfo,
                kinds: reopened.document.layers.map((l) => l.kind),
                error: before.reduce(
                  (n, v, i) => Math.max(n, Math.abs(v - after[i])),
                  0,
                ),
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
    expect(results).toHaveLength(6);
    for (const r of results) {
      expect(r.assetExact).toBe(true);
      expect(r.missingCallback).toContain("original image resources asset");
      expect(r.retained).toEqual([true, true, true]);
      expect(r.profile).toBe(false);
      expect(r.untagged).toBe(false);
      expect(r.version).toEqual({
        hasRealMergedData: true,
        writerName: "Photo Editor",
        readerName: "Photo Editor",
        fileVersion: 1,
      });
      expect(r.kinds).toEqual(["image", "image"]);
      expect(r.nativeOpacity).toBe(0.35);
      expect(r.reopenedOpacity).toBe(r.psdOpacity);
      expect(r.error).toBeLessThanOrEqual(
        r.depth === 16 ? 1 / 65535 : 0.000001,
      );
    }
  });
}
