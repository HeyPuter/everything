// Editor commands for specs, reached the way a person reaches them on every
// screen size: the menu bar (or the File options menu on a phone, where the
// menu bar gives way) and the ribbon (from a folded group's drop-down where
// the ribbon is narrow).
import { expect } from "@playwright/test";

// Opens a menu from the menu bar, or from the File options menu on a phone,
// where the menu bar gives way, then the submenus along the path.
export async function openMenuPath(page, menu, ...path) {
  const bar = page
    .getByRole("menubar")
    .getByRole("menuitem", { name: menu, exact: true });
  const options = page.getByRole("button", { name: "File options" });
  // Whichever the layout shows, once the editor is up.
  const opener = bar.or(options).filter({ visible: true }).first();
  await opener.click();
  if ((await opener.getAttribute("role")) !== "menuitem")
    await page.getByRole("menuitem", { name: menu, exact: true }).click();
  for (const label of path)
    await page.getByRole("menuitem", { name: label, exact: true }).click();
}
// A command from a menu, by the menu's name and the command's.
export async function menuCommand(page, menu, ...path) {
  const item = path.pop();
  await openMenuPath(page, menu, ...path);
  await page
    .getByRole("menuitem", { name: item, exact: true })
    .or(page.getByRole("menuitemcheckbox", { name: item, exact: true }))
    .click();
}
// Insert > Shape, left open on its shapes.
export const openShapeMenu = (page) => openMenuPath(page, "Insert", "Shape");
// Insert > New slide, left open on its layouts.
export const openNewSlideMenu = (page) =>
  openMenuPath(page, "Insert", "New slide");
// Insert > Image: the file chooser for a picture.
export const insertImage = (page) => menuCommand(page, "Insert", "Image");
// A menu command pressed from within the page, for a step that has to
// happen in the same task as the ones around it:
// window.__menuNow("Insert", "Shape", "Rectangle"), and
// window.__addTextNow() for Insert > Text box. The menu bar is pressed even
// where a phone hides it.
export async function installMenuNow(page) {
  await page.evaluate(() => {
    const named = (nodes, name) =>
      [...nodes].find((node) => node.textContent.trim() === name);
    window.__menuNow = (menu, ...path) => {
      named(
        document.querySelectorAll('[role="menubar"] [role="menuitem"]'),
        menu,
      ).click();
      for (const label of path) {
        const open = [...document.querySelectorAll('[role="menu"]')].at(-1);
        named(open.querySelectorAll('[role^="menuitem"]'), label).click();
      }
    };
    window.__addTextNow = () => window.__menuNow("Insert", "Text box");
  });
}
export const installAddTextNow = installMenuNow;
// A ribbon command by its id, from the group a narrow ribbon folds it into
// if need be.
export async function ribbonButton(page, tab, id) {
  await page.getByRole("tab", { name: tab, exact: true }).click();
  const direct = page
    .locator(`.ribbon-panel:not([hidden]) [data-command="${id}"]`)
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
// Insert > Text box: a text box at the slide's default place.
export async function addText(page) {
  await menuCommand(page, "Insert", "Text box");
}
// Opens the format panel unless it is open.
export async function inspector(page) {
  if (
    !(await page
      .getByRole("complementary", { name: "Format panel" })
      .isVisible())
  )
    await menuCommand(page, "View", "Format panel");
}
// Shows a tab of the Format panel by name: a top-level tab such as "Text
// Options", or an icon tab such as "Size & Properties" (opening the panel
// first when it is closed). Several names show nested tabs in turn; a name
// the panel does not show (a row with a single tab) is passed over.
export async function paneTab(page, ...names) {
  await inspector(page);
  const panel = page.getByRole("complementary", { name: "Format panel" });
  // A row with a single tab is not shown, and its tab needs no choosing.
  for (const name of names) {
    const tab = panel.getByRole("tab", { name, exact: true });
    if (!(await tab.count())) continue;
    if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  }
}
// Shows and opens the Format panel's section `key` (its data-section), with
// the tabs that hold it.
export async function paneSection(page, key) {
  await inspector(page);
  const panel = page.getByRole("complementary", { name: "Format panel" });
  for (const kind of ["fmt-top-tab", "fmt-sub-tab"]) {
    const tab = panel
      .locator(`.${kind}[data-sections~="${key}"]`)
      .filter({ visible: true })
      .first();
    if (
      (await tab.count()) &&
      (await tab.getAttribute("aria-selected")) !== "true"
    )
      await tab.click();
  }
  const node = panel.locator(`details[data-section="${key}"]`).first();
  if (!(await node.evaluate((d) => d.open)))
    await node.locator("summary").click();
  return node;
}
// Format > Theme: the presentation theme dialog.
export async function themeDialog(page) {
  await menuCommand(page, "Format", "Theme");
}
// A ribbon control's state, read where the ribbon keeps it even while its
// group is folded away.
export const ribbonControl = (page, id) =>
  page
    .locator(
      `.ribbon-panel [data-command="${id}"], .ribbon-fold-panel [data-command="${id}"]`,
    )
    .first();
// Types a font name into the Home tab's Font box.
export async function setRibbonFont(page, name, label = "Font") {
  const box = await ribbonButton(
    page,
    "Home",
    label === "Font" ? "font-name" : "font-size",
  );
  await box.fill(String(name));
  await box.press("Enter");
}
