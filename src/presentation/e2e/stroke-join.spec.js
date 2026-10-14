import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, parseDeck, MIME } from "../src/model.js";
import {
  strokeJoinFixture,
  strokeJoinEdgeFixture,
} from "../tests/stroke-join-fixture.js";
async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
}
async function load(page, bytes, count) {
  const back = page.getByRole("button", { name: "Back to presentations" });
  if (await back.isVisible()) await back.click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Native outline joins.pptx",
    mimeType: MIME,
    buffer: Buffer.from(bytes),
  });
  // The editor, not the library it was opened from, before counting.
  await expect(page.locator("#slide-position")).toBeVisible();
  await expect(page.locator(".object-hit")).toHaveCount(count);
}
async function styles(page, selector = ".slide-image") {
  return page.locator(selector).evaluate(async (img) => {
    await img.decode();
    const doc = new DOMParser().parseFromString(
      await (await fetch(img.src)).text(),
      "image/svg+xml",
    );
    return [...doc.querySelectorAll('[stroke="#1267B2"]')].map((el) => ({
      join: el.getAttribute("stroke-linejoin"),
      limit: el.getAttribute("stroke-miterlimit"),
    }));
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
test("native default and explicit joins survive presentation and .pptx download without flattening defaults", async ({
  page,
}) => {
  await start(page);
  const bytes = await strokeJoinFixture();
  await load(page, bytes, 8);
  const expected = [
    "round",
    "round",
    "miter",
    "bevel",
    "round",
    "round",
    "miter",
    "bevel",
  ].map((join) => ({ join, limit: join === "miter" ? "8" : null }));
  expect(await styles(page)).toEqual(expected);
  // Native pre-fix print export confirms this point is outside the rounded
  // first rectangle corner. SVG's unconfigured miter covered it with blue.
  const corner = await page.locator(".slide-image").evaluate(async (img) => {
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 1280;
    c.height = 720;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, 1280, 720);
    return [...ctx.getImageData(53, 63, 1, 1).data];
  });
  expect(corner).toEqual([255, 255, 255, 255]);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  expect(await styles(page, ".presenter-slide")).toEqual(expected);
  await page.keyboard.press("Escape");
  const saved = await download(page),
    sh = P.getSlideShapes(P.getSlides(saved)[0]);
  for (const i of [0, 4]) {
    expect(P.getShapeStrokeJoin(sh[i])).toBeNull();
    expect(P.getShapeStrokeJoinResolved(sh[i])).toEqual({ kind: "round" });
  }
  await load(page, await P.savePresentation(saved), 8);
  expect(await styles(page)).toEqual(expected);
});
test("native picture, custom path and star join policies keep explicit limits and survive download", async ({
  page,
}) => {
  await start(page);
  await load(page, await strokeJoinEdgeFixture(), 12);
  const expected = [0, 1, 2].flatMap((row) =>
    ["round", "round", "miter", "bevel"].map((join, col) => ({
      join: row === 2 && col < 2 ? "miter" : join,
      limit: col === 2 ? "3.5" : row === 2 && col < 2 ? "8" : null,
    })),
  );
  expect(await styles(page)).toEqual(expected);
  const saved = await download(page);
  await load(page, await P.savePresentation(saved), 12);
  expect(await styles(page)).toEqual(expected);
});
test("native joins survive object clipboard forward and return with authored defaults preserved", async ({
  page,
}) => {
  await start(page);
  const bytes = await strokeJoinFixture();
  await load(page, bytes, 8);
  const source = await styles(page),
    objects = page.locator(".object-hit");
  await objects.nth(0).click();
  await objects.nth(4).click({ modifiers: ["Shift"] });
  await objects.nth(6).click({ modifiers: ["Shift"] });
  await page.keyboard.press("Control+c");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(3);
  expect(await styles(page)).toEqual([source[0], source[4], source[6]]);
  const copied = await download(page),
    shapes = P.getSlideShapes(P.getSlides(copied)[0]);
  expect(shapes.map((s) => P.getShapeStrokeJoin(s))).toEqual([
    null,
    null,
    "miter",
  ]);
  for (let i = 0; i < 3; i++)
    await objects.nth(i).click(i ? { modifiers: ["Shift"] } : {});
  await page.keyboard.press("Control+c");
  await load(page, bytes, 8);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(11);
  expect((await styles(page)).slice(-3)).toEqual([
    source[0],
    source[4],
    source[6],
  ]);
  const returned = await download(page);
  expect(
    P.getSlideShapes(P.getSlides(returned)[0])
      .slice(-3)
      .map((s) => P.getShapeStrokeJoin(s)),
  ).toEqual([null, null, "miter"]);
});
