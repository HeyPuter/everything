// Editor commands for specs, reached the way a person reaches them on every
// screen size: the menu bar (or the File options menu on a phone, where the
// menu bar gives way) and the ribbon (from a folded group's drop-down where
// the ribbon is narrow).
import { expect } from "@playwright/test";

// A command from the menu bar, or from the File options menu on a phone,
// where the menu bar gives way.
export async function menuCommand(page, menu, item) {
  const bar = page
    .getByRole("menubar")
    .getByRole("menuitem", { name: menu, exact: true });
  if (await bar.isVisible()) await bar.click();
  else {
    await page.getByRole("button", { name: "File options" }).click();
    await page.getByRole("menuitem", { name: menu, exact: true }).click();
  }
  await page
    .getByRole("menuitem", { name: item, exact: true })
    .or(page.getByRole("menuitemcheckbox", { name: item, exact: true }))
    .click();
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
