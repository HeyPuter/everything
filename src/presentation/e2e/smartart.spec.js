// SmartArt: inserting a graphic, the Text Pane, SmartArt Design commands,
// and converting bulleted text to a graphic and back, saved as real diagram
// parts.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { P, createDeck, parseDeck } from "../src/model.js";

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

// A new graphic's items hold the sample text "[Text]", and typing in the
// Text Pane added to it ("[Text]Plan") instead of replacing it.
test("typing in a new graphic's Text Pane replaces the sample text", async ({
  page,
}) => {
  await start(page);
  await insertGraphic(page, "Process", "Chevron Flow");
  const inputs = page.locator(".smartart-outline-input");
  await expect(inputs.nth(0)).toBeFocused();
  await page.keyboard.type("Plan");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("Build");
  await inputs.nth(2).click();
  await page.keyboard.type("Ship");
  await page.waitForTimeout(600);
  const { model } = await download(page);
  expect(model.items.map((i) => i.text)).toEqual([
    "Plan",
    "Build",
    "Ship",
    "[Text]",
  ]);
});

test("a click on the sample text in the item being typed in chooses all of it", async ({
  page,
}) => {
  await start(page);
  await insertGraphic(page, "Process", "Chevron Flow");
  const first = page.locator(".smartart-outline-input").first();
  await expect(first).toBeFocused();
  await first.click();
  await page.keyboard.type("Plan");
  await expect(first).toHaveValue("Plan");
});

test("Backspace takes away an empty first item, and Delete joins the next item on", async ({
  page,
}) => {
  await start(page);
  await insertGraphic(page, "Process", "Chevron Flow");
  const inputs = page.locator(".smartart-outline-input");
  const count = await inputs.count();
  await expect(inputs.first()).toBeFocused();
  await page.keyboard.type("Plan");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("Build");
  await inputs.first().click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(inputs).toHaveCount(count - 1);
  await expect(inputs.first()).toHaveValue("Build");
  await expect(inputs.first()).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.press("Delete");
  await expect(inputs).toHaveCount(count - 2);
  await expect(inputs.first()).toHaveValue("Build[Text]");
  await page.waitForTimeout(600);
  const { model } = await download(page);
  expect(model.items[0].text).toBe("Build[Text]");
  expect(model.items).toHaveLength(count - 2);
});

test("Ctrl+Z and Ctrl+Y in the Text Pane undo and redo its edits, Enter and Tab included", async ({
  page,
}) => {
  await start(page);
  await insertGraphic(page, "Process", "Chevron Flow");
  const inputs = page.locator(".smartart-outline-input");
  const outline = () =>
    inputs.evaluateAll((list) =>
      list.map((i) => `${i.closest("li").dataset.level}:${i.value}`),
    );
  const before = await outline();
  await expect(inputs.first()).toBeFocused();
  await page.keyboard.type("Plan");
  // Each change lands as its own step once the last has settled.
  await page.waitForTimeout(1300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1300);
  await page.keyboard.type("Scope");
  await page.keyboard.press("Tab");
  await expect(inputs.nth(1)).toHaveValue("Scope");
  await expect.poll(outline).toContain("1:Scope");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(outline).not.toContain("1:Scope");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(outline).toEqual(["0:Plan", ...before.slice(1)]);
  await expect(page.locator(".smartart-pane input:focus")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+y");
  await expect.poll(outline).not.toEqual(["0:Plan", ...before.slice(1)]);
  await expect(page.locator(".smartart-pane input:focus")).toHaveCount(1);
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
test("a graphic turned into text and back keeps its place behind other objects", async ({
  page,
}) => {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  P.addSlideSmartArt(slide, {
    model: {
      layout: "arrow-steps",
      items: [
        { text: "Plan", level: 0 },
        { text: "Build", level: 0 },
      ],
      colors: "accent2",
      style: "subtle",
    },
    x: P.inches(1),
    y: P.inches(1),
    w: P.inches(6),
    h: P.inches(3),
  });
  P.addSlideShape(slide, {
    preset: "rect",
    x: P.inches(4),
    y: P.inches(2.5),
    w: P.inches(4),
    h: P.inches(3),
    name: "Cover",
  });
  await start(page);
  await page.goto("/#/home");
  const choose = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import PPTX", exact: true }).click();
  await (
    await choose
  ).setFiles({
    name: "Graphic.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(pres)),
  });
  const hit = page.locator(".object-hit").first();
  await expect(hit).toBeVisible();
  const box = await hit.boundingBox();
  await page.mouse.click(box.x + 10, box.y + 10);
  await ribbonCommand(page, "SmartArt Design", "smartart-convert");
  await page.getByRole("menuitem", { name: "Convert to Text" }).click();
  await page.waitForTimeout(300);
  let { shapes } = await download(page);
  expect(shapes.map((s) => P.getShapeName(s))).toEqual([
    expect.stringMatching(/^TextBox/),
    "Cover",
  ]);
  // The text box is selected; Convert to SmartArt turns it back.
  await ribbonCommand(page, "Home", "convert-smartart");
  await page.locator(".chart-menu-choice").first().click();
  await expect(page.locator(".smartart-pane")).toBeVisible();
  await page.waitForTimeout(300);
  ({ shapes } = await download(page));
  expect(shapes.map((s) => P.getShapeName(s))).toEqual([
    expect.stringMatching(/^SmartArt/),
    "Cover",
  ]);
});

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

// Closing the Text Pane from the keyboard dropped the focus to the page.
test("closing the Text Pane with Escape puts the keyboard back on the graphic", async ({
  page,
}) => {
  await start(page);
  await insertGraphic(page, "Process", "Chevron Flow");
  await expect(page.locator(".smartart-outline-input").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".smartart-pane")).toHaveCount(0);
  await expect(
    page.locator("#slide-canvas .object-hit.selected"),
  ).toBeFocused();
});

// Lines pasted into the Text Pane ran together in one item.
test("lines pasted into the Text Pane become items of their own", async ({
  page,
}) => {
  await start(page);
  await insertGraphic(page, "Process", "Chevron Flow");
  const inputs = page.locator(".smartart-outline-input");
  await expect(inputs.first()).toBeFocused();
  await inputs.first().evaluate((input) => {
    const data = new DataTransfer();
    data.setData("text/plain", "Plan\nBuild\n\tTest\nShip\n");
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(inputs.nth(3)).toBeFocused();
  await page.keyboard.type("ped");
  await page.waitForTimeout(600);
  const { model } = await download(page);
  expect(model.items.slice(0, 4)).toEqual([
    { text: "Plan", level: 0 },
    { text: "Build", level: 0 },
    { text: "Test", level: 1 },
    { text: "Shipped", level: 0 },
  ]);
});

// Scaling the slides to a new size shrank a graphic's frame but left its
// shapes drawn at the old size, running off the frame and the slide.
test("a graphic scaled with the slide size is drawn within its frame", async ({
  page,
}) => {
  await start(page);
  await insertGraphic(page, "Process", "Chevron Flow");
  await page.keyboard.press("Escape");
  await ribbonCommand(page, "Design", "slide-size");
  await page.getByRole("menuitemcheckbox", { name: "Standard (4:3)" }).click();
  const dialog = page.getByRole("dialog", { name: "Slide size" });
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(300);
  const { bytes, graphic } = await download(page);
  const frame = P.getShapeBounds(graphic);
  const files = unzipSync(bytes);
  const drawing = Object.keys(files).find((n) =>
    /^ppt\/diagrams\/drawing\d*\.xml$/.test(n),
  );
  const xml = new TextDecoder().decode(files[drawing]);
  const rights = [
    ...xml.matchAll(/<a:off x="(-?\d+)" y="-?\d+"\/><a:ext cx="(\d+)"/g),
  ].map((m) => Number(m[1]) + Number(m[2]));
  expect(rights.length).toBeGreaterThan(0);
  expect(Math.max(...rights)).toBeLessThanOrEqual(frame.w + 1);
});
