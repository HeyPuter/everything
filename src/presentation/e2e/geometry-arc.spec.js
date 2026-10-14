import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, parseDeck, MIME } from "../src/model.js";
import native from "../tests/data/geometry-arc-native.json" with { type: "json" };
import { geometryArcFixture } from "../tests/geometry-arc-fixture.js";

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
    name: "Native ellipse arcs.pptx",
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
    return [...doc.querySelectorAll('path[stroke="#1267B2"]')].map((el) =>
      el.getAttribute("d"),
    );
  });
}
function contour(d) {
  const commands = d.match(/[A-Z][^A-Z]*/g),
    first = commands[0]
      .slice(1)
      .match(/-?\d+(?:\.\d+)?/g)
      .map(Number);
  return commands.map((command) => {
    const kind = command[0],
      values =
        command
          .slice(1)
          .match(/-?\d+(?:\.\d+)?/g)
          ?.map(Number) ?? [];
    if (values.length) {
      values[values.length - 2] =
        Math.round((values.at(-2) - first[0]) * 100) / 100;
      values[values.length - 1] =
        Math.round((values.at(-1) - first[1]) * 100) / 100;
    }
    return { kind, values };
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
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const p = await parseDeck(await readFile(await (await event).path()));
  await page.keyboard.press("Escape");
  return p;
}
const geometries = (p) =>
  P.getSlideShapes(P.getSlides(p)[0]).map((sh) =>
    P.getShapeGeometryEffective(p, sh),
  );
function nativeEnds(p, ds, set) {
  const shapes = P.getSlideShapes(P.getSlides(p)[0]);
  ds.forEach((d, index) => {
    const command = d.match(/[A-Z][^A-Z]*/g).at(set === "ordinary" ? -1 : -2),
      end = command
        .slice(1)
        .match(/-?\d+(?:\.\d+)?/g)
        .map(Number)
        .slice(-2),
      bounds = P.getShapeBoundsResolved(p, shapes[index]);
    for (let axis = 0; axis < 2; axis++)
      expect(
        Math.abs(
          end[axis] -
            ((axis ? bounds.y : bounds.x) +
              native.sets[set][index].nativeEndEmu[axis]) /
              9525,
        ),
      ).toBeLessThan(0.006);
  });
}
test("native ellipse arcs use exact radial geometry through slideshow and .pptx download", async ({
  page,
}) => {
  await start(page);
  const bytes = await geometryArcFixture(),
    source = await parseDeck(bytes);
  await load(page, bytes);
  const before = await paths(page);
  nativeEnds(source, before, "ordinary");
  expect(before.every((d) => d.includes("A") && !d.includes("C"))).toBe(true);
  // These two points were independently sampled from the pre-fix native print.
  // Old parametric conversion painted the first and missed the second.
  const pixels = await page.locator(".slide-image").evaluate(async (img) => {
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 1280;
    c.height = 720;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, 1280, 720);
    return [
      [130, 139],
      [145, 133],
    ].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
  });
  expect(pixels).toEqual([
    [245, 243, 238, 255],
    [18, 103, 178, 255],
  ]);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  expect(await paths(page, ".presenter-slide")).toEqual(before);
  await page.keyboard.press("Escape");
  const saved = await download(page);
  expect(geometries(saved)).toEqual(geometries(source));
  await load(page, await P.savePresentation(saved));
  expect(await paths(page)).toEqual(before);
  const object = page.locator(".object-hit").nth(0);
  await object.click();
  await object.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeVisible();
  await editor.fill("Native radial arc");
  await editor.press("Control+Enter");
  expect(await paths(page)).toEqual(before);
  const edited = await download(page);
  expect(P.getShapeText(P.getSlideShapes(P.getSlides(edited)[0])[0])).toBe(
    "Native radial arc",
  );
  expect(geometries(edited)).toEqual(geometries(source));
});
test("signed, collapsed and oversized native arcs retain their authored geometry on download", async ({
  page,
}) => {
  await start(page);
  for (const set of ["edge", "signed"]) {
    const bytes = await geometryArcFixture(set),
      source = await parseDeck(bytes);
    await load(page, bytes);
    const before = await paths(page);
    nativeEnds(source, before, set);
    expect(before.every((d) => !d.includes("C"))).toBe(true);
    const saved = await download(page);
    expect(geometries(saved)).toEqual(geometries(source));
    await load(page, await P.savePresentation(saved));
    expect(await paths(page)).toEqual(before);
  }
});
test("radial ellipse arcs survive actual object clipboard forward and return without materializing paths", async ({
  page,
}) => {
  await start(page);
  const bytes = await geometryArcFixture(),
    source = await parseDeck(bytes);
  await load(page, bytes);
  const before = (await paths(page)).map(contour),
    objects = page.locator(".object-hit");
  for (let i = 0; i < 3; i++)
    await objects.nth(i).click(i ? { modifiers: ["Shift"] } : {});
  await page.keyboard.press("Control+c");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(3);
  expect((await paths(page)).map(contour)).toEqual(before.slice(0, 3));
  const copied = await download(page);
  expect(geometries(copied)).toEqual(geometries(source).slice(0, 3));
  for (let i = 0; i < 3; i++)
    await objects.nth(i).click(i ? { modifiers: ["Shift"] } : {});
  await page.keyboard.press("Control+c");
  await load(page, bytes);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(11);
  expect((await paths(page)).slice(-3).map(contour)).toEqual(
    before.slice(0, 3),
  );
  const returned = await download(page);
  expect(geometries(returned).slice(-3)).toEqual(
    geometries(source).slice(0, 3),
  );
});
