import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, createDeck, parseDeck, MIME } from "../src/model.js";

async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/#/home");
}
function fixture(w, h, rotation = 0, connector = false) {
  const p = createDeck("blank"),
    s = P.getSlides(p)[0];
  const x = 6 - w / 2,
    y = 3.5 - h / 2;
  const sh = connector
    ? P.addSlideLine(s, {
        from: { x: P.inches(x), y: P.inches(y) },
        to: { x: P.inches(x + w), y: P.inches(y + h) },
      })
    : P.addSlideShape(s, {
        preset: "rect",
        x: P.inches(x),
        y: P.inches(y),
        w: P.inches(w),
        h: P.inches(h),
      });
  P.setShapeRotation(sh, rotation);
  return p;
}
async function load(page, p, count = 1) {
  const back = page.getByRole("button", { name: "Back to presentations" });
  if (await back.isVisible()) await back.click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "Small objects.pptx",
    mimeType: MIME,
    buffer: Buffer.from(await P.savePresentation(p)),
  });
  // The editor, not the library it was opened from, before counting.
  await expect(page.locator("#slide-position")).toBeVisible();
  const object = page.locator(".object-hit");
  await expect(object).toHaveCount(count);
  await object.first().click();
  return object.first();
}
async function centerIsObject(object) {
  await object.scrollIntoViewIfNeeded();
  expect(
    await object.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return (
        document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === el
      );
    }),
  ).toBe(true);
}
async function handlesAreReachable(page) {
  const handles = page.locator(".resize-handle:visible");
  for (const handle of await handles.all())
    expect(
      await handle.evaluate((el) => {
        const b = el.getBoundingClientRect();
        return (
          document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) ===
          el
        );
      }),
    ).toBe(true);
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
const first = (p) => P.getSlideShapes(P.getSlides(p)[0])[0];
test("small, narrow and rotated objects keep their centers editable and every visible resize handle reachable", async ({
  page,
}) => {
  await start(page);
  for (const [w, h, rotation] of [
    [2.7, 1.4, 0],
    [3, 0.15, 0],
    [0.15, 3, 0],
    [0.08, 0.08, 0],
    [0.11, 0.16, 37],
  ]) {
    const source = fixture(w, h, rotation),
      object = await load(page, source);
    await centerIsObject(object);
    await handlesAreReachable(page);
    const b = await object.boundingBox();
    await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
    const editor = page.getByRole("textbox", {
      name: "Edit text",
      exact: true,
    });
    await expect(editor).toBeVisible();
    await editor.fill("Small object edit");
    await editor.press("Control+Enter");
    const saved = await download(page);
    expect(P.getShapeText(first(saved))).toBe("Small object edit");
    expect(P.getShapeBoundsResolved(saved, first(saved))).toEqual(
      P.getShapeBoundsResolved(source, first(source)),
    );
    expect(P.getShapeRotation(first(saved))).toBe(rotation);
  }
});
test("short connector handles follow their line and leave its center free through unchanged export", async ({
  page,
}) => {
  await start(page);
  for (const [w, h, rotation] of [
    [0.08, 0, 0],
    [0, 0.08, 0],
    [0.08, 0.13, 0],
    [0.12, -0.09, 41],
    [0, 0, 0],
  ]) {
    const source = fixture(w, h, rotation, true),
      object = await load(page, source);
    await centerIsObject(object);
    await handlesAreReachable(page);
    await expect(page.locator(".resize-handle:visible")).toHaveCount(2);
    const saved = await download(page);
    expect(P.getShapeBoundsResolved(saved, first(saved))).toEqual(
      P.getShapeBoundsResolved(source, first(source)),
    );
    expect(P.getShapeFlip(first(saved))).toEqual(P.getShapeFlip(first(source)));
    expect(P.getShapeRotation(first(saved))).toBe(rotation);
  }
});
test("a tiny object's corner follows the pointer while resizing and undo restores its editable center", async ({
  page,
}) => {
  await start(page);
  const source = fixture(0.08, 0.08),
    object = await load(page, source);
  const grip = page.locator('.resize-handle[data-handle="se"]');
  const b = await grip.boundingBox(),
    x = b.x + b.width / 2,
    y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(x + 28, y + 24, { steps: 4 });
  const moved = await grip.boundingBox();
  expect(Math.abs(moved.x + moved.width / 2 - x - 28)).toBeLessThan(2);
  expect(Math.abs(moved.y + moved.height / 2 - y - 24)).toBeLessThan(2);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await centerIsObject(object);
  await handlesAreReachable(page);
  const resized = await download(page);
  const before = P.getShapeBoundsResolved(source, first(source)),
    after = P.getShapeBoundsResolved(resized, first(resized));
  expect(after.x).toBe(before.x);
  expect(after.y).toBe(before.y);
  expect(after.w).toBeGreaterThan(before.w);
  expect(after.h).toBeGreaterThan(before.h);
  await page.keyboard.press("Control+z");
  await centerIsObject(object);
  const undone = await download(page);
  expect(P.getShapeBoundsResolved(undone, first(undone))).toEqual(before);
});
test("selection targets adapt to viewport and zoom changes without reselecting the object", async ({
  page,
}) => {
  await start(page);
  const object = await load(page, fixture(0.55, 0.55));
  for (const width of [510, 360, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await centerIsObject(object);
    await handlesAreReachable(page);
  }
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await centerIsObject(object);
    await handlesAreReachable(page);
  }
});

test("enlarged capture regions resize on empty canvas while visible grips and neighboring objects keep priority", async ({
  page,
}) => {
  await start(page);
  const source = fixture(3, 2),
    object = await load(page, source);
  const grip = page.locator('.resize-handle[data-handle="se"]');
  const b = await grip.boundingBox();
  const target = await page
    .locator('.resize-target[data-handle="se"]')
    .evaluate((el) => el.getBoundingClientRect().width);
  const gap = target > b.width ? (target + b.width) / 4 : b.width / 2 + 1;
  const x = b.x + b.width / 2 + gap,
    y = b.y + b.height / 2 + gap;
  if (target > b.width) {
    expect(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.className,
        { x, y },
      ),
    ).toBe("resize-target");
    await page.mouse.move(x, y);
    await page.keyboard.down("Alt");
    await page.mouse.down();
    await page.mouse.move(x + 23, y + 19, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    const resized = await download(page);
    expect(P.getShapeBoundsResolved(resized, first(resized)).w).toBeGreaterThan(
      P.getShapeBoundsResolved(source, first(source)).w,
    );
  }
  const scale =
    (await page.locator("#slide-canvas").evaluate((el) => el.clientWidth)) /
    P.getSlideSize(source).width;
  const bounds = P.getShapeBoundsResolved(source, first(source)),
    side = P.inches(0.08);
  P.addSlideShape(P.getSlides(source)[0], {
    preset: "rect",
    x: Math.round(bounds.x + bounds.w + gap / scale - side / 2),
    y: Math.round(bounds.y + bounds.h + gap / scale - side / 2),
    w: side,
    h: side,
  });
  await load(page, source, 2);
  const neighbor = page.locator(".object-hit").nth(1);
  await centerIsObject(neighbor);
  await handlesAreReachable(page);
  await neighbor.click();
  await expect(neighbor).toHaveAttribute("aria-pressed", "true");
  await expect(object).toHaveAttribute("aria-pressed", "false");
  await neighbor.dblclick();
  await expect(
    page.getByRole("textbox", { name: "Edit text", exact: true }),
  ).toBeVisible();
});

// The dashed outline around several objects took a turned one's upright
// box, so it cut across a tall turned bar instead of enclosing it.
test("the outline around several objects encloses a turned one as the slide shows it", async ({
  page,
}) => {
  await start(page);
  const source = fixture(1, 1);
  const bar = P.addSlideShape(P.getSlides(source)[0], {
    preset: "rect",
    x: P.inches(5),
    y: P.inches(3),
    w: P.inches(4),
    h: P.inches(0.5),
  });
  P.setShapeRotation(bar, 90);
  await load(page, source, 2);
  const turned = page.locator(".object-hit").nth(1);
  await turned.click({ modifiers: ["Shift"] });
  const outline = page.locator(".selection-box.multi");
  await expect(outline).toHaveCount(1);
  const box = await outline.boundingBox();
  const shown = await turned.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
  expect(box.y).toBeLessThanOrEqual(shown.y + 1);
  expect(box.y + box.height).toBeGreaterThanOrEqual(shown.y + shown.height - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(shown.x + shown.width + 1);
});

// A turned object stopped at the slide's edges where its upright box met
// them: a bar turned a quarter turn halted well short of the left edge and
// could be pushed off the top.
test("a turned object moves up to the slide's edges as the slide shows it", async ({
  page,
}) => {
  await start(page);
  const source = createDeck("blank");
  const bar = P.addSlideShape(P.getSlides(source)[0], {
    preset: "rect",
    x: P.inches(0.25),
    y: P.inches(3),
    w: P.inches(4),
    h: P.inches(0.5),
  });
  P.setShapeRotation(bar, 90);
  // Shown 0.5 inches wide from 2 inches in, and 4 inches tall from 1.25.
  await load(page, source);
  for (let i = 0; i < 25; i++) await page.keyboard.press("Shift+ArrowLeft");
  for (let i = 0; i < 15; i++) await page.keyboard.press("Shift+ArrowUp");
  const moved = await download(page);
  let saved = P.getShapeBoundsResolved(moved, first(moved));
  expect(saved.x).toBe(P.inches(-1.75));
  expect(saved.y).toBe(P.inches(1.75));
  // Dragged far past the top left corner, it stops there too.
  const object = await load(page, source);
  const canvas = await page.locator("#slide-canvas").boundingBox();
  const b = await object.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x - 40, canvas.y - 200, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => Math.round((await object.boundingBox()).x - canvas.x))
    .toBeLessThanOrEqual(1);
  const result = await download(page);
  saved = P.getShapeBoundsResolved(result, first(result));
  expect(Math.abs(saved.x - P.inches(-1.75))).toBeLessThan(P.inches(0.01));
  expect(Math.abs(saved.y - P.inches(1.75))).toBeLessThan(P.inches(0.01));
});
