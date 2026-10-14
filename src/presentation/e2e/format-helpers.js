// Shared steps for the format feature specs: starting the editor, menus on
// the menu bar (or behind File options on a phone), ribbon commands (or
// inside their folded group on a narrow screen), and the downloaded file.
import { expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { P, parseDeck } from "../src/model.js";

export const mod = process.platform === "darwin" ? "Meta" : "Control";

export async function start(page) {
  await page.route("https://js.puter.com/v2/", (r) =>
    r.fulfill({
      contentType: "application/javascript",
      body: 'window.puter={env:"web",auth:{isSignedIn:async()=>false},ui:{onLaunchedWithItems:()=>{}}};',
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Home" })).toBeVisible();
}

/** Opens a menu bar menu and walks its items, by name. */
export async function menu(page, name, ...path) {
  const bar = page
    .getByRole("menuitem", { name, exact: true })
    .filter({ visible: true });
  // On a phone the menu bar folds into File options, whose long menu can
  // run past the screen; its items are chosen without scrolling to them.
  const phone = !(await bar.count());
  const choose = async (item) => {
    const node = page
      .getByRole("menuitem", { name: item, exact: true })
      .filter({ visible: true })
      .last();
    if (phone) await node.dispatchEvent("click");
    else await node.click();
  };
  if (!phone) await bar.first().click();
  else {
    await page.getByRole("button", { name: "File options" }).click();
    if (name !== "File") await choose(name);
  }
  for (const item of path) await choose(item);
}

/** A ribbon command by id, opening its folded group first when needed. */
export async function command(page, id) {
  const folded = page.locator(`.ribbon-fold-panel [data-command="${id}"]`);
  if (await folded.first().isVisible()) return folded.first();
  const node = page.locator(
    `.ribbon-panel:not([hidden]) [data-command="${id}"]`,
  );
  if (!(await node.first().isVisible())) {
    const group = page
      .locator(".ribbon-panel:not([hidden]) .ribbon-group")
      .filter({ has: page.locator(`[data-command="${id}"]`) });
    await group.locator(".ribbon-fold").click();
    return page.locator(`.ribbon-fold-panel [data-command="${id}"]`);
  }
  return node.first();
}

export async function tab(page, name) {
  await page.getByRole("tab", { name, exact: true }).click();
}

export async function addTextBox(page, text) {
  await menu(page, "Insert", "Text box");
  await expect(page.locator(".object-hit")).not.toHaveCount(0);
  if (text != null) {
    await page.getByRole("textbox", { name: "Object text" }).waitFor({
      state: "attached",
    });
  }
}

export async function addShape(page, name = "Rectangle") {
  await menu(page, "Insert", "Shape", name);
}

export async function download(page) {
  await menu(page, "File");
  const event = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download PowerPoint (.pptx)", exact: true })
    .filter({ visible: true })
    .dispatchEvent("click");
  const bytes = await readFile(await (await event).path());
  const p = await parseDeck(bytes);
  const files = unzipSync(bytes);
  const slideXml = (i = 0) =>
    strFromU8(files[P.getSlidePartName(P.getSlides(p)[i]).slice(1)]);
  return {
    bytes,
    p,
    files,
    slideXml,
    shapes: P.getSlideShapes(P.getSlides(p)[0]),
  };
}

/** Opens the Format pane for the selected object. */
export async function formatPane(page) {
  await menu(page, "Format", "Format Object…");
  const pane = page.getByRole("complementary", { name: "Format panel" });
  await expect(pane).toBeVisible();
  return pane;
}

/**
 * Opens a collapsible section of the Format pane, showing the tab that
 * holds it first: its top-level tab, then its icon tab.
 */
export async function section(pane, key) {
  for (const kind of ["fmt-top-tab", "fmt-sub-tab"]) {
    const tab = pane
      .locator(`.${kind}[data-sections~="${key}"]`)
      .filter({ visible: true })
      .first();
    if (
      (await tab.count()) &&
      (await tab.getAttribute("aria-selected")) !== "true"
    )
      await tab.click();
  }
  const node = pane.locator(`details[data-section="${key}"]`);
  if (!(await node.evaluate((d) => d.open)))
    await node.locator("summary").click();
  return node;
}

export { P };
