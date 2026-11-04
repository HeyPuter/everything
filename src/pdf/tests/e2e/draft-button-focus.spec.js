import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// A button pressed from the keyboard while text was being edited lost the focus to the page:
// finishing the draft turned the buttons off while it saved, or moved the focus there itself.
test.beforeEach(async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([400, 500]).drawText('Original words', { x: 40, y: 350, size: 18 });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'draft.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption').first()).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
});
async function editText(page, from, to) {
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: `Edit text: ${from}`, exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).fill(to);
}

test('Undo pressed while text is edited keeps the focus', async ({ page }) => {
  await editText(page, 'Original words', 'First change');
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).press('ControlOrMeta+Enter');
  await expect(page.getByRole('button', { name: 'Edit text: First change' })).toBeVisible();
  await editText(page, 'First change', 'Unwanted change');
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await undo.focus();
  await page.keyboard.press('Enter');
  // The draft is gone and the button can still undo the first change, so it keeps the focus.
  await expect(page.getByRole('textbox', { name: 'Edit text', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit text: First change' })).toBeVisible();
  await expect(undo).toBeEnabled();
  await expect(undo).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Edit text: Original words' })).toBeVisible();
});

test('a tool chosen from the keyboard while text is edited keeps the focus', async ({ page }) => {
  await editText(page, 'Original words', 'Changed words');
  const highlight = page.getByRole('button', { name: 'Highlight', exact: true });
  await highlight.focus();
  await page.keyboard.press('Enter');
  await expect(highlight).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(highlight).toBeFocused();
  // The draft was saved on the way.
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit text: Changed words' })).toBeVisible();
});
