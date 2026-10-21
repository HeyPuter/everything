import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts } from 'pdf-lib';
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

test('in a short window the quick tools scroll within the page area', async ({ page }) => {
  // A phone turned sideways, or a laptop window zoomed in.
  await page.setViewportSize({ width: 844, height: 390 });
  await openPdf(page, await numberedPdf(2));
  const toolbar = page.getByRole('toolbar', { name: 'PDF tools' });
  await toolbar.getByRole('button', { name: 'Select', exact: true }).focus();
  await page.keyboard.press('End');
  const last = toolbar.getByRole('button', { name: 'Fill forms', exact: true });
  await expect(last).toBeFocused();
  const [area, tools, button] = await Promise.all([
    page.locator('.document-view').boundingBox(),
    toolbar.boundingBox(),
    last.boundingBox(),
  ]);
  // The column ends inside the page area, and reaching its last tool leaves the bars in place.
  expect(tools.y + tools.height).toBeLessThanOrEqual(area.y + area.height);
  expect(button.y + button.height).toBeLessThanOrEqual(area.y + area.height);
  expect(await page.locator('.editor').evaluate((node) => node.scrollTop)).toBe(0);
  await expect(page.getByRole('menubar', { name: 'PDF menus' })).toBeInViewport();
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

for (const display of ['Scrolling', 'Single page'])
  test(`${display}: a page left behind by a jump lets its picture go`, async ({ page }) => {
    await openPdf(page, await numberedPdf(24));
    if (display !== 'Scrolling') {
      await page.getByRole('menuitem', { name: 'View', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Page display' }).click();
      await page.getByRole('menuitemcheckbox', { name: display, exact: true }).click();
      await settled(page);
    }
    // Pictures far from the view, or of pages not shown, hold no pixels.
    const held = () =>
      page.evaluate(() => {
        const view = document.querySelector('.workspace').getBoundingClientRect();
        return [...document.querySelectorAll('.page-slot:not(:has(.paper))')]
          .filter((slot) => {
            const box = slot.getBoundingClientRect();
            const far =
              box.bottom < view.top - 3 * view.height || box.top > view.bottom + 3 * view.height;
            const image = slot.querySelector('.page-image');
            return (slot.hidden || far) && image.width * image.height > 300 * 150;
          })
          .map((slot) => slot.dataset.page);
      });
    for (const number of ['24', '1', '12']) {
      await page.getByLabel('Page number').fill(number);
      await page.getByLabel('Page number').press('Enter');
      await expect(page.locator('.page-caption')).toHaveText(`Page ${number} of 24`);
      await settled(page);
    }
    await page.waitForTimeout(300);
    expect(await held()).toEqual([]);
    await page.evaluate(() => localStorage.removeItem('pdf-editor:page-display'));
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

for (const display of ['Two-page', 'Two-page scrolling'])
  test(`${display} turns a pair of pages at a time`, async ({ page }) => {
    await openPdf(page, await numberedPdf(5));
    await page.getByRole('menuitem', { name: 'View', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Page display' }).click();
    await page.getByRole('menuitemcheckbox', { name: display, exact: true }).click();
    await expect(page.locator('.page-stack')).toHaveClass(/two-up/);
    await settled(page);
    const caption = page.locator('.page-caption');
    const atTop = (index) =>
      page.evaluate((index) => {
        const slot = document.querySelector(`.page-slot[data-page="${index}"]`);
        const top =
          slot.getBoundingClientRect().top -
          document.querySelector('.workspace').getBoundingClientRect().top;
        return !slot.hidden && top >= 0 && top < 40;
      }, index);
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(caption).toHaveText('Page 3 of 5');
    await expect.poll(() => atTop(2)).toBe(true);
    await page.keyboard.press('Alt+ArrowRight');
    await expect(caption).toHaveText('Page 5 of 5');
    await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
    // From the right-hand page of a pair, back is the pair before.
    await page.getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(caption).toHaveText('Page 3 of 5');
    const right = await page.locator('.page-slot[data-page="3"]').boundingBox();
    await page.mouse.click(right.x + 50, right.y + 50);
    await expect(caption).toHaveText('Page 4 of 5');
    await settled(page);
    await page.getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(caption).toHaveText('Page 1 of 5');
    await expect.poll(() => atTop(0)).toBe(true);
    await page.evaluate(() => localStorage.removeItem('pdf-editor:page-display'));
  });

test('in two-page view, Next and Previous stop at the first and last pair', async ({ page }) => {
  await openPdf(page, await numberedPdf(4));
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Page display' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Two-page', exact: true }).click();
  await settled(page);
  const caption = page.locator('.page-caption');
  const next = page.getByRole('button', { name: 'Next page', exact: true });
  const previous = page.getByRole('button', { name: 'Previous page', exact: true });
  await next.click();
  await expect(caption).toHaveText('Page 3 of 4');
  await settled(page);
  // Page 4 is already in view beside page 3; there is no pair to turn to.
  await expect(next).toBeDisabled();
  await page.keyboard.press('Alt+ArrowRight');
  await page.waitForTimeout(300);
  await expect(caption).toHaveText('Page 3 of 4');
  await previous.click();
  await expect(caption).toHaveText('Page 1 of 4');
  await settled(page);
  const right = await page.locator('.page-slot[data-page="1"]').boundingBox();
  await page.mouse.click(right.x + 50, right.y + 50);
  await expect(caption).toHaveText('Page 2 of 4');
  await settled(page);
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await page.evaluate(() => localStorage.removeItem('pdf-editor:page-display'));
});

test('Read out loud speaks a long page in short pieces and says when a page has no text', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([600, 800]);
  const lines = Array.from(
    { length: 30 },
    (_, i) => `Line ${i + 1} of the long page is read aloud.`,
  );
  lines.forEach((line, i) => sheet.drawText(line, { x: 40, y: 760 - i * 22, size: 14, font }));
  doc.addPage([600, 800]);
  await openPdf(page, doc);
  // A recorder stands in for the browser's voices and finishes each utterance at once.
  await page.evaluate(() => {
    window.spoken = [];
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        paused: false,
        speak(utterance) {
          window.spoken.push(utterance.text);
          setTimeout(() => utterance.onend?.(), 0);
        },
        cancel() {},
      },
    });
  });
  const read = async () => {
    await page.getByRole('menuitem', { name: 'View', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Read out loud' }).click();
    await page.getByRole('menuitem', { name: 'Read this page', exact: true }).click();
  };
  await read();
  await expect.poll(() => page.evaluate(() => window.spoken.length)).toBeGreaterThan(3);
  const spoken = await page.evaluate(() => window.spoken);
  expect(spoken.every((text) => text.length <= 200)).toBe(true);
  expect(spoken.join(' ')).toBe(lines.join(' '));
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await settled(page);
  await read();
  await expect(page.locator('#toast')).toContainText('This page has no text to read');
  expect(await page.evaluate(() => window.spoken.length)).toBe(spoken.length);
});

test('Read out loud speaks a PDF in the language it is written in', async ({ page }) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([600, 800]).drawText('Bonjour tout le monde.', { x: 40, y: 700, size: 14, font });
  doc.catalog.set(PDFName.of('Lang'), PDFString.of('fr-FR'));
  await openPdf(page, doc);
  await page.evaluate(() => {
    window.spoken = [];
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        paused: false,
        speak(utterance) {
          window.spoken.push({ text: utterance.text, lang: utterance.lang });
          setTimeout(() => utterance.onend?.(), 0);
        },
        cancel() {},
      },
    });
  });
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Read out loud' }).click();
  await page.getByRole('menuitem', { name: 'Read this page', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.spoken))
    .toEqual([{ text: 'Bonjour tout le monde.', lang: 'fr-FR' }]);
});

test('Read out loud joins a word hyphenated at the end of a line', async ({ page }) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([600, 800]);
  ['Here is an exam-', 'ple of a well-', 'Known word.'].forEach((line, i) =>
    sheet.drawText(line, { x: 40, y: 700 - i * 20, size: 14, font }),
  );
  await openPdf(page, doc);
  await page.evaluate(() => {
    window.spoken = [];
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        paused: false,
        speak(utterance) {
          window.spoken.push(utterance.text);
          setTimeout(() => utterance.onend?.(), 0);
        },
        cancel() {},
      },
    });
  });
  await page.getByRole('menuitem', { name: 'View', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Read out loud' }).click();
  await page.getByRole('menuitem', { name: 'Read this page', exact: true }).click();
  // A capital after the hyphen is a hyphenated name or compound, which keeps its hyphen.
  await expect
    .poll(() => page.evaluate(() => window.spoken.join(' ')))
    .toBe('Here is an example of a well- Known word.');
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

test('Organize pages keeps the duplicated pages selected', async ({ page }) => {
  await openPdf(page, await numberedPdf(5));
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  await grid.getByRole('option', { name: 'Page 2', exact: true }).click();
  await grid
    .getByRole('option', { name: 'Page 4', exact: true })
    .click({ modifiers: ['ControlOrMeta'] });
  const toolbar = page.getByRole('toolbar', { name: 'Organize pages' });
  await toolbar.getByRole('button', { name: 'Duplicate pages', exact: true }).click();
  await settled(page);
  await expect(grid.getByRole('option')).toHaveCount(7);
  // The original page 4 now comes after the copy of page 2.
  await expect(grid.locator('[aria-selected="true"]')).toHaveText(['2', '5']);
  await toolbar.getByRole('button', { name: 'Rotate clockwise', exact: true }).click();
  await settled(page);
  const doc = await PDFDocument.load(await downloaded(page));
  expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90, 0, 0, 90, 0, 0]);
});

test('Organize pages drops a page dragged into the gap between two pages there', async ({
  page,
}) => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 6; i++) doc.addPage([400 + i, 500]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  const tile = (n) => grid.getByRole('option', { name: `Page ${n}`, exact: true });
  const [second, third, area] = await Promise.all([
    tile(2).boundingBox(),
    tile(3).boundingBox(),
    grid.boundingBox(),
  ]);
  expect(third.y).toBe(second.y);
  // The narrow space between pages 2 and 3 belongs to neither tile.
  await tile(1).dragTo(grid, {
    targetPosition: {
      x: (second.x + second.width + third.x) / 2 - area.x,
      y: second.y + second.height / 2 - area.y,
    },
  });
  await settled(page);
  const saved = await PDFDocument.load(await downloaded(page));
  expect(saved.getPages().map((p) => p.getWidth())).toEqual([401, 400, 402, 403, 404, 405]);
});

test('batch text recognition lets each PDF go before reading the next', async ({ page }) => {
  // Count the documents PDF.js holds open: each GetDocRequest opens one, Terminate closes it.
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    window.__pdfDocs = { open: 0, most: 0 };
    Worker.prototype.postMessage = function (message, ...rest) {
      const docs = window.__pdfDocs;
      if (message?.action === 'GetDocRequest') docs.most = Math.max(docs.most, ++docs.open);
      if (message?.action === 'Terminate') docs.open--;
      return post.call(this, message, ...rest);
    };
  });
  await openPdf(page, await numberedPdf(1));
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Batch process', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Batch process' });
  const files = [];
  for (let i = 0; i < 4; i++) {
    // Pages that already have text, so recognition reads them and skips them.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([400, 500]).drawText(`File ${i} has plenty of words on its page already`, {
      x: 20,
      y: 200,
      size: 12,
      font,
    });
    files.push({
      name: `file ${i}.pdf`,
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
  }
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Add PDFs…' }).click();
  await (await chooser).setFiles(files);
  await expect(dialog.getByText('file 3.pdf')).toBeVisible();
  await page.evaluate(() => {
    window.__pdfDocs.most = window.__pdfDocs.open;
  });
  const before = await page.evaluate(() => window.__pdfDocs.open);
  await dialog.getByLabel('Recognize text (OCR)').check();
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  await pending;
  await expect(dialog).toBeHidden();
  const docs = await page.evaluate(() => window.__pdfDocs);
  // At most one batch file is open beside what the editor already had open.
  expect(docs.most - before).toBeLessThanOrEqual(1);
  await expect.poll(() => page.evaluate(() => window.__pdfDocs.open)).toBe(before);
});

for (const [languages, expected] of [
  [['de-DE', 'de-DE'], 'de-DE'],
  [['de-DE', 'fr-FR'], null],
])
  test(`Combine files keeps a language all the files share (${languages})`, async ({ page }) => {
    const pdfIn = async (lang, count) => {
      const doc = await numberedPdf(count);
      doc.catalog.set(PDFName.of('Lang'), PDFString.of(lang));
      return doc;
    };
    await openPdf(page, await pdfIn(languages[0], 1));
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page
      .getByRole('complementary', { name: 'Tools' })
      .getByRole('button', { name: 'Combine files', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Combine files' });
    const chooser = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: /Add files/ }).click();
    const other = await pdfIn(languages[1], 2);
    await (
      await chooser
    ).setFiles({
      name: 'other.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await other.save()),
    });
    await expect(dialog.getByText('other.pdf')).toBeVisible();
    await dialog.getByRole('button', { name: 'Combine', exact: true }).click();
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
    await settled(page);
    const combined = await PDFDocument.load(await downloaded(page));
    expect(combined.catalog.lookup(PDFName.of('Lang'))?.decodeText() ?? null).toBe(expected);
  });

test('the Combine files list keeps the keyboard focus on the button that was pressed', async ({
  page,
}) => {
  await openPdf(page, await numberedPdf(1));
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Combine files', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Combine files' });
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: /Add files/ }).click();
  const files = [];
  for (const [name, count] of [
    ['a.pdf', 1],
    ['b.pdf', 2],
    ['c.pdf', 3],
  ])
    files.push({
      name,
      mimeType: 'application/pdf',
      buffer: Buffer.from(await (await numberedPdf(count)).save()),
    });
  await (await chooser).setFiles(files);
  const rows = dialog.locator('.combine-name');
  await expect(rows).toHaveText(['a.pdf', 'b.pdf', 'c.pdf']);
  // Down twice takes a.pdf to the end; at the end, the focus moves to its other move button.
  await dialog.getByRole('button', { name: 'Move a.pdf down' }).focus();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveText(['b.pdf', 'a.pdf', 'c.pdf']);
  await expect(dialog.getByRole('button', { name: 'Move a.pdf down' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveText(['b.pdf', 'c.pdf', 'a.pdf']);
  await expect(dialog.getByRole('button', { name: 'Move a.pdf up' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Move c.pdf up' }).focus();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveText(['c.pdf', 'b.pdf', 'a.pdf']);
  await expect(dialog.getByRole('button', { name: 'Move c.pdf down' })).toBeFocused();
  // Removing a file hands the focus to the file that takes its place, or the one before it.
  await dialog.getByRole('button', { name: 'Remove b.pdf' }).focus();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveText(['c.pdf', 'a.pdf']);
  await expect(dialog.getByRole('button', { name: 'Remove a.pdf' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Remove c.pdf' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Add files/ })).toBeFocused();
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

test('the Signatures panel leaves out the revision of a signature it cannot place', async ({
  page,
}) => {
  const { createSelfSignedId, signPdf } = await import('../../src/core/digital-signature.js');
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const signed = await signPdf(await doc.save(), await createSelfSignedId({ name: 'Ada' }), {});
  // A byte range that does not start at the beginning of the file covers no revision.
  const text = Buffer.from(signed).toString('latin1');
  const at = text.indexOf('/ByteRange [0 ') + '/ByteRange ['.length;
  signed[at] = '1'.charCodeAt(0);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'signed.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(signed),
  });
  await settled(page);
  await page.getByRole('tab', { name: 'Signatures' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Signatures' });
  await expect(panel).toContainText('does not start at the beginning of the file');
  await expect(panel.locator('dt')).not.toContainText(['Revision']);
  await expect(panel.locator('dd')).not.toContainText(['null']);
});

/** Sign the open PDF with a new digital ID; the tools pane is left on the certificate tool. */
async function signWithNewId(page) {
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
  await chooser.getByRole('button', { name: 'Continue' }).click();
  await page
    .getByRole('dialog', { name: 'Sign with a certificate' })
    .getByRole('button', { name: 'Sign', exact: true })
    .click();
  await settled(page);
  await expect(page.locator('.signature-bar')).toContainText('Signed');
  return pane;
}

test('declining to edit a signed PDF does not report that it has no watermarks', async ({
  page,
}) => {
  await openPdf(page, await numberedPdf(1));
  const pane = await signWithNewId(page);
  await pane.getByRole('button', { name: 'Back to all tools' }).click();
  await pane.getByRole('button', { name: 'Edit a PDF', exact: true }).click();
  await page.locator('#toast').evaluate((node) => (node.textContent = ''));
  await pane.getByRole('button', { name: 'Remove watermarks', exact: true }).click();
  const warning = page.getByRole('dialog', { name: 'Edit a signed PDF?' });
  await warning.getByRole('button', { name: 'Cancel' }).click();
  await settled(page);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  await expect(page.locator('#toast')).not.toContainText('no watermarks');
});

test('declining to edit a signed PDF does not report that its page is not cropped', async ({
  page,
}) => {
  await openPdf(page, await numberedPdf(1));
  await signWithNewId(page);
  await page.locator('#toast').evaluate((node) => (node.textContent = ''));
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  await bar.getByRole('menuitem', { name: 'Page', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove crop', exact: true }).click();
  const warning = page.getByRole('dialog', { name: 'Edit a signed PDF?' });
  await warning.getByRole('button', { name: 'Cancel' }).click();
  await settled(page);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  await expect(page.locator('#toast')).not.toContainText('not cropped');
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
  const confirm = page.getByRole('dialog', { name: 'Apply redactions' });
  await expect(confirm).toContainText(
    'A form field under a mark is removed everywhere it appears.',
  );
  await confirm.getByRole('button', { name: 'Apply', exact: true }).click();
  await settled(page);
  // Nothing unusual happened, so a brief message is enough.
  await expect(page.locator('#toast')).toContainText('Redactions applied');
  await expect(page.getByRole('dialog', { name: 'Check the redacted PDF' })).toHaveCount(0);
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

test('Redact pages removes what a cropped page hides outside its crop box', async ({ page }) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([500, 500]);
  sheet.drawText('Shown on the page', { x: 20, y: 100, size: 16, font });
  sheet.drawText('Cropped away', { x: 300, y: 400, size: 16, font });
  sheet.setCropBox(0, 0, 250, 250);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Redact pages…' }).click();
  await page
    .getByRole('dialog', { name: 'Redact pages' })
    .getByRole('button', { name: 'Mark pages' })
    .click();
  await settled(page);
  await pane.getByRole('button', { name: 'Apply redactions…' }).click();
  await page
    .getByRole('dialog', { name: 'Apply redactions' })
    .getByRole('button', { name: 'Apply', exact: true })
    .click();
  await settled(page);
  // Uncropped, the page shows nothing that was on it.
  const redacted = await PDFDocument.load(await downloaded(page));
  const { width, height } = redacted.getPage(0).getMediaBox();
  redacted.getPage(0).setCropBox(0, 0, width, height);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: await redacted.save() }).promise;
  const { items } = await (await pdf.getPage(1)).getTextContent();
  expect(items.map((item) => item.str).join('')).toBe('');
});

test('Find text and redact says which pages hold text it cannot search', async ({ page }) => {
  // Page 2 draws its words with a font that does not say which characters its glyphs are.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 300]).drawText('Searchable words', { x: 40, y: 200, size: 16, font });
  const sheet = doc.addPage([400, 300]);
  const glyph = doc.context.register(doc.context.stream('500 0 d0 0 0 400 700 re f'));
  const shapes = doc.context.obj({
    Type: 'Font',
    Subtype: 'Type3',
    FontBBox: [0, 0, 500, 700],
    FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    CharProcs: { g1: glyph },
    Encoding: { Type: 'Encoding', Differences: [65, PDFName.of('g1')] },
    FirstChar: 65,
    LastChar: 65,
    Widths: [500],
  });
  sheet.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T3: shapes } }));
  sheet.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.stream('BT /T3 20 Tf 40 200 Td (AAAA) Tj ET')),
  );
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Redact a PDF', exact: true }).click();
  await pane.getByRole('button', { name: 'Find text and redact…' }).click();
  const finder = page.getByRole('dialog', { name: 'Find text and redact' });
  await finder.getByLabel('Find text').fill('secret');
  await finder.getByRole('button', { name: 'Search' }).click();
  await expect(finder.getByRole('status')).toHaveText(
    'No matches found. Some text on page 2 cannot be searched. Check it by eye.',
  );
  await finder.getByLabel('Find text').fill('words');
  await finder.getByRole('button', { name: 'Search' }).click();
  await expect(finder.getByRole('status')).toHaveText(
    '1 match found. Choose the ones to mark. Some text on page 2 cannot be searched. Check it by eye.',
  );
});

test('redaction lists what it could not handle before the file is shared', async ({ page }) => {
  // A transparency effect under the mark whose drawing cannot be read stays as it was.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([500, 300]);
  const group = doc.context.register(
    doc.context.stream(new Uint8Array([1, 2, 3, 4]), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 500, 300],
      Group: { S: 'Transparency', CS: 'DeviceGray' },
      Filter: 'JBIG2Decode',
    }),
  );
  sheet.node.set(
    PDFName.of('Resources'),
    doc.context.obj({
      ExtGState: { Faded: { Type: 'ExtGState', SMask: { S: 'Luminosity', G: group } } },
    }),
  );
  sheet.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.stream('q /Faded gs 30 180 400 50 re f Q')),
  );
  sheet.drawText('Employee SSN 123-45-6789 on file', { x: 40, y: 200, size: 16, font });
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
  await pane.getByRole('button', { name: 'Apply redactions…' }).click();
  await page
    .getByRole('dialog', { name: 'Apply redactions' })
    .getByRole('button', { name: 'Apply', exact: true })
    .click();
  // The notice stays until it is read and dismissed.
  const notice = page.getByRole('dialog', { name: 'Check the redacted PDF' });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Redactions applied');
  await expect(notice.getByRole('listitem')).toHaveText([
    /A transparency effect under a mark could not be read/,
  ]);
  await page.waitForTimeout(6000);
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('button', { name: 'OK' })).toBeFocused();
  await notice.getByRole('button', { name: 'OK' }).click();
  await expect(notice).toHaveCount(0);
  await settled(page);
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

test('Scan & OCR skips a page with text whatever its unit size', async ({ page }) => {
  test.setTimeout(180000);
  // A large-format page written in two-point units: a short heading still covers enough of
  // the page to count as text, measured in the units the text is measured in.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const sheet = doc.addPage([306, 396]);
  sheet.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
  sheet.drawText('PLAN', { x: 40, y: 200, size: 40, font });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Scan & OCR', exact: true }).click();
  await pane.getByRole('button', { name: 'In this file…' }).click();
  await page
    .getByRole('dialog', { name: 'Recognize text' })
    .getByRole('button', { name: 'Recognize text' })
    .click();
  await expect(page.getByText('These pages already have text', { exact: false })).toBeVisible({
    timeout: 120000,
  });
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

test('Batch process stays open, with its files, until it has files and steps', async ({ page }) => {
  await openPdf(page, await numberedPdf(1));
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Batch process', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Batch process' });
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Add PDFs…' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'other.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await (await numberedPdf(2)).save()),
  });
  await expect(dialog.getByText('other.pdf')).toBeVisible();
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(dialog.locator('.dialog-error')).toHaveText('Choose at least one step.');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('other.pdf')).toBeVisible();
  await dialog.getByLabel('Rotate all pages').check();
  await dialog.getByLabel('Include test.pdf').uncheck();
  await dialog.getByRole('button', { name: 'Remove other.pdf' }).click();
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(dialog.locator('.dialog-error')).toHaveText('Add at least one PDF.');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Rotate all pages')).toBeChecked();
});

test('removing a file from Batch process keeps the keyboard focus in the dialog', async ({
  page,
}) => {
  await openPdf(page, await numberedPdf(1));
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).click();
  await pane.getByRole('button', { name: 'Batch process', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Batch process' });
  const chooser = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Add PDFs…' }).click();
  const files = [];
  for (const name of ['a.pdf', 'b.pdf'])
    files.push({
      name,
      mimeType: 'application/pdf',
      buffer: Buffer.from(await (await numberedPdf(1)).save()),
    });
  await (await chooser).setFiles(files);
  await dialog.getByRole('button', { name: 'Remove a.pdf' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Remove b.pdf' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Remove b.pdf' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Add PDFs…' })).toBeFocused();
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

for (const [asked, shown] of [
  [20, '4'],
  [0.05, '0.25'],
])
  test(`a PDF that asks to open at ${asked * 100}% opens within the zoom range`, async ({
    page,
  }) => {
    const doc = await numberedPdf(2);
    const { writeInitialView } = await import('../../src/core/initial-view.js');
    writeInitialView(doc, { zoom: asked });
    await openPdf(page, doc);
    const zoom = page.getByLabel('Zoom', { exact: true });
    await expect(zoom).toHaveValue(shown);
    await expect(page.locator('.paper')).toHaveCSS('width', `${400 * Number(shown)}px`);
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

test('View more and View less keep the keyboard focus in the tools pane', async ({ page }) => {
  await openPdf(page, await numberedPdf(1));
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'View more' }).focus();
  await page.keyboard.press('Enter');
  await expect(pane.getByRole('button', { name: 'Export a PDF', exact: true })).toBeFocused();
  await pane.getByRole('button', { name: 'View less' }).focus();
  await page.keyboard.press('Enter');
  await expect(pane.getByRole('button', { name: 'View more' })).toBeFocused();
});

test('an edit made by shortcut leaves the focus on View more', async ({ page }) => {
  await openPdf(page, await numberedPdf(1));
  const more = page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'View more' });
  await more.focus();
  // The pane redraws for the edit; the button it held the focus on is drawn again too.
  await page.keyboard.press('ControlOrMeta+Shift+R');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await settled(page);
  await expect(more).toBeFocused();
});

test('a command chosen from the keyboard in the tools pane keeps the focus through its edit', async ({
  page,
}) => {
  await openPdf(page, await numberedPdf(3));
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Organize pages', exact: true }).click();
  const rotate = pane.getByRole('button', { name: 'Rotate clockwise', exact: true });
  await rotate.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await settled(page);
  // The command is disabled while the edit runs; once it is done the focus is back on it.
  await expect(rotate).toBeFocused();
  await page.keyboard.press('Enter');
  await settled(page);
  await expect(rotate).toBeFocused();
});

test('Undo pressed from the keyboard keeps the focus for the next press', async ({ page }) => {
  await openPdf(page, await numberedPdf(2));
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('ControlOrMeta+Shift+R');
    await expect(undo).toBeEnabled();
    await settled(page);
  }
  await undo.focus();
  await page.keyboard.press('Enter');
  await settled(page);
  // Disabled while the PDF changed, the button takes the focus back once it is usable again.
  await expect(undo).toBeEnabled();
  await expect(undo).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(undo).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
});

test('removing an attachment hands the focus to the file that takes its place', async ({
  page,
}) => {
  await openPdf(page, await numberedPdf(1));
  await page.getByRole('tab', { name: 'Attachments' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Attachments' });
  for (const name of ['first.txt', 'second.txt']) {
    const chooser = page.waitForEvent('filechooser');
    await panel.getByRole('button', { name: 'Attach a file…' }).click();
    await (await chooser).setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(name) });
    await expect(panel.getByText(name)).toBeVisible();
    await settled(page);
  }
  await panel.getByRole('button', { name: 'Remove first.txt' }).focus();
  await page.keyboard.press('Enter');
  await page
    .getByRole('dialog', { name: 'Remove attachment?' })
    .getByRole('button', { name: 'Remove', exact: true })
    .press('Enter');
  await expect(panel.getByText('first.txt')).toBeHidden();
  await expect(panel.getByRole('button', { name: 'Remove second.txt' })).toBeFocused();
  // Any later change redraws the list too, and the focused button is drawn again.
  await panel.getByRole('button', { name: 'Save second.txt' }).focus();
  await page.keyboard.press('ControlOrMeta+Shift+R');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await settled(page);
  await expect(panel.getByRole('button', { name: 'Save second.txt' })).toBeFocused();
});
