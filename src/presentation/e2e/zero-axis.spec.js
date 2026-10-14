import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, parseDeck, createDeck, MIME } from "../src/model.js";
import { zeroAxisFixture } from "../tests/zero-axis-fixture.js";

test("zero-axis shape strokes paint in canvas and slideshow, move without changing size, and copy in both directions", async ({
  page,
}) => {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
  const p = await parseDeck(await zeroAxisFixture()),
    s = P.getSlides(p)[0];
  P.setSlideBackground(s, "#FFFFFF");
  const vertical = P.addSlideShape(s, {
    x: P.inches(6),
    y: P.inches(2),
    w: 0,
    h: P.inches(3),
    preset: "line",
  });
  P.setShapeNoFill(vertical);
  P.setShapeStroke(vertical, { color: "#1267B2", widthEmu: P.pt(3) });
  const original = await P.savePresentation(p),
    bounds = P.getSlideShapes(s).map((sh) => P.getShapeBoundsResolved(p, sh));
  async function load(bytes, count) {
    const back = page.getByRole("button", { name: "Back to presentations" });
    if (await back.isVisible()) await back.click();
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Import PPTX", exact: true })
      .click();
    await (
      await chooser
    ).setFiles({
      name: "Zero-axis paths.pptx",
      mimeType: MIME,
      buffer: Buffer.from(bytes),
    });
    // The editor, not the library it was opened from, before counting.
    await expect(page.locator("#slide-position")).toBeVisible();
    // An empty deck also has zero hits while import is still on the home
    // screen. Wait for the editor before sending clipboard shortcuts.
    await expect(back).toBeVisible();
    await expect(page.locator(".object-hit")).toHaveCount(count);
  }
  async function download() {
    await page
      .getByRole("menuitem", { name: "File", exact: true })
      .or(page.getByRole("button", { name: "File options" }))
      .filter({ visible: true })
      .click();
    const event = page.waitForEvent("download");
    await page
      .getByRole("menuitem", {
        name: "Download PowerPoint (.pptx)",
        exact: true,
      })
      .click();
    const bytes = await readFile(await (await event).path());
    await page.keyboard.press("Escape");
    return { bytes, p: await parseDeck(bytes) };
  }
  async function select(index) {
    const hit = page.locator(".object-hit").nth(index);
    await hit.focus();
    await hit.press("Space");
    await expect(hit).toHaveAttribute("aria-pressed", "true");
    await hit.focus();
    return hit;
  }
  async function copyAll() {
    await select(0);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+c");
  }
  const uri = () => page.locator(".slide-image").getAttribute("src");
  await load(original, 2);
  const pixels = await page.locator(".slide-image").evaluate(async (img) => {
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 1280;
    c.height = 720;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, 1280, 720);
    return [
      [250, 96],
      [576, 320],
    ].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
  });
  expect(pixels).toEqual([
    [18, 103, 178, 255],
    [18, 103, 178, 255],
  ]);
  const before = await uri();
  await page.getByRole("button", { name: "Present", exact: true }).click();
  expect(await page.locator(".presenter-slide").getAttribute("src")).toBe(
    before,
  );
  await page.keyboard.press("Escape");
  await (await select(0)).press("ArrowDown");
  await expect.poll(uri).not.toBe(before);
  const moved = await download(),
    movedShape = P.getSlideShapes(P.getSlides(moved.p)[0])[0];
  expect(P.getShapeBoundsResolved(moved.p, movedShape).h).toBe(0);
  expect(P.getShapeBoundsResolved(moved.p, movedShape).w).toBe(bounds[0].w);
  await page.keyboard.press("Control+z");
  await expect.poll(uri).toBe(before);
  await copyAll();
  await load(await P.savePresentation(createDeck("blank")), 0);
  await page.keyboard.press("Control+v");
  await expect(page.locator(".object-hit")).toHaveCount(2);
  const forward = await download();
  expect(
    P.getSlideShapes(P.getSlides(forward.p)[0]).map((sh) =>
      P.getShapeBoundsResolved(forward.p, sh),
    ),
  ).toEqual(bounds);
  expect(P.validatePresentation(forward.p)).toEqual([]);
  await copyAll();
  await load(original, 2);
  await page.keyboard.press("Control+v");
  await expect(page.locator(".object-hit")).toHaveCount(4);
  const returned = await download();
  expect(
    P.getSlideShapes(P.getSlides(returned.p)[0])
      .slice(2)
      .map((sh) => P.getShapeBoundsResolved(returned.p, sh)),
  ).toEqual(bounds);
  expect(P.validatePresentation(returned.p)).toEqual([]);
});
