import { test, expect } from "@playwright/test";
import { paneSection } from "./editor-commands.js";
import { readFile } from "node:fs/promises";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  P,
  parseDeck,
  createDeck,
  MIME,
  textEditorRectangle,
} from "../src/model.js";
import { presetGeometryFixture } from "../tests/preset-geometry-fixture.js";
import {
  geometryImage,
  createGeometryDeck,
  presetGeometry,
} from "../tests/geometry-fixture.js";

async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
}
async function load(page, bytes, count = 6) {
  const back = page.getByRole("button", { name: "Back to presentations" });
  if (await back.isVisible()) await back.click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Preset geometry.pptx",
    mimeType: MIME,
    buffer: Buffer.from(bytes),
  });
  // The editor, not the library it was opened from, before counting.
  await expect(page.locator("#slide-position")).toBeVisible();
  await expect(page.locator(".object-hit")).toHaveCount(count);
}
async function download(page) {
  await page
    .getByRole("menuitem", { name: "File", exact: true })
    .or(page.getByRole("button", { name: "File options" }))
    .filter({ visible: true })
    .click();
  const event = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const bytes = await readFile(await (await event).path());
  await page.keyboard.press("Escape");
  return { bytes, p: await parseDeck(bytes) };
}
const authored = (bytes, p) =>
  strFromU8(
    unzipSync(bytes)[P.getSlidePartName(P.getSlides(p)[0]).slice(1)],
  ).match(/<a:prstGeom\b[\s\S]*?<\/a:prstGeom>/g);

test("the corner inspector reads a formula adjustment and keeps it intact until edited", async ({
  page,
}) => {
  await start(page);
  const p = createDeck("blank"),
    s = P.getSlides(p)[0];
  P.addSlideTextBox(s, {
    text: "Formula corners",
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(4),
    h: P.inches(2),
  });
  const files = unzipSync(await P.savePresentation(p)),
    part = P.getSlidePartName(s).slice(1);
  files[part] = strToU8(
    strFromU8(files[part]).replace(
      /<a:prstGeom\b[\s\S]*?<\/a:prstGeom>/,
      '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="*/ 20000 2 1"/></a:avLst></a:prstGeom>',
    ),
  );
  const bytes = zipSync(files),
    source = await parseDeck(bytes);
  await load(page, bytes, 1);
  await page.locator(".object-hit").click();
  // The corners are sized in Size & Properties.
  await paneSection(page, "size");
  const radius = page.getByRole("slider", { name: "Corner radius (%)" });
  await expect(radius).toHaveValue("40");
  const before = await download(page);
  expect(authored(before.bytes, before.p)).toEqual(authored(bytes, source));
  await page.locator(".object-hit").click();
  await paneSection(page, "size");
  await radius.fill("30");
  const edited = await download(page),
    sh = P.getSlideShapes(P.getSlides(edited.p)[0])[0];
  expect(P.getShapeAdjustValues(sh)).toEqual({ adj: 30000 });
  const arc = P.getShapeGeometryResolved(
    edited.p,
    sh,
  ).geometry.paths[0].commands.find((c) => c.kind === "arcTo");
  expect(arc.wR).toBe(P.inches(2) * 0.3);
});

test("canonical paths shade their faces and use the same text bounds in canvas, slideshow and editing", async ({
  page,
}) => {
  await start(page);
  const bytes = await presetGeometryFixture(),
    source = await parseDeck(bytes);
  await load(page, bytes);
  const colors = await page.locator(".slide-image").evaluate(async (img) => {
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, 1280, 720);
    return [
      [900, 250],
      [1050, 80],
      [1170, 220],
      [60, 500],
      [385, 500],
    ].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
  });
  const base = [64, 128, 192],
    modifiers = [
      [1, 0],
      [0.8, 0.2],
      [0.8, 0],
      [0.6, 0.4],
      [0.6, 0],
    ];
  colors.forEach((rgba, i) => {
    const [slope, intercept] = modifiers[i];
    base.forEach((value, j) =>
      expect(
        Math.abs(rgba[j] - (value * slope + 255 * intercept)),
      ).toBeLessThanOrEqual(1),
    );
    expect(rgba[3]).toBe(255);
  });
  const before = await page.locator(".slide-image").getAttribute("src");
  await page.getByRole("button", { name: "Present", exact: true }).click();
  expect(await page.locator(".presenter-slide").getAttribute("src")).toBe(
    before,
  );
  await page.keyboard.press("Escape");
  const diamond = page.locator(".object-hit").nth(1);
  await diamond.click();
  await diamond.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  const box = await editor.evaluate((el) => ({
    x: parseFloat(el.style.left),
    y: parseFloat(el.style.top),
    w: parseFloat(el.style.width),
    h: parseFloat(el.style.height),
  }));
  const frame = textEditorRectangle(
      source,
      P.getSlideShapes(P.getSlides(source)[0])[1],
    ),
    size = P.getSlideSize(source);
  expect(box.x).toBeCloseTo((100 * frame.x) / size.width, 4);
  expect(box.y).toBeCloseTo((100 * frame.y) / size.height, 4);
  expect(box.w).toBeCloseTo((100 * frame.w) / size.width, 4);
  expect(box.h).toBeCloseTo((100 * frame.h) / size.height, 4);
  await editor.fill("Edited diamond bounds");
  await editor.press("Control+Enter");
  const edited = await download(page);
  expect(authored(edited.bytes, edited.p)).toEqual(authored(bytes, source));
  expect(P.getShapeText(P.getSlideShapes(P.getSlides(edited.p)[0])[1])).toBe(
    "Edited diamond bounds",
  );
  await load(page, edited.bytes);
});

test("the object clipboard retains preset formulas and multiple shaded paths in both directions", async ({
  page,
}) => {
  await start(page);
  const bytes = await presetGeometryFixture(),
    source = await parseDeck(bytes);
  await load(page, bytes);
  const objects = page.locator(".object-hit");
  await objects.nth(0).click();
  await objects.nth(2).click({ modifiers: ["Shift"] });
  await page.keyboard.press("Control+c");
  const target = createDeck("blank");
  P.addSlideTextBox(P.getSlides(target)[0], {
    text: "Target",
    x: P.inches(0.1),
    y: P.inches(0.1),
    w: P.inches(1),
    h: P.inches(0.4),
  });
  await load(page, await P.savePresentation(target), 1);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(3);
  const forward = await download(page);
  expect(authored(forward.bytes, forward.p).slice(-2)).toEqual([
    authored(bytes, source)[0],
    authored(bytes, source)[2],
  ]);
  await objects.nth(1).click();
  await objects.nth(2).click({ modifiers: ["Shift"] });
  await page.keyboard.press("Control+c");
  await load(page, bytes);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(8);
  const returned = await download(page);
  expect(authored(returned.bytes, returned.p).slice(-2)).toEqual([
    authored(bytes, source)[0],
    authored(bytes, source)[2],
  ]);
  expect(P.validatePresentation(returned.p)).toEqual([]);
});

test("gradient, pattern and image faces share fill coordinates and preserve alpha", async ({
  page,
}) => {
  await start(page);
  const imageDeck = await parseDeck(
    await createGeometryDeck({
      level: "local",
      geometry: presetGeometry("cube"),
      bounds: {
        x: P.inches(0.5),
        y: P.inches(0.5),
        w: P.inches(2),
        h: P.inches(2),
      },
    }),
  );
  const imageSlide = P.getSlides(imageDeck)[0];
  P.addSlideImage(imageSlide, geometryImage, {
    x: P.inches(3.5),
    y: P.inches(0.5),
    w: P.inches(2),
    h: P.inches(2),
  });
  for (const sh of P.getSlideShapes(imageSlide)) {
    P.setShapeNoStroke(sh);
    P.setShapeImageCrop(sh, { left: 0.1, top: 0.15, right: 0.2, bottom: 0.05 });
    P.setShapeImageBrightness(sh, 0.1);
  }
  const paints = await page.evaluate(
    async (imageDeckBytes) => {
      const { P, createDeck, parseDeck } = await import("/src/model.js");
      const { renderSlideToSvg } =
        await import("/lib/pptx-preview/src/index.ts");
      const results = [];
      for (const kind of [
        "gradient",
        "gradientAlpha",
        "pattern",
        "patternLine",
        "patternMotif",
        "image",
      ]) {
        const p =
            kind === "image"
              ? await parseDeck(new Uint8Array(imageDeckBytes))
              : createDeck("blank"),
          s = P.getSlides(p)[0];
        P.setSlideSize(p, { width: P.inches(6.25), height: P.inches(3.125) });
        for (const [i, preset] of (kind === "image"
          ? []
          : ["cube", "rect"]
        ).entries()) {
          const sh = P.addSlideShape(s, {
            x: P.inches(0.5) + i * 288 * 9525,
            y: P.inches(0.5),
            w: P.inches(2),
            h: P.inches(2),
            preset,
          });
          P.setShapeNoStroke(sh);
          if (kind.startsWith("gradient"))
            P.setShapeGradientFill(sh, {
              stops: [
                {
                  offset: 0,
                  color: "#4080C0",
                  opacity: kind === "gradientAlpha" ? 1 : 0.5,
                },
                {
                  offset: 1,
                  color: "#F0A060",
                  opacity: kind === "gradientAlpha" ? 0.2 : 0.5,
                },
              ],
              angleDeg: 0,
            });
          if (kind.startsWith("pattern"))
            P.setShapePatternFill(sh, {
              preset:
                kind === "patternLine"
                  ? "horz"
                  : kind === "patternMotif"
                    ? "sphere"
                    : "pct50",
              foreground: "#4080C0",
              background: "#C08040",
            });
        }
        const shapes = P.getSlideShapes(s);
        P.setShapePosition(shapes[1], P.inches(0.5), P.inches(0.5));
        const raster = async () => {
          const doc = new DOMParser().parseFromString(
            renderSlideToSvg(p, s),
            "image/svg+xml",
          );
          // Isolate alpha from the slide background.
          for (const el of doc.documentElement.children)
            if (el.localName === "rect") el.remove();
          const im = new Image();
          im.src =
            "data:image/svg+xml," +
            encodeURIComponent(new XMLSerializer().serializeToString(doc));
          await im.decode();
          const canvas = document.createElement("canvas");
          canvas.width = 600;
          canvas.height = 300;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(im, 0, 0, 600, 300);
          return ctx;
        };
        // Paint each control separately at the SAME coordinates. User-space
        // hatch phase stays fixed, independently of the shape's path bounds.
        P.setShapeHidden(shapes[1], true);
        const faceCanvas = await raster();
        P.setShapeHidden(shapes[1], false);
        P.setShapeHidden(shapes[0], true);
        const referenceCanvas = await raster();
        const samples = [
          [50, 10, 0.8, 0.2],
          [60, 100, 1, 0],
          [170, 85, 0.8, 0],
        ].map(([x, y, slope, intercept]) => ({
          slope,
          intercept,
          face: [...faceCanvas.getImageData(48 + x, 48 + y, 1, 1).data],
          reference: [
            ...referenceCanvas.getImageData(48 + x, 48 + y, 1, 1).data,
          ],
        }));
        results.push({ kind, samples });
      }
      return results;
    },
    [...(await P.savePresentation(imageDeck))],
  );
  for (const { kind, samples } of paints)
    for (const { face, reference, slope, intercept } of samples) {
      for (let j = 0; j < 3; j++)
        // Canvas readback unpremultiplies quantized RGB, amplifying rounding
        // at low alpha. Compare visible premultiplied channels instead.
        expect(
          Math.abs(
            (face[j] * face[3]) / 255 -
              ((reference[j] * slope + 255 * intercept) * reference[3]) / 255,
          ),
          `${kind} channel ${j}`,
        ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(face[3] - reference[3]),
        `${kind} alpha`,
      ).toBeLessThanOrEqual(1);
      expect(face[3]).toBeGreaterThan(0);
    }
});
