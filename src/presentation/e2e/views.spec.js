// The presentation views: Outline View, Slide Sorter with sections, Notes
// Page, Reading View, and the grid, guides and Zoom dialog, checked through
// the file the app downloads.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { P, parseDeck } from "../src/model.js";

test.setTimeout(90_000);
const mod = process.platform === "darwin" ? "Meta" : "Control";

async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/");
  await expect(page.locator("#slide-canvas img")).toBeVisible();
}
const phone = (page) => page.viewportSize().width < 700;
// A menu bar menu, or on a phone the same menu inside File options.
async function barMenu(page, name) {
  const item = page.getByRole("menuitem", { name, exact: true });
  if (!(await item.isVisible()))
    await page.getByRole("button", { name: "File options" }).click();
  await item.click();
}
// The views are switched from the View menu, which lists them all.
async function view(page, id) {
  const label = {
    normal: "Normal",
    sorter: "Slide Sorter",
    notesPage: "Notes Page",
    outline: "Outline View",
    reading: "Reading View",
  }[id];
  await barMenu(page, "View");
  await page
    .getByRole("menuitemcheckbox", { name: new RegExp(`^${label}`) })
    .click();
  if (id !== "reading")
    await expect(page.locator(".editor")).toHaveAttribute("data-view", id);
}
async function download(page) {
  const event = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "File", exact: true })
    .or(page.getByRole("button", { name: "File options" }))
    .filter({ visible: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .click();
  const bytes = await readFile(await (await event).path());
  return { p: await parseDeck(bytes), files: unzipSync(bytes) };
}
async function addSlides(page, n) {
  for (let i = 0; i < n; i++)
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+KeyN" : "Control+KeyM",
    );
}

test("Outline View writes titles and paragraphs, levels and new slides", async ({
  page,
}) => {
  await start(page);
  await view(page, "outline");
  const title = page.getByRole("textbox", { name: "Slide 1 title" });
  await title.click();
  await page.keyboard.type("Plan");
  // Enter starts a slide; Tab makes it a paragraph of the slide above.
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "Slide 2 title" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.type("First point");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Detail");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type("Next");
  await expect(page.locator(".outline-slide")).toHaveCount(2);
  // The thumbnails and the slide follow the outline.
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelectorAll(".slide-item").length),
    )
    .toBe(2);
  // Undo takes the typing back from the outline itself.
  await page.keyboard.press(`${mod}+z`);
  await expect(page.getByRole("textbox", { name: "Slide 2 title" })).toHaveText(
    "",
  );
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect(page.getByRole("textbox", { name: "Slide 2 title" })).toHaveText(
    "Next",
  );
  // A slide folds to its title.
  await page.getByRole("button", { name: "Slide 1", exact: true }).dblclick();
  await expect(page.locator(".outline-slide").first()).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.locator(".outline-body")).toHaveCount(0);
  const { p } = await download(page);
  const slides = P.getSlides(p);
  expect(slides).toHaveLength(2);
  expect(P.getSlideTitle(slides[0])).toBe("Plan");
  const body = P.getSlideOutlineShapes(slides[0]).body;
  expect(P.getShapeText(body)).toBe("First point\nDetail");
  expect(P.getParagraphLevel(body, 1)).toBe(1);
  expect(P.getSlideTitle(slides[1])).toBe("Next");
  // Back in Normal view the thumbnails return.
  await view(page, "normal");
  await expect(page.locator("#slide-list")).toBeVisible();
});

test("Outline View unfolds a slide before Delete or a paste changes its body", async ({
  page,
}) => {
  await start(page);
  await view(page, "outline");
  const title = page.getByRole("textbox", { name: "Slide 1 title" });
  await title.click();
  await page.keyboard.type("Plan");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("One");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Two");
  const rows = page.locator(".outline-text");
  await expect(rows).toHaveText(["Plan", "One", "Two"]);
  const fold = () =>
    page.getByRole("button", { name: "Slide 1", exact: true }).dblclick();
  await fold();
  await expect(rows).toHaveText(["Plan"]);
  // Delete at the end of a folded title joins the first paragraph to it,
  // in view.
  await title.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Delete");
  await expect(rows).toHaveText(["PlanOne", "Two"]);
  // Lines pasted into a folded title show too, with the caret after them.
  await fold();
  await expect(rows).toHaveText(["PlanOne"]);
  await title.click();
  await page.keyboard.press("End");
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "X\nY");
    document.activeElement.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(rows).toHaveText(["PlanOneX", "Y", "Two"]);
  await expect(rows.nth(1)).toBeFocused();
});

test("Slide Sorter reorders slides across sections and opens a slide", async ({
  page,
}) => {
  test.skip(
    phone(page),
    "Dragging thumbnails needs a pointer; phones reorder from the slide menu.",
  );
  await start(page);
  await addSlides(page, 3);
  await expect(page.locator(".slide-item")).toHaveCount(4);
  await view(page, "sorter");
  const cards = page.locator(".sorter-card");
  await expect(cards).toHaveCount(4);
  const parts = await cards.evaluateAll((list) =>
    list.map((c) => c.dataset.part),
  );
  // A section from the third slide on.
  await cards.nth(2).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add Section" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Later");
  await page.getByRole("dialog").getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".sorter-section")).toHaveCount(2);
  await expect(page.locator(".sorter-toggle").nth(1)).toContainText("Later");
  // Drag the fourth slide in front of the first, out of its section.
  const from = await cards.nth(3).boundingBox();
  const to = await cards.nth(0).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 10, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => cards.evaluateAll((list) => list.map((c) => c.dataset.part)))
    .toEqual([parts[3], parts[0], parts[1], parts[2]]);
  // Shift+click selects a range; Alt+Arrow moves it.
  await cards.nth(1).click();
  await cards.nth(2).click({ modifiers: ["Shift"] });
  await expect(page.locator(".sorter-card.selected")).toHaveCount(2);
  // The section folds under its header.
  await page.locator(".sorter-toggle").nth(1).click();
  await expect(page.locator(".sorter-toggle").nth(1)).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(cards).toHaveCount(3);
  await page.locator(".sorter-toggle").nth(1).click();
  // Keyboard: arrows move, Enter opens the slide in Normal view.
  await cards.nth(0).click();
  await page.keyboard.press("ArrowRight");
  await expect(cards.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".editor")).toHaveAttribute("data-view", "normal");
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 4");
  const { p } = await download(page);
  expect(P.getSlides(p).map(P.getSlidePartName)).toEqual([
    parts[3],
    parts[0],
    parts[1],
    parts[2],
  ]);
  expect(
    P.getSlideSections(p).map((s) => [
      s.name,
      s.slides.map(P.getSlidePartName),
    ]),
  ).toEqual([
    ["Default Section", [parts[3], parts[0], parts[1]]],
    ["Later", [parts[2]]],
  ]);
});

test("sections follow slides moved, deleted and added outside a drag", async ({
  page,
}) => {
  await start(page);
  await addSlides(page, 3);
  await expect(page.locator(".slide-item")).toHaveCount(4);
  await view(page, "sorter");
  const cards = page.locator(".sorter-card");
  const parts = await cards.evaluateAll((list) =>
    list.map((c) => c.dataset.part),
  );
  await cards.nth(2).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add Section" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Later");
  await page.getByRole("dialog").getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".sorter-section")).toHaveCount(2);
  // The second slide moves past the third, into "Later".
  await cards.nth(1).click();
  await page.keyboard.press("Alt+ArrowRight");
  await expect
    .poll(() => cards.evaluateAll((list) => list.map((c) => c.dataset.part)))
    .toEqual([parts[0], parts[2], parts[1], parts[3]]);
  // The last slide goes; a new slide after the first stays in its section,
  // although it may take the deleted slide's id.
  await cards.nth(3).click();
  await page.keyboard.press("Delete");
  await expect(cards).toHaveCount(3);
  await cards.nth(0).click({ button: "right" });
  await page.getByRole("menuitem", { name: "New Slide" }).click();
  await expect(cards).toHaveCount(4);
  const { p, files } = await download(page);
  const added = P.getSlidePartName(P.getSlides(p)[1]);
  expect(
    P.getSlideSections(p).map((s) => [
      s.name,
      s.slides.map(P.getSlidePartName),
    ]),
  ).toEqual([
    ["Default Section", [parts[0], added]],
    ["Later", [parts[2], parts[1]]],
  ]);
  // Every section entry names a slide still in the deck.
  const xml = strFromU8(files["ppt/presentation.xml"]);
  const ids = (s) => [...s.matchAll(/sldId id="(\d+)"/g)].map((m) => m[1]);
  const deck = ids(xml.match(/<p:sldIdLst>.*?<\/p:sldIdLst>/s)[0]);
  expect(ids(xml.match(/<p14:sectionLst.*?<\/p14:sectionLst>/s)[0])).toEqual(
    deck,
  );
});

test("Notes Page edits the notes on a page of the notes size", async ({
  page,
}) => {
  await start(page);
  await view(page, "notesPage");
  const pageBox = await page.locator(".notes-page").first().boundingBox();
  // A portrait page, 7.5 by 10 inches.
  expect(pageBox.height / pageBox.width).toBeCloseTo(10 / 7.5, 1);
  const notes = page.getByRole("textbox", { name: "Notes for slide 1" });
  await notes.click();
  await page.keyboard.type("Remember the demo");
  await view(page, "normal");
  await expect(page.locator("#speaker-notes")).toHaveValue("Remember the demo");
  // Its zoom is its own.
  await view(page, "notesPage");
  const level = page.getByRole("button", { name: "Zoom level" });
  await level.click();
  await page.getByRole("menuitemcheckbox", { name: "100%" }).click();
  await expect(level).toHaveText("100%");
  const wide = await page.locator(".notes-page").first().boundingBox();
  expect(Math.round(wide.width)).toBe(720);
  const { p } = await download(page);
  expect(P.getSlideNotes(P.getSlides(p)[0])).toBe("Remember the demo");
});

test("Reading View plays in the window and returns with Escape", async ({
  page,
}) => {
  await start(page);
  await addSlides(page, 2);
  await page.locator(".slide-item .slide-thumb").first().click();
  await view(page, "reading");
  const reading = page.getByRole("dialog", { name: "Reading View" });
  await expect(reading).toBeVisible();
  await expect(reading.locator(".reading-counter")).toHaveText("Slide 1 of 3");
  await reading.getByRole("button", { name: "Next slide" }).click();
  await expect(reading.locator(".reading-counter")).toHaveText("Slide 2 of 3");
  await reading.getByRole("button", { name: "Reading View menu" }).click();
  await page.getByRole("menuitem", { name: "Go to Slide" }).click();
  await page.getByRole("menuitemcheckbox", { name: /^3\./ }).click();
  await expect(reading.locator(".reading-counter")).toHaveText("Slide 3 of 3");
  await page.keyboard.press("Escape");
  await expect(reading).toHaveCount(0);
  // The bar's view buttons leave for another view on the slide reached.
  await view(page, "reading");
  await page
    .getByRole("dialog", { name: "Reading View" })
    .getByRole("button", { name: "Next slide" })
    .click();
  await page
    .getByRole("dialog", { name: "Reading View" })
    .getByRole("button", { name: phone(page) ? "Normal" : "Slide Sorter" })
    .click();
  await expect(page.locator(".editor")).toHaveAttribute(
    "data-view",
    phone(page) ? "normal" : "sorter",
  );
  await expect(page.locator("#slide-position")).toHaveText("Slide 2 of 3");
});

test("grid and guides: dialog, snapping, dragging guides, Zoom dialog", async ({
  page,
}) => {
  test.skip(
    phone(page),
    "Guides are dragged with a pointer over the slide; the phone layout has no ribbon View tab.",
  );
  await start(page);
  await barMenu(page, "View");
  await page.getByRole("menuitem", { name: "Grid and Guides" }).click();
  await page.getByRole("menuitem", { name: "Grid Options…" }).click();
  const dialog = page.getByRole("dialog", { name: "Grid and Guides" });
  await dialog.getByLabel("Snap objects to the grid").check();
  await dialog
    .getByLabel("Spacing", { exact: true })
    .selectOption({ label: "1/4 in" });
  await dialog.getByLabel("Show the grid on the slide").check();
  await dialog.getByLabel("Show drawing guides").check();
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(page.locator(".canvas-aids.grid")).toHaveCount(1);
  const guides = page.locator(".guide-line");
  await expect(guides).toHaveCount(2);
  // Drag the vertical guide a quarter of the way in; Ctrl-drag a copy.
  const canvas = await page.locator("#slide-canvas").boundingBox();
  const vertical = page.locator(".guide-line.vertical").first();
  const vb = await vertical.boundingBox();
  await page.mouse.move(vb.x + vb.width / 2, canvas.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width / 4, canvas.y + 40, {
    steps: 6,
  });
  await expect(page.locator(".guide-tip")).toBeVisible();
  await page.mouse.up();
  // Snapped to the quarter-inch grid: 3.25 of the slide's 13.33 inches.
  await expect
    .poll(async () => {
      const b = await page
        .locator(".guide-line.vertical")
        .first()
        .boundingBox();
      return Math.round(((b.x - canvas.x) / canvas.width) * 100);
    })
    .toBe(24);
  const moved = await page
    .locator(".guide-line.vertical")
    .first()
    .boundingBox();
  await page.keyboard.down("Control");
  await page.mouse.move(moved.x + moved.width / 2, canvas.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvas.x + (canvas.width * 3) / 4, canvas.y + 60, {
    steps: 6,
  });
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect(page.locator(".guide-line.vertical")).toHaveCount(2);
  // A guide is moved and removed from the keyboard too.
  const horizontal = page.locator(".guide-line.horizontal");
  await horizontal.focus();
  await page.keyboard.press("Delete");
  await expect(page.locator(".guide-line.horizontal")).toHaveCount(0);
  // The Zoom dialog sets the slide's zoom.
  await page.getByRole("button", { name: "Zoom level" }).click();
  await page.getByRole("menuitem", { name: "Zoom…" }).click();
  const zoom = page.getByRole("dialog", { name: "Zoom" });
  await zoom.getByLabel("Percent").fill("150");
  await zoom.getByRole("button", { name: "OK" }).click();
  await expect(page.getByRole("button", { name: "Zoom level" })).toHaveText(
    "150%",
  );
  const { p, files } = await download(page);
  const props = P.getViewProperties(p);
  expect(props.snapToGrid).toBe(true);
  expect(props.gridSpacing).toEqual({ cx: 228600, cy: 228600 });
  expect(props.guides.map((g) => g.orient)).toEqual(["vert", "vert"]);
  expect(props.guides[0].pos).toBe(3.25 * 914400);
  expect(strFromU8(files["ppt/viewProps.xml"])).toContain("<p:guideLst>");
});

test("the status bar switches views and the view menu lists them", async ({
  page,
}) => {
  test.skip(phone(page), "The status bar's view buttons are hidden on phones.");
  await start(page);
  await page.getByRole("button", { name: "Slide Sorter", exact: true }).click();
  await expect(page.locator(".editor")).toHaveAttribute("data-view", "sorter");
  await expect(
    page.locator('.status-views [data-view="sorter"]'),
  ).toHaveAttribute("aria-pressed", "true");
  // The sorter zooms on its own.
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Zoom level" })).toHaveText(
    "125%",
  );
  const menu = page.getByRole("menuitem", { name: "View", exact: true });
  if (await menu.isVisible()) {
    await menu.click();
    await page.getByRole("menuitemcheckbox", { name: /^Notes Page/ }).click();
    await expect(page.locator(".editor")).toHaveAttribute(
      "data-view",
      "notesPage",
    );
  }
  await page.getByRole("button", { name: "Normal", exact: true }).click();
  await expect(page.locator(".editor")).toHaveAttribute("data-view", "normal");
  // The views have their shortcuts too.
  await page.keyboard.press(`${mod}+Digit2`);
  await expect(page.locator(".editor")).toHaveAttribute("data-view", "sorter");
});
