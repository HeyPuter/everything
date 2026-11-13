import { test, expect } from '@playwright/test';
import { PDFDocument, degrees } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

async function prepare(page) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  for (const [index, size] of [
    [400, 500],
    [600, 400],
    [300, 700],
  ].entries()) {
    const sheet = doc.addPage(size);
    if (index === 1) sheet.setRotation(degrees(90));
    sheet.drawText(`Page ${index + 1} words`, { x: 40, y: 300, size: 18 });
  }
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'navigation.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Page 1 words', exact: true }).click();
  await expect(page.locator('.text-draft-background')).toBeVisible();
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).fill('Revised first page');
}

async function holdWorkerMessage(page, action = 'GetTextContent') {
  await page.evaluate((action) => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message?.action === action) {
        Worker.prototype.postMessage = post;
        window.releaseNavigation = () => post.call(this, message, ...rest);
      } else post.call(this, message, ...rest);
    };
  }, action);
}

async function holdNavigation(page, action = 'GetTextContent') {
  await prepare(page);
  await holdWorkerMessage(page, action);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.releaseNavigation)).toBe(true);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'true');
}

async function goTo(page, number) {
  const input = page.getByLabel('Page number', { exact: true });
  await input.fill(String(number));
  await input.press('Enter');
}

for (const [action, destination] of [
  ['forward', 3],
  ['back', 1],
  ['next button', 3],
  ['previous button', 1],
  ['number', 3],
  ['current number', 1],
  ['thumbnail', 3],
]) {
  test(`a ${action} command during a navigation commit reaches the requested page`, async ({
    page,
    isMobile,
  }) => {
    test.skip(
      action === 'thumbnail' && isMobile,
      'The mobile pages overlay closes before editing.',
    );
    await holdNavigation(page);
    if (action === 'number' || action === 'current number') await goTo(page, destination);
    else if (action.endsWith('button'))
      await page
        .getByRole('button', {
          name: action === 'next button' ? 'Next page' : 'Previous page',
          exact: true,
        })
        .click();
    else if (action === 'thumbnail')
      await page.getByRole('button', { name: 'Go to page 3', exact: true }).click();
    else await page.keyboard.press(action === 'forward' ? 'Alt+ArrowRight' : 'Alt+ArrowLeft');
    await page.evaluate(() => window.releaseNavigation());
    await expect(page.locator('.page-caption')).toHaveText(`Page ${destination} of 3`);
    await expect(page.getByLabel('Page number', { exact: true })).toHaveValue(String(destination));
    await expect(
      page.getByRole('button', {
        name: `Edit text: ${destination === 1 ? 'Revised first page' : 'Page 3 words'}`,
        exact: true,
      }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await goTo(page, 1);
    await expect(
      page.getByRole('button', { name: 'Edit text: Page 1 words', exact: true }),
    ).toBeEnabled();
  });
}

test('relative navigation clamps each pending step at document boundaries', async ({ page }) => {
  await holdNavigation(page);
  await page.keyboard.press('Alt+ArrowRight');
  await page.keyboard.press('Alt+ArrowRight');
  await page.keyboard.press('Alt+ArrowLeft');
  await page.keyboard.press('Alt+ArrowLeft');
  await page.evaluate(() => window.releaseNavigation());
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await expect(
    page.getByRole('button', { name: 'Edit text: Revised first page', exact: true }),
  ).toBeEnabled();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const bytes = await readFile(await (await download).path());
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name: 'reopened.pdf', mimeType: 'application/pdf', buffer: bytes });
  await expect(
    page.getByRole('button', { name: 'Edit text: Revised first page', exact: true }),
  ).toBeEnabled();
  await goTo(page, 2);
  await expect(
    page.getByRole('button', { name: 'Edit text: Page 2 words', exact: true }),
  ).toBeEnabled();
});

test('a page number being typed survives completion of the preceding navigation', async ({
  page,
}) => {
  await holdNavigation(page);
  const input = page.getByLabel('Page number', { exact: true });
  await input.fill('3');
  await page.evaluate(() => window.releaseNavigation());
  await expect(
    page.getByRole('button', { name: 'Edit text: Page 2 words', exact: true }),
  ).toBeEnabled();
  await expect(input).toHaveValue('3');
  await input.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
});

test('navigation remains available while the PDF renderer is being replaced', async ({ page }) => {
  await holdNavigation(page, 'GetDocRequest');
  await page.keyboard.press('Alt+ArrowRight');
  await page.evaluate(() => window.releaseNavigation());
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
  await expect(
    page.getByRole('button', { name: 'Edit text: Page 3 words', exact: true }),
  ).toBeEnabled();
});

test('a rejected text edit restores the page number and permits corrected navigation', async ({
  page,
}) => {
  await prepare(page);
  const draft = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await draft.fill('🦄');
  await goTo(page, 3);
  await expect(page.locator('.text-edit-error')).toContainText('does not support');
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('1');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await draft.fill('Corrected first page');
  await goTo(page, 3);
  await expect(
    page.getByRole('button', { name: 'Edit text: Page 3 words', exact: true }),
  ).toBeEnabled();
  await goTo(page, 1);
  await expect(
    page.getByRole('button', { name: 'Edit text: Corrected first page', exact: true }),
  ).toBeEnabled();
});

for (const stepDuringReload of [false, true])
  test(`page deletion rebases ${stepDuringReload ? 'relative' : 'absolute'} navigation to the new page count`, async ({
    page,
  }) => {
    await prepare(page);
    await page.keyboard.press('Escape');
    await goTo(page, 3);
    await expect(
      page.getByRole('button', { name: 'Edit text: Page 3 words', exact: true }),
    ).toBeEnabled();
    await page.evaluate(async () => {
      const { PdfSession } = await import('/src/core/document.js');
      const change = PdfSession.prototype.change;
      PdfSession.prototype.change = async function (...args) {
        PdfSession.prototype.change = change;
        const result = await change.apply(this, args);
        await new Promise((resolve) => {
          window.releasePageDeletion = resolve;
        });
        return result;
      };
    });
    const bar = page.getByRole('menubar', { name: 'PDF menus' });
    if (await bar.isVisible())
      await bar.getByRole('menuitem', { name: 'Page', exact: true }).click();
    else {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('menu').getByRole('menuitem', { name: 'Page', exact: true }).click();
    }
    await page
      .getByRole('menu')
      .getByRole('menuitem', { name: 'Delete page', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete page', exact: true })
      .click();
    await expect.poll(() => page.evaluate(() => !!window.releasePageDeletion)).toBe(true);
    await goTo(page, 1);
    await goTo(page, 3);
    if (stepDuringReload) await holdWorkerMessage(page);
    await page.evaluate(() => window.releasePageDeletion());
    if (stepDuringReload) {
      await expect.poll(() => page.evaluate(() => !!window.releaseNavigation)).toBe(true);
      await expect(page.getByLabel('Page number', { exact: true })).toHaveAttribute('max', '2');
      await page.getByRole('button', { name: 'Previous page', exact: true }).click();
      await page.evaluate(() => window.releaseNavigation());
    }
    const destination = stepDuringReload ? 1 : 2;
    await expect(page.locator('.page-caption')).toHaveText(`Page ${destination} of 2`);
    await expect(page.getByLabel('Page number', { exact: true })).toHaveValue(String(destination));
    await expect(
      page.getByRole('button', { name: `Edit text: Page ${destination} words`, exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole('button', {
        name: stepDuringReload ? 'Previous page' : 'Next page',
        exact: true,
      }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.locator('.page-caption')).toHaveText(`Page ${destination} of 3`);
    await goTo(page, 3);
    await expect(
      page.getByRole('button', { name: 'Edit text: Page 3 words', exact: true }),
    ).toBeEnabled();
  });
