import { test, expect } from '@playwright/test';
import { PDFDocument, degrees } from 'pdf-lib';

const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

// The comment tools live in the desktop tools pane; phones reach them through phone-shell.
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

for (const rotation of [0, 90, 270])
  test(`text boxes, callouts, and measurement labels read across a page turned ${rotation} degrees`, async ({
    page,
  }) => {
    await page.route('https://js.puter.com/**', (route) => route.abort());
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).setRotation(degrees(rotation));
    await page.goto('/#library');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^Open a PDF/ }).click();
    await (
      await chooser
    ).setFiles({
      name: 'rotated-comments.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await settled(page);
    const overlay = page.locator('.drawing-overlay');
    const box = await overlay.boundingBox();
    // Screen pixels per point: the page's long side is 792 points.
    const unit = Math.max(box.width, box.height) / 792;
    const pane = page.getByRole('complementary', { name: 'Tools' });

    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await pane.getByRole('button', { name: 'Add text comment', exact: true }).click();
    const click = { x: box.x + 60, y: box.y + 60 };
    await page.mouse.click(click.x, click.y);
    const dialog = page.getByRole('dialog', { name: 'Text box' });
    await dialog.getByLabel('Text').fill('Check this');
    await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await settled(page);

    await pane.getByRole('button', { name: 'Callout', exact: true }).click();
    const anchor = { x: box.x + 60, y: box.y + 300 * unit };
    await page.mouse.click(anchor.x, anchor.y);
    const calloutDialog = page.getByRole('dialog', { name: 'Callout' });
    await calloutDialog.getByLabel('Text').fill('Point here');
    await calloutDialog.getByRole('button', { name: 'Add', exact: true }).click();
    await settled(page);

    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await pane.getByRole('button', { name: 'View more' }).click();
    await pane.getByRole('button', { name: 'Measure', exact: true }).click();
    await pane.getByRole('button', { name: 'Distance', exact: true }).click();
    const line = { y: box.y + box.height * 0.6, from: box.x + 60, to: box.x + 60 + 216 * unit };
    await page.mouse.move(line.from, line.y);
    await page.mouse.down();
    await page.mouse.move(line.to, line.y, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('#toast')).toContainText(/Measured: 3\.0\d in/);
    await settled(page);

    await page.getByRole('button', { name: 'Select', exact: true }).click();
    // A clicked text box runs 180 points right and 50 down from the click, as the page reads.
    const textBox = await page.getByRole('button', { name: 'Text box: Check this' }).boundingBox();
    expect(textBox.x).toBeCloseTo(click.x, -1);
    expect(textBox.y).toBeCloseTo(click.y, -1);
    expect(textBox.width / unit).toBeCloseTo(180, -1);
    expect(textBox.height / unit).toBeCloseTo(50, -1);
    // A clicked callout's box sits up and to the right of its point, 180 points wide.
    const callout = await page.getByRole('button', { name: 'Text box: Point here' }).boundingBox();
    expect(callout.x).toBeCloseTo(anchor.x, -1);
    expect(callout.x + callout.width).toBeCloseTo(anchor.x + 60 + 180 * unit, -1);
    expect(callout.y).toBeCloseTo(anchor.y - 60, -1);
    // The label is one line wide and sits just above the middle of the measured line.
    const label = await page.getByRole('button', { name: /^Text box: 3\.0\d in/ }).boundingBox();
    expect(label.width).toBeGreaterThan(label.height * 2);
    expect(label.y + label.height).toBeLessThanOrEqual(line.y);
    expect(label.y + label.height).toBeGreaterThan(line.y - 10 * unit);
    expect(label.x + label.width / 2).toBeCloseTo((line.from + line.to) / 2, -1);
  });
