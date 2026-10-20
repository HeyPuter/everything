import { test, expect } from '@playwright/test';
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { addNote } from '../../src/core/notes.js';
import { addHighlight, rectQuad } from '../../src/core/highlight.js';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
async function mockPuter(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
}
async function openPdf(page, doc) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
}
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
/** Show the side panel on phones, where it starts hidden. */
async function showSidebar(page) {
  const tabs = page.getByRole('tablist', { name: 'Side panel' });
  if (!(await page.locator('#page-sidebar').isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await expect(page.locator('#page-sidebar')).toBeVisible();
  return tabs;
}

test('the Comments tab lists notes and highlights by page and jumps to each', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([400, 400]);
  first.drawText('Highlighted words here', { x: 40, y: 300, size: 18, font });
  doc.addPage([400, 400]);
  addHighlight(doc, 0, {
    quads: [rectQuad({ x: 40, y: 294, width: 120, height: 20 })],
    hex: '#ffff00',
  });
  addNote(doc, 1, { x: 100, y: 300, text: 'Please double-check the totals', author: 'Ada' });
  await openPdf(page, doc);
  const tabs = await showSidebar(page);
  const commentsTab = tabs.getByRole('tab', { name: /Comments/ });
  await expect(commentsTab).toContainText('2');
  await commentsTab.click();
  const list = page.getByRole('group', { name: 'Comments' });
  await expect(list.getByRole('heading', { name: 'Page 1' })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Page 2' })).toBeVisible();
  // Each page has its own list, and every comment is a button in a list item.
  await expect(list.getByRole('list')).toHaveCount(2);
  await expect(list.getByRole('listitem')).toHaveCount(2);
  const items = list.getByRole('button');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAccessibleName(/Highlight on page 1/);
  await expect(items.nth(1)).toHaveAccessibleName('Note on page 2: Please double-check the totals');
  await expect(items.nth(1)).toContainText('Ada');
  // The note opens on its page.
  await items.nth(1).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await expect(page.getByLabel('Note text')).toHaveValue('Please double-check the totals');
  await page.keyboard.press('Escape');
  await settled(page);
  // The highlight gets selected on its page, with its color control.
  const tabsAgain = await showSidebar(page);
  await tabsAgain.getByRole('tab', { name: /Comments/ }).click();
  await page.getByRole('group', { name: 'Comments' }).getByRole('button').nth(0).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.getByLabel('Highlight color', { exact: true })).toHaveValue('#ffff00');
  // Deleting the highlight refreshes the list.
  await page.getByRole('button', { name: 'Delete highlight', exact: true }).click();
  await settled(page);
  const after = await showSidebar(page);
  await expect(after.getByRole('tab', { name: /Comments/ })).toContainText('1');
  await after.getByRole('tab', { name: /Comments/ }).click();
  await expect(page.getByRole('group', { name: 'Comments' }).getByRole('button')).toHaveCount(1);
  // The View menu opens the Comments panel too, and marks it while it shows.
  await page.keyboard.press('Escape');
  const viewItem = async (name) => {
    const bar = page.getByRole('menubar', { name: 'PDF menus' });
    if (await bar.isVisible())
      await bar.getByRole('menuitem', { name: 'View', exact: true }).click();
    else {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('menu').getByRole('menuitem', { name: 'View', exact: true }).click();
    }
    return page.getByRole('menu').getByRole('menuitemcheckbox', { name, exact: true });
  };
  await expect(await viewItem('Comments panel')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await (await showSidebar(page)).getByRole('tab', { name: /Pages/ }).click();
  await (await viewItem('Comments panel')).click();
  await expect(page.getByRole('tab', { name: /Comments/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('undo and redo keep keyboard focus on the updated comment', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  addNote(doc, 0, { x: 100, y: 300, text: 'Original comment' });
  await openPdf(page, doc);
  await (await showSidebar(page)).getByRole('tab', { name: /Comments/ }).click();
  const list = page.getByRole('group', { name: 'Comments', exact: true });
  await list.getByRole('button', { name: 'Note on page 1: Original comment' }).click();
  await page.getByLabel('Note text', { exact: true }).fill('Revised comment');
  await page.getByRole('button', { name: 'Close note', exact: true }).click();
  await settled(page);
  await (await showSidebar(page)).getByRole('tab', { name: /Comments/ }).click();
  await list.getByRole('button', { name: 'Note on page 1: Revised comment' }).focus();
  for (const [shortcut, text] of [
    ['ControlOrMeta+z', 'Original comment'],
    ['ControlOrMeta+Shift+z', 'Revised comment'],
  ]) {
    await page.keyboard.press(shortcut);
    const item = list.getByRole('button', { name: `Note on page 1: ${text}`, exact: true });
    await expect(item).toBeVisible();
    await settled(page);
    await expect(item).toBeFocused();
  }
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Note text', { exact: true })).toHaveValue('Revised comment');
});

test('a PDF without comments says so, and the tabs cycle with the arrow keys', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  const tabs = await showSidebar(page);
  await expect(tabs.getByRole('tab', { name: 'Outline', exact: true })).toBeHidden();
  const pagesTab = tabs.getByRole('tab', { name: 'Pages', exact: true });
  await pagesTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: /Comments/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('No comments yet.')).toBeVisible();
  // Attachments follows Comments in the rail; the next step wraps around to Pages.
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'Attachments' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowRight');
  await expect(pagesTab).toHaveAttribute('aria-selected', 'true');
});

test('a PDF with more comments than the list holds says so', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const total = 2001;
  for (let made = 0; made < total;) {
    const sheet = doc.addPage([300, 300]);
    for (let i = 0; i < 100 && made < total; i++, made++)
      sheet.node.addAnnot(
        doc.context.register(
          doc.context.obj({
            Type: 'Annot',
            Subtype: 'Square',
            Rect: [10, 10, 20, 20],
            Contents: PDFHexString.fromText(`Remark ${made + 1}`),
          }),
        ),
      );
  }
  await openPdf(page, doc);
  const tabs = await showSidebar(page);
  const tab = tabs.getByRole('tab', { name: /Comments/ });
  // The count is not claimed exactly when the scan stopped early.
  await expect(tab).toHaveAttribute('aria-label', 'Comments (2,000 or more)');
  await tab.click();
  const panel = page.locator('#sidebar-panel-comments');
  await expect(panel.getByRole('button')).toHaveCount(2000);
  await expect(panel).toContainText('Only the first 2,000 comments are listed.');
});

test('invalid modification dates do not invent timestamps in the comments list or note editor', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  addNote(doc, 0, { x: 100, y: 300, text: 'Check this date', author: 'Ada' });
  const note = doc.context.lookup(sheet.node.Annots().get(0));
  note.set(PDFName.of('M'), PDFString.of('D:20260230120000Z'));
  note.set(PDFName.of('CreationDate'), PDFString.of('D:20260101120000Z'));
  await openPdf(page, doc);
  await (await showSidebar(page)).getByRole('tab', { name: /Comments/ }).click();
  const item = page.getByRole('group', { name: 'Comments' }).getByRole('button');
  const created = await page.evaluate(() =>
    new Date('2026-01-01T12:00:00Z').toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
  );
  await expect(item).toContainText(created);
  await item.click();
  await expect(page.getByRole('group', { name: 'Edit note' }).locator('.note-meta')).toHaveText(
    'Ada',
  );
});

test('a locked highlight chosen in the Comments tab opens its page without edit controls', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  doc.addPage([400, 400]);
  addHighlight(doc, 1, {
    quads: [rectQuad({ x: 40, y: 294, width: 120, height: 20 })],
    hex: '#ffff00',
  });
  // ReadOnly: the markup may be shown but not changed.
  doc
    .getPage(1)
    .node.Annots()
    .lookup(0)
    .set(PDFName.of('F'), doc.context.obj(4 | 64));
  await openPdf(page, doc);
  const tabs = await showSidebar(page);
  await tabs.getByRole('tab', { name: /Comments/ }).click();
  await page.getByRole('group', { name: 'Comments' }).getByRole('button').first().click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await settled(page);
  await page.waitForTimeout(500);
  await expect(page.getByLabel('Highlight color', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete highlight', exact: true })).toHaveCount(0);
});

test('a comment chosen in the Comments tab is brought into view on its page', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 1400]);
  doc.addPage([400, 1400]).drawText('Words near the end', { x: 40, y: 60, size: 18, font });
  addHighlight(doc, 1, {
    quads: [rectQuad({ x: 40, y: 54, width: 160, height: 20 })],
    hex: '#ffff00',
  });
  addNote(doc, 1, { x: 300, y: 40, text: 'Last remark', author: 'Ada' });
  await openPdf(page, doc);
  const tabs = await showSidebar(page);
  await tabs.getByRole('tab', { name: /Comments/ }).click();
  const list = page.getByRole('group', { name: 'Comments' });
  const workspace = page.locator('.workspace');
  const inView = async (locator) => {
    const [box, view] = await Promise.all([locator.boundingBox(), workspace.boundingBox()]);
    return !!box && box.y >= view.y && box.y + box.height <= view.y + view.height;
  };
  await list.getByRole('button', { name: /^Highlight on page 2/ }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await settled(page);
  const highlight = page.locator('.highlight-target').first();
  await expect.poll(() => inView(highlight)).toBe(true);
  // The page stays current while the highlight is selected, though it is scrolled away.
  await workspace.evaluate((node) => (node.scrollTop = 0));
  // A narrow panel closed over the page when the highlight was chosen.
  await showSidebar(page);
  await list.getByRole('button', { name: /^Note on page 2/ }).click();
  await expect(page.getByRole('textbox', { name: 'Note text', exact: true })).toHaveValue(
    'Last remark',
  );
  await expect.poll(() => inView(page.locator('.note-target').first())).toBe(true);
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
});

test.describe('narrow side panel', () => {
  test.use({ viewport: { width: 390, height: 800 } });
  test('choosing a page or a comment by keyboard hands focus to what it opens', async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([400, 400]);
    addNote(doc, 2, { x: 100, y: 300, text: 'Check this page', author: 'Ada' });
    await openPdf(page, doc);
    const view = page.getByRole('region', { name: 'PDF page view' });
    let tabs = await showSidebar(page);
    await page.getByRole('button', { name: 'Go to page 2', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
    // The narrow panel overlays the page, so choosing a page closes it.
    await expect(page.locator('#page-sidebar')).toBeHidden();
    await expect(view).toBeFocused();
    tabs = await showSidebar(page);
    await tabs.getByRole('tab', { name: /Comments/ }).click();
    await page.getByRole('group', { name: 'Comments' }).getByRole('button').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
    await expect(page.getByLabel('Note text')).toBeFocused();
  });
});
