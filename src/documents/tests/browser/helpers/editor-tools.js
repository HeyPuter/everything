import { expect } from '@playwright/test';

/** Feature regressions exercise the optional Formatting Pane. Shell tests use the compact default. */
export async function showAllTools(page) {
  await page.locator('.canvas-workspace, #playground-error:not(:empty)').first().waitFor();
  await onTab(page, 'home');
  const more = page.getByRole('button', { name: 'Formatting Pane', exact: true });
  if (!await more.count()) return; // Unsupported browser capabilities can reject the initial sample.
  if (await more.getAttribute('aria-expanded') !== 'true') await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  const pageTools = page.locator('.canvas-inspector-details');
  if (await pageTools.count() && !await pageTools.evaluate(el => el.open)) await pageTools.locator('summary').click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  if (await input.count()) await input.focus();
}

/**
 * Bring the ribbon tab that holds a control to the front, as a user would before using it, and
 * return the page so a lookup can follow: `(await onTab(page, 'insert')).getByRole(…)`. A contextual
 * tab that is not showing (a table tab outside a table) is left alone.
 */
export async function onTab(page, id) {
  const tab = page.locator(`#ribbon-tab-${id}`);
  if (await tab.count() && await tab.isVisible() && await tab.getAttribute('aria-selected') !== 'true') await tab.click();
  return page;
}

/** Open a menu of the menu bar (or, in a narrow window, of the Menus button) and return it. */
export async function menuBarMenu(page, name) {
  const bar = page.getByRole('menubar', { name: 'Menu bar' }).getByRole('menuitem', { name, exact: true });
  if (await bar.isVisible()) { await bar.click(); return page.getByRole('menu', { name, exact: true }); }
  await page.getByRole('button', { name: 'Menus', exact: true }).click();
  await page.getByRole('menu', { name: 'Menus' }).getByRole('menuitem', { name, exact: true }).click();
  return page.getByRole('menu', { name, exact: true });
}

/** The File menu's command of this name. */
export async function fileCommand(page, name) {
  return (await menuBarMenu(page, 'File')).getByRole('menuitem', { name, exact: true });
}

export async function saveToPuter(page) {
  await (await fileCommand(page, 'Save')).click();
}

/** The evaluation playground has a direct download button; the app downloads from File. */
export async function downloadDocx(page) {
  const button = page.getByRole('button', { name: 'Download .docx', exact: true });
  if (await button.count()) return button.click();
  await (await fileCommand(page, 'Download a Copy')).click();
}

/** Table commands live on the contextual table tabs, which stay hidden outside a table; their
 * controls remain in the page and disabled until a table selection exists. */
export async function expectTableCommandUnavailable(page, name) {
  const control = page.locator('.ribbon-card').getByRole('button', { name, exact: true, includeHidden: true });
  await expect(control).toHaveCount(1);
  await expect(control).toBeHidden();
  await expect(control).toBeDisabled();
  await expect(page.getByRole('tab', { name: 'Table Layout' })).toBeHidden();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
}
