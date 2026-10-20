import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
async function mockPuter(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
}
async function openPdf(page, doc, name = 'test.pdf') {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
  await settled(page);
}
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
async function numberedPdf(count, size = [400, 500]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++)
    doc.addPage(size).drawText(`Page ${i + 1} words`, { x: 40, y: 100, size: 20, font });
  return doc;
}
async function downloaded(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return new Uint8Array(await readFile(await (await pending).path()));
}

// The desktop workspace: phones overlay the tools pane and step it aside after each command,
// which phone-shell.spec.js covers.
test.skip(({ isMobile }) => isMobile, 'desktop workspace');

test.beforeEach(async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
});

test('the tool sets open their tools in the tools pane and the list finds every tool', async ({
  page,
}) => {
  await openPdf(page, await numberedPdf(1));
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await expect(pane.getByRole('heading', { name: 'All tools' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(pane.getByRole('heading', { name: 'Edit a PDF' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await pane.getByRole('button', { name: 'Add text', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Text', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await pane.getByRole('button', { name: 'Back to all tools' }).click();
  await pane.getByRole('button', { name: 'View more' }).click();
  for (const name of ['Bates numbering', 'Use a certificate', 'Split a PDF', 'Flatten'])
    await expect(pane.getByRole('button', { name, exact: true })).toBeVisible();
  // The pane closes with its own button and comes back with a tool set.
  await pane.getByRole('button', { name: 'Close tools panel' }).click();
  await expect(pane).toBeHidden();
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(pane.getByRole('heading', { name: 'All tools' })).toBeVisible();
});

test('the find box also offers matching tools', async ({ page }) => {
  await openPdf(page, await numberedPdf(1));
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Find in PDF' }).fill('compress');
  await page.getByRole('button', { name: 'Open tool: Compress a PDF' }).click();
  await expect(page.getByRole('dialog', { name: 'Reduce file size' })).toBeVisible();
});

test('Home and End move along the menu bar without turning the page', async ({ page }) => {
  await openPdf(page, await numberedPdf(3));
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  await bar.getByRole('menuitem', { name: 'Edit', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(bar.getByRole('menuitem', { name: 'Insert', exact: true })).toBeFocused();
  // The page would otherwise have gone to the last page, scrolled there, and settled.
  await page.waitForTimeout(500);
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('1');
  await page.keyboard.press('Home');
  await expect(bar.getByRole('menuitem', { name: 'File', exact: true })).toBeFocused();
});

test('Home and End move along the panel tabs without turning the page', async ({ page }) => {
  await openPdf(page, await numberedPdf(3));
  const rail = page.getByRole('navigation', { name: 'Panels' });
  const tabs = rail.getByRole('tab');
  await tabs.first().focus();
  await page.keyboard.press('End');
  await expect(tabs.last()).toBeFocused();
  await page.waitForTimeout(500);
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('1');
});

test('the quick tools are one tab stop that the arrow keys move through', async ({ page }) => {
  await openPdf(page, await numberedPdf(3));
  const toolbar = page.getByRole('toolbar', { name: 'PDF tools' });
  const tool = (name) => toolbar.getByRole('button', { name, exact: true });
  await tool('Select').focus();
  await page.keyboard.press('ArrowDown');
  await expect(tool('Hand')).toBeFocused();
  await page.keyboard.press('End');
  await expect(tool('Fill forms')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(tool('Select')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Home');
  await expect(tool('Select')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(tool('Text')).toHaveAttribute('aria-pressed', 'true');
  // One button holds the tab stop: the one used last.
  await expect(toolbar.locator('button[tabindex="0"], button:not([tabindex])')).toHaveCount(1);
  await expect(tool('Text')).toHaveJSProperty('tabIndex', 0);
  await page.waitForTimeout(500);
  await expect(page.getByLabel('Page number', { exact: true })).toHaveValue('1');
});

test('pages scroll continuously and the page in view becomes the current page', async ({
  page,
}) => {
  await openPdf(page, await numberedPdf(4));
  await expect(page.locator('.page-slot')).toHaveCount(4);
  const workspace = page.locator('.workspace');
  await workspace.evaluate((node) => {
    const third = node.querySelector('.page-slot[data-page="2"]');
    node.scrollTop += third.getBoundingClientRect().top - node.getBoundingClientRect().top;
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 4');
  await expect(page.getByLabel('Page number')).toHaveValue('3');
  // Other pages show their pictures, drawn as they come near the view.
  await expect
    .poll(() =>
      page.locator('.page-slot[data-page="1"] .page-image').evaluate((canvas) => canvas.width),
    )
    .toBeGreaterThan(300);
  // Choosing a page brings its top into view.
  await page.getByLabel('Page number').fill('1');
  await page.getByLabel('Page number').press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 4');
  const top = await page.evaluate(
    () =>
      document.querySelector('.page-slot[data-page="0"]').getBoundingClientRect().top -
      document.querySelector('.workspace').getBoundingClientRect().top,
  );
  expect(top).toBeGreaterThanOrEqual(0);
  expect(top).toBeLessThan(40);
});

test('pages already in view are drawn again at a new zoom', async ({ page }) => {
  await openPdf(page, await numberedPdf(6));
  const zoom = page.getByLabel('Zoom', { exact: true });
  await zoom.selectOption('0.5');
  await settled(page);
  // Neighbours stay near the view through the zoom; their pictures must not be left stretched.
  await zoom.selectOption('0.75');
  await settled(page);
  const sharp = () =>
    page.evaluate(() => {
      const view = document.querySelector('.workspace').getBoundingClientRect();
      return [...document.querySelectorAll('.page-slot:not(:has(.paper))')]
        .filter((slot) => {
          const box = slot.getBoundingClientRect();
          return box.bottom > view.top && box.top < view.bottom;
        })
        .map((slot) => [
          slot.dataset.page,
          slot.querySelector('.page-image').width ===
            Math.floor(slot.offsetWidth * window.devicePixelRatio),
        ]);
    });
  await expect.poll(async () => (await sharp()).length).toBeGreaterThan(0);
  await expect.poll(async () => (await sharp()).every(([, ok]) => ok)).toBe(true);
});

test('single page display shows one page at a time', async ({ page }) => {
  await openPdf(page, await numberedPdf(3));
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page display' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Single page' }).click();
  await expect(page.locator('.page-slot:visible')).toHaveCount(1);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await expect(page.locator('.page-slot:visible')).toHaveAttribute('data-page', '1');
  await page.evaluate(() => localStorage.removeItem('pdf-editor:page-display'));
});

test('Space-drag panning ends when the window loses focus with Space held', async ({ page }) => {
  await openPdf(page, await numberedPdf(3));
  const workspace = page.locator('.workspace');
  await workspace.focus();
  await page.keyboard.down('Space');
  await expect(page.locator('.editor')).toHaveClass(/space-pan/);
  // Space comes up in another window, so this one only sees the blur.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('.editor')).not.toHaveClass(/space-pan/);
  // A drag on the page is the Select tool's again, not a pan.
  await workspace.evaluate((node) => (node.scrollTop = 200));
  const box = await page.locator('.page-slot[data-page="1"]').boundingBox();
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 20, { steps: 4 });
  await page.mouse.up();
  expect(await workspace.evaluate((node) => node.scrollTop)).toBe(200);
  await page.keyboard.up('Space');
});

for (const display of ['Two-page', 'Two-page scrolling'])
  test(`${display} at fit width fits both pages without sideways scrolling`, async ({ page }) => {
    await openPdf(page, await numberedPdf(4));
    await page.getByRole('menuitem', { name: 'View', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Page display' }).click();
    await page.getByRole('menuitemcheckbox', { name: display, exact: true }).click();
    await expect(page.locator('.page-stack')).toHaveClass(/two-up/);
    await settled(page);
    await expect(page.getByLabel('Zoom', { exact: true })).toHaveValue('fit');
    const workspace = page.locator('.workspace');
    const [first, second] = await Promise.all(
      [0, 1].map((i) => page.locator(`.page-slot[data-page="${i}"]`).boundingBox()),
    );
    expect(Math.abs(first.y - second.y)).toBeLessThan(1);
    expect(await workspace.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
    // The pair still fills the width the quick tools leave free.
    const room = (await workspace.evaluate((node) => node.clientWidth)) - 120;
    expect(second.x + second.width - first.x).toBeGreaterThan(room - 3);
    await page.evaluate(() => localStorage.removeItem('pdf-editor:page-display'));
  });

test('in two-page scrolling, the right-hand page stays current while its row is in view', async ({
  page,
}) => {
  await openPdf(page, await numberedPdf(6));
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page display' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Two-page scrolling', exact: true }).click();
  await expect(page.locator('.page-stack')).toHaveClass(/two-up/);
  await settled(page);
  const right = await page.locator('.page-slot[data-page="1"]').boundingBox();
  await page.mouse.click(right.x + 50, right.y + 50);
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 6');
  await settled(page);
  // A little scrolling to read on leaves the chosen page current.
  await page.mouse.wheel(0, 40);
  await expect
    .poll(() => page.locator('.workspace').evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await page.waitForTimeout(600);
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 6');
  // The next row's left page becomes current once that row is reached.
  await page.locator('.workspace').evaluate((node) => {
    const slot = node.querySelector('.page-slot[data-page="2"]');
    node.scrollTop += slot.getBoundingClientRect().top - node.getBoundingClientRect().top;
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 6');
  await page.evaluate(() => localStorage.removeItem('pdf-editor:page-display'));
});

test('Organize pages selects, turns, moves, and deletes several pages', async ({ page }) => {
  await openPdf(page, await numberedPdf(4));
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  await expect(grid.getByRole('option')).toHaveCount(4);
  await grid.getByRole('option', { name: 'Page 2', exact: true }).click();
  await grid.getByRole('option', { name: 'Page 3', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.locator('.organize-status')).toHaveText('2 of 4 pages selected');
  const toolbar = page.getByRole('toolbar', { name: 'Organize pages' });
  await toolbar.getByRole('button', { name: 'Rotate clockwise', exact: true }).click();
  await settled(page);
  let doc = await PDFDocument.load(await downloaded(page));
  expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90, 90, 0]);
  // Dragging the selection to the end moves both pages, in their order.
  await grid
    .getByRole('option', { name: 'Page 2', exact: true })
    .dragTo(grid.getByRole('option', { name: 'Page 4', exact: true }), {
      targetPosition: { x: 150, y: 60 },
    });
  await settled(page);
  doc = await PDFDocument.load(await downloaded(page));
  expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 0, 90, 90]);
  await grid.getByRole('option', { name: 'Page 1', exact: true }).click();
  await grid.getByRole('option', { name: 'Page 2', exact: true }).click({ modifiers: ['Shift'] });
  await toolbar.getByRole('button', { name: 'Delete pages', exact: true }).click();
  await page.getByRole('button', { name: 'Delete pages', exact: true }).last().click();
  await settled(page);
  await expect(grid.getByRole('option')).toHaveCount(2);
  await toolbar.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText(/of 2$/);
});

test('Bates numbering stamps padded numbers across the chosen pages', async ({ page }) => {
  await openPdf(page, await numberedPdf(3));
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Bates numbering', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Bates numbering' });
  await dialog.getByLabel('Prefix').fill('CASE-');
  await dialog.getByLabel('Start number').fill('7');
  await dialog.getByLabel('Number of digits').fill('4');
  await dialog.getByRole('button', { name: 'Add header and footer' }).click();
  await settled(page);
  const bytes = await downloaded(page);
  const text = new TextDecoder('latin1').decode(bytes);
  expect(text.length).toBeGreaterThan(0);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const words = [];
  for (let i = 1; i <= 3; i++)
    words.push(
      (await (await pdf.getPage(i)).getTextContent()).items.map((item) => item.str).join(' '),
    );
  expect(words[0]).toContain('CASE-0007');
  expect(words[2]).toContain('CASE-0009');
});

test('files can be attached, saved again, and removed in the Attachments panel', async ({
  page,
}) => {
  await openPdf(page, await numberedPdf(1));
  await page.getByRole('tab', { name: 'Attachments' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Attachments' });
  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Attach a file…' }).click();
  await (
    await chooser
  ).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('kept inside') });
  await expect(panel.getByText('notes.txt')).toBeVisible();
  const saved = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Save notes.txt' }).click();
  expect(await readFile(await (await saved).path(), 'utf8')).toBe('kept inside');
  await panel.getByRole('button', { name: 'Remove notes.txt' }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(panel.getByText('notes.txt')).toBeHidden();
});

test('a certificate signature is added, validated, and protected from silent edits', async ({
  page,
}) => {
  await openPdf(page, await numberedPdf(1));
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Use a certificate', exact: true }).click();
  await pane.getByRole('button', { name: /Digitally sign/ }).click();
  await page.getByRole('button', { name: 'Place at page center' }).click();
  const chooser = page.getByRole('dialog', { name: 'Choose a digital ID' });
  await chooser.getByLabel('Create a new digital ID').check();
  await chooser.getByLabel('Name', { exact: true }).fill('Ada Lovelace');
  await chooser.getByLabel('Email').fill('ada@example.com');
  await chooser.getByLabel('Password for the ID file').fill('secret-123');
  const idFile = page.waitForEvent('download');
  await chooser.getByRole('button', { name: 'Continue' }).click();
  expect((await idFile).suggestedFilename()).toMatch(/\.p12$/);
  const details = page.getByRole('dialog', { name: 'Sign with a certificate' });
  await details.getByLabel('Reason (optional)').fill('Approved');
  await details.getByRole('button', { name: 'Sign', exact: true }).click();
  await settled(page);
  await expect(page.locator('.signature-bar')).toContainText('Signed');
  await page.getByRole('tab', { name: 'Signatures' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Signatures' })).toContainText(
    'Signed by Ada Lovelace',
  );
  // The downloaded file keeps a valid signature.
  const { verifySignatures } = await import('../../src/core/digital-signature.js');
  const reports = await verifySignatures(await downloaded(page));
  expect(reports.map((r) => r.status)).toEqual(['valid-unknown-identity']);
  expect(reports[0].reason).toBe('Approved');
  // An edit asks first, since it would invalidate the signature.
  await page.locator('.workspace').focus();
  await page.keyboard.press('ControlOrMeta+Shift+R');
  const warning = page.getByRole('dialog', { name: 'Edit a signed PDF?' });
  await expect(warning).toBeVisible();
  await warning.getByRole('button', { name: 'Cancel' }).click();
  await settled(page);
  expect((await verifySignatures(await downloaded(page))).map((r) => r.status)).toEqual([
    'valid-unknown-identity',
  ]);
});

test('Find text and redact removes the matched words from the saved file', async ({ page }) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([500, 300]);
  sheet.drawText('Employee SSN 123-45-6789 on file', { x: 40, y: 200, size: 16, font });
  sheet.drawText('Keep this line', { x: 40, y: 150, size: 16, font });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Find text and redact…' }).click();
  const finder = page.getByRole('dialog', { name: 'Find text and redact' });
  await finder.getByLabel('US Social Security numbers').check();
  await finder.getByRole('button', { name: 'Search' }).click();
  await expect(finder.getByText('Page 1: 123-45-6789')).toBeVisible();
  await finder.getByRole('button', { name: 'Mark selected' }).click();
  await settled(page);
  await expect(pane.getByText('1 mark to apply')).toBeVisible();
  await pane.getByRole('button', { name: 'Apply redactions…' }).click();
  await page
    .getByRole('dialog', { name: 'Apply redactions' })
    .getByRole('button', { name: 'Apply', exact: true })
    .click();
  await settled(page);
  const bytes = await downloaded(page);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const text = (await (await pdf.getPage(1)).getTextContent()).items
    .map((item) => item.str)
    .join(' ');
  expect(text).not.toContain('6789');
  expect(text).toContain('Employee SSN');
  expect(text).toContain('Keep this line');
});

test('Scan & OCR makes a scanned page searchable', async ({ page }) => {
  test.setTimeout(180000);
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(1700, 2200);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 1700, 2200);
  ctx.fillStyle = '#000';
  ctx.font = '64px sans-serif';
  ctx.fillText('Invoice number 4217', 200, 400);
  ctx.fillText('Payment due in thirty days', 200, 560);
  const doc = await PDFDocument.create();
  const scan = await doc.embedPng(canvas.toBuffer('image/png'));
  doc.addPage([612, 792]).drawImage(scan, { x: 0, y: 0, width: 612, height: 792 });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Scan & OCR', exact: true }).click();
  await pane.getByRole('button', { name: 'In this file…' }).click();
  await page
    .getByRole('dialog', { name: 'Recognize text' })
    .getByRole('button', { name: 'Recognize text' })
    .click();
  // Recognition takes a few seconds a page, longer on a busy machine.
  const progress = page.getByRole('dialog', { name: 'Recognizing text' });
  await expect(progress).toBeVisible();
  await expect(progress).toBeHidden({ timeout: 120000 });
  await settled(page);
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Find in PDF' }).fill('thirty');
  await expect(page.locator('.search-count')).toHaveText(/1/);
  const bytes = await downloaded(page);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const text = (await (await pdf.getPage(1)).getTextContent()).items
    .map((item) => item.str)
    .join(' ');
  expect(text).toContain('Invoice');
  expect(text).toContain('4217');
});

test('Batch process applies the same steps to several PDFs', async ({ page }) => {
  await openPdf(page, await numberedPdf(2));
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Batch process', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Batch process' });
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Add PDFs…' }).click();
  const other = await numberedPdf(3);
  await (
    await chooser
  ).setFiles({
    name: 'other.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await other.save()),
  });
  await expect(dialog.getByText('other.pdf')).toBeVisible();
  await dialog.getByLabel('Add Bates numbers').check();
  await dialog.getByLabel('Bates prefix').fill('LAW');
  await dialog.getByLabel('Rotate all pages').check();
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('Processed PDFs.zip');
  // The ZIP stores the PDFs uncompressed; read each one from its header to its end marker.
  const zip = await readFile(await download.path());
  const text = zip.toString('latin1');
  const starts = [...text.matchAll(/%PDF-/g)].map((m) => m.index);
  expect(starts).toHaveLength(2);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const labels = [];
  for (const start of starts) {
    const end = text.indexOf('%%EOF', start) + 5;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(zip.subarray(start, end)) }).promise;
    for (let i = 1; i <= pdf.numPages; i++) {
      const pdfPage = await pdf.getPage(i);
      expect(pdfPage.rotate).toBe(90);
      labels.push(
        (await pdfPage.getTextContent()).items
          .map((item) => item.str)
          .find((s) => s.startsWith('LAW')),
      );
    }
  }
  expect(labels).toEqual(['LAW000001', 'LAW000002', 'LAW000003', 'LAW000004', 'LAW000005']);
});

test('Prepare a form adds fields, edits their properties, and detects blanks', async ({ page }) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([600, 400]);
  sheet.drawText('Company: ____________________', { x: 40, y: 300, size: 14, font });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Prepare a form', exact: true }).click();
  await pane.getByRole('button', { name: 'Text field', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center' }).click();
  const dialog = page.getByRole('dialog', { name: 'Text field properties' });
  await dialog.getByLabel('Name', { exact: true }).fill('Full name');
  await dialog.getByLabel('Tooltip (read to screen reader users)').fill('Your full name');
  await dialog.getByLabel('Required').check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await settled(page);
  await expect(page.getByRole('button', { name: 'Text field Full name' })).toBeVisible();
  await pane.getByRole('button', { name: 'Detect form fields…' }).click();
  const found = page.getByRole('dialog', { name: 'Fields found' });
  await expect(found.getByText(/Text field/)).toBeVisible();
  await found.getByRole('button', { name: 'Create fields' }).click();
  await settled(page);
  const saved = await PDFDocument.load(await downloaded(page));
  const fields = saved.getForm().getFields();
  expect(fields.map((field) => field.getName())).toContain('Full name');
  expect(fields).toHaveLength(2);
  const created = saved.getForm().getTextField('Full name');
  expect(created.isRequired()).toBe(true);
});

test('Compare files shows the differences between two versions', async ({ page }) => {
  const version = async (words) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([500, 300]).drawText(words, { x: 40, y: 200, size: 16, font });
    return doc;
  };
  await openPdf(page, await version('The quick brown fox jumps'), 'old.pdf');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Compare files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Compare files' });
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose file…' }).click();
  const newer = await version('The quick red fox jumps');
  await (
    await chooser
  ).setFiles({
    name: 'new.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await newer.save()),
  });
  await dialog.getByRole('button', { name: 'Compare', exact: true }).click();
  const view = page.getByRole('region', { name: 'Compare files' });
  await expect(view).toContainText('1 change: 1 replacement');
  await expect(view).toContainText('brown');
  await view.getByRole('button', { name: 'Close compare' }).click();
  await expect(view).toBeHidden();
});

test('a PDF opens the way it asks to: page, zoom, and panel', async ({ page }) => {
  const doc = await numberedPdf(3);
  const { writeInitialView } = await import('../../src/core/initial-view.js');
  writeInitialView(doc, { page: 2, zoom: 'page', panel: 'pages' });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'view.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
  await expect(page.getByLabel('Zoom', { exact: true })).toHaveValue('page');
});

test('Document details keeps a magnification it does not list', async ({ page }) => {
  const doc = await numberedPdf(2);
  const { readInitialView, writeInitialView } = await import('../../src/core/initial-view.js');
  writeInitialView(doc, { zoom: 1.1 });
  await openPdf(page, doc);
  await page.keyboard.press('ControlOrMeta+d');
  const dialog = page.getByRole('dialog', { name: 'Document details' });
  await dialog.getByText('Initial view', { exact: true }).click();
  const magnification = dialog.getByLabel('Magnification', { exact: true });
  await expect(magnification).toHaveValue('1.1');
  await expect(magnification.locator('option:checked')).toHaveText('110%');
  // Changing only the title leaves how the PDF opens as it was.
  await dialog.getByLabel('Title', { exact: true }).fill('Renamed');
  await dialog.getByRole('button', { name: 'Save details' }).click();
  await expect(dialog).toBeHidden();
  const saved = await PDFDocument.load(await downloaded(page));
  expect(saved.getTitle()).toBe('Renamed');
  expect(readInitialView(saved).zoom).toBe(1.1);
});

test('the accessibility check finds problems and its fixes clear them', async ({ page }) => {
  await openPdf(page, await numberedPdf(2));
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Prepare for accessibility', exact: true }).click();
  await pane.getByRole('button', { name: 'Accessibility check', exact: true }).click();
  const report = page.getByRole('tabpanel', { name: 'Accessibility check' });
  const summary = report.locator('.a11y-summary');
  await expect(summary).toHaveAttribute('aria-label', /^[1-9]\d* failed/);
  const before = Number((await summary.getAttribute('aria-label')).match(/^(\d+)/)[1]);
  await pane.getByRole('button', { name: 'Autotag document', exact: true }).click();
  await settled(page);
  await pane.getByRole('button', { name: 'Set the document language…' }).click();
  await page
    .getByRole('dialog', { name: 'Document language' })
    .getByRole('button', { name: /Save|OK|Continue|Done/ })
    .click();
  await settled(page);
  await expect
    .poll(async () => Number((await summary.getAttribute('aria-label')).match(/^(\d+)/)[1]))
    .toBeLessThan(before);
  const saved = await PDFDocument.load(await downloaded(page));
  expect(saved.catalog.has((await import('pdf-lib')).PDFName.of('StructTreeRoot'))).toBe(true);
});

test('headers, footers, and watermarks can be removed again', async ({ page }) => {
  await openPdf(page, await numberedPdf(2));
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Watermark…' }).click();
  const dialog = page.getByRole('dialog', { name: /watermark/i });
  await dialog.getByRole('textbox').first().fill('DRAFT');
  await dialog.getByRole('button', { name: 'Add watermark', exact: true }).click();
  await settled(page);
  await pane.getByRole('button', { name: 'Remove watermarks', exact: true }).click();
  await settled(page);
  await expect(page.locator('#toast')).toContainText('Removed 2 watermarks');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: await downloaded(page) }).promise;
  const text = (await (await pdf.getPage(1)).getTextContent()).items.map((i) => i.str).join(' ');
  expect(text).not.toContain('DRAFT');
  expect(text).toContain('Page 1 words');
});

test('comments drawn as annotations can be added, edited, replied to, and exchanged', async ({
  page,
}) => {
  await openPdf(page, await numberedPdf(1));
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Add text comment', exact: true }).click();
  const overlay = page.locator('.drawing-overlay');
  const box = await overlay.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + 120, { steps: 5 });
  await page.mouse.up();
  const dialog = page.getByRole('dialog', { name: 'Text box' });
  await dialog.getByLabel('Text').fill('Please check this figure');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await settled(page);
  await pane.getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.mouse.move(box.x + 60, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 300, { steps: 5 });
  await page.mouse.up();
  await settled(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const target = page.getByRole('button', { name: /^Text box: Please check this figure/ });
  await target.click();
  const props = page.getByRole('complementary', { name: 'Selection properties' });
  await props.getByLabel('Review status').selectOption('Accepted');
  await settled(page);
  await props.getByLabel('Reply text').fill('Done, thanks');
  await props.getByRole('button', { name: 'Reply', exact: true }).click();
  await settled(page);
  await expect(props.getByRole('list', { name: 'Replies' })).toContainText('Done, thanks');
  const pending = page.waitForEvent('download');
  await pane.getByRole('button', { name: 'Export comments (XFDF)' }).click();
  const xfdf = await readFile(await (await pending).path(), 'utf8');
  expect(xfdf).toContain('Please check this figure');
  expect(xfdf).toContain('<square');
  const { PDFDocument: Doc } = await import('pdf-lib');
  const { importXfdf, listAnnotations } = await import('../../src/core/annotations.js');
  const other = await Doc.create();
  other.addPage([400, 500]);
  const result = await importXfdf(other, xfdf);
  expect(result.imported).toBeGreaterThanOrEqual(2);
  expect(
    listAnnotations(other, 0)
      .map((a) => a.subtype)
      .sort(),
  ).toEqual(['FreeText', 'Square']);
});

test('the Measure tool labels distances and areas at the chosen scale', async ({ page }) => {
  await openPdf(page, await numberedPdf(1, [612, 792]));
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Measure', exact: true }).click();
  await pane.getByRole('button', { name: 'Distance', exact: true }).click();
  const paper = await page.locator('.paper').boundingBox();
  const inch = paper.width / 8.5; // one inch on screen
  await page.mouse.move(paper.x + inch, paper.y + inch);
  await page.mouse.down();
  await page.mouse.move(paper.x + 3 * inch, paper.y + inch, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#toast')).toContainText(/Measured: 2\.0\d in/);
  await settled(page);
  await pane.getByRole('button', { name: 'Area', exact: true }).click();
  for (const [x, y] of [
    [1, 3],
    [3, 3],
    [3, 5],
    [1, 5],
  ])
    await page.mouse.click(paper.x + x * inch, paper.y + y * inch);
  await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toContainText(/Measured: 4\.0\d sq in/);
  await settled(page);
  const { listAnnotations } = await import('../../src/core/annotations.js');
  const saved = await PDFDocument.load(await downloaded(page));
  expect(
    listAnnotations(saved, 0)
      .map((a) => a.subtype)
      .sort(),
  ).toEqual(['FreeText', 'FreeText', 'Line', 'Polygon']);
});

test('PDF standards checks PDF/A and converts to it', async ({ page }) => {
  await openPdf(page, await numberedPdf(1));
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'PDF standards', exact: true }).click();
  await pane.getByRole('button', { name: 'Check compliance…' }).click();
  await page
    .getByRole('dialog', { name: 'Check PDF/A compliance' })
    .getByRole('button', { name: 'Check' })
    .click();
  const report = page.getByRole('dialog', { name: 'PDF/A-2b check' });
  await expect(report).toContainText(/problems? remains?/);
  await report.getByRole('button', { name: 'Close', exact: true }).click();
  await pane.getByRole('button', { name: 'Save as PDF/A…' }).click();
  await page
    .getByRole('dialog', { name: 'Save as PDF/A' })
    .getByRole('button', { name: 'Convert' })
    .click();
  const done = page.getByRole('dialog', { name: 'Saved as PDF/A-2b' });
  await expect(done).toContainText('No problems were found for this level.');
  await done.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.standards-bar')).toContainText('PDF/A-2b');
  const { preflightPdfA } = await import('../../src/core/pdfa.js');
  const bytes = await downloaded(page);
  const saved = await PDFDocument.load(bytes);
  expect(preflightPdfA(saved, { part: 2, conformance: 'b', bytes }).compliant).toBe(true);
});
