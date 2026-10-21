import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { listAnnotations } from '../../src/core/annotations.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// The comment tools live in the desktop tools pane; phones reach them through phone-shell.
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

test('a callout dragged to the left or straight up keeps its box clear of its point', async ({
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
    name: 'callout-drag.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Callout', exact: true })
    .click();
  const box = await page.locator('.drawing-overlay').boundingBox();
  const drags = [
    // Left of the point, a little higher: the box once covered the point.
    { from: [400, 200], to: [300, 180], text: 'Left' },
    // Straight up, less than a box's height.
    { from: [150, 330], to: [150, 300], text: 'Up' },
    // Up and to the right, as before.
    { from: [80, 450], to: [180, 380], text: 'Right' },
  ];
  for (const [index, { from, to, text }] of drags.entries()) {
    await page.mouse.move(box.x + from[0], box.y + from[1]);
    await page.mouse.down();
    await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 5 });
    await page.mouse.up();
    const dialog = page.getByRole('dialog', { name: 'Callout' });
    await dialog.getByLabel('Text').fill(text);
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    // The comment is added after the dialog closes; a drag begun before then is lost when the
    // page is drawn again, so wait for the comment itself rather than an idle editor.
    await expect(page.getByRole('tab', { name: `Comments (${index + 1})` })).toBeVisible();
    await settled(page);
    await expect(page.locator('#toast')).not.toContainText('outside its text box');
  }
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const callouts = listAnnotations(saved, 0);
  expect(callouts.map((entry) => entry.contents)).toEqual(['Left', 'Up', 'Right']);
  const unit = box.width / 612;
  const pdf = ([x, y]) => ({ x: x / unit, y: 792 - y / unit });
  const [left, up, right] = callouts;
  // The dragged-to point is the box corner nearest the callout's point.
  const end = drags.map(({ to }) => pdf(to));
  expect(left.box.x + left.box.width).toBeCloseTo(end[0].x, 0);
  expect(left.box.y + left.box.height).toBeCloseTo(end[0].y, 0);
  expect(up.box.x).toBeCloseTo(end[1].x, 0);
  expect(up.box.y).toBeCloseTo(end[1].y, 0);
  expect(right.box.x).toBeCloseTo(end[2].x, 0);
  expect(right.box.y + right.box.height).toBeCloseTo(end[2].y, 0);
  for (const entry of callouts) expect(entry.box.width).toBeCloseTo(180, 0);
});
