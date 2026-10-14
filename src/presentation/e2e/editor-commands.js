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
// Insert > Text box, pressed from within the page, for a step that has to
// happen in the same task as the ones around it: window.__addTextNow().
export async function installAddTextNow(page) {
  await page.evaluate(() => {
    window.__addTextNow = () => {
      const named = (selector, name) =>
        [...document.querySelectorAll(selector)].find(
          (node) => node.textContent.trim() === name,
        );
      named('[role="menubar"] [role="menuitem"]', "Insert").click();
      named('[role="menu"] [role="menuitem"]', "Text box").click();
    };
  });
}
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
// Format > Theme: the presentation theme dialog.
export async function themeDialog(page) {
  await menuCommand(page, "Format", "Theme");
}
