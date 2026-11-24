import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

// A folder dragged onto the app arrives as a file with no type that cannot be read, and was
// refused as "Choose a PDF, or PNG and JPEG pictures", as if it were some other kind of file.
// It is now named for what it is, as a folder handed over by the Puter desktop already is.
async function drop(page, items) {
  await page.evaluate(async (items) => {
    const transfer = new DataTransfer();
    const entries = [];
    for (const { name, folder, base64 } of items) {
      transfer.items.add(
        folder
          ? new File([], name)
          : new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name, {
              type: 'application/pdf',
            }),
      );
      entries.push({ kind: 'file', webkitGetAsEntry: () => ({ name, isDirectory: !!folder }) });
    }
    // A synthetic transfer cannot hold a folder; its items report one as a real drop does.
    Object.defineProperty(transfer, 'items', { value: entries });
    const workspace = document.querySelector('.workspace');
    for (const type of ['dragenter', 'dragover', 'drop'])
      workspace.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
  }, items);
}

test.beforeEach(async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
});

test('a folder dropped on the app is named as a folder', async ({ page }) => {
  await drop(page, [{ name: 'Scans', folder: true }]);
  await expect(page.locator('#toast')).toHaveText(
    'Folders cannot be opened. Open a PDF from the folder.',
  );
  await expect(page.locator('body')).not.toHaveClass(/dropping/);
});

test('a PDF dropped with a folder opens, and the folder is left out', async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.addPage();
  const base64 = Buffer.from(await doc.save()).toString('base64');
  await drop(page, [
    { name: 'Scans', folder: true },
    { name: 'report.pdf', base64 },
  ]);
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.locator('#toast')).not.toHaveText(/One PDF opens at a time/);
});
