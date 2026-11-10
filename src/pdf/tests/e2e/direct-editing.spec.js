import { test, expect } from '@playwright/test';
import { PDFDocument, rgb, degrees, StandardFonts, PDFName } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addNote } from '../../src/core/notes.js';
import { addHighlight } from '../../src/core/highlight.js';

async function openDocument(page, { rich = false, rotation = 0 } = {}) {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([500, 600]);
  sheet.setRotation(degrees(rotation));
  if (rich) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    sheet.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: font.ref } }));
    sheet.node.set(
      PDFName.of('Contents'),
      doc.context.register(
        doc.context.flateStream('BT /F 20 Tf 50 480 Td (Original ) Tj (text) Tj ET'),
      ),
    );
  } else sheet.drawText('Original text', { x: 50, y: 480, size: 20 });
  sheet.drawText('Other text', { x: 280, y: 480, size: 20 });
  sheet.drawRectangle({ x: 80, y: 260, width: 130, height: 80, color: rgb(0.7, 0.2, 0.2) });
  const png = await doc.embedPng(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  sheet.drawImage(png, { x: 300, y: 280, width: 60, height: 60 });
  addNote(doc, 0, { x: 340, y: 400, text: 'Review note', hex: '#ffff00' });
  addHighlight(doc, 0, { quads: [[50, 430, 230, 430, 50, 410, 230, 410]], hex: '#ffff00' });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'direct.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}

async function clickAway(page) {
  await page.locator('.workspace').click({ position: { x: 4, y: 4 } });
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}

async function exportedText(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const bytes = await readFile(await (await pending).path());
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    return (await (await (await task.promise).getPage(1)).getTextContent()).items;
  } finally {
    await task.destroy();
  }
}

for (const fit of ['fit', 'page'])
  test(`Select drags text at ${fit} zoom, with document undo and redo`, async ({ page }) => {
    await openDocument(page);
    await page.getByLabel('Zoom', { exact: true }).selectOption(fit);
    await expect(page.locator('.paper')).toHaveAttribute('aria-busy', 'false');
    const target = page.getByRole('button', { name: 'Edit text: Original text', exact: true });
    const before = await target.boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 24, before.y + before.height / 2 + 18, {
      steps: 5,
    });
    await page.mouse.up();
    await expect.poll(async () => (await target.boundingBox())?.x - before.x).toBeCloseTo(24, 0);
    await expect(page.getByRole('button', { name: 'Move text', exact: true })).toBeVisible();
    await expect.poll(async () => (await target.boundingBox())?.y - before.y).toBeCloseTo(18, 0);
    await expect.poll(async () => (await target.boundingBox())?.width).toBeCloseTo(before.width, 0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    await clickAway(page);
    await expect(page.locator('.text-edit-handles')).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await target.boundingBox())?.x).toBeCloseTo(before.x, 0);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect.poll(async () => (await target.boundingBox())?.x - before.x).toBeCloseTo(24, 0);
  });

test('one click selects text, double-click edits, and click-away saves without an Apply button', async ({
  page,
}, info) => {
  await openDocument(page);
  await page
    .getByRole('button', { name: 'Edit text: Original text', exact: true })
    .click({ position: { x: 1, y: 8 } });
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  const frame = page.getByRole('button', { name: 'Move text', exact: true });
  await expect(input).not.toBeEditable();
  await expect(frame).toBeFocused();
  await expect(frame).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await frame.click();
  await expect(input).not.toBeEditable();
  await frame.dblclick({ position: { x: 8, y: 15 } });
  await expect(input).toBeEditable();
  await expect(input).toBeFocused();
  await page.keyboard.insertText('Updated ');
  await expect(input).toHaveValue('Updated Original text');
  await expect(page.getByRole('button', { name: /^(Apply text|Add text)$/ })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('direct-text-editing.png') });
  await clickAway(page);
  await expect(input).toHaveCount(0);
  expect((await exportedText(page)).some((item) => item.str === 'Updated Original text')).toBe(
    true,
  );
});

test('text tool creates text on click-away, and its border drags while the inside edits', async ({
  page,
}) => {
  await openDocument(page);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Text to add', exact: true });
  await input.fill('New text');
  const before = await input.boundingBox();
  const frame = await page.getByRole('button', { name: 'Move text', exact: true }).boundingBox();
  await page.mouse.move(frame.x + frame.width / 2, frame.y + 2);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width / 2 + 20, frame.y + 12, { steps: 4 });
  await page.mouse.up();
  expect((await input.boundingBox()).x - before.x).toBeCloseTo(20, 0);
  await input.fill('New text moved');
  await clickAway(page);
  await expect(input).toHaveCount(0);
  expect((await exportedText(page)).some((item) => item.str === 'New text moved')).toBe(true);
});

for (const kind of ['shape', 'image', 'highlight', 'note'])
  test(`clicking away deselects a ${kind} and preserves its changes`, async ({ page }) => {
    await openDocument(page);
    const target = page.getByRole('button', {
      name:
        kind === 'highlight'
          ? 'Edit highlight'
          : kind === 'note'
            ? 'Edit note: Review note'
            : `Select ${kind} 1`,
      exact: true,
    });
    await target.click();
    const panel = page.getByRole('complementary', { name: 'Selection properties' });
    if (kind === 'note') await page.getByLabel('Note text').fill('Edited note');
    else if (kind !== 'highlight') {
      const label = `${kind[0].toUpperCase() + kind.slice(1)} width in points`;
      await page.getByLabel(label, { exact: true }).fill('100');
      await expect(panel.getByRole('heading')).toHaveText(kind[0].toUpperCase() + kind.slice(1));
    }
    if (kind === 'shape') await page.locator('.paper').click({ position: { x: 10, y: 10 } });
    else await clickAway(page);
    await expect(panel.getByRole('group')).toHaveCount(0);
    await expect(page.locator('.image-controls')).toBeHidden();
    if (kind === 'note')
      await expect(
        page.getByRole('button', { name: 'Edit note: Edited note', exact: true }),
      ).toBeVisible();
    else if (kind !== 'highlight') {
      await target.click();
      await expect(
        page.getByLabel(`${kind[0].toUpperCase() + kind.slice(1)} width in points`, {
          exact: true,
        }),
      ).toHaveValue('100');
    }
  });

test('switching text objects keeps typed changes, and blank page deselects', async ({ page }) => {
  await openDocument(page);
  await page.getByRole('button', { name: 'Edit text: Original text', exact: true }).dblclick();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await input.fill('First box edited');
  await page.getByRole('button', { name: 'Edit text: Other text', exact: true }).click();
  await expect(input).toHaveValue('Other text');
  await expect(input).not.toBeEditable();
  await expect(
    page.getByRole('button', { name: 'Edit text: First box edited', exact: true }),
  ).toBeAttached();
  await page.getByLabel('Text size').selectOption('24');
  await expect(page.locator('.text-edit-handles')).toBeVisible();
  await page.locator('.paper').click({ position: { x: 10, y: 10 } });
  await expect(input).toHaveCount(0);
  const items = await exportedText(page);
  expect(items.some((item) => item.str === 'First box edited')).toBe(true);
  expect(items.find((item) => item.str === 'Other text').height).toBe(24);
});

test('a selected text box supports keyboard editing, deletion, and undo', async ({ page }) => {
  await openDocument(page);
  const target = page.getByRole('button', { name: 'Edit text: Original text', exact: true });
  await target.press('Enter');
  const frame = page.getByRole('button', { name: 'Move text', exact: true });
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await expect(frame).toBeFocused();
  await expect(input).not.toBeEditable();
  await frame.press('Enter');
  await expect(input).toBeEditable();
  await input.fill('Unfinished replacement');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await target.press('Enter');
  await frame.press('Delete');
  await expect(target).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(target).toBeVisible();
});

test('Escape hands the keyboard back to the text it leaves, as pictures and shapes do', async ({
  page,
}) => {
  await openDocument(page);
  const target = page.getByRole('button', { name: 'Edit text: Original text', exact: true });
  const frame = page.getByRole('button', { name: 'Move text', exact: true });
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await target.press('Enter');
  await expect(frame).toBeFocused();
  await frame.press('Escape');
  await expect(frame).toHaveCount(0);
  await expect(target).toBeFocused();
  // Leaving a draft with typing in it ends in the same place, ready for Tab or Enter.
  await target.press('Enter');
  await frame.press('Enter');
  await expect(input).toBeEditable();
  await page.keyboard.insertText('Unfinished ');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(frame).toBeFocused();
});

test('touch can drag unselected text without starting page scrolling', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Uses the Chromium touch protocol.');
  await openDocument(page);
  const target = page.getByRole('button', { name: 'Edit text: Original text', exact: true });
  const before = await target.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const finger = { id: 1, x: before.x + before.width / 2, y: before.y + before.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger] });
  finger.x += 24;
  finger.y += 16;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [finger] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(async () => (await target.boundingBox())?.x - before.x).toBeCloseTo(24, 0);
  await expect(page.getByRole('button', { name: 'Move text', exact: true })).toBeVisible();
  await clickAway(page);
  await expect(page.getByRole('group', { name: 'Text properties', exact: true })).toHaveCount(0);
});

test('double-clicking another text box saves the first and starts typing in the second', async ({
  page,
}) => {
  await openDocument(page);
  await page.getByRole('button', { name: 'Edit text: Original text', exact: true }).dblclick();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await input.fill('First changed');
  await page.getByRole('button', { name: 'Edit text: Other text', exact: true }).dblclick();
  await expect(input).toHaveValue('Other text');
  await expect(input).toBeEditable();
  await input.fill('Second changed');
  await clickAway(page);
  const items = await exportedText(page);
  expect(items.some((item) => item.str === 'First changed')).toBe(true);
  expect(items.some((item) => item.str === 'Second changed')).toBe(true);
});

for (const holdFirstPress of [false, true])
  test(`a second click keeps ownership during redraw ${holdFirstPress ? 'that starts before the first release' : 'after the first click'}`, async ({
    page,
  }) => {
    await openDocument(page);
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    await page.getByRole('button', { name: 'Edit text: Original text', exact: true }).dblclick();
    const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
    await input.fill('First changed');
    const probe = await PDFDocument.create();
    probe.addPage([500, 600]);
    await page.evaluate(
      async (bytes) => {
        const moduleUrl = performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((url) => /\/pdfjs-dist\.js(?:\?|$)/.test(url));
        const pdfjs = await import(moduleUrl);
        const loading = pdfjs.getDocument({ data: new Uint8Array(bytes) });
        const pdf = await loading.promise;
        const prototype = Object.getPrototypeOf(await pdf.getPage(1));
        const render = prototype.render;
        // Deliver the second press inside a real redraw, after the target nodes have
        // been cleared. Fixed event times keep this state test independent of machine load.
        // A render can start between native pointerdown and pointerup. A real second
        // press must wait for the first release, even when the redraw is fast. Observe
        // pointerup after it bubbles through the captured target; replacing the pressed
        // node can suppress its compatibility click event in Chromium.
        const firstRelease = new Promise((resolve) => {
          document.addEventListener('pointerup', resolve, { once: true });
        });
        let first;
        document.querySelector('.text-targets').addEventListener(
          'pointerdown',
          (e) => {
            first = {
              clientX: e.clientX,
              clientY: e.clientY,
              pointerId: e.pointerId,
              timeStamp: e.timeStamp,
            };
          },
          { once: true, capture: true },
        );
        prototype.render = function (options) {
          const task = render.call(this, options);
          if (options.viewport.scale === 0.5) {
            prototype.render = render;
            task.onContinue = async (resume) => {
              task.onContinue = null;
              window.clickRedrawStarted = true;
              await firstRelease;
              window.targetsDuringSecondClick = document.querySelectorAll('.text-target').length;
              const target = document.elementFromPoint(first.clientX, first.clientY);
              for (const type of ['pointerdown', 'pointerup']) {
                const event = new PointerEvent(type, {
                  ...first,
                  bubbles: true,
                  cancelable: true,
                  button: 0,
                  isPrimary: true,
                  pointerType: 'mouse',
                });
                Object.defineProperty(event, 'timeStamp', { value: first.timeStamp + 100 });
                target.dispatchEvent(event);
              }
              target.dispatchEvent(new MouseEvent('click', { ...first, bubbles: true, detail: 2 }));
              resume();
            };
          }
          return task;
        };
        await loading.destroy();
      },
      Array.from(await probe.save()),
    );
    const target = page.getByRole('button', { name: 'Edit text: Other text', exact: true });
    if (holdFirstPress) {
      await target.hover();
      await page.mouse.down();
      await expect.poll(() => page.evaluate(() => window.clickRedrawStarted)).toBe(true);
      await page.mouse.up();
    } else await target.click();
    await expect.poll(() => page.evaluate(() => window.targetsDuringSecondClick)).toBe(0);
    await expect(input).toHaveValue('Other text');
    await expect(input).toBeEditable();
    await input.fill('Second changed');
    await clickAway(page);
    const items = await exportedText(page);
    expect(items.some((item) => item.str === 'First changed')).toBe(true);
    expect(items.some((item) => item.str === 'Second changed')).toBe(true);
  });

for (const kind of ['text', 'shape'])
  test(`click-away during a ${kind} drag save keeps it deselected when saving finishes`, async ({
    page,
  }) => {
    await openDocument(page);
    await page.evaluate(async () => {
      const { PdfSession } = await import('/src/core/document.js');
      const change = PdfSession.prototype.change;
      PdfSession.prototype.change = async function (operation) {
        PdfSession.prototype.change = change;
        await new Promise((resolve) => {
          window.finishDragSave = resolve;
        });
        return change.call(this, operation);
      };
    });
    const target = page.getByRole('button', {
      name: kind === 'text' ? 'Edit text: Original text' : 'Select shape 1',
      exact: true,
    });
    const before = await target.boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 20, before.y + before.height / 2 + 12, {
      steps: 4,
    });
    await page.mouse.up();
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'true');
    await page.locator('.workspace').click({ position: { x: 4, y: 4 } });
    await page.evaluate(() => window.finishDragSave());
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    await expect(
      page.getByRole('complementary', { name: 'Selection properties' }).getByRole('group'),
    ).toHaveCount(0);
    await expect(page.locator('.text-edit-handles')).toHaveCount(0);
    await expect(page.locator('.image-controls')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  });

test('a moved text box stays visible on hover and requires a double-click to edit', async ({
  page,
}, info) => {
  await openDocument(page);
  const target = page.getByRole('button', { name: 'Edit text: Original text', exact: true });
  const before = await target.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 20, before.y + before.height / 2, {
    steps: 4,
  });
  await page.mouse.up();
  await expect.poll(async () => (await target.boundingBox())?.x - before.x).toBeCloseTo(20, 0);
  const frame = page.getByRole('button', { name: 'Move text', exact: true });
  await frame.hover();
  await expect(frame).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.screenshot({ path: info.outputPath('text-hover.png') });
  await frame.click();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await expect(input).not.toBeEditable();
  await frame.dblclick();
  await expect(input).toBeEditable();
  await expect(input).toBeFocused();
  await expect(page.locator('.text-edit-handles')).toHaveClass(/is-typing/);
});

for (const rich of [false, true])
  for (const rotation of [0, 90])
    for (const tool of ['Select', 'Text'])
      test(`${tool}: ${tool === 'Select' ? 'double-click' : 'click'} places a caret in ${rich ? 'mixed' : 'plain'} text rotated ${rotation}`, async ({
        page,
      }) => {
        await openDocument(page, { rich, rotation });
        if (tool === 'Text') await page.getByRole('button', { name: tool, exact: true }).click();
        const target = page.getByRole('button', { name: 'Edit text: Original text', exact: true });
        const before = await target.boundingBox();
        // Check the first character with Select, and a position between words with Text.
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const ratio =
          font.widthOfTextAtSize('Original ', 20) / font.widthOfTextAtSize('Original text', 20);
        const advance = tool === 'Text' ? (rotation ? before.height : before.width) * ratio : 1;
        const x = before.x + (rotation ? before.width / 2 : advance);
        const y = before.y + (rotation ? advance : before.height / 2);
        if (tool === 'Select') await page.mouse.dblclick(x, y);
        else await page.mouse.click(x, y);
        const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
        await expect(input).toBeEditable();
        await expect(input).toBeFocused();
        await page.keyboard.insertText('X');
        const expected = tool === 'Text' ? 'Original Xtext' : 'XOriginal text';
        expect(await input.evaluate((node) => node.value)).toBe(expected);
        await clickAway(page);
        expect((await exportedText(page)).map((item) => item.str).join('')).toContain(expected);
      });

for (const rotation of [0, 90])
  test(`keyboard text moves form a redoable action at page rotation ${rotation}`, async ({
    page,
  }) => {
    await openDocument(page, { rotation });
    await page.getByLabel('Zoom', { exact: true }).selectOption('1.25');
    await expect(page.locator('.paper')).toHaveAttribute('aria-busy', 'false');
    const target = page.getByRole('button', { name: 'Edit text: Original text', exact: true });
    await target.click();
    const frame = page.getByRole('button', { name: 'Move text', exact: true });
    const position = async () => {
      const bounds = await target.boundingBox();
      const paper = await page.locator('.paper').boundingBox();
      return bounds && { x: bounds.x - paper.x, y: bounds.y - paper.y };
    };
    const before = await position();
    // A held arrow, including repeat events, is one completed action.
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowRight');
    await page.keyboard.up('ArrowRight');
    await expect(frame).toBeFocused();
    await expect.poll(async () => (await position())?.x - before.x).toBeCloseTo(3.75, 0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect.poll(async () => (await position())?.x - before.x).toBeCloseTo(3.75, 0);
    await target.click();
    await frame.press('Shift+ArrowDown');
    await expect.poll(async () => (await position())?.y - before.y).toBeCloseTo(12.5, 0);
    await frame.press('Escape');
    await expect(frame).toHaveCount(0);
    await expect.poll(async () => (await position())?.y - before.y).toBeCloseTo(12.5, 0);
  });

for (const rich of [false, true])
  test(`native paste history survives edit, zoom, drag and object switching in ${rich ? 'mixed' : 'plain'} text`, async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Clipboard permissions use the Chromium test context.');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openDocument(page, { rich, rotation: rich ? 90 : 0 });
    await page.getByRole('button', { name: 'Edit text: Original text', exact: true }).dblclick();
    const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
    await expect(input).toBeEditable();
    await input.press('ControlOrMeta+a');
    await page.keyboard.type('Edited');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await page.evaluate(() => navigator.clipboard.writeText(' pasted'));
    await input.press('ControlOrMeta+v');
    await expect.poll(() => input.evaluate((el) => el.value)).toBe('Edited pasted');
    await input.press('ControlOrMeta+z');
    await expect.poll(() => input.evaluate((el) => el.value)).toBe('Edited');
    await input.press('ControlOrMeta+Shift+z');
    await expect.poll(() => input.evaluate((el) => el.value)).toBe('Edited pasted');
    await page.getByLabel('Zoom', { exact: true }).selectOption('1.5');
    await expect(page.locator('.paper')).toHaveAttribute('aria-busy', 'false');
    const target = page.getByRole('button', { name: 'Edit text: Edited pasted', exact: true });
    await target.scrollIntoViewIfNeeded();
    const before = await target.boundingBox();
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 18, before.y + before.height / 2 + 12, {
      steps: 5,
    });
    await page.mouse.up();
    await expect(page.getByRole('button', { name: 'Move text', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await page.getByRole('button', { name: 'Edit text: Other text', exact: true }).dblclick();
    await expect(input).toBeEditable();
    await input.press('ControlOrMeta+a');
    await page.keyboard.type('Second edited');
    await target.click();
    await expect.poll(() => input.evaluate((el) => el.value)).toBe('Edited pasted');
    await expect(input).not.toBeEditable();
    const coordinate = page.getByLabel('Text X in points', { exact: true });
    await coordinate.dblclick();
    await expect(coordinate).toBeFocused();
    await expect(input).not.toBeEditable();
    await page.keyboard.press('Escape');
    await expect(input).toHaveCount(0);
    const items = await exportedText(page);
    expect(items.some((item) => item.str === 'Edited pasted')).toBe(true);
    expect(items.map((item) => item.str).join('')).toContain('Second edited');
  });
