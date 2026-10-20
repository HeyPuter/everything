// SmartArt: inserting a graphic, the Text Pane, SmartArt Design commands,
// and converting bulleted text to a graphic and back, saved as real diagram
// parts.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { P, parseDeck } from "../src/model.js";

test.setTimeout(120_000);

async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/");
}
// A ribbon command, opening its group's drop-down where a narrow window has
// folded the group away.
async function ribbonCommand(page, tab, command) {
  await page.getByRole("tab", { name: tab, exact: true }).click();
  const panel = page.locator(".ribbon-panel:not([hidden])");
  const button = panel.locator(`[data-command="${command}"]`).first();
  if (!(await button.isVisible())) {
    await panel
      .locator(`.ribbon-group:has([data-command="${command}"]) .ribbon-fold`)
      .click();
    await page
      .locator(`.ribbon-fold-panel [data-command="${command}"]`)
      .first()
      .click();
    return;
  }
  await button.click();
}
async function download(page) {
  // An edit landing as the menu opens can redraw it away; open it again.
  const item = page.getByRole("menuitem", {
    name: "Download PowerPoint (.pptx)",
    exact: true,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    await page
      .getByRole("menuitem", { name: "File", exact: true })
      .or(page.getByRole("button", { name: "File options" }))
      .filter({ visible: true })
      .click();
    try {
      await item.waitFor({ state: "visible", timeout: 5000 });
      break;
    } catch {}
  }
  const event = page.waitForEvent("download");
  await item.click();
  const bytes = await readFile(await (await event).path());
  const pres = await parseDeck(bytes);
  const shapes = P.getSlideShapes(P.getSlides(pres)[0]);
  const graphic = shapes.find((s) => P.isDiagramShape(s));
  return {
    bytes,
    shapes,
    graphic,
    model: graphic && P.getShapeSmartArt(graphic),
  };
}
async function insertGraphic(page, category, name) {
  await ribbonCommand(page, "Insert", "smartart");
  const dialog = page.getByRole("dialog", {
    name: "Choose a SmartArt Graphic",
  });
  await dialog.getByRole("tab", { name: category, exact: true }).click();
  await dialog.getByRole("option", { name, exact: true }).click();
  await expect(dialog.locator(".smartart-layout-name")).toHaveText(name);
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(page.locator(".smartart-pane")).toBeVisible();
}

test("a graphic is inserted as diagram parts and its Text Pane edits the outline", async ({
  page,
}) => {
  await start(page);
  await insertGraphic(page, "Process", "Chevron Flow");
  const inputs = page.locator(".smartart-outline-input");
  await inputs.nth(0).fill("Plan");
  await inputs.nth(0).press("Enter");
  await page.keyboard.type("Scope");
  await page.keyboard.press("Tab");
  await inputs.nth(2).fill("Build");
  await inputs.nth(3).fill("Ship");
  await page.waitForTimeout(600);
  const { bytes, model } = await download(page);
  expect(model.layout).toBe("chevrons");
  expect(model.items.slice(0, 4)).toEqual([
    { text: "Plan", level: 0 },
    { text: "Scope", level: 1 },
    { text: "Build", level: 0 },
    { text: "Ship", level: 0 },
  ]);
  const names = Object.keys(unzipSync(bytes));
  for (const part of ["data", "layout", "quickStyle", "colors", "drawing"])
    expect(names.some((n) => n.startsWith(`ppt/diagrams/${part}`))).toBe(true);
});

test("SmartArt Design adds and moves shapes, and changes layout, colors and style", async ({
  page,
}) => {
  await start(page);
  await insertGraphic(page, "List", "Tile Grid");
  const before = (await download(page)).model.items.length;
  await page.getByRole("button", { name: "Close Text Pane" }).click();
  await ribbonCommand(page, "SmartArt Design", "smartart-add-shape");
  await page.waitForTimeout(300);
  let { model } = await download(page);
  expect(model.items.filter((i) => i.level === 0).length).toBeGreaterThan(0);
  expect(model.items.length).toBe(before + 1);

  await ribbonCommand(page, "SmartArt Design", "smartart-colors");
  await page
    .getByRole("menuitemradio", { name: /accent 2/i })
    .first()
    .click();
  await page.waitForTimeout(300);
  ({ model } = await download(page));
  expect(model.colors).toMatch(/^accent2/);

  await ribbonCommand(page, "SmartArt Design", "smartart-rtl");
  await page.waitForTimeout(300);
  ({ model } = await download(page));
  expect(model.rightToLeft).toBe(true);

  // Another layout, from the gallery's full list, keeps the text.
  await page.getByRole("tab", { name: "SmartArt Design", exact: true }).click();
  const group = page.locator(
    '.ribbon-panel:not([hidden]) [data-group="smartart-layouts"]',
  );
  const gallery = group.locator(".ribbon-gallery");
  if (await gallery.isVisible())
    await gallery.getByRole("button", { name: "More Layouts" }).click();
  else {
    await group.locator(".ribbon-fold").click();
    await page
      .locator(".ribbon-fold-panel")
      .getByRole("button", { name: "More Layouts" })
      .click();
  }
  await page
    .locator(".ribbon-gallery-panel")
    .getByRole("option", { name: "Venn", exact: true })
    .click();
  await page.waitForTimeout(300);
  ({ model } = await download(page));
  expect(model.layout).toBe("venn");
  expect(model.items.length).toBe(before + 1);
});

test("bulleted text converts to a graphic, and a graphic back to text", async ({
  page,
}) => {
  await start(page);
  await ribbonCommand(page, "Insert", "smartart");
  await page
    .getByRole("dialog", { name: "Choose a SmartArt Graphic" })
    .getByRole("button", { name: "Insert", exact: true })
    .click();
  await page.getByRole("button", { name: "Close Text Pane" }).click();
  await ribbonCommand(page, "SmartArt Design", "smartart-convert");
  await page.getByRole("menuitem", { name: "Convert to Text" }).click();
  await page.waitForTimeout(300);
  let result = await download(page);
  expect(result.graphic).toBeUndefined();
  const box = result.shapes.find((s) => P.getShapeText(s).includes("[Text]"));
  expect(box).toBeTruthy();

  // The text box is selected; Convert to SmartArt turns it back.
  await ribbonCommand(page, "Home", "convert-smartart");
  await page.locator(".chart-menu-choice").first().click();
  await expect(page.locator(".smartart-pane")).toBeVisible();
  await page.waitForTimeout(300);
  result = await download(page);
  expect(result.graphic).toBeTruthy();
  expect(result.model.items.length).toBeGreaterThan(1);
  expect(result.shapes).toHaveLength(1);
});

// Find & Replace looked only through text boxes and tables, so it reported no
// match for text that a SmartArt graphic showed on the slide.
test("Find and Replace reach a graphic's text, Replace All in one step", async ({
  page,
}) => {
  await start(page);
  await insertGraphic(page, "Process", "Chevron Flow");
  const inputs = page.locator(".smartart-outline-input");
  await inputs.nth(0).fill("Budget review");
  await inputs.nth(1).fill("Budget sign-off");
  await inputs.nth(2).fill("Launch");
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Close Text Pane" }).click();
  await page.keyboard.press("ControlOrMeta+f");
  const query = page.getByRole("searchbox", { name: "Find", exact: true });
  await query.fill("Budget");
  await expect(page.locator(".find-count")).toHaveText("1 of 2");
  await page
    .getByRole("textbox", { name: "Replace with", exact: true })
    .fill("Cost");
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(page.locator(".find-count")).toHaveText("1 of 1");
  await page.getByRole("button", { name: "Replace all", exact: true }).click();
  await expect(page.locator(".find-count")).toHaveText("No matches");
  let { model } = await download(page);
  expect(model.items.slice(0, 3).map((i) => i.text)).toEqual([
    "Cost review",
    "Cost sign-off",
    "Launch",
  ]);
  // Replace All is one step to undo.
  await page.locator("#slide-canvas").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+z");
  ({ model } = await download(page));
  expect(model.items[1].text).toBe("Budget sign-off");
});
