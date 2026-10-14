import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { P, parseDeck, MIME } from "../src/model.js";
import { geometryTextRectFixture } from "../tests/geometry-text-rect-fixture.js";

async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
}
async function load(page, bytes, count = 3) {
  const back = page.getByRole("button", { name: "Back to presentations" });
  if (await back.isVisible()) await back.click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Custom text rectangles.pptx",
    mimeType: MIME,
    buffer: Buffer.from(bytes),
  });
  // The editor, not the library it was opened from, before counting.
  await expect(page.locator("#slide-position")).toBeVisible();
  await expect(page.locator(".object-hit")).toHaveCount(count);
}
async function textPositions(page, selector = ".slide-image") {
  return page.locator(selector).evaluate(async (img) => {
    await img.decode();
    const doc = new DOMParser().parseFromString(
      await (await fetch(img.src)).text(),
      "image/svg+xml",
    );
    return [...doc.querySelectorAll("[data-pptx-shape-name]")].map((group) =>
      [...group.querySelectorAll("text")].map((text) => ({
        x: Number(text.getAttribute("x")),
        y: Number(text.getAttribute("y")),
        text: text.textContent,
      })),
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
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
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
function checkPositions(p, positions) {
  const shapes = P.getSlideShapes(P.getSlides(p)[0]);
  expect(positions).toHaveLength(shapes.length);
  shapes.forEach((sh, i) => {
    const b = P.getShapeBoundsResolved(p, sh),
      rect = P.getShapeGeometryEffective(p, sh).geometry.textRect;
    const expected = (b.x + rect.l + P.getShapeTextMargins(sh).left) / 9525;
    expect(positions[i].length).toBeGreaterThan(0);
    for (const line of positions[i])
      expect(Math.abs(line.x - expected)).toBeLessThan(0.006);
  });
}

test("custom text rectangles constrain canvas, slideshow and the inline editor and retain formulas after edits", async ({
  page,
}) => {
  await start(page);
  const bytes = await geometryTextRectFixture(),
    source = await parseDeck(bytes);
  await load(page, bytes);
  const before = await textPositions(page);
  checkPositions(source, before);
  expect(before[0].length).toBeGreaterThan(before[2].length);
  expect(before[0][0].y - before[2][0].y).toBeCloseTo(72, 2);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  expect(await textPositions(page, ".presenter-slide")).toEqual(before);
  await page.keyboard.press("Escape");
  const shape = page.locator(".object-hit").first();
  await shape.click();
  await shape.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  const b = P.getShapeBoundsResolved(
      source,
      P.getSlideShapes(P.getSlides(source)[0])[0],
    ),
    size = P.getSlideSize(source);
  const box = await editor.evaluate((el) => ({
    left: parseFloat(el.style.left),
    top: parseFloat(el.style.top),
    width: parseFloat(el.style.width),
    height: parseFloat(el.style.height),
    padding: el.style.padding,
    border: el.style.border,
    minHeight: el.style.minHeight,
  }));
  // CSSOM serializes percentages to six significant digits.
  expect(box.left).toBeCloseTo(
    (100 * (b.x + b.w / 4 + P.inches(0.1))) / size.width,
    4,
  );
  expect(box.top).toBeCloseTo(
    (100 * (b.y + b.h / 4 + P.inches(0.15))) / size.height,
    4,
  );
  expect(box.width).toBeCloseTo(
    (100 * (b.w / 2 - P.inches(0.3))) / size.width,
    4,
  );
  expect(box.height).toBeCloseTo(
    (100 * ((b.h * 3) / 4 - P.inches(0.2))) / size.height,
    4,
  );
  expect(box.padding).toBe("0px");
  expect(box.minHeight).toBe("");
  await editor.fill("Edited inside the custom text rectangle");
  await editor.press("Control+Enter");
  const edited = await download(page);
  expect(P.getShapeText(P.getSlideShapes(P.getSlides(edited.p)[0])[0])).toBe(
    "Edited inside the custom text rectangle",
  );
  expect(authored(edited.bytes, edited.p)).toEqual(authored(bytes, source));
  await load(page, edited.bytes);
  checkPositions(edited.p, await textPositions(page));
  // A text rectangle controls wrapping; the editor retains its standard UI
  // height floor so a short imported box still holds a usable caret/line.
  const tiny = await parseDeck(bytes);
  P.setShapeSize(
    P.getSlideShapes(P.getSlides(tiny)[0])[0],
    P.inches(0.4),
    P.inches(0.25),
  );
  await load(page, await P.savePresentation(tiny));
  await shape.click();
  await shape.focus();
  await page.keyboard.press("Enter");
  const tinyHeight = await editor.evaluate((el) => ({
    actual: el.getBoundingClientRect().height,
    minimum: Number.parseFloat(getComputedStyle(el).minHeight),
  }));
  expect(tinyHeight.minimum).toBe(40);
  expect(tinyHeight.actual).toBeGreaterThanOrEqual(tinyHeight.minimum);
  await editor.fill("Short custom rectangle edit");
  await editor.press("Control+Enter");
  const tinySaved = await download(page);
  expect(P.getShapeText(P.getSlideShapes(P.getSlides(tinySaved.p)[0])[0])).toBe(
    "Short custom rectangle edit",
  );
  expect(authored(tinySaved.bytes, tinySaved.p)).toEqual(
    authored(bytes, source),
  );
});

test("actual object clipboard forward and return retains custom text rectangles and wrapping", async ({
  page,
}) => {
  await start(page);
  const bytes = await geometryTextRectFixture(),
    source = await parseDeck(bytes);
  await load(page, bytes);
  const before = await textPositions(page),
    objects = page.locator(".object-hit");
  await objects.first().click();
  await objects.nth(1).click({ modifiers: ["Shift"] });
  await page.keyboard.press("Control+c");
  await page.getByRole("button", { name: "Back to presentations" }).click();
  await page
    .getByRole("button", { name: "New presentation", exact: true })
    .click();
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(2);
  const copied = await download(page),
    positions = await textPositions(page);
  checkPositions(copied.p, positions);
  expect(positions.map((lines) => lines.map((line) => line.text))).toEqual(
    before.slice(0, 2).map((lines) => lines.map((line) => line.text)),
  );
  expect(authored(copied.bytes, copied.p)).toEqual(
    authored(bytes, source).slice(0, 2),
  );
  await objects.first().click();
  await objects.nth(1).click({ modifiers: ["Shift"] });
  await page.keyboard.press("Control+c");
  await load(page, bytes);
  await page.keyboard.press("Control+v");
  await expect(objects).toHaveCount(5);
  const returned = await download(page);
  checkPositions(returned.p, await textPositions(page));
  expect(authored(returned.bytes, returned.p).slice(-2)).toEqual(
    authored(bytes, source).slice(0, 2),
  );
});
