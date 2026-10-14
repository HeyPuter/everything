import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, parseDeck, preview } from "../src/model.js";
import { templateFixture } from "../tests/template-import-fixture.js";
import { lineFormattingFixture } from "../tests/line-formatting-fixture.js";
import { createSharedFontDeck } from "../tests/fixtures.js";
import {
  createGeometryDeck,
  triangleGeometry,
  presetGeometry,
} from "../tests/geometry-fixture.js";
import { BUILTIN_LAYOUTS } from "../lib/pptx/src/internal/parts/builtin-layouts.ts";

for (const kind of [
  "master artwork",
  "placeholder formatting",
  "shared font descriptor",
  "editable template geometry",
])
  test(`native template transfer retains ${kind} in browser rendering, return copy and app download`, async ({
    page,
  }) => {
    await page.route("https://js.puter.com/v2/", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
      }),
    );
    await page.goto("/#/home");
    const shared =
      kind === "shared font descriptor"
        ? await parseDeck(await createSharedFontDeck({ encoded: true }))
        : null;
    const geometry =
      kind === "editable template geometry"
        ? await parseDeck(await createGeometryDeck({ inheritedBounds: true }))
        : null;
    const f =
      shared || geometry
        ? {
            pres: shared || geometry,
            slide: P.getSlides(shared || geometry)[0],
          }
        : kind === "master artwork"
          ? templateFixture()
          : await lineFormattingFixture({ local: "", shapeKind: "shape" });
    const result = await page.evaluate(
      async ({ bytes, inherit, originalGeometry, editedGeometry }) => {
        const { P, parseDeck, createDeck, preview } =
          await import("/src/model.js");
        const source = await parseDeck(Uint8Array.from(bytes)),
          sourceSlide = P.getSlides(source)[0];
        const target = createDeck("blank"),
          layout = P.importSlideTemplate(target, sourceSlide),
          options = inherit
            ? { preserveGeometry: false }
            : { preserveTextFormatting: true, preservePaintFormatting: true };
        const copied = P.importSlide(target, sourceSlide, layout, options);
        const before = preview(target, copied);
        let unchangedBody = true;
        if (inherit) {
          const { INTERNAL_PACKAGE } =
            await import("/lib/pptx/src/api/_internal-symbols.ts");
          const enc = new TextEncoder(),
            dec = new TextDecoder();
          unchangedBody =
            Array.from(
              target[INTERNAL_PACKAGE].getPart(P.getSlidePartName(copied)).data,
            ).join() ===
            Array.from(
              source[INTERNAL_PACKAGE].getPart(P.getSlidePartName(sourceSlide))
                .data,
            ).join();
          for (const [pres, template] of [
            [source, P.getSlideLayout(sourceSlide)],
            [target, layout],
          ]) {
            const part = pres[INTERNAL_PACKAGE].getPart(
              P.getSlideLayoutPartName(template),
            );
            part.data = enc.encode(
              dec
                .decode(part.data)
                .replace(originalGeometry, editedGeometry)
                .replace(`cx="${P.inches(4)}"`, `cx="${P.inches(5)}"`),
            );
          }
        }
        const sourceUri = preview(source, sourceSlide);
        const exported = await P.savePresentation(target),
          restored = await parseDeck(exported),
          last = P.getSlides(restored).at(-1);
        const back = createDeck("blank"),
          returned = P.importSlide(
            back,
            last,
            P.importSlideTemplate(back, last),
            options,
          );
        const paint = async (uri) => {
          const image = new Image();
          image.src = uri;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.getContext("2d").drawImage(image, 0, 0);
          return canvas.toDataURL();
        };
        return {
          bytes: Array.from(exported),
          unchangedBody,
          geometryChanged: before !== preview(target, copied),
          sourceUri,
          copiedUri: preview(target, copied),
          restoredUri: preview(restored, last),
          returnedUri: preview(back, returned),
          sourcePixels: await paint(sourceUri),
          copiedPixels: await paint(preview(target, copied)),
          shapes: P.getSlideShapes(copied).length,
          errors: P.validatePresentation(restored).filter(
            (i) => i.severity === "error",
          ),
        };
      },
      {
        bytes: Array.from(await P.savePresentation(f.pres)),
        inherit: kind === "editable template geometry",
        originalGeometry: triangleGeometry,
        editedGeometry: presetGeometry("ellipse"),
      },
    );
    expect(result.copiedUri).toBe(result.sourceUri);
    expect(result.restoredUri).toBe(result.sourceUri);
    expect(result.returnedUri).toBe(result.sourceUri);
    expect(result.copiedPixels).toBe(result.sourcePixels);
    expect(result.shapes).toBe(P.getSlideShapes(f.slide).length);
    expect(result.errors).toEqual([]);
    if (kind === "editable template geometry") {
      expect(result.unchangedBody).toBe(true);
      expect(result.geometryChanged).toBe(true);
    }

    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await chooser
    ).setFiles({
      name: "Native templates.pptx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from(result.bytes),
    });
    await expect(page.locator("#slide-position")).toHaveText("Slide 1 of 2");
    const second = page.getByRole("button", { name: /^Slide 2:/ });
    if (!(await second.isVisible()))
      await page
        .getByRole("button", { name: "Toggle slide navigator", exact: true })
        .click();
    await second.click();
    await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 2");
    await expect(page.locator(".object-hit")).toHaveCount(result.shapes);
    await expect(page.locator(".slide-image")).toHaveAttribute(
      "src",
      result.sourceUri,
    );
    await page
      .getByRole("menuitem", { name: "File", exact: true })
      .or(page.getByRole("button", { name: "File options" }))
      .filter({ visible: true })
      .click();
    const download = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const downloadedBytes = await readFile(await (await download).path()),
      downloaded = await parseDeck(downloadedBytes);
    // Keep font measurement in the same environment for each comparison.
    const downloadedUri = await page.evaluate(async (bytes) => {
      const { P, parseDeck, preview } = await import("/src/model.js");
      const pres = await parseDeck(Uint8Array.from(bytes));
      return preview(pres, P.getSlides(pres).at(-1));
    }, Array.from(downloadedBytes));
    expect(downloadedUri).toBe(result.sourceUri);
    const expected = geometry
      ? await parseDeck(Uint8Array.from(result.bytes))
      : f.pres;
    expect(preview(downloaded, P.getSlides(downloaded).at(-1))).toBe(
      preview(expected, geometry ? P.getSlides(expected).at(-1) : f.slide),
    );
    // The new presentation's built-in layouts and the one imported.
    expect(P.getSlideLayouts(downloaded)).toHaveLength(
      BUILTIN_LAYOUTS.length + 1,
    );
  });
