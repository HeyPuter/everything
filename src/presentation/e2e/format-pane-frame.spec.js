// The Format pane's frame: the heading that names what is formatted, the
// top-level and icon tabs (remembered, and moved through from the keyboard),
// the settings search, closing the pane while text is being edited, and the
// sheet a phone shows it as.
import { test, expect } from "@playwright/test";
import {
  P,
  addShape,
  addTextBox,
  command,
  download,
  formatPane,
  menu,
  start,
  tab,
} from "./format-helpers.js";

test.setTimeout(120_000);

const panel = (page) =>
  page.getByRole("complementary", { name: "Format panel" });

test("the heading names the object, and the tabs hold its settings", async ({
  page,
}) => {
  await start(page);
  await addShape(page, "Rectangle");
  const pane = await formatPane(page);
  await expect(pane.getByRole("heading", { level: 2 })).toHaveText(
    "Format Shape",
  );
  const tops = pane.getByRole("tablist", { name: "Format options" });
  await expect(tops.getByRole("tab")).toHaveText([
    "Shape Options",
    "Text Options",
  ]);
  const icons = pane.getByRole("tablist", { name: "Shape Options" });
  await expect(icons.getByRole("tab")).toHaveCount(3);
  await expect(icons.getByRole("tab", { name: "Fill & Line" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(pane.locator("details[data-section='fill']")).toBeVisible();
  await expect(pane.locator("details[data-section='line']")).toBeVisible();
  // Only the chosen tab's settings are on the page.
  await expect(pane.locator("details[data-section='shadow']")).toHaveCount(0);

  await icons.getByRole("tab", { name: "Size & Properties" }).click();
  for (const key of ["size", "position", "altText", "arrange"])
    await expect(pane.locator(`details[data-section='${key}']`)).toHaveCount(1);
  await expect(pane.getByRole("spinbutton", { name: "X (in)" })).toBeVisible();

  // Text Options carries the text itself, its font and its paragraphs.
  await tops.getByRole("tab", { name: "Text Options" }).click();
  const text = pane.getByRole("tablist", { name: "Text Options" });
  await expect(text.getByRole("tab")).toHaveCount(4);
  const content = pane.getByRole("textbox", { name: "Object text" });
  await content.fill("Typed in the pane");
  await content.press("Tab");
  await expect(pane.getByLabel("Font family")).toBeVisible();
  await expect(pane.getByLabel("Line spacing")).toBeVisible();
  const { shapes } = await download(page);
  expect(P.getShapeText(shapes[0])).toBe("Typed in the pane");

  // The tabs a kind of object last showed come back for the next one.
  await addShape(page, "Rectangle");
  // (A narrow screen closes the pane over the slide when a shape is added.)
  await formatPane(page);
  await expect(
    panel(page).getByRole("tab", { name: "Text Options", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("arrow keys move between the tabs and show them", async ({ page }) => {
  await start(page);
  await addShape(page, "Rectangle");
  const pane = await formatPane(page);
  const fill = pane.getByRole("tab", { name: "Fill & Line" });
  await fill.focus();
  await page.keyboard.press("ArrowRight");
  const effects = pane.getByRole("tab", { name: "Effects" });
  await expect(effects).toBeFocused();
  await expect(effects).toHaveAttribute("aria-selected", "true");
  await expect(pane.locator("details[data-section='shadow']")).toBeVisible();
  await page.keyboard.press("End");
  const size = pane.getByRole("tab", { name: "Size & Properties" });
  await expect(size).toBeFocused();
  await expect(pane.locator("details[data-section='size']")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(fill).toBeFocused();
  // Ctrl+PageDown steps on from anywhere in the pane, into Text Options.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Control+PageDown");
  await expect(
    pane.getByRole("tab", { name: "Text", exact: true }),
  ).toBeFocused();
  await expect(
    pane.getByRole("textbox", { name: "Object text" }),
  ).toBeVisible();
  // The tab rows are a single stop for Tab: only the chosen tab takes it.
  await expect(pane.locator(".fmt-sub-tab[tabindex='0']")).toHaveCount(1);
});

test("the search finds settings in every tab", async ({ page }) => {
  await start(page);
  await addShape(page, "Rectangle");
  const pane = await formatPane(page);
  const search = pane.getByRole("searchbox", { name: "Search format options" });
  await search.fill("glow");
  await expect(pane.getByRole("status")).toHaveText(/match/);
  // Shape glow under Effects and text glow under Text Effects.
  const glow = pane.locator("details[data-section='glow']");
  await expect(glow).toBeVisible();
  await expect(glow).toHaveAttribute("open", "");
  await expect(
    pane.locator("details[data-section='textEffects']"),
  ).toBeVisible();
  await expect(pane.locator("details[data-section='fill']")).toHaveCount(0);
  await glow.getByLabel("Glow presets").selectOption({ index: 2 });
  // The search holds through the edit's refresh.
  await expect(search).toHaveValue("glow");
  await expect(pane.locator("details[data-section='glow']")).toBeVisible();
  await search.fill("no such setting");
  await expect(pane.getByRole("status")).toHaveText("No settings match");
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(pane.locator("details[data-section='fill']")).toBeVisible();
  const { shapes, p } = await download(page);
  expect(P.getShapeEffectSpec(p, shapes[0]).glow).toBeTruthy();
});

test("closing the pane while editing text keeps the edit going", async ({
  page,
}) => {
  await start(page);
  await addTextBox(page);
  const pane = await formatPane(page);
  await page.locator(".object-hit").first().dblclick();
  const editor = page.getByRole("textbox", { name: "Edit text", exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.type("Hello");
  await pane.getByRole("button", { name: "Close format panel" }).click();
  await expect(pane).toBeHidden();
  await expect(editor).toBeFocused();
  await page.keyboard.type(" there");
  await expect(editor).toHaveText("Hello there");
  await editor.press("Control+Enter");
  const { shapes } = await download(page);
  expect(P.getShapeText(shapes[0])).toBe("Hello there");
});

test("the background and several objects use the same frame", async ({
  page,
}) => {
  await start(page);
  const pane = await formatPane(page);
  await expect(pane.getByRole("heading", { level: 2 })).toHaveText(
    "Format Background",
  );
  // One set of sections: no tab rows to choose from.
  await expect(pane.getByRole("tab")).toHaveCount(0);
  await expect(
    pane.locator("details[data-section='background']"),
  ).toBeVisible();
  await expect(pane.locator("#format-background")).toBeVisible();
  await expect(
    pane.getByRole("combobox", { name: "Transition" }),
  ).toBeVisible();

  await addShape(page, "Rectangle");
  await addShape(page, "Rectangle");
  await menu(page, "Edit", "Select all");
  await expect(pane.getByRole("heading", { level: 2 })).toHaveText("Format");
  await expect(
    pane.locator("details[data-section='multiAlign']"),
  ).toBeVisible();
});

test("a phone shows the pane as a sheet over the lower screen", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile", "The sheet is the phone's layout");
  await start(page);
  await addShape(page, "Rectangle");
  const pane = await formatPane(page);
  const box = await pane.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBe(0);
  expect(Math.round(box.width)).toBe(viewport.width);
  expect(box.y).toBeGreaterThan(viewport.height * 0.3);
  // Its heading drags it taller.
  const heading = pane.locator(".panel-heading");
  const h = await heading.boundingBox();
  await page.mouse.move(h.x + 60, h.y + 8);
  await page.mouse.down();
  await page.mouse.move(h.x + 60, h.y - 100, { steps: 4 });
  await page.mouse.up();
  const taller = await pane.boundingBox();
  expect(taller.height).toBeGreaterThan(box.height + 60);
  await pane.getByRole("button", { name: "Close format panel" }).click();
  await expect(pane).toBeHidden();
});

test("an effect's Options item opens its section in the Effects tab", async ({
  page,
}) => {
  await start(page);
  await addShape(page, "Rectangle");
  const pane = await formatPane(page);
  await pane.getByRole("tab", { name: "Size & Properties" }).click();
  await tab(page, "Shape Format");
  await (await command(page, "format-shape-effects")).click();
  await page.getByRole("menuitem", { name: "Glow", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Glow Options…", exact: true })
    .click();
  await expect(pane.getByRole("tab", { name: "Effects" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const glow = pane.locator("details[data-section='glow']");
  await expect(glow).toHaveAttribute("open", "");
  await expect(glow.getByLabel("Glow presets")).toBeFocused();
});
