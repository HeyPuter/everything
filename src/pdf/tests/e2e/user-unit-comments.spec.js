import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addShapeAnnotation, addTextBox, listAnnotations } from '../../src/core/annotations.js';
import { listNotes } from '../../src/core/notes.js';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test.skip(({ isMobile }) => isMobile, 'desktop workspace');

// Letter paper in units of ten points, as large drawings set a UserUnit: comments placed with a
// click have the sizes they have on any other page, not ten times those.
test('comments clicked onto a page with large units have their usual size', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([61.2, 79.2]).node.set(PDFName.of('UserUnit'), PDFNumber.of(10));
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'drawing.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  const paper = await page.locator('.paper').boundingBox();
  const inch = paper.width / 8.5;
  const click = (x, y) => page.mouse.click(paper.x + x * inch, paper.y + y * inch);

  await pane.getByRole('button', { name: 'Add text comment', exact: true }).click();
  await click(1, 1);
  const textBox = page.getByRole('dialog', { name: 'Text box' });
  await textBox.getByLabel('Text').fill('Boxed');
  await textBox.getByRole('button', { name: 'Add', exact: true }).click();
  await settled(page);

  await pane.getByRole('button', { name: 'Sticky note', exact: true }).click();
  await click(1, 6);
  await page.getByLabel('New note text').fill('Noted');
  await page.getByRole('button', { name: 'Close note', exact: true }).click();
  await settled(page);

  // A shape and a drawing at the thinnest width, 1 point, not five times as thick.
  await pane.getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByLabel('Stroke width', { exact: true }).selectOption('1');
  const drag = async (from, to) => {
    await page.mouse.move(paper.x + from[0] * inch, paper.y + from[1] * inch);
    await page.mouse.down();
    await page.mouse.move(paper.x + to[0] * inch, paper.y + to[1] * inch, { steps: 5 });
    await page.mouse.up();
    await settled(page);
  };
  await drag([4, 1], [6, 3]);
  await pane.getByRole('button', { name: 'Pencil', exact: true }).click();
  await drag([4, 5], [6, 7]);

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  for (const subtype of ['Square', 'Ink'])
    expect(listAnnotations(saved, 0).find((a) => a.subtype === subtype).width * 10).toBeCloseTo(
      1,
      2,
    );
  const box = listAnnotations(saved, 0).find((a) => a.subtype === 'FreeText');
  expect([box.box.width * 10, box.box.height * 10, box.fontSize * 10, box.width * 10]).toEqual([
    expect.closeTo(180, 0),
    expect.closeTo(50, 0),
    expect.closeTo(12, 1),
    expect.closeTo(1, 1),
  ]);
  const [note] = listNotes(saved, 0);
  expect(note.width * 10).toBeCloseTo(20, 1);
});

// On such a page the properties panel showed widths and font sizes in the page's units while
// calling them points: a 2 point line read "0.2 pt", and choosing "4 pt" drew it 40 points wide.
test('a comment on a page with large units shows and takes its sizes in points', async ({
  page,
}) => {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  const doc = await PDFDocument.create();
  doc.addPage([61.2, 79.2]).node.set(PDFName.of('UserUnit'), PDFNumber.of(10));
  addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 10, y: 50, width: 20, height: 10 },
    width: 0.2,
  });
  await addTextBox(doc, 0, {
    rect: { x: 10, y: 20, width: 18, height: 5 },
    text: 'Sized',
    fontSize: 1.2,
    borderWidth: 0.1,
  });
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'drawing.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const props = page.getByRole('complementary', { name: 'Selection properties' });

  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  const width = props.getByLabel('Line width', { exact: true });
  await expect(width).toHaveValue('2');
  await width.selectOption('4');
  await settled(page);

  await page.getByRole('button', { name: 'Text box: Sized', exact: true }).click();
  const size = props.getByLabel('Font size', { exact: true });
  await expect(size).toHaveValue('12');
  await size.fill('20');
  await size.press('Enter');
  await settled(page);

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const [square, box] = listAnnotations(saved, 0);
  expect(square.width).toBeCloseTo(0.4, 6);
  expect(box.fontSize).toBeCloseTo(2, 6);
});
