import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { addNote } from '../../src/core/notes.js';

// The workspace on a phone: panels overlay the page, so they must leave the tools in reach,
// step aside once a command needs the page, and never move the controls under a finger.
test.skip(({ isMobile }) => !isMobile, 'phone layout');

async function openPdf(page, doc) {
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'phone.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}
async function pages(count) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++)
    doc.addPage([400, 500]).drawText(`Page ${i + 1} words`, { x: 40, y: 400, size: 20, font });
  return doc;
}

test('the tools pane steps aside once a tool needs the page and comes back with its commands', async ({
  page,
}) => {
  await openPdf(page, await pages(3));
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await expect(pane).toBeHidden();
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await pane.getByRole('button', { name: 'Organize pages', exact: true }).click();
  await expect(pane).toBeHidden();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  await grid.getByRole('option', { name: 'Page 2', exact: true }).click();
  await expect(page.locator('.organize-status')).toHaveText('1 of 3 pages selected');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(pane.getByRole('heading', { name: 'Organize pages' })).toBeVisible();
  await pane.getByRole('button', { name: 'Rotate clockwise', exact: true }).click();
  await expect(pane).toBeHidden();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
});

test('the comments panel covers the page but not the tools, and keeps an open note', async ({
  page,
}) => {
  const doc = await pages(1);
  addNote(doc, 0, { x: 40, y: 320, text: 'First note' });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Note', exact: true }).click();
  const note = page.getByRole('button', { name: 'Edit note: First note', exact: true });
  await note.focus();
  await note.press('Enter');
  await page.getByLabel('Note text', { exact: true }).fill('Still editing');
  await page.getByRole('tab', { name: /Comments/ }).click();
  const panel = page.getByRole('complementary', { name: 'Comments panel' });
  await expect(panel).toBeVisible();
  // Opening the panel neither saves the draft nor hides it.
  await expect(page.getByLabel('Note text', { exact: true })).toHaveValue('Still editing');
  await expect(panel).toContainText('First note');
  const tools = await page.getByRole('toolbar', { name: 'PDF tools' }).boundingBox();
  const box = await panel.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(tools.y + tools.height - 1);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('selecting text keeps the page and its controls where they were', async ({ page }) => {
  await openPdf(page, await pages(1));
  const target = page.getByRole('button', { name: 'Edit text: Page 1 words', exact: true });
  const zoom = page.getByRole('group', { name: 'Zoom controls' });
  const before = { text: await target.boundingBox(), zoom: await zoom.boundingBox() };
  await target.click({ position: { x: 6, y: 6 } });
  await expect(page.getByLabel('Text size', { exact: true })).toBeVisible();
  expect(await target.boundingBox()).toEqual(before.text);
  expect(await zoom.boundingBox()).toEqual(before.zoom);
});

test('a message over the selection dock lets taps through to its controls', async ({ page }) => {
  await openPdf(page, await pages(1));
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Insert', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Stamp…', exact: true }).click();
  await page.getByRole('button', { name: 'Place stamp', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText(/^Stamp added/);
  // The message shows over the dock for a few seconds; a field under it still takes a tap.
  const covered = await page.evaluate(() => {
    const box = document.querySelector('#toast').getBoundingClientRect();
    const field = [...document.querySelectorAll('.properties-sidebar input[type="number"]')]
      .map((input) => ({ input, r: input.getBoundingClientRect() }))
      .find(
        ({ r }) =>
          r.width &&
          r.x + r.width / 2 > box.left &&
          r.x + r.width / 2 < box.right &&
          r.y + r.height / 2 > box.top &&
          r.y + r.height / 2 < box.bottom,
      );
    return (
      field && {
        label: field.input.getAttribute('aria-label'),
        x: field.r.x + field.r.width / 2,
        y: field.r.y + field.r.height / 2,
      }
    );
  });
  expect(covered).toBeTruthy();
  await page.touchscreen.tap(covered.x, covered.y);
  await expect(page.getByLabel(covered.label, { exact: true })).toBeFocused();
  await expect(page.locator('#toast')).toHaveText(/^Stamp added/);
});

test('the accessibility report shows each problem in full in the narrow panel', async ({
  page,
}) => {
  await openPdf(page, await pages(2));
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Prepare for accessibility', exact: true }).click();
  const check = pane.getByRole('button', { name: 'Accessibility check', exact: true });
  if (!(await check.isVisible()))
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await check.click();
  const report = page.getByRole('tabpanel', { name: 'Accessibility check' });
  const detail = report.getByText('MarkInfo does not mark the file as tagged', { exact: true });
  await expect(detail).toBeVisible();
  // The details wrap: none of them is cut short with an ellipsis.
  const cut = await report
    .locator('.a11y-details li > span')
    .evaluateAll((spans) =>
      spans.filter((span) => span.scrollWidth > span.clientWidth + 1).map((s) => s.textContent),
    );
  expect(cut).toEqual([]);
});
