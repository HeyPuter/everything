import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFBool } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { duplicateListPdf } from '../fixtures/duplicate-list.js';
import { rendered } from '../helpers/list-render.js';

for (const action of ['page', 'dialog', 'flatten'])
  for (const sorted of [false, true])
    for (const rotation of [0, 90])
      test(`only the chosen duplicate-label row is painted after ${action} (sorted=${sorted}, rotation=${rotation})`, async ({
        page,
      }) => {
        await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
        await page.goto('/#library');
        const { doc } = await duplicateListPdf({
          sorted,
          rotation,
          inherited: true,
          selected: action === 'flatten' ? ['south'] : [],
        });
        if (action === 'flatten')
          doc.getForm().acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
        const opening = page.waitForEvent('filechooser');
        await page.keyboard.press('ControlOrMeta+o');
        await (
          await opening
        ).setFiles({
          name: 'offices.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from(await doc.save()),
        });
        await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
        const control = page.getByLabel('Group.Office (on page)', { exact: true });
        if (action === 'page') await control.selectOption(['south']);
        else if (action === 'dialog') {
          await page.getByRole('button', { name: 'Fill forms', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Fill forms' });
          await dialog.getByLabel('Group.Office', { exact: true }).selectOption(['south']);
          await dialog.getByRole('button', { name: 'Save form', exact: true }).click();
          await expect(dialog).toHaveCount(0);
        } else {
          const bar = page.getByRole('menubar', { name: 'PDF menus' });
          if (await bar.isVisible())
            await bar.getByRole('menuitem', { name: 'File', exact: true }).click();
          else await page.getByRole('button', { name: 'Menu', exact: true }).click();
          await page
            .getByRole('menu')
            .getByRole('menuitem', { name: 'Flatten…', exact: true })
            .click();
          const dialog = page.getByRole('dialog', { name: 'Flatten', exact: true });
          await dialog.getByRole('button', { name: 'Flatten', exact: true }).click();
          await expect(dialog).toHaveCount(0);
          await expect(page.locator('.form-control')).toHaveCount(0);
        }
        const downloading = page.waitForEvent('download');
        await page.getByRole('button', { name: 'Download', exact: true }).click();
        const bytes = new Uint8Array(await readFile(await (await downloading).path()));
        expect((await rendered(bytes, rotation)).bands).toHaveLength(1);
        const saved = await PDFDocument.load(bytes);
        if (action === 'flatten') expect(saved.getForm().getFields()).toHaveLength(0);
        else expect(saved.getForm().getOptionList('Group.Office').getSelected()).toEqual(['south']);
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(control).toHaveValues(action === 'flatten' ? ['south'] : []);
        await page.getByRole('button', { name: 'Redo', exact: true }).click();
        if (action === 'flatten') await expect(page.locator('.form-control')).toHaveCount(0);
        else await expect(control).toHaveValues(['south']);
      });

test('a click on a list box row chooses the option drawn there', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const list = doc.getForm().createOptionList('Fruit');
  list.addOptions(['Apples', 'Bananas', 'Cherries', 'Dates', 'Elderberries']);
  list.addToPage(doc.addPage([400, 300]), { x: 50, y: 150, width: 150, height: 80 });
  const opening = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+o');
  await (
    await opening
  ).setFiles({
    name: 'fruit.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const control = page.getByRole('listbox', { name: 'Fruit (on page)', exact: true });
  // The five rows fill the box: the fourth is Dates.
  const box = await control.boundingBox();
  await page.mouse.click(box.x + 30, box.y + (box.height / 5) * 3.5);
  await expect(control).toHaveValue('Dates');
  await expect(control.locator('option')).toHaveText([
    'Apples',
    'Bananas',
    'Cherries',
    'Dates',
    'Elderberries',
  ]);
});
