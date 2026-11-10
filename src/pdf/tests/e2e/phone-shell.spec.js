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

test('the tools pane and the side panel take turns instead of covering each other', async ({
  page,
}) => {
  await openPdf(page, await pages(3));
  const pane = page.getByRole('complementary', { name: 'Tools' });
  const panel = page.getByRole('complementary', { name: 'Pages panel' });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(pane).toBeVisible();
  await page.getByRole('tab', { name: 'Pages', exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(pane).toBeHidden();
  // The page thumbnails are under the reader's finger, not under the tools pane.
  const thumb = await panel.locator('.thumb-paper').first().boundingBox();
  const hit = await page.evaluate(
    ([x, y]) => !!document.elementFromPoint(x, y)?.closest('.page-sidebar'),
    [thumb.x + thumb.width / 2, thumb.y + thumb.height / 2],
  );
  expect(hit).toBe(true);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(pane).toBeVisible();
  await expect(panel).toBeHidden();
});

test('two fingers zoom the page, not the whole application', async ({ page }) => {
  await openPdf(page, await pages(3));
  const zoom = page.getByLabel('Zoom', { exact: true });
  await expect(zoom).toHaveValue('fit');
  const sheet = page.locator('.page-slot[data-page="0"]');
  const before = (await sheet.boundingBox()).width;
  const view = await page.locator('.workspace').boundingBox();
  // Between the fingers is blank page, which the browser would otherwise have zoomed.
  const x = view.x + view.width * 0.6,
    y = view.y + view.height * 0.5;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizePinchGesture', {
    x,
    y,
    scaleFactor: 1.5,
    gestureSourceType: 'touch',
  });
  await expect(zoom).not.toHaveValue('fit');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => window.visualViewport.scale)).toBe(1);
  const zoomed = (await sheet.boundingBox()).width;
  expect(zoomed).toBeGreaterThan(before * 1.2);
  // The tools stay where they were, in reach.
  await expect(page.getByRole('toolbar', { name: 'PDF tools' })).toBeInViewport();
  await cdp.send('Input.synthesizePinchGesture', {
    x,
    y,
    scaleFactor: 0.6,
    gestureSourceType: 'touch',
  });
  await expect.poll(async () => (await sheet.boundingBox()).width).toBeLessThan(zoomed * 0.8);
  expect(await page.evaluate(() => window.visualViewport.scale)).toBe(1);
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

test('the hints speak of taps on a touch screen, and a double tap edits text', async ({ page }) => {
  await openPdf(page, await pages(1));
  await expect(page.locator('.tool-hint')).toHaveText(
    'Tap to select, drag to move, or double-tap text to edit.',
  );
  const words = page.getByRole('button', { name: 'Edit text: Page 1 words', exact: true });
  const box = await words.boundingBox();
  const x = box.x + 8,
    y = box.y + box.height / 2;
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x, y);
  await expect(page.locator('.page-text-input, .text-line-input').first()).toBeVisible();
});

test('read mode tells a touch screen how to bring the tools back', async ({ page }) => {
  await openPdf(page, await pages(1));
  const readMode = async () => {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'View', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Read mode', exact: true }).click();
  };
  await readMode();
  await expect(page.locator('.editor')).toHaveClass(/read-mode/);
  // A phone has no Escape key; the way back is the one the message names.
  await expect(page.locator('#toast')).toHaveText(
    'Read mode. Turn it off in the View menu to show the tools again.',
  );
  await readMode();
  await expect(page.locator('.editor')).not.toHaveClass(/read-mode/);
});

test('a stamp placed on a phone is brought into view above the selection dock', async ({
  page,
}) => {
  // A Letter page: at the phone's width its middle is near the foot of the view.
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Insert', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Stamp…', exact: true }).click();
  await page.getByRole('button', { name: 'Place stamp', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText(/^Stamp added/);
  await expect(page.getByRole('complementary', { name: 'Selection properties' })).toBeVisible();
  // The middle of the page sits under the dock once it opens; the view follows the stamp,
  // its corner handles included.
  const view = await page.getByRole('region', { name: 'PDF page view' }).boundingBox();
  const handles = page.locator('.image-move, .image-resize');
  await expect(handles).toHaveCount(5);
  for (const box of await Promise.all(
    (await handles.all()).map((handle) => handle.boundingBox()),
  )) {
    expect(box.y).toBeGreaterThanOrEqual(view.y);
    expect(box.y + box.height).toBeLessThanOrEqual(view.y + view.height);
  }
});

// A finger put down beside an open note let go of it at once, as a click away does: scrolling
// the page closed the note being typed, and a pinch only closed it, without zooming.
test('scrolling or pinching keeps an open note, and a tap beside it closes it', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 1200]);
  addNote(doc, 0, { x: 300, y: 1150, text: 'Keep me' });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Edit note: Keep me' }).tap();
  const text = page.getByRole('textbox', { name: 'Note text', exact: true });
  await expect(text).toBeFocused();
  await page.keyboard.type(' open');
  const workspace = page.locator('.workspace');
  const view = await workspace.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizeScrollGesture', {
    x: Math.round(view.x + view.width * 0.4),
    y: Math.round(view.y + view.height * 0.7),
    yDistance: -100,
    gestureSourceType: 'touch',
  });
  await expect.poll(() => workspace.evaluate((node) => node.scrollTop)).toBeGreaterThan(40);
  await expect(text).toHaveValue('Keep me open');
  await expect(text).toBeFocused();
  const zoom = page.getByLabel('Zoom', { exact: true });
  await cdp.send('Input.synthesizePinchGesture', {
    x: view.x + view.width * 0.4,
    y: view.y + view.height * 0.5,
    scaleFactor: 0.7,
    gestureSourceType: 'touch',
  });
  await expect(zoom).not.toHaveValue('fit');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(text).toHaveValue('Keep me open');
  // A tap on the page beside it closes the note and keeps what was typed.
  const sheet = await page.locator('.paper').boundingBox();
  await page.touchscreen.tap(sheet.x + 10, sheet.y + 10);
  await expect(text).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit note: Keep me open' })).toBeVisible();
});

test('the find box shows its whole prompt until there is a count beside it', async ({ page }) => {
  await openPdf(page, await pages(2));
  await page.keyboard.press('ControlOrMeta+f');
  const box = page.getByRole('combobox', { name: 'Find in PDF' });
  await expect(box).toBeFocused();
  // The empty match count kept 60px beside the box, and "Find text or tools" lost its end.
  const room = () =>
    box.evaluate((input) => {
      const style = getComputedStyle(input);
      const context = document.createElement('canvas').getContext('2d');
      context.font = `${style.fontSize} ${style.fontFamily}`;
      const free =
        input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return free - context.measureText(input.placeholder).width;
    });
  // Beyond the prompt, a search field keeps the place of its clear button (about 20px).
  expect(await room()).toBeGreaterThan(30);
  await box.fill('words');
  await expect(page.locator('.search-count')).toHaveText('1 of 2');
  await expect(page.locator('.search-count')).toBeVisible();
});
