// The ribbon and the commands it carries, checked by what
// they do to the presentation the app downloads.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { P, parseDeck } from "../src/model.js";

const isMac = process.platform === "darwin";
// Each test drives several commands and downloads the file at the end.
test.setTimeout(90_000);
const mod = isMac ? "Meta" : "Control";

async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Home" })).toBeVisible();
}
const tab = (page, name) =>
  page.getByRole("tab", { name, exact: true }).click();
// A ribbon command. Where the ribbon is too narrow for its group, the group
// folds into a drop-down, which is opened first.
async function reveal(page, id) {
  const direct = page
    .locator(
      `.ribbon-panel:not([hidden]) [data-command="${id}"], .ribbon-fold-panel [data-command="${id}"]`,
    )
    .filter({ visible: true })
    .first();
  if (await direct.isVisible()) return direct;
  await page
    .locator(
      `.ribbon-panel:not([hidden]) .ribbon-group:has([data-command="${id}"]) > .ribbon-fold`,
    )
    .click();
  const folded = page.locator(`.ribbon-fold-panel [data-command="${id}"]`);
  await expect(folded.first()).toBeVisible();
  return folded.first();
}
const command = async (page, id) => (await reveal(page, id)).click();
// Points on the slide are given for a slide at least 480px wide and scaled
// down on a smaller one.
async function scale(page) {
  return Math.min(1, (await slideBox(page)).width / 480);
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
  const p = await parseDeck(bytes);
  const files = unzipSync(bytes);
  const slideXml = (i = 0) =>
    strFromU8(files[P.getSlidePartName(P.getSlides(p)[i]).slice(1)]);
  return { bytes, p, files, slideXml };
}
async function slideBox(page) {
  return page.locator("#slide-canvas").boundingBox();
}
// Draws a text box with the Insert tab's tool and types into it.
async function textBox(page, text, at = [200, 120]) {
  await tab(page, "Insert");
  await command(page, "insert-text-box");
  const box = await slideBox(page);
  const k = await scale(page);
  await page.mouse.click(box.x + at[0] * k, box.y + at[1] * k);
  await expect(page.locator(".inline-editor")).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
  await expect(page.locator(".inline-editor")).toHaveCount(0);
}
async function rectangle(page, from, to) {
  await tab(page, "Insert");
  await command(page, "insert-shapes");
  await page.getByRole("menuitem", { name: "Rectangle", exact: true }).click();
  const box = await slideBox(page);
  const k = await scale(page);
  await page.mouse.move(box.x + from[0] * k, box.y + from[1] * k);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0] * k, box.y + to[1] * k, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole("tab", { name: "Shape Format" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

test("tabs follow the arrow keys, collapse, and a contextual tab follows the selection", async ({
  page,
}) => {
  await start(page);
  const home = page.getByRole("tab", { name: "Home" });
  await home.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Insert" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Insert" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("End");
  await expect(
    page.getByRole("tab", { name: "View", exact: true }),
  ).toBeFocused();
  await expect(page.getByRole("tab", { name: "Shape Format" })).toBeHidden();
  await page.getByRole("button", { name: "Collapse the ribbon" }).click();
  await expect(page.locator(".ribbon-body")).toBeHidden();
  await page.getByRole("button", { name: "Expand the ribbon" }).click();
  await expect(page.locator(".ribbon-body")).toBeVisible();
  await rectangle(page, [100, 100], [300, 200]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tab", { name: "Shape Format" })).toBeHidden();
  await expect(page.getByRole("tab", { name: "Home" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("a dragged rectangle takes the dragged size and a clicked text box opens for typing", async ({
  page,
}) => {
  await start(page);
  await rectangle(page, [100, 40], [400, 190]);
  await textBox(page, "Typed after a click");
  const { p } = await download(page);
  const shapes = P.getSlideShapes(P.getSlides(p)[0]);
  const box = await slideBox(page);
  const k = await scale(page);
  const emuPerPx = P.getSlideSize(p).width / box.width;
  const rect = shapes.find(
    (s) => P.getShapeKind(s) === "shape" && !P.getShapeText(s),
  );
  const b = P.getShapeBounds(rect);
  expect(Math.abs(b.w - 300 * k * emuPerPx) / b.w).toBeLessThan(0.03);
  expect(Math.abs(b.h - 150 * k * emuPerPx) / b.h).toBeLessThan(0.03);
  expect(shapes.some((s) => P.getShapeText(s) === "Typed after a click")).toBe(
    true,
  );
});

test("font, size, styles, case and spacing apply to the selected text box", async ({
  page,
}) => {
  await start(page);
  await textBox(page, "make me loud");
  await page.locator(".object-hit").first().click();
  await tab(page, "Home");
  await reveal(page, "font-name");
  const font = page.getByRole("combobox", { name: "Font", exact: true });
  await font.fill("Georgia");
  await font.press("Enter");
  await reveal(page, "font-size");
  const size = page.getByRole("combobox", { name: "Font Size" });
  await size.fill("40");
  await size.press("Enter");
  await command(page, "bold");
  await expect(await reveal(page, "bold")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await command(page, "change-case");
  await page.getByRole("menuitem", { name: "UPPERCASE" }).click();
  await command(page, "char-spacing");
  await page
    .getByRole("menuitemcheckbox", { name: "Loose", exact: true })
    .click();
  await command(page, "superscript");
  const { p } = await download(page);
  const shape = P.getSlideShapes(P.getSlides(p)[0])[0];
  expect(P.getShapeText(shape)).toBe("MAKE ME LOUD");
  const fmt = P.getShapeRunFormat(shape, 0, 0);
  expect(fmt.font).toBe("Georgia");
  expect(fmt.size).toBe(40);
  expect(fmt.bold).toBe(true);
  expect(fmt.spc).toBe(300);
  expect(fmt.baseline).toBeCloseTo(0.3, 5);
});

test("the colour palettes write theme colours as lumMod/lumOff tints", async ({
  page,
}) => {
  await start(page);
  await rectangle(page, [100, 100], [300, 200]);
  await reveal(page, "format-shape-fill");
  await page.getByRole("button", { name: "Fill colors", exact: true }).click();
  await page.getByRole("menuitem", { name: "Accent 2, Lighter 40%" }).click();
  await reveal(page, "format-shape-outline");
  await page
    .getByRole("button", { name: "Outline colors", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Weight" }).click();
  await page.getByRole("menuitemcheckbox", { name: "3 pt" }).click();
  const { slideXml } = await download(page);
  expect(slideXml()).toMatch(
    /<a:solidFill><a:schemeClr val="accent2"><a:lumMod val="60000"\/><a:lumOff val="40000"\/><\/a:schemeClr><\/a:solidFill>/,
  );
  expect(slideXml()).toMatch(/<a:ln w="38100"/);
});

test("Shape Styles, Shape Effects and Format Painter restyle shapes", async ({
  page,
}) => {
  await start(page);
  await rectangle(page, [60, 60], [200, 160]);
  await page.getByRole("button", { name: "More Shape Styles" }).click();
  await page
    .getByRole("dialog", { name: "Shape Styles" })
    .getByRole("option", { name: "Colored Fill - Accent 3", exact: true })
    .click();
  await command(page, "format-shape-effects");
  await page.getByRole("menuitem", { name: "Shadow", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "Offset: Bottom", exact: true })
    .click();
  await rectangle(page, [300, 60], [440, 160]);
  const hits = page.locator(".object-hit");
  await hits.nth(0).click();
  await tab(page, "Home");
  await command(page, "format-painter");
  await hits.nth(1).click();
  await expect(await reveal(page, "format-painter")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const { p, slideXml } = await download(page);
  const xml = slideXml();
  expect(
    xml.match(/<a:schemeClr val="accent3"\/>/g)?.length,
  ).toBeGreaterThanOrEqual(2);
  expect(xml).toContain("<a:outerShdw");
  expect(P.getSlideShapes(P.getSlides(p)[0])).toHaveLength(2);
});

test("the Selection Pane lists and selects objects; sections reach the file", async ({
  page,
}) => {
  await start(page);
  await textBox(page, "First");
  await textBox(page, "Second", [200, 230]);
  await page.locator(".object-hit").first().click();
  await page.getByRole("tab", { name: "Shape Format" }).click();
  await command(page, "selection-pane");
  const pane = page.getByRole("complementary", { name: "Selection" });
  await expect(pane.getByRole("option")).toHaveCount(2);
  await pane.getByRole("option").first().getByRole("button").first().click();
  await expect(pane.getByRole("option").first()).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await tab(page, "Home");
  await command(page, "section");
  await page.getByRole("menuitem", { name: "Add Section" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Intro");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Rename" })
    .click();
  const { p } = await download(page);
  expect(P.getSlideSections(p).map((s) => s.name)).toEqual(["Intro"]);
});

test("View shows rulers, gridlines and guides, hides notes, and zooms", async ({
  page,
}) => {
  await start(page);
  await tab(page, "View");
  await reveal(page, "show-ruler");
  await page.getByRole("checkbox", { name: "Ruler" }).check();
  await reveal(page, "show-gridlines");
  await page.getByRole("checkbox", { name: "Gridlines" }).check();
  await reveal(page, "show-guides");
  await page.getByRole("checkbox", { name: "Guides" }).check();
  await expect(page.locator(".ruler")).toHaveCount(2);
  await expect(page.locator(".canvas-aids.grid")).toHaveCount(1);
  await expect(page.locator(".guide-line")).toHaveCount(2);
  await command(page, "notes");
  await expect(page.locator("#speaker-notes")).toBeHidden();
  await page.locator("#status-notes").click();
  await expect(page.locator("#speaker-notes")).toBeVisible();
  await command(page, "zoom");
  await page.getByRole("menuitemcheckbox", { name: "200%" }).click();
  await expect(page.getByRole("button", { name: "Zoom level" })).toHaveText(
    "200%",
  );
  await page
    .getByRole("button", { name: "Fit slide to current window" })
    .click();
  await reveal(page, "show-ruler");
  await page.getByRole("checkbox", { name: "Ruler" }).uncheck();
  await expect(page.locator(".ruler")).toHaveCount(0);
});

test("Alt Text, the accessibility checker, symbols and command search", async ({
  page,
}) => {
  await start(page);
  await textBox(page, "Price");
  await page.locator(".object-hit").first().click();
  await tab(page, "Insert");
  await command(page, "symbol");
  await page
    .getByRole("dialog", { name: "Symbol" })
    .getByRole("button", { name: "€" })
    .click();
  await tab(page, "Review");
  await command(page, "alt-text");
  await page
    .getByRole("dialog", { name: "Alt Text" })
    .getByRole("textbox")
    .fill("A price label");
  await page
    .getByRole("dialog", { name: "Alt Text" })
    .getByRole("button", { name: "Done" })
    .click();
  await command(page, "check-accessibility");
  const pane = page.getByRole("complementary", { name: "Accessibility" });
  await expect(pane).toContainText("Missing slide title");
  await pane.getByRole("button", { name: "Close pane" }).click();
  await page.locator(".object-hit").first().click();
  // Command search is in a wide window's title bar; a narrower one has the
  // ribbon's own Italic.
  const search = page.getByRole("searchbox", { name: "Search for commands" });
  if (await search.isVisible()) {
    await search.fill("italic");
    await page.getByRole("menuitem", { name: /^Italic/ }).click();
  } else {
    await tab(page, "Home");
    await command(page, "italic");
  }
  const { p } = await download(page);
  const shape = P.getSlideShapes(P.getSlides(p)[0])[0];
  expect(P.getShapeText(shape)).toBe("Price€");
  expect(P.getShapeDescription(shape)).toBe("A price label");
  expect(P.getShapeRunFormat(shape, 0, 0).italic).toBe(true);
});

test("keyboard: new slide, paragraph alignment and F5", async ({ page }) => {
  await start(page);
  await textBox(page, "Centered");
  await page.locator(".object-hit").first().click();
  await page.keyboard.press(`${mod}+KeyE`);
  if (isMac) await page.keyboard.press("Meta+Shift+KeyN");
  else await page.keyboard.press("Control+KeyM");
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 2");
  await page.keyboard.press("F5");
  await expect(
    page.getByRole("dialog", { name: "Presentation mode" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const { p } = await download(page);
  expect(P.getSlides(p)).toHaveLength(2);
  const shape = P.getSlideShapes(P.getSlides(p)[0])[0];
  expect(P.getParagraphAlignment(shape, 0)).toBe("ctr");
});
