import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFHexString, PDFNull } from 'pdf-lib';

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
}
/** Give a document an outline: [{ title, page, top?, bold?, children: [...] }]. */
function addOutline(doc, tree) {
  const context = doc.context;
  const root = context.nextRef();
  const build = (items, parent) => {
    const refs = items.map(() => context.nextRef());
    items.forEach((item, i) => {
      const dict = context.obj({
        Title: PDFHexString.fromText(item.title),
        Parent: parent,
        ...(item.url
          ? { A: { S: 'URI', URI: PDFHexString.fromText(item.url) } }
          : { Dest: [doc.getPage(item.page).ref, 'XYZ', PDFNull, item.top ?? PDFNull, PDFNull] }),
      });
      if (item.bold) dict.set(PDFName.of('F'), context.obj(2));
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < refs.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
      if (item.children?.length) {
        const [first, last, count] = build(item.children, refs[i]);
        dict.set(PDFName.of('First'), first);
        dict.set(PDFName.of('Last'), last);
        dict.set(PDFName.of('Count'), context.obj(-count));
      }
      context.assign(refs[i], dict);
    });
    return [refs[0], refs.at(-1), refs.length];
  };
  const [first, last, count] = build(tree, root);
  context.assign(root, context.obj({ Type: 'Outlines', First: first, Last: last, Count: count }));
  doc.catalog.set(PDFName.of('Outlines'), root);
}
async function outlinedPdf() {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) doc.addPage([400, 400]);
  addOutline(doc, [
    { title: 'Introduction', page: 0, bold: true },
    {
      title: 'Methods',
      page: 1,
      children: [
        { title: 'Sampling', page: 2 },
        { title: 'Analysis', page: 3 },
      ],
    },
  ]);
  return doc;
}

/** Open the side panel; on a phone it closes itself whenever a page is chosen. */
async function showPanel(page) {
  if (!(await page.locator('#page-sidebar').isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel' }).click();
}

/** Choose a menu item by name from the menu bar, or from the folded phone menu. */
async function menu(page, name) {
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  const item = page.getByRole('menu').getByRole('menuitem', { name, exact: true });
  if (await bar.isVisible()) {
    for (const title of ['Page', 'File', 'Edit', 'View', 'Insert']) {
      await bar.getByRole('menuitem', { name: title, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  } else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    if (await item.count()) return item.click();
    for (const section of ['Page', 'Edit', 'View', 'Insert']) {
      await page.getByRole('menu').getByRole('menuitem', { name: section, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  }
  throw new Error(`No menu item named ${name}`);
}

test('an outlined PDF gets an Outline tab whose items jump to their pages', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await outlinedPdf());
  await showPanel(page);
  const tabs = page.getByRole('tablist', { name: 'Side panel' });
  await expect(tabs.getByRole('tab', { name: 'Pages' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'Outline' }).click();
  const tree = page.getByRole('tree', { name: 'Document outline' });
  await expect(tree).toBeVisible();
  await expect(page.locator('.thumbnails')).toBeHidden();
  const intro = tree.getByRole('treeitem', { name: 'Introduction' });
  await expect(intro).toBeEnabled();
  await expect(intro).toHaveClass(/bold/);
  await expect(intro).toHaveAttribute('aria-current', 'page');
  // Children start folded and unfold from the toggle.
  await expect(tree.getByRole('treeitem', { name: 'Sampling' })).toBeHidden();
  await tree.getByRole('button', { name: 'Expand Methods' }).click();
  await tree.getByRole('treeitem', { name: 'Analysis' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 4 of 4');
  await showPanel(page);
  await expect(tree.getByRole('treeitem', { name: 'Analysis' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(intro).not.toHaveAttribute('aria-current', 'page');
  // Arrow keys move through the visible items; Left folds a group.
  await intro.focus();
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem', { name: 'Methods' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tree.getByRole('treeitem', { name: 'Sampling' })).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem', { name: 'Sampling' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 4');
});

test('bookmarks and links bring the place they point to to the top of the view', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([400, 1400]);
  addOutline(doc, [
    { title: 'Start', page: 0 },
    { title: 'Results', page: 1, top: 300 },
  ]);
  // A link at the top of the first page to a place lower down the same page.
  doc.getPage(0).node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [40, 1340, 160, 1370],
        Dest: [doc.getPage(0).ref, 'FitH', 500],
      }),
    ),
  );
  await openPdf(page, doc);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  /** Where PDF height `y` on a page is, measured from the top of the view (scrolling rounds). */
  const fromTop = (index, y) =>
    page.evaluate(
      ({ index, y }) => {
        const slot = document
          .querySelector(`.page-slot[data-page="${index}"]`)
          .getBoundingClientRect();
        const view = document.querySelector('.workspace').getBoundingClientRect();
        return slot.top + ((1400 - y) * slot.height) / 1400 - view.top;
      },
      { index, y },
    );
  await page.getByRole('button', { name: /Link to/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Go to linked page', exact: true }).click();
  await expect.poll(async () => Math.abs(await fromTop(0, 500))).toBeLessThan(2);
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await showPanel(page);
  await page.getByRole('tab', { name: 'Outline' }).click();
  await page.getByRole('treeitem', { name: 'Results' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await expect.poll(async () => Math.abs(await fromTop(1, 300))).toBeLessThan(2);
  // A bookmark to the page alone still opens it at its top.
  await showPanel(page);
  await page.getByRole('treeitem', { name: 'Start' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await expect.poll(async () => Math.abs((await fromTop(0, 1400)) - 12)).toBeLessThan(2);
});

test('collapsing the focused outline branch keeps a visible keyboard entry point', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await outlinedPdf());
  await showPanel(page);
  await page.getByRole('tab', { name: 'Outline', exact: true }).click();
  const tree = page.getByRole('tree', { name: 'Document outline' });
  const methods = tree.getByRole('treeitem', { name: 'Methods', exact: true });
  const sampling = tree.getByRole('treeitem', { name: 'Sampling', exact: true });
  await methods.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(sampling).toBeFocused();
  await tree.getByRole('button', { name: 'Collapse Methods', exact: true }).click();
  await expect(sampling).toBeHidden();
  await expect(tree.locator('[role="treeitem"][tabindex="0"]:visible')).toHaveCount(1);
  await expect(methods).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await tree.evaluate((node) => node.contains(document.activeElement))).toBe(false);
  await page.keyboard.press('Shift+Tab');
  await expect(methods).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(sampling).toBeFocused();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 4');
});

test("a group collapsed without taking focus hands it the tree's tab stop", async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i++) doc.addPage([400, 400]);
  addOutline(doc, [
    {
      title: 'Links',
      url: 'https://example.com/',
      children: [
        { title: 'First', page: 0 },
        { title: 'Second', page: 1 },
      ],
    },
  ]);
  await openPdf(page, doc);
  await showPanel(page);
  const outlineTab = page.getByRole('tab', { name: 'Outline', exact: true });
  await outlineTab.click();
  const tree = page.getByRole('tree', { name: 'Document outline' });
  const links = tree.getByRole('treeitem', { name: /^Links/ });
  // The group starts open, since it holds the page on view.
  await expect(links).toHaveAttribute('aria-expanded', 'true');
  await tree.getByRole('treeitem', { name: 'First', exact: true }).focus();
  await outlineTab.focus();
  // Safari and Firefox on macOS do not focus a button when it is clicked.
  await links.evaluate((label) => label.click());
  await expect(tree.getByRole('treeitem', { name: 'First', exact: true })).toBeHidden();
  await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
  await expect(tree.locator('[role="treeitem"][tabindex="0"]:visible')).toHaveCount(1);
});

for (const state of ['expanded', 'collapsed', 'leaf']) {
  test(`bookmark context menus preserve the ${state} tree item's expansion semantics`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await outlinedPdf());
    await showPanel(page);
    await page.getByRole('tab', { name: 'Outline', exact: true }).click();
    const tree = page.getByRole('tree', { name: 'Document outline' });
    const item = tree.getByRole('treeitem', {
      name: state === 'leaf' ? 'Introduction' : 'Methods',
      exact: true,
    });
    await item.focus();
    if (state === 'expanded') await page.keyboard.press('ArrowRight');
    const checkState = async () => {
      if (state === 'leaf') await expect(item).not.toHaveAttribute('aria-expanded');
      else {
        await expect(item).toHaveAttribute('aria-expanded', String(state === 'expanded'));
        await expect(tree.getByRole('treeitem', { name: 'Sampling', exact: true })).toBeVisible({
          visible: state === 'expanded',
        });
      }
    };
    await checkState();
    await item.click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Bookmark', exact: true })).toBeVisible();
    await checkState();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Bookmark', exact: true })).toBeHidden();
    await checkState();
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 4');
  });
}

test('bookmarks that lead nowhere stay in the keyboard path and keep their menu', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i++) doc.addPage([400, 400]);
  addOutline(doc, [
    { title: 'Website', url: 'https://example.com/' },
    { title: 'Intro', page: 0 },
    { title: 'Site map', url: 'https://example.com/map' },
    { title: 'End', page: 1 },
  ]);
  await openPdf(page, doc);
  await showPanel(page);
  const tabs = page.getByRole('tablist', { name: 'Side panel' });
  await tabs.getByRole('tab', { name: 'Outline' }).click();
  const tree = page.getByRole('tree', { name: 'Document outline' });
  const website = tree.getByRole('treeitem', { name: /^Website/ });
  await expect(website).toHaveAttribute('aria-disabled', 'true');
  await expect(tree.getByRole('treeitem', { name: 'Intro' })).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  // Tab reaches the tree (past the panel's Close button) even though its first item points
  // nowhere, and arrows pass through such items.
  await tabs.getByRole('tab', { name: 'Outline' }).focus();
  for (let i = 0; i < 3 && !(await website.evaluate((n) => n === document.activeElement)); i++)
    await page.keyboard.press('Tab');
  await expect(website).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem', { name: 'Intro' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem', { name: /^Site map/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem', { name: 'End' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  // A dead bookmark can still be removed from its menu (Playwright counts aria-disabled as
  // not actionable, hence the forced click).
  await showPanel(page);
  await website.click({ button: 'right', force: true });
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'Remove bookmark', exact: true })
    .click();
  await expect(page.locator('#toast')).toHaveText('Bookmark removed.');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await showPanel(page);
  await tabs.getByRole('tab', { name: 'Outline' }).click();
  await expect(tree.getByRole('treeitem')).toHaveCount(3);
});

test('the View menu switches between the pages and outline panels', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await outlinedPdf());
  const view = async (name) => {
    // A folded phone menu that is still open would close from a second press on its button.
    while (await page.getByRole('menu').count()) await page.keyboard.press('Escape');
    const bar = page.getByRole('menubar', { name: 'PDF menus' });
    if (await bar.isVisible())
      await bar.getByRole('menuitem', { name: 'View', exact: true }).click();
    else {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('menu').getByRole('menuitem', { name: 'View', exact: true }).click();
    }
    return page.getByRole('menuitemcheckbox', { name, exact: true });
  };
  await (await view('Outline panel')).click();
  await expect(page.getByRole('tree', { name: 'Document outline' })).toBeVisible();
  await expect(await view('Outline panel')).toHaveAttribute('aria-checked', 'true');
  await (await view('Pages panel')).click();
  await expect(page.locator('.thumbnails')).toBeVisible();
  await expect(page.getByRole('tree', { name: 'Document outline' })).toBeHidden();
});

test('a PDF without an outline keeps the plain Pages heading', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  if (!(await page.locator('#page-sidebar').isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel' }).click();
  // Without an outline the Outline tab stays away; Pages and Comments remain.
  const tabs = page.getByRole('tablist', { name: 'Side panel' });
  await expect(tabs.getByRole('tab', { name: 'Outline', exact: true })).toBeHidden();
  await expect(tabs.getByRole('tab', { name: 'Pages', exact: true })).toBeVisible();
  await expect(tabs.getByRole('tab', { name: /Comments/ })).toBeVisible();
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  if (await bar.isVisible()) {
    await bar.getByRole('menuitem', { name: 'View', exact: true }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Outline panel' })).toBeDisabled();
  }
});

test('bookmarks can be added for the current page, renamed, and removed', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  doc.addPage([300, 300]);
  await openPdf(page, doc);
  const tabs = page.getByRole('tablist', { name: 'Side panel' });
  const bookmark = async (name) => {
    await menu(page, 'Add bookmark for this page…');
    const prompt = page.getByRole('dialog', { name: 'Add bookmark' });
    await prompt.getByLabel('Bookmark name').fill(name);
    await prompt.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.locator('#toast')).toHaveText('Bookmark added. Find it in the Outline tab.');
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  };
  await bookmark('Start');
  if (!(await tabs.isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await expect(tabs.getByRole('tab', { name: 'Outline', exact: true })).toBeVisible();
  await tabs.getByRole('tab', { name: 'Outline', exact: true }).click();
  const tree = page.getByRole('tree', { name: 'Document outline' });
  await expect(tree.getByRole('treeitem', { name: 'Start' })).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await bookmark('Second');
  if (!(await tabs.isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await tabs.getByRole('tab', { name: 'Outline', exact: true }).click();
  await expect(tree.getByRole('treeitem')).toHaveCount(2);
  await tree.getByRole('treeitem', { name: 'Start' }).click({ button: 'right' });
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'Rename bookmark…', exact: true })
    .click();
  const rename = page.getByRole('dialog', { name: 'Rename bookmark' });
  await expect(rename.getByLabel('Bookmark name')).toHaveValue('Start');
  await rename.getByLabel('Bookmark name').fill('Intro');
  await rename.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Bookmark renamed.');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  // The rebuilt tree gives the focus back to the renamed item where the panel stays open.
  const panelOpen = await tabs.isVisible();
  if (panelOpen) await expect(tree.getByRole('treeitem', { name: 'Intro' })).toBeFocused();
  else await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await tabs.getByRole('tab', { name: 'Outline', exact: true }).click();
  await expect(tree.getByRole('treeitem', { name: 'Intro' })).toBeVisible();
  await tree.getByRole('treeitem', { name: 'Second' }).click({ button: 'right' });
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'Remove bookmark', exact: true })
    .click();
  await expect(page.locator('#toast')).toHaveText('Bookmark removed.');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  // With its item gone, the focus moves to the nearest remaining bookmark.
  if (panelOpen) await expect(tree.getByRole('treeitem', { name: 'Intro' })).toBeFocused();
  else await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await tabs.getByRole('tab', { name: 'Outline', exact: true }).click();
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await tree.getByRole('treeitem', { name: 'Intro' }).click({ button: 'right' });
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'Remove bookmark', exact: true })
    .click();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  if (!(await tabs.isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await expect(tabs.getByRole('tab', { name: 'Outline', exact: true })).toBeHidden();
});

test('the side panel tabs name their panels and answer Home and End', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await outlinedPdf());
  await showPanel(page);
  const tabs = page.getByRole('tablist', { name: 'Side panel' });
  // Each tab points at the panel it opens, and each panel names its tab back.
  for (const [name, id] of [
    ['Pages', 'pages'],
    ['Outline', 'outline'],
    ['Comments', 'comments'],
  ]) {
    const tab = tabs.getByRole('tab', { name, exact: true });
    await expect(tab).toHaveAttribute('aria-controls', `sidebar-panel-${id}`);
    await expect(tab).toHaveAttribute('id', `sidebar-tab-${id}`);
    const panel = page.locator(`#sidebar-panel-${id}`);
    await expect(panel).toHaveAttribute('role', 'tabpanel');
    await expect(panel).toHaveAttribute('aria-labelledby', `sidebar-tab-${id}`);
  }
  // One landmark holds the three panels, and its name follows the tab that is open.
  await expect(page.locator('#page-sidebar')).toHaveAttribute('aria-label', 'Pages panel');
  await tabs.getByRole('tab', { name: 'Pages', exact: true }).focus();
  // Attachments is the last tab for a PDF without layers or signatures.
  await page.keyboard.press('End');
  await expect(tabs.getByRole('tab', { name: 'Attachments', exact: true })).toBeFocused();
  await expect(page.locator('#sidebar-panel-attachments')).toBeVisible();
  await expect(page.locator('#page-sidebar')).toHaveAttribute('aria-label', 'Attachments panel');
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.getByRole('tab', { name: 'Comments', exact: true })).toBeFocused();
  await expect(page.locator('#page-sidebar')).toHaveAttribute('aria-label', 'Comments panel');
  await page.keyboard.press('Home');
  await expect(tabs.getByRole('tab', { name: 'Pages', exact: true })).toBeFocused();
  await expect(page.locator('#sidebar-panel-pages')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'Outline', exact: true })).toBeFocused();
  await expect(page.getByRole('tree', { name: 'Document outline' })).toBeVisible();
  await expect(page.locator('#page-sidebar')).toHaveAttribute('aria-label', 'Outline panel');
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.getByRole('tab', { name: 'Pages', exact: true })).toBeFocused();
});

test('a PDF with more bookmarks than the tree holds says so', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) doc.addPage([300, 300]);
  addOutline(
    doc,
    Array.from({ length: 2001 }, (_, i) => ({ title: `Section ${i + 1}`, page: i % 4 })),
  );
  await openPdf(page, doc);
  await showPanel(page);
  const tabs = page.getByRole('tablist', { name: 'Side panel' });
  await tabs.getByRole('tab', { name: 'Outline', exact: true }).click();
  const tree = page.getByRole('tree', { name: 'Document outline' });
  await expect(tree.getByRole('treeitem')).toHaveCount(2000);
  await expect(page.locator('#sidebar-panel-outline')).toContainText(
    'Only the first 2,000 of 2,001 bookmarks are listed.',
  );
});

test('deleting a bookmarked page keeps its nested outline navigable through export and undo/redo', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await outlinedPdf());
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 4');
  await menu(page, 'Delete page');
  await page.getByRole('button', { name: 'Delete page', exact: true }).click();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  const checkOutline = async () => {
    await showPanel(page);
    await page.getByRole('tab', { name: 'Outline', exact: true }).click();
    const tree = page.getByRole('tree', { name: 'Document outline' });
    await expect(tree.getByRole('treeitem', { name: 'Methods', exact: true })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await tree.getByRole('treeitem', { name: 'Introduction' }).click();
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
    await showPanel(page);
    await tree.getByRole('treeitem', { name: 'Methods', exact: true }).click();
    await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  };
  await checkOutline();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 4');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await checkOutline();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await download).path()));
  const methods = saved.catalog
    .lookup(PDFName.of('Outlines'))
    .lookup(PDFName.of('First'))
    .lookup(PDFName.of('Next'));
  expect(methods.lookup(PDFName.of('Dest')).get(0)).toBe(saved.getPage(1).ref);
  expect(methods.lookup(PDFName.of('First')).lookup(PDFName.of('Dest')).get(0)).toBe(
    saved.getPage(1).ref,
  );
  expect(methods.lookup(PDFName.of('Last')).lookup(PDFName.of('Dest')).get(0)).toBe(
    saved.getPage(2).ref,
  );
  // Reopen exactly what was downloaded and follow the repaired bookmark again.
  await page.goto('/#library');
  await openPdf(page, saved);
  await checkOutline();
});

for (const fallback of [false, true])
  test(`deep bookmarks remain usable with ${fallback ? 'the main-thread fallback' : 'a real worker'}`, async ({
    page,
  }) => {
    const { addDeepOutline } = await import('../fixtures/deep-outline.js');
    if (fallback)
      await page.addInitScript(() => {
        window.Worker = class {
          constructor() {
            throw new Error('Worker unavailable for testing');
          }
        };
      });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    addDeepOutline(doc);
    await openPdf(page, doc);
    await showPanel(page);
    await page.getByRole('tab', { name: 'Outline', exact: true }).click();
    await expect(page.locator('.outline-item')).toHaveCount(2000);
    await expect(page.locator('.outline-note')).toHaveText(
      'Only the first 2,000 of 12,000 bookmarks are listed.',
    );
    const first = page.getByRole('treeitem', { name: 'Level 1', exact: true });
    await first.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('treeitem', { name: 'Level 2', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(first).toBeFocused();
    expect(errors).toEqual([]);
  });

for (const kind of ['missing', 'stale']) {
  test(`adding a bookmark preserves the imported outline with a ${kind} Last pointer`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await outlinedPdf();
    const root = doc.catalog.lookup(PDFName.of('Outlines'));
    if (kind === 'missing') root.delete(PDFName.of('Last'));
    else root.set(PDFName.of('Last'), root.get(PDFName.of('First')));
    await openPdf(page, doc);
    const check = async (added) => {
      await showPanel(page);
      await page.getByRole('tab', { name: 'Outline', exact: true }).click();
      const tree = page.getByRole('tree', { name: 'Document outline' });
      await expect(tree.getByRole('treeitem', { name: 'Introduction', exact: true })).toBeVisible();
      await expect(tree.getByRole('treeitem', { name: 'Methods', exact: true })).toBeVisible();
      await expect(tree.getByRole('treeitem', { name: 'New bookmark', exact: true })).toHaveCount(
        added ? 1 : 0,
      );
    };
    await check(false);
    await menu(page, 'Add bookmark for this page…');
    const dialog = page.getByRole('dialog', { name: 'Add bookmark' });
    await dialog.getByLabel('Bookmark name').fill('New bookmark');
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    await check(true);
    await page.getByRole('treeitem', { name: 'Methods', exact: true }).click();
    await expect(page.locator('.page-caption')).toHaveText('Page 2 of 4');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    await check(false);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    await check(true);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const saved = await PDFDocument.load(await readFile(await (await pending).path()));
    const savedRoot = saved.catalog.lookup(PDFName.of('Outlines'));
    const methods = savedRoot.lookup(PDFName.of('First')).lookup(PDFName.of('Next'));
    expect(methods.lookup(PDFName.of('Title')).decodeText()).toBe('Methods');
    expect(methods.lookup(PDFName.of('First')).lookup(PDFName.of('Title')).decodeText()).toBe(
      'Sampling',
    );
    expect(methods.lookup(PDFName.of('Next'))).toBe(savedRoot.lookup(PDFName.of('Last')));
    await page.goto('/#library');
    await openPdf(page, saved);
    await check(true);
  });
}

for (const nested of [false, true]) {
  test(`removing a bookmark with a missing Prev preserves its siblings (nested=${nested})`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([300, 300]);
    const entries = [
      { title: 'First', page: 0 },
      { title: 'Second', page: 1, children: [{ title: 'Second detail', page: 1 }] },
      { title: 'Third', page: 2 },
    ];
    addOutline(doc, nested ? [{ title: 'Parent', page: 0, children: entries }] : entries);
    const root = doc.catalog.lookup(PDFName.of('Outlines'));
    const parent = nested ? root.lookup(PDFName.of('First')) : root;
    parent.lookup(PDFName.of('First')).lookup(PDFName.of('Next')).delete(PDFName.of('Prev'));
    await openPdf(page, doc);
    const tree = page.getByRole('tree', { name: 'Document outline' });
    const check = async (removed) => {
      await showPanel(page);
      await page.getByRole('tab', { name: 'Outline', exact: true }).click();
      if (
        nested &&
        (await tree.getByRole('button', { name: 'Expand Parent', exact: true }).isVisible())
      )
        await tree.getByRole('button', { name: 'Expand Parent', exact: true }).click();
      await expect(tree.getByRole('treeitem', { name: 'First', exact: true })).toBeVisible();
      await expect(tree.getByRole('treeitem', { name: 'Third', exact: true })).toBeVisible();
      await expect(tree.getByRole('treeitem', { name: 'Second', exact: true })).toHaveCount(
        removed ? 0 : 1,
      );
    };
    await check(false);
    await tree.getByRole('treeitem', { name: 'Second', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove bookmark', exact: true }).click();
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    await check(true);
    await tree.getByRole('treeitem', { name: 'Third', exact: true }).click();
    await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    await check(false);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    await check(true);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const saved = await PDFDocument.load(await readFile(await (await pending).path()));
    const savedRoot = saved.catalog.lookup(PDFName.of('Outlines'));
    const savedParent = nested ? savedRoot.lookup(PDFName.of('First')) : savedRoot;
    const first = savedParent.lookup(PDFName.of('First'));
    expect(first.lookup(PDFName.of('Title')).decodeText()).toBe('First');
    expect(first.lookup(PDFName.of('Next')).lookup(PDFName.of('Title')).decodeText()).toBe('Third');
    expect(savedParent.lookup(PDFName.of('Last'))).toBe(first.lookup(PDFName.of('Next')));
    await page.goto('/#library');
    await openPdf(page, saved);
    await check(true);
  });
}
