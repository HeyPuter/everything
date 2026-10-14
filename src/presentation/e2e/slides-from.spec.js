// Slides from elsewhere and the menu bar's slide and find commands: Reuse
// Slides, Slides from Outline, Duplicate Slide, Delete Slide, Find Next and
// Previous, and the Ribbon switch.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { P, createDeck, parseDeck, text } from "../src/model.js";

async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/");
  await expect(page.locator(".slide-image")).toBeVisible();
}
const thumbs = (page) => page.locator("#slide-list .slide-thumb");
async function menubar(page, menu, ...path) {
  const bar = page.getByRole("menubar", { name: "Presentation menus" });
  if (await bar.isVisible())
    await bar.getByRole("menuitem", { name: menu, exact: true }).click();
  else {
    // Phones keep the menus in the File options menu.
    await page.getByRole("button", { name: "File options" }).click();
    await page.getByRole("menuitem", { name: menu, exact: true }).click();
  }
  for (const name of path)
    await page
      .getByRole("menuitem", { name, exact: true })
      .or(page.getByRole("menuitemcheckbox", { name, exact: true }))
      .last()
      .click();
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
  return parseDeck(await readFile(await (await event).path()));
}
const skipPhone = (info) =>
  test.skip(
    info.project.name === "mobile",
    "Keyboard shortcuts and the ribbon switch are for keyboards and wide screens",
  );

test("Reuse Slides inserts chosen slides with their own formatting", async ({
  page,
}) => {
  const source = createDeck("blank");
  text(P.getSlides(source)[0], "Borrowed one", 1, 1, 6, 1);
  const second = P.addBlankSlide(source);
  text(second, "Borrowed two", 1, 1, 6, 1);
  await start(page);
  const choose = page.waitForEvent("filechooser");
  await menubar(page, "Insert", "Slides from", "Reuse Slides…");
  await (
    await choose
  ).setFiles({
    name: "Other.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    buffer: Buffer.from(await P.savePresentation(source)),
  });
  const dialog = page.getByRole("dialog", { name: "Reuse Slides" });
  await expect(dialog.locator(".reuse-card")).toHaveCount(2);
  await dialog.getByRole("checkbox", { name: "Slide 2" }).check();
  await dialog
    .getByRole("checkbox", { name: "Keep source formatting" })
    .check();
  await dialog.getByRole("button", { name: "Insert", exact: true }).click();
  await expect(thumbs(page)).toHaveCount(2);
  const pres = await download(page);
  expect(P.getSlideText(P.getSlides(pres)[1])).toContain("Borrowed two");
});

test("Slides from Outline makes titled slides with bullets", async ({
  page,
}) => {
  await start(page);
  const choose = page.waitForEvent("filechooser");
  await menubar(page, "Insert", "Slides from", "Slides from Outline…");
  await (
    await choose
  ).setFiles({
    name: "Talk.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Welcome\n- Hello\n  - World\n# Thanks\n"),
  });
  await expect(thumbs(page)).toHaveCount(3);
  const pres = await download(page);
  const texts = P.getSlides(pres).map((s) => P.getSlideText(s));
  expect(texts[1]).toContain("Welcome");
  expect(texts[1]).toContain("World");
  expect(texts[2]).toContain("Thanks");
});

test("slide, find and ribbon commands from the menu bar and keyboard", async ({
  page,
}, info) => {
  skipPhone(info);
  await start(page);
  await expect(thumbs(page)).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Shift+D");
  await expect(thumbs(page)).toHaveCount(2);
  await menubar(page, "Insert", "Duplicate slide");
  await expect(thumbs(page)).toHaveCount(3);
  await menubar(page, "Edit", "Delete slide");
  await expect(thumbs(page)).toHaveCount(2);
  // The ribbon folds away and back.
  const ribbon = page.locator("section.ribbon");
  await page.keyboard.press("ControlOrMeta+Alt+R");
  await expect(ribbon).toHaveClass(/collapsed/);
  await menubar(page, "View", "Ribbon");
  await expect(ribbon).not.toHaveClass(/collapsed/);
  // Find Next with no search opens the find bar.
  await page.locator("#main").focus();
  await page.keyboard.press("ControlOrMeta+G");
  await expect(page.locator(".findbar")).toBeVisible();
});
