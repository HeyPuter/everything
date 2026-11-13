import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { partialFlattenPdf } from '../fixtures/partial-flatten.js';

async function download(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return new Uint8Array(await readFile(await (await pending).path()));
}

for (const kind of ['text', 'dropdown', 'list', 'widget-layout', 'rectangle', 'widgets'])
  test(`partial flatten keeps unsupported fields and saves other content (${kind})`, async ({
    page,
  }) => {
    await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
    await page.goto('/#library');
    const bytes = await partialFlattenPdf(kind);
    const opening = page.waitForEvent('filechooser');
    await page.keyboard.press('ControlOrMeta+o');
    await (
      await opening
    ).setFiles({
      name: 'partial-flatten.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(bytes),
    });
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    const bar = page.getByRole('menubar', { name: 'PDF menus' });
    if (await bar.isVisible())
      await bar.getByRole('menuitem', { name: 'File', exact: true }).click();
    else await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Flatten…', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Flatten', exact: true })
      .getByRole('button', { name: 'Flatten', exact: true })
      .click();
    await expect(page.locator('#toast')).toHaveText(
      'Flattened 1 field and 1 comment. Kept 1 field unflattened to preserve its content.',
    );
    const saved = await PDFDocument.load(await download(page));
    const fields = saved.getForm().getFields();
    expect(fields.map((field) => field.getName())).toEqual(['Keep value']);
    expect(
      kind === 'dropdown' || kind === 'list' ? fields[0].getSelected() : fields[0].getText(),
    ).toEqual(
      kind === 'dropdown' || kind === 'list'
        ? ['🦄']
        : kind === 'widgets'
          ? 'Old'
          : ['widget-layout', 'rectangle'].includes(kind)
            ? 'Updated retained'
            : '🦄',
    );
    expect(saved.getPage(0).node.Annots().size()).toBe(
      ['widget-layout', 'rectangle'].includes(kind) ? 2 : 1,
    );
    expect(saved.getPage(0).node.Contents()).toBeDefined();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(await download(page)).toEqual(bytes);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect((await PDFDocument.load(await download(page))).getForm().getFields()).toHaveLength(1);
  });
