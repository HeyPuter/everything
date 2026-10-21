// The Draw tab's ink tools: the pen collection, lasso, point eraser, Ink to
// Shape, Ink to Text and Math (with the AI answered by the test), Ink
// Replay, the ruler, drawing by touch, and ink kept from a slide show.
import { test, expect as baseExpect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { P, parseDeck } from "../src/model.js";
import { addText, openNewSlideMenu } from "./editor-commands.js";

test.setTimeout(120_000);
// Phones render each stroke at three times the pixels; give them time.
const expect = baseExpect.configure({ timeout: 15_000 });

const errors = new WeakMap();
test.beforeEach(({ page }) => {
  const failures = [];
  errors.set(page, failures);
  page.on("pageerror", (error) => failures.push(error.message));
});
test.afterEach(({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

// The AI's answer to every question is `reply`; the prompts asked are kept
// in window.__asked.
async function start(page, { reply = null } = {}) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: `window.__asked=[];window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}},ai:{chat:async(prompt,image,test,options)=>{window.__asked.push({prompt,image:String(image).slice(0,22),options});return {message:{content:${JSON.stringify(reply ?? "")}}};}}};`,
    }),
  );
  await page.goto("/");
  await page.getByRole("tab", { name: "Draw" }).click();
}
// Runs a ribbon command, from the drop-down of its group when the group is
// folded on a narrow screen.
async function command(page, id) {
  const button = page.locator(`[data-command="${id}"]`);
  if (!(await button.isVisible()))
    await page
      .locator(`[data-group]:has([data-command="${id}"]) .ribbon-fold`)
      .click();
  await button.click();
}
async function menuOf(page, id, label) {
  const button = page.getByRole("button", { name: label, exact: true });
  if (!(await button.isVisible()))
    await page
      .locator(`[data-group]:has([data-command="${id}"]) .ribbon-fold`)
      .click();
  await button.click();
}
// Points are on an 800 × 450 grid laid over the canvas.
async function stroke(page, points, target = "#slide-canvas") {
  const b = await page.locator(target).boundingBox();
  const at = ([x, y]) => [
    b.x + (x / 800) * b.width,
    b.y + (y / 450) * b.height,
  ];
  await page.mouse.move(...at(points[0]));
  await page.mouse.down();
  for (const p of points.slice(1)) await page.mouse.move(...at(p));
  await page.mouse.up();
}
const along = (from, to, n = 12) =>
  Array.from({ length: n + 1 }, (_, i) => [
    from[0] + ((to[0] - from[0]) * i) / n,
    from[1] + ((to[1] - from[1]) * i) / n,
  ]);
const loop = (vertices, n = 10) =>
  [...vertices, vertices[0]].flatMap((v, i, all) =>
    i ? along(all[i - 1], v, n).slice(1) : [v],
  );
const wave = (x, y, w = 200) =>
  Array.from({ length: 20 }, (_, i) => [
    x + (i * w) / 19,
    y + Math.sin(i / 2) * 15,
  ]);
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
  const p = await parseDeck(bytes);
  await page.keyboard.press("Escape");
  const files = unzipSync(bytes);
  return {
    p,
    shapes: P.getSlideShapes(P.getSlides(p)[0]),
    xml: strFromU8(files[P.getSlidePartName(P.getSlides(p)[0]).slice(1)]),
  };
}
const hits = (page) => page.locator(".object-hit");
// A menu item, whether or not it carries a check mark.
const item = (page, name) =>
  page
    .getByRole("menuitem", { name, exact: true })
    .or(page.getByRole("menuitemcheckbox", { name, exact: true }));

test("pens can be added, changed, reordered and removed, and stay on this device", async ({
  page,
}) => {
  await start(page);
  await menuOf(page, "draw-add-pen", "Add Pen");
  await page.getByRole("menuitem", { name: "Add Pencil" }).click();
  const added = page.locator('[data-command="draw-pen-5"]');
  await expect(added).toHaveAttribute("aria-pressed", "true");
  await expect(added).toHaveAttribute("data-pen-type", "pencil");
  // A second click on the chosen pen opens its options.
  await added.click();
  await item(page, "3.5 mm").click();
  await expect(added).toHaveAttribute("aria-label", "Pencil: Graphite, 3.5 mm");
  await added.click();
  await page.getByRole("menuitem", { name: "Move Left" }).click();
  const ids = () =>
    page
      .locator(".ink-pens [data-command]")
      .evaluateAll((nodes) => nodes.map((n) => n.dataset.command));
  await expect
    .poll(ids)
    .toEqual([
      "draw-pen1",
      "draw-pen2",
      "draw-pen3",
      "draw-pen-5",
      "draw-highlighter",
    ]);
  await page.reload();
  await page.getByRole("tab", { name: "Draw" }).click();
  await expect.poll(ids).toContain("draw-pen-5");
  await expect(page.locator('[data-command="draw-pen-5"]')).toHaveAttribute(
    "aria-label",
    "Pencil: Graphite, 3.5 mm",
  );
  await page.locator('[data-command="draw-pen1"]').click();
  await page.locator('[data-command="draw-pen1"]').click();
  await page.getByRole("menuitem", { name: "Remove Pen" }).click();
  await expect.poll(ids).not.toContain("draw-pen1");
});

test("the lasso selects what lies wholly inside it, and the point eraser cuts a stroke in two", async ({
  page,
}) => {
  await start(page);
  await page.locator('[data-command="draw-pen1"]').click();
  await stroke(page, wave(100, 120));
  await stroke(page, wave(450, 300));
  await expect(hits(page)).toHaveCount(2);
  await command(page, "draw-lasso");
  await stroke(
    page,
    loop([
      [60, 60],
      [360, 60],
      [360, 200],
      [60, 200],
    ]),
  );
  await expect(page.locator(".ink-layer")).toHaveCount(0);
  await expect(page.locator(".object-hit.selected")).toHaveCount(1);
  await expect(page.locator(".object-hit.selected")).toHaveAttribute(
    "aria-label",
    /^Ink /,
  );
  // The point eraser rubs out the middle of the second stroke.
  await menuOf(page, "draw-eraser", "Eraser options");
  await item(page, "Point Eraser").click();
  await expect(page.locator(".ink-layer")).toHaveAttribute(
    "data-tool",
    "eraser-point",
  );
  await stroke(page, along([550, 240], [550, 360], 6));
  await expect(hits(page)).toHaveCount(3);
  const { shapes, xml } = await download(page);
  expect(shapes).toHaveLength(3);
  expect(xml.match(/inkTiming/g)?.length).toBe(3);
});

test("Ink to Shape turns strokes into shapes, and a V at a line's end makes an arrow", async ({
  page,
}) => {
  await start(page);
  await command(page, "draw-ink-to-shape");
  await expect(
    page.locator('[data-command="draw-ink-to-shape"]'),
  ).toHaveAttribute("aria-pressed", "true");
  // Turning it on takes up a pen.
  await expect(page.locator(".ink-layer")).toHaveCount(1);
  await stroke(
    page,
    loop([
      [80, 60],
      [300, 60],
      [300, 200],
      [80, 200],
    ]),
  );
  await stroke(page, along([400, 300], [700, 300]));
  await stroke(
    page,
    along([660, 270], [700, 300], 4).concat(along([700, 300], [660, 330], 4)),
  );
  await expect(hits(page)).toHaveCount(2);
  const { shapes, xml } = await download(page);
  expect(shapes).toHaveLength(2);
  expect(xml).toContain('prst="rect"');
  expect(P.getShapeStrokeArrow(shapes[1], "tail")?.type).toBe("triangle");
  expect(P.getShapeName(shapes[1])).toMatch(/^Arrow /);
});

test("Convert Ink to Shapes recognises ink already drawn", async ({ page }) => {
  await start(page);
  await page.locator('[data-command="draw-pen2"]').click();
  // A triangle, then a line of handwriting that stays ink.
  await stroke(
    page,
    loop([
      [200, 60],
      [320, 260],
      [80, 260],
    ]),
  );
  await stroke(page, wave(450, 300, 120));
  await expect(hits(page)).toHaveCount(2);
  await menuOf(page, "draw-ink-to-shape", "Ink to Shape options");
  await page.getByRole("menuitem", { name: "Convert Ink to Shapes" }).click();
  await expect(page.locator("#toast")).toContainText("1 ink stroke converted");
  const { shapes, xml } = await download(page);
  expect(shapes).toHaveLength(2);
  expect(xml).toContain('prst="triangle"');
  expect(xml).toContain('<a:srgbClr val="E81224"/>');
});

test("Ink to Text and Ink to Math ask the AI to read the ink", async ({
  page,
}) => {
  await start(page, { reply: "Hello there" });
  await page.locator('[data-command="draw-pen1"]').click();
  await stroke(page, wave(100, 150));
  await stroke(page, wave(150, 190, 120));
  await command(page, "draw-ink-to-text");
  await expect(page.locator("#toast")).toContainText("Ink converted to text");
  await expect(hits(page)).toHaveCount(1);
  const asked = await page.evaluate(() => window.__asked);
  expect(asked[0].prompt).toMatch(/handwriting/);
  expect(asked[0].image).toBe("data:image/png;base64,");
  expect(asked[0].options.model).toBeTruthy();
  let { shapes } = await download(page);
  expect(P.getShapeText(shapes[0])).toBe("Hello there");
  // Math: the answer becomes an equation object, opened again for editing
  // by a double-click.
  await page.evaluate(() => {
    window.puter.ai.chat = async () => ({ message: { content: "$$x^2+1$$" } });
  });
  await page.locator('[data-command="draw-pen1"]').click();
  await stroke(page, wave(400, 330));
  await command(page, "draw-ink-to-math");
  await expect(page.locator("#toast")).toContainText("Ink converted to math");
  await expect(hits(page)).toHaveCount(2);
  ({ shapes } = await download(page));
  expect(shapes).toHaveLength(2);
  expect(P.getShapeKind(shapes[1])).toBe("picture");
  expect(P.getShapeObjectData(shapes[1])).toMatchObject({
    type: "equation",
    source: "x^2+1",
  });
  expect(P.getShapeDescription(shapes[1])).toBe("Equation: x^2+1");
  expect(P.getShapeName(shapes[1])).toMatch(/^Equation /);
  await page.locator(".object-hit").nth(1).dblclick();
  const edit = page.getByRole("dialog", { name: "Edit Equation" });
  await expect(edit).toBeVisible();
  await expect(edit.getByRole("textbox", { name: /Equation/ })).toHaveValue(
    "x^2+1",
  );
  await page.keyboard.press("Escape");
});

test("Ink to Text puts the words on the ink's slide when another is shown meanwhile", async ({
  page,
}) => {
  await start(page);
  // The AI answers when the test says.
  await page.evaluate(() => {
    window.puter.ai.chat = () =>
      new Promise((resolve) => {
        window.__read = () => resolve({ message: { content: "Hello" } });
      });
  });
  // Slide 2 holds a text box with the same id the ink on slide 1 will get.
  await openNewSlideMenu(page);
  await page.getByRole("menuitem").filter({ hasText: /Blank/ }).first().click();
  await expect(page.locator(".slide-thumb")).toHaveCount(2);
  await addText(page);
  await page.keyboard.press("Escape");
  await expect(hits(page)).toHaveCount(1);
  const other = await hits(page).first().getAttribute("data-shape-id");
  await page.locator(".slide-thumb").first().click();
  await page.getByRole("tab", { name: "Draw" }).click();
  await page.locator('[data-command="draw-pen1"]').click();
  await stroke(page, wave(100, 150));
  await expect(hits(page)).toHaveCount(1);
  expect(await hits(page).first().getAttribute("data-shape-id")).toBe(other);
  await command(page, "draw-ink-to-text");
  await expect(page.locator("#toast")).toContainText("Reading");
  await page.keyboard.press("Escape");
  await page.locator(".slide-thumb").nth(1).click();
  await page.evaluate(() => window.__read());
  await expect(page.locator("#toast")).toContainText("Ink converted to text");
  // Slide 2's own box is untouched; the words replace the ink on slide 1.
  await expect(hits(page)).toHaveCount(1);
  await expect(hits(page).first()).not.toHaveAttribute("aria-label", /^Hello/);
  await page.locator(".slide-thumb").first().click();
  await expect(hits(page)).toHaveCount(1);
  await expect(hits(page).first()).toHaveAttribute("aria-label", /^Hello/);
});

test("Ink Replay plays the strokes back over the slide and closes with Escape", async ({
  page,
}) => {
  await start(page);
  await page.locator('[data-command="draw-pen2"]').click();
  await stroke(page, wave(100, 150));
  await stroke(page, wave(300, 300));
  await expect(hits(page)).toHaveCount(2);
  await command(page, "draw-ink-replay");
  const replay = page.locator(".ink-replay");
  await expect(replay).toHaveAttribute("data-strokes", "2");
  await expect(
    replay.getByRole("button", { name: "Replay from the start" }),
  ).toBeVisible();
  const drawn = await replay
    .locator(".ink-replay-strokes path")
    .evaluateAll((paths) => paths.map((p) => p.getAttribute("d")?.length));
  expect(drawn.every((n) => n > 10)).toBe(true);
  // Scrubbing back to the start shows only where the first stroke began.
  await replay.getByRole("slider", { name: "Replay position" }).fill("0");
  await expect(replay).toHaveAttribute("data-time", "0");
  const atStart = await replay
    .locator(".ink-replay-strokes path")
    .evaluateAll((paths) => paths.map((p) => p.getAttribute("d") || ""));
  expect(atStart[0].length).toBeLessThan(drawn[0] / 3);
  expect(atStart[1]).toBe("");
  await page.keyboard.press("Escape");
  await expect(replay).toHaveCount(0);
  await expect(hits(page)).toHaveCount(2);
});

test("a stroke begun on the ruler's edge is drawn straight along it", async ({
  page,
}) => {
  await start(page);
  await command(page, "draw-ruler");
  const ruler = page.locator(".ink-ruler");
  await expect(ruler).toBeVisible();
  // Turned level from the keyboard.
  await ruler.focus();
  for (let i = 0; i < 15; i++) await page.keyboard.press("Alt+ArrowRight");
  await expect(ruler).toHaveAttribute("aria-label", /at 0 degrees/);
  await page.locator('[data-command="draw-pen1"]').click();
  const box = await ruler.boundingBox();
  const canvas = await page.locator("#slide-canvas").boundingBox();
  // Just above the ruler's top edge, wobbling.
  const y = ((box.y - canvas.y - 4) / canvas.height) * 450;
  const x0 = ((box.x - canvas.x + 30) / canvas.width) * 800;
  await stroke(
    page,
    Array.from({ length: 16 }, (_, i) => [x0 + i * 15, y - (i % 2) * 5]),
  );
  await expect(hits(page)).toHaveCount(1);
  const { shapes } = await download(page);
  const b = P.getShapeBounds(shapes[0]);
  expect(b.h).toBeLessThan(b.w / 50);
  // Drawing with touch can be turned off.
  await command(page, "draw-touch");
  await expect(page.locator('[data-command="draw-touch"]')).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.locator('[data-command="draw-pen1"]').click();
  await expect(page.locator(".ink-layer")).toHaveClass(/touch-pans/);
});

test("the ruler follows the first finger laid on it, not a second", async ({
  page,
}) => {
  await start(page);
  await command(page, "draw-ruler");
  const ruler = page.locator(".ink-ruler");
  await expect(ruler).toBeVisible();
  const box = await ruler.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  // Two fingers on the ruler, both moving 40px to the right.
  const fingers = (dx) => [
    { x: box.x + box.width * 0.4 + dx, y: box.y + box.height / 2, id: 1 },
    { x: box.x + box.width * 0.6 + dx, y: box.y + box.height / 2, id: 2 },
  ];
  await touch("touchStart", fingers(0).slice(0, 1));
  await touch("touchStart", fingers(0));
  for (let dx = 10; dx <= 40; dx += 10) await touch("touchMove", fingers(dx));
  await touch("touchEnd", []);
  const after = await ruler.boundingBox();
  expect(after.x - box.x).toBeCloseTo(40, -1);
  expect(after.y).toBeCloseTo(box.y, 0);
});

test("two fingers draw one stroke, and a palm under the pen draws nothing", async ({
  page,
}) => {
  await start(page);
  await page.locator('[data-command="draw-pen1"]').click();
  const b = await page.locator("#slide-canvas").boundingBox();
  const at = (x, y) => ({
    x: b.x + (x / 800) * b.width,
    y: b.y + (y / 450) * b.height,
  });
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  const pen = (type, x, y) =>
    cdp.send("Input.dispatchMouseEvent", {
      type,
      ...at(x, y),
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1,
      pointerType: "pen",
    });
  // Two fingers moving at once, one along the top and one along the bottom.
  const fingers = (i) => [
    { ...at(100 + i * 20, 100), id: 1 },
    { ...at(100 + i * 20, 350), id: 2 },
  ];
  await touch("touchStart", fingers(0).slice(0, 1));
  await touch("touchStart", fingers(0));
  for (let i = 1; i <= 10; i++) await touch("touchMove", fingers(i));
  await touch("touchEnd", fingers(10).slice(0, 1));
  await touch("touchEnd", []);
  await expect(hits(page)).toHaveCount(1);
  // The first finger's line, flat: no zigzag through the second's.
  const first = await hits(page).first().boundingBox();
  expect(first.height).toBeLessThan(b.height / 10);
  // A palm resting on the glass before the pen comes down, and moving with
  // it, leaves only the pen's line.
  const palm = (type, i = 0) =>
    touch(type, type === "touchEnd" ? [] : [{ ...at(500 + i, 380), id: 7 }]);
  await palm("touchStart");
  await palm("touchMove", 5);
  await pen("mousePressed", 100, 220);
  for (let i = 1; i <= 10; i++) {
    await pen("mouseMoved", 100 + i * 20, 220);
    await palm("touchMove", 5 + i);
  }
  await pen("mouseReleased", 300, 220);
  await palm("touchEnd");
  await expect(hits(page)).toHaveCount(2);
  const { shapes } = await download(page);
  for (const s of shapes) {
    const box = P.getShapeBounds(s);
    expect(box.h).toBeLessThan(box.w / 10);
  }
});

test("ink drawn in a slide show can be kept on the slide", async ({ page }) => {
  await start(page);
  await page.getByRole("button", { name: "Present", exact: true }).click();
  const frame = page.locator(".presenter-frame");
  await expect(frame).toBeVisible();
  await page
    .locator(".presenter")
    .getByRole("button", { name: "Pen", exact: true })
    .click();
  await expect(frame).toHaveClass(/ink-mode/);
  await stroke(page, wave(100, 150, 300), ".presenter-frame");
  await expect(page.locator(".presenter-ink path")).toHaveCount(1);
  // The stroke is not a click: the show is still on its slide.
  await expect(page.locator(".presenter-end")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(frame).not.toHaveClass(/ink-mode/);
  await page.keyboard.press("Escape");
  const keep = page.getByRole("dialog", { name: "Keep your ink?" });
  await expect(keep).toBeVisible();
  await keep.getByRole("button", { name: "Keep Ink" }).click();
  await expect(hits(page)).toHaveCount(1);
  const { shapes, xml } = await download(page);
  expect(shapes).toHaveLength(1);
  expect(P.getShapeName(shapes[0])).toMatch(/^Ink /);
  expect(xml).toContain("inkTiming");
});
