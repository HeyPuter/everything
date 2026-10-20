import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listAnnotations } from '../../src/core/annotations.js';
import { drawAppearance } from '../../src/core/annotation-appearance.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// Other editors' squiggly underlines are listed with the comments; they can be chosen there or
// on the page, recolored, and deleted, but not dragged off the words they mark.
test('a squiggly underline from another editor can be selected, recolored, and deleted', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 500]);
  sheet.drawText('Spelling mistkae', {
    x: 40,
    y: 400,
    size: 20,
    font: await doc.embedFont(StandardFonts.Helvetica),
  });
  const squiggly = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Squiggly',
    F: 4,
    C: [1, 0, 0],
    Contents: PDFString.of('Typo'),
    QuadPoints: [120, 420, 200, 420, 120, 396, 200, 396],
    Rect: [120, 396, 200, 420],
  });
  drawAppearance(doc, sheet, squiggly);
  sheet.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(squiggly)]));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'squiggly.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  const tabs = page.getByRole('tablist', { name: 'Side panel' });
  if (!(await tabs.isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await tabs.getByRole('tab', { name: /Comments/ }).click();
  await page
    .getByRole('button', { name: 'Squiggly underline on page 1: Typo', exact: true })
    .click();
  const target = page.getByRole('button', { name: 'Squiggly underline: Typo', exact: true });
  await expect(target).toHaveAttribute('aria-pressed', 'true');
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  await expect(props.getByRole('heading', { name: 'Squiggly underline' })).toBeVisible();
  await props.getByLabel('Color', { exact: true }).fill('#0055ff');
  await settled(page);
  await expect(target).toHaveAttribute('aria-pressed', 'true');
  // It stays on its words: a drag does not move it.
  const box = await target.boundingBox();
  await page.mouse.move(box.x + 10, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 60, { steps: 5 });
  await page.mouse.up();
  await settled(page);
  await expect(page.locator('#toast')).not.toContainText('cannot be changed');
  const download = async () => {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    return listAnnotations(await PDFDocument.load(await readFile(await (await pending).path())), 0);
  };
  const [recolored] = await download();
  expect(recolored.color).toBe('#0055ff');
  expect(recolored.points).toEqual([[120, 420, 200, 420, 120, 396, 200, 396]]);
  await target.focus();
  await page.keyboard.press('Delete');
  await settled(page);
  await expect(target).toHaveCount(0);
  expect(await download()).toEqual([]);
});
