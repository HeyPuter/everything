import { test, expect } from '@playwright/test';

// Puter's SDK rejects a refused file operation with a plain object, its reason nested inside.
const refusals = {
  Rename: 'A file with that name already exists.',
  Duplicate: 'Storage capacity limit reached.',
  Delete: 'Permission denied.',
};
for (const [action, reason] of Object.entries(refusals))
  test(`a library ${action} that Puter refuses says why`, async ({ page }) => {
    await page.route('https://js.puter.com/**', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `const refuse = async () => { throw { error: { code: 'refused', message: ${JSON.stringify(reason)} } }; };
        window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({ username: 'test-user' }) },
          fs: { readdir: async () => [{ name: 'report.pdf', path: 'PDF Editor/report.pdf', size: 10, modified: 1700000000 }],
            read: async () => new Blob(['%PDF-1.7']), write: refuse, rename: refuse, delete: refuse },
          ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`,
      }),
    );
    await page.goto('/#library');
    await page.getByRole('button', { name: 'Options for report.pdf', exact: true }).click();
    await page.getByRole('button', { name: action, exact: true }).click();
    if (action === 'Rename') {
      const dialog = page.getByRole('dialog', { name: 'Rename PDF', exact: true });
      await dialog.getByRole('textbox').fill('summary');
      await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    }
    if (action === 'Delete')
      await page
        .getByRole('dialog', { name: 'Delete PDF?', exact: true })
        .getByRole('button', { name: 'Delete PDF', exact: true })
        .click();
    // Duplicate reports in its still open dialog, the others on the page.
    const message =
      action === 'Duplicate'
        ? page.getByRole('dialog', { name: 'report.pdf' }).getByRole('alert')
        : page.locator('#toast');
    await expect(message).toHaveText(reason);
  });
