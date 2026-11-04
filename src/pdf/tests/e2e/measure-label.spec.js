import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

/** Every comment on the first page, as subtype and Rect, read from the downloaded PDF. */
async function saved(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const doc = await PDFDocument.load(await readFile(await (await pending).path()));
  const all = (doc.getPage(0).node.Annots()?.asArray() || []).map((ref) => {
    const dict = doc.context.lookup(ref);
    return {
      subtype: dict.lookup(PDFName.of('Subtype')).decodeText(),
      rect: dict
        .lookup(PDFName.of('Rect'))
        .asArray()
        .map((n) => n.asNumber()),
    };
  });
  return { all, listed: listAnnotations(doc, 0) };
}

// A measurement's label belongs to it: one comment, which moves and goes as one.
test('a measurement and its label are one comment that moves and is deleted as one', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'measure.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Measure', exact: true }).click();
  await pane.getByRole('button', { name: 'Distance', exact: true }).click();
  const paper = await page.locator('.paper').boundingBox();
  const inch = paper.width / 8.5;
  await page.mouse.move(paper.x + inch, paper.y + 3 * inch);
  await page.mouse.down();
  await page.mouse.move(paper.x + 3 * inch, paper.y + 3 * inch, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#toast')).toContainText(/Measured: 2\.0\d in/);
  await settled(page);

  // Listed once in the Comments panel.
  if (!(await page.locator('#page-sidebar').isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await page
    .getByRole('tablist', { name: 'Side panel' })
    .getByRole('tab', { name: /Comments/ })
    .click();
  const list = page.getByRole('group', { name: 'Comments' });
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(list.getByRole('button')).toHaveAccessibleName(/Line on page 1/);

  const first = await saved(page);
  const label = (all) => all.find((a) => a.subtype === 'FreeText').rect;
  expect(first.listed.map((a) => a.subtype)).toEqual(['Line']);

  // Dragged by its label, the line takes the label along.
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const [lx1, ly1, lx2, ly2] = label(first.all);
  const scale = paper.width / 612;
  const at = (x, y) => [paper.x + x * scale, paper.y + (792 - y) * scale];
  const [sx, sy] = at((lx1 + lx2) / 2, (ly1 + ly2) / 2);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 36 * scale, sy + 72 * scale, { steps: 6 });
  await page.mouse.up();
  await settled(page);
  const second = await saved(page);
  const moved = label(second.all);
  expect(moved[0] - lx1).toBeCloseTo(36, 0);
  expect(moved[1] - ly1).toBeCloseTo(-72, 0);
  const line = (all) => all.find((a) => a.subtype === 'Line').rect;
  expect(line(second.all)[0] - line(first.all)[0]).toBeCloseTo(36, 0);

  // Delete removes both.
  await page.locator('.annotation-target').focus();
  await page.keyboard.press('Delete');
  await settled(page);
  expect((await saved(page)).all).toEqual([]);
});
