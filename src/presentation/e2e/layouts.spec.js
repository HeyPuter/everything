// Layouts, placeholders and the master views: a new presentation's Title
// Slide with prompts, the New Slide and Layout galleries, Reset, quick
// inserts in a content placeholder, and editing the slide, notes and
// handout masters. Each flow is checked in the file the app downloads.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { P, parseDeck } from "../src/model.js";

test.setTimeout(120_000);
// These flows start where a new presentation does by default: on a Title
// Slide (the shared config starts other specs on a blank slide).
test.use({ storageState: { cookies: [], origins: [] } });
const mod = process.platform === "darwin" ? "Meta" : "Control";

async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/");
  await expect(page.locator("#slide-canvas .slide-image")).toBeVisible();
}
const tab = (page, id) => page.locator(`[role=tab][data-tab="${id}"]`).click();
// A ribbon command, unfolding its group first on a narrow screen.
async function command(page, id, { arrow = false } = {}) {
  const selector = `[data-command="${id}"]`;
  const visible = page.locator(`${selector}:visible`);
  if (!(await visible.count())) {
    await page
      .locator(
        `.ribbon-panel:not([hidden]) .ribbon-group:has(${selector}) .ribbon-fold`,
      )
      .click();
  }
  const face = page.locator(`${selector}:visible`).first();
  if (!arrow) return face.click();
  return face.locator("xpath=following-sibling::button[1]").click();
}
async function download(page) {
  // The File menu: on the menu bar, or behind File options on a phone.
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
  const xml = (name) => strFromU8(files[name.replace(/^\//, "")]);
  return { p, files, xml };
}
const hits = (page) => page.locator("#slide-canvas .object-hit");

test("a new presentation opens on a Title Slide that waits for its title", async ({
  page,
}) => {
  await start(page);
  // Two empty placeholders, outlined on the canvas, with their prompts in
  // the canvas render but not in the thumbnail.
  await expect(hits(page)).toHaveCount(2);
  await expect(page.locator(".object-hit.placeholder-frame")).toHaveCount(2);
  const canvasSrc = await page
    .locator("#slide-canvas .slide-image")
    .getAttribute("src");
  expect(decodeURIComponent(canvasSrc)).toContain("Click to add title");
  const thumb = await page
    .locator("#slide-list .slide-thumb img")
    .first()
    .getAttribute("src");
  expect(decodeURIComponent(thumb)).not.toContain("Click to add");
  await hits(page).first().dblclick();
  await expect(page.locator(".inline-editor")).toBeFocused();
  await page.keyboard.type("Quarterly review");
  await page.keyboard.press("Escape");
  await expect(page.locator(".object-hit.placeholder-frame")).toHaveCount(1);
  const { p, xml } = await download(page);
  const slide = P.getSlides(p)[0];
  expect(P.getSlideLayoutType(P.getSlideLayout(slide))).toBe("title");
  expect(P.getSlideText(slide)).toBe("Quarterly review");
  const slideXml = xml(P.getSlidePartName(slide));
  expect(slideXml).not.toContain("Click to add");
  expect(slideXml).toContain('type="ctrTitle"');
});

test("New Slide and Layout galleries draw the master's layouts, and Reset restores", async ({
  page,
}) => {
  await start(page);
  await tab(page, "home");
  await command(page, "new-slide", { arrow: true });
  const gallery = page.locator(".layout-gallery");
  await expect(gallery.getByRole("menuitemradio")).toHaveCount(11);
  await expect(gallery.locator(".layout-thumb img").first()).toHaveAttribute(
    "src",
    /^data:image\/svg\+xml/,
  );
  await gallery.getByRole("menuitemradio", { name: "Two Content" }).click();
  await expect(page.locator("#slide-list .slide-item")).toHaveCount(2);
  await expect(hits(page)).toHaveCount(3);
  // The New Slide button follows the current layout.
  await command(page, "new-slide");
  await expect(page.locator("#slide-list .slide-item")).toHaveCount(3);
  await expect(hits(page)).toHaveCount(3);
  // Layout puts the slide on another layout, keeping what it holds.
  await hits(page).first().dblclick();
  await page.keyboard.type("Agenda");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await command(page, "layout");
  await expect(
    page.locator(".layout-gallery-item.selected .layout-gallery-label"),
  ).toHaveText("Two Content");
  await page.getByRole("menuitemradio", { name: "Title Only" }).click();
  await expect(hits(page)).toHaveCount(1);
  // Reset brings a moved title back to its layout's place.
  await hits(page).first().click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await command(page, "reset");
  const { p } = await download(page);
  const slides = P.getSlides(p);
  expect(slides.map((s) => P.getSlideLayoutType(P.getSlideLayout(s)))).toEqual([
    "title",
    "twoObj",
    "titleOnly",
  ]);
  const [title] = P.getSlideShapes(slides[2]);
  expect(P.getShapeText(title)).toBe("Agenda");
  expect(P.getShapeBounds(title)).toBeNull();
});

test("an empty content placeholder's table button puts a table in its place", async ({
  page,
}) => {
  await start(page);
  await tab(page, "home");
  await command(page, "new-slide");
  const inserts = page.locator(".placeholder-inserts");
  await expect(inserts).toHaveCount(1);
  await expect(
    inserts.getByRole("button", { name: "Insert Table" }),
  ).toBeVisible();
  await inserts.getByRole("button", { name: "Insert Table" }).click();
  await page
    .locator("dialog[open]")
    .getByRole("button", { name: "Insert" })
    .click();
  await expect(page.locator(".placeholder-inserts")).toHaveCount(0);
  const { p, xml } = await download(page);
  const slide = P.getSlides(p)[1];
  const table = P.getSlideShapes(slide).find((s) => P.isTableShape(s));
  expect(table).toBeTruthy();
  expect(P.getShapePlaceholderIdx(table)).toBe(1);
  expect(xml(P.getSlidePartName(slide))).toMatch(
    /<p:graphicFrame>[\s\S]*<p:ph idx="1"\/>/,
  );
});

test("Slide Master view edits the master, adds a layout and placeholders, and slides follow", async ({
  page,
}) => {
  await start(page);
  await tab(page, "view");
  await command(page, "slide-master");
  await expect(
    page.locator('[role=tab][data-tab="slide-master"]'),
  ).toHaveAttribute("aria-selected", "true");
  const pane = page.locator(".master-pane");
  await expect(pane.locator(".master-pane-item")).toHaveCount(12);
  // The Title Slide layout the slide uses is open first.
  await expect(pane.locator(".master-pane-item.active")).toHaveAttribute(
    "data-part",
    /slideLayout2\.xml$/,
  );
  await expect(page.locator(".object-hit.placeholder-frame")).toHaveCount(5);
  // Make the master's title bold.
  await pane.locator(".master-pane-item.master .master-pane-thumb").click();
  await expect(pane.locator(".master-pane-item.master")).toHaveClass(/active/);
  await hits(page).first().click();
  await page.keyboard.press(`${mod}+b`);
  // Insert a layout, rename it, and give it a picture placeholder.
  await tab(page, "slide-master");
  await command(page, "insert-layout");
  await expect(pane.locator(".master-pane-item")).toHaveCount(13);
  await command(page, "rename-layout");
  const name = page.locator("dialog[open] input");
  await name.fill("Photo Story");
  await page
    .locator("dialog[open]")
    .getByRole("button", { name: "Rename" })
    .click();
  await command(page, "insert-placeholder", { arrow: true });
  await page.getByRole("menuitem", { name: "Picture", exact: true }).click();
  await expect(page.locator(".object-hit.placeholder-frame")).toHaveCount(5);
  // Footers off for this layout.
  await command(page, "layout-footers");
  await expect(page.locator(".object-hit.placeholder-frame")).toHaveCount(2);
  // Undo works in master view.
  await page.keyboard.press(`${mod}+z`);
  await expect(page.locator(".object-hit.placeholder-frame")).toHaveCount(5);
  await tab(page, "slide-master");
  await command(page, "close-master-view");
  await expect(page.locator(".master-pane")).toHaveCount(0);
  await expect(page.locator("#slide-list .slide-item")).toHaveCount(1);
  // A new slide on the new layout.
  await tab(page, "home");
  await command(page, "new-slide", { arrow: true });
  await page.getByRole("menuitemradio", { name: "Photo Story" }).click();
  await expect(page.locator("#slide-list .slide-item")).toHaveCount(2);
  const { p } = await download(page);
  const master = P.getSlideMasters(p)[0];
  expect(master.layouts.at(-1).name).toBe("Photo Story");
  const [first, second] = P.getSlides(p);
  expect(P.getSlideLayoutName(P.getSlideLayout(second))).toBe("Photo Story");
  expect(
    P.getSlideShapes(second).map((s) => P.getShapePlaceholderType(s)),
  ).toEqual(["title", "pic"]);
  // The master title's bold reaches the slide's (empty) title.
  const title = P.getSlideShapes(first)[0];
  expect(P.getShapeRunFormatEffective(p, title, 0, 0).bold).toBe(true);
});

test("Notes and Handout Master views set placeholders and page orientation", async ({
  page,
}) => {
  await start(page);
  await page.keyboard.press(`${mod}+Alt+3`);
  await expect(
    page.locator('[role=tab][data-tab="notes-master"]'),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".object-hit.placeholder-frame")).toHaveCount(6);
  await command(page, "notes-header");
  await expect(page.locator(".object-hit.placeholder-frame")).toHaveCount(5);
  await command(page, "notes-orientation");
  await page.getByRole("menuitemcheckbox", { name: "Landscape" }).click();
  const canvas = await page.locator("#slide-canvas").boundingBox();
  expect(canvas.width).toBeGreaterThan(canvas.height);
  await tab(page, "view");
  await command(page, "handout-master");
  await expect(page.locator(".handout-slots span")).toHaveCount(6);
  await tab(page, "handout-master");
  await command(page, "handout-slides-per-page");
  await page.getByRole("menuitemcheckbox", { name: "4 Slides" }).click();
  await expect(page.locator(".handout-slots span")).toHaveCount(4);
  await command(page, "handout-close-master-view");
  await expect(page.locator(".handout-slots")).toHaveCount(0);
  const { p, xml } = await download(page);
  expect(xml("ppt/presentation.xml")).toMatch(
    /<p:notesSz cx="9144000" cy="6858000"\/>/,
  );
  const notes = P.getTemplateSlide(p, P.getNotesMasterPartName(p));
  expect(P.hasTemplatePlaceholder(notes, "header")).toBe(false);
  expect(P.hasTemplatePlaceholder(notes, "slideImage")).toBe(true);
  expect(P.getHandoutMasterPartName(p)).toBeTruthy();
});

test("the master pane works from the keyboard", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "arrow keys need a keyboard");
  await start(page);
  await page.keyboard.press(`${mod}+Alt+1`);
  const pane = page.locator(".master-pane");
  await pane.locator(".master-pane-item.active .master-pane-thumb").focus();
  await page.keyboard.press("ArrowDown");
  await expect(pane.locator(".master-pane-item.active")).toHaveAttribute(
    "data-part",
    /slideLayout3\.xml$/,
  );
  await expect(
    pane.locator(".master-pane-item.active .master-pane-thumb"),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(pane.locator(".master-pane-item.master")).toHaveClass(/active/);
  await page.keyboard.press("Shift+F10");
  await expect(
    page.getByRole("menuitem", { name: "Insert Layout" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${mod}+Alt+1`);
  await expect(pane).toHaveCount(0);
});

test("the start of a new presentation is a preference", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "phones hide the account button that opens the same dialog",
  );
  await start(page);
  await expect(hits(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Account and settings" }).click();
  await page.getByRole("menuitem", { name: "Appearance", exact: true }).click();
  await page
    .getByRole("combobox", { name: "New presentations start with" })
    .selectOption("blank");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator("#slide-canvas .slide-image")).toBeVisible();
  await expect(hits(page)).toHaveCount(0);
});
