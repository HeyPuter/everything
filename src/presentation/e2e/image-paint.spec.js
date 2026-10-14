import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, parseDeck, createDeck, MIME } from "../src/model.js";
import { imagePaintFixture } from "../tests/image-paint-fixture.js";
import { geometryImage } from "../tests/geometry-fixture.js";
const first = (p) => P.getSlideShapes(P.getSlides(p)[0])[0];
const semanticPaint = (p) => ({
  ...P.getShapeImagePaintEffective(p, first(p)),
  partName: null,
});
async function load(page, bytes, n) {
  const back = page.getByRole("button", { name: "Back to presentations" });
  if (await back.isVisible()) await back.click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Image paint.pptx",
    mimeType: MIME,
    buffer: Buffer.from(bytes),
  });
  // The editor, not the library it was opened from, before counting.
  await expect(page.locator("#slide-position")).toBeVisible();
  await expect(page.locator(".object-hit")).toHaveCount(n);
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
async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
}
async function select(page, index) {
  const hit = page.locator(".object-hit").nth(index);
  await hit.focus();
  await hit.press("Space");
  await expect(hit).toHaveAttribute("aria-pressed", "true");
  await hit.focus();
  return hit;
}

test("inherited image paint matches a literal picture, keeps alpha and text, and survives export", async ({
  page,
}) => {
  await start(page);
  const p = await parseDeck(await imagePaintFixture()),
    s = P.getSlides(p)[0],
    shape = first(p),
    bounds = P.getShapeBoundsResolved(p, shape);
  const control = P.addSlideImage(s, geometryImage, {
    ...bounds,
    x: bounds.x + P.inches(6),
  });
  P.setShapeImageCrop(control, {
    left: 0.1,
    top: 0.15,
    right: 0.2,
    bottom: 0.05,
  });
  P.setShapeImageOpacity(control, 0.25);
  P.setShapeImageBrightness(control, 0.1);
  P.setShapeImageContrast(control, 0.8);
  const bytes = await P.savePresentation(p),
    before = semanticPaint(p);
  await load(page, bytes, 2);
  const pixels = await page.locator(".slide-image").evaluate(async (img) => {
    await img.decode();
    const doc = new DOMParser().parseFromString(
      await (await fetch(img.src)).text(),
      "image/svg+xml",
    );
    for (const el of doc.documentElement.children)
      if (el.localName === "rect") el.remove();
    const raster = new Image();
    raster.src =
      "data:image/svg+xml," +
      encodeURIComponent(new XMLSerializer().serializeToString(doc));
    await raster.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(raster, 0, 0, 1280, 720);
    return [
      [140, 160],
      [350, 250],
    ].map(([x, y]) => ({
      inherited: [...ctx.getImageData(x, y, 1, 1).data],
      literal: [...ctx.getImageData(x + 576, y, 1, 1).data],
    }));
  });
  for (const { inherited, literal } of pixels) {
    inherited.forEach((n, i) =>
      expect(Math.abs(n - literal[i])).toBeLessThanOrEqual(1),
    );
    expect(inherited[3]).toBe(64);
  }
  const uri = await page.locator(".slide-image").getAttribute("src");
  await page.getByRole("button", { name: "Present", exact: true }).click();
  expect(await page.locator(".presenter-slide").getAttribute("src")).toBe(uri);
  await page.keyboard.press("Escape");
  await (await select(page, 0)).press("Enter");
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeVisible();
  await editor.fill("Image fill retains text");
  await editor.press("Control+Enter");
  const saved = await download(page);
  expect(P.getShapeText(first(saved.p))).toBe("Image fill retains text");
  expect(semanticPaint(saved.p)).toEqual(before);
  expect(P.validatePresentation(saved.p)).toEqual([]);
  await load(page, saved.bytes, 2);
});

test("actual object clipboard retains inherited image corrections in both directions", async ({
  page,
}) => {
  await start(page);
  const bytes = await imagePaintFixture({ level: "master" }),
    p = await parseDeck(bytes),
    before = semanticPaint(p);
  await load(page, bytes, 1);
  await select(page, 0);
  await page.keyboard.press("Control+c");
  await load(page, await P.savePresentation(createDeck("blank")), 0);
  await page.keyboard.press("Control+v");
  await expect(page.locator(".object-hit")).toHaveCount(1);
  const forward = await download(page);
  expect(semanticPaint(forward.p)).toEqual(before);
  expect(P.validatePresentation(forward.p)).toEqual([]);
  await select(page, 0);
  await page.keyboard.press("Control+c");
  await load(page, bytes, 1);
  await page.keyboard.press("Control+v");
  await expect(page.locator(".object-hit")).toHaveCount(2);
  const returned = await download(page);
  expect({
    ...P.getShapeImagePaintEffective(
      returned.p,
      P.getSlideShapes(P.getSlides(returned.p)[0])[1],
    ),
    partName: null,
  }).toEqual(before);
  expect(P.validatePresentation(returned.p)).toEqual([]);
});
