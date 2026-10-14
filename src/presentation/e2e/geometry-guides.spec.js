import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { P, parseDeck, MIME } from "../src/model.js";
import { geometryGuidesFixture } from "../tests/geometry-guides-fixture.js";

async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
}
async function load(page, bytes, count = 8) {
  const back = page.getByRole("button", { name: "Back to presentations" });
  if (await back.isVisible()) await back.click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Built-in geometry guides.pptx",
    mimeType: MIME,
    buffer: Buffer.from(bytes),
  });
  // The editor, not the library it was opened from, before counting.
  await expect(page.locator("#slide-position")).toBeVisible();
  await expect(page.locator(".object-hit")).toHaveCount(count);
}
async function paths(page, selector = ".slide-image") {
  return page.locator(selector).evaluate(async (img) => {
    await img.decode();
    const doc = new DOMParser().parseFromString(
      await (await fetch(img.src)).text(),
      "image/svg+xml",
    );
    if (doc.querySelector('[data-pptx-fallback="custGeom"]'))
      throw new Error("Valid guide geometry fell back");
    return [...doc.querySelectorAll('path[stroke="#1267B2"]')].map((el) =>
      el.getAttribute("d"),
    );
  });
}
async function download(page) {
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
function authored(bytes, p) {
  return strFromU8(
    unzipSync(bytes)[P.getSlidePartName(P.getSlides(p)[0]).slice(1)],
  ).match(/<a:custGeom\b[\s\S]*?<\/a:custGeom>/g);
}
function checkCoordinates(p, ds) {
  expect(ds).toHaveLength(8);
  P.getSlideShapes(P.getSlides(p)[0]).forEach((shape, index) => {
    const { x, y, w, h } = P.getShapeBoundsResolved(p, shape),
      short = Math.min(w, h);
    const expected =
      index < 4
        ? [x + w / 32, y + short / 16, x + short / 32, y + w / 32, x + w, y + h]
        : [
            x,
            y,
            x + (3 * w) / 32,
            y + (3 * short) / 32,
            x + short / 32,
            y + short / 16,
          ];
    const coordinates = ds[index].match(/-?\d+(?:\.\d+)?/g).map(Number);
    expect(coordinates).toHaveLength(expected.length);
    coordinates.forEach((value, i) =>
      expect(Math.abs(value - expected[i] / 9525)).toBeLessThan(0.006),
    );
  });
}
const contour = (path) => {
  const coordinates = path.match(/-?\d+(?:\.\d+)?/g).map(Number),
    x = coordinates[0],
    y = coordinates[1];
  return coordinates.map(
    (value, i) => Math.round((value - (i % 2 ? y : x)) * 100) / 100,
  );
};

test("built-in width and short-side guides paint and survive slideshow, text edits and downloads", async ({
  page,
}) => {
  await start(page);
  const bytes = await geometryGuidesFixture(),
    source = await parseDeck(bytes);
  await load(page, bytes);
  const before = await paths(page);
  checkCoordinates(source, before);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  expect(await paths(page, ".presenter-slide")).toEqual(before);
  await page.keyboard.press("Escape");
  const saved = await download(page);
  expect(authored(saved.bytes, saved.p)).toEqual(authored(bytes, source));
  await load(page, saved.bytes);
  expect(await paths(page)).toEqual(before);
  const shape = page.locator(".object-hit").first();
  await shape.click();
  await shape.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await editor.fill("Guide geometry edit");
  await editor.press("Control+Enter");
  expect(await paths(page)).toEqual(before);
  const edited = await download(page);
  expect(P.getShapeText(P.getSlideShapes(P.getSlides(edited.p)[0])[0])).toBe(
    "Guide geometry edit",
  );
  expect(authored(edited.bytes, edited.p)).toEqual(authored(bytes, source));
});

test("built-in guide paths retain formulas through actual object clipboard forward and return", async ({
  page,
}) => {
  await start(page);
  const bytes = await geometryGuidesFixture(),
    source = await parseDeck(bytes);
  await load(page, bytes);
  const before = await paths(page),
    selected = [0, 3, 4],
    objects = page.locator(".object-hit");
  for (let i = 0; i < selected.length; i++)
    await objects.nth(selected[i]).click(i ? { modifiers: ["Shift"] } : {});
  await page.keyboard.press("Control+c");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(3);
  expect((await paths(page)).map(contour)).toEqual(
    selected.map((i) => contour(before[i])),
  );
  const copied = await download(page),
    original = authored(bytes, source);
  expect(authored(copied.bytes, copied.p)).toEqual(
    selected.map((i) => original[i]),
  );
  for (let i = 0; i < 3; i++)
    await objects.nth(i).click(i ? { modifiers: ["Shift"] } : {});
  await page.keyboard.press("Control+c");
  await load(page, bytes);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(11);
  expect((await paths(page)).slice(-3).map(contour)).toEqual(
    selected.map((i) => contour(before[i])),
  );
  const returned = await download(page);
  expect(authored(returned.bytes, returned.p).slice(-3)).toEqual(
    selected.map((i) => original[i]),
  );
});
