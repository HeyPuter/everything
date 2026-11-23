import { clickAway } from './editing-helpers.js';
import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

async function openParagraph(page) {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([500, 500]).drawText('One two three\nfour five.', {
    x: 40.123456,
    y: 400.654321,
    size: 18,
    lineHeight: 22,
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'test.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('.text-target').click();
  return page.getByRole('textbox', { name: 'Edit text', exact: true });
}

for (const [label, value] of [
  ['Text X in points', '80.25'],
  ['Text Y in points', '360.75'],
  ['Paragraph width in points', '220.5'],
]) {
  test(`Apply shortcut commits the focused ${label} field`, async ({ page }) => {
    const input = await openParagraph(page);
    const field = page.getByRole('spinbutton', { name: label, exact: true });
    await field.fill(value);
    await field.press('ControlOrMeta+Enter');
    await expect(input).toHaveCount(0);
    await page.locator('.text-target').click();
    await expect(field).toHaveValue(value);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await page.locator('.text-target').click();
    await expect(field).not.toHaveValue(value);
  });
}

test('Download shortcut commits focused text coordinates to the exported PDF', async ({ page }) => {
  const input = await openParagraph(page);
  const field = page.getByRole('spinbutton', { name: 'Text X in points', exact: true });
  await field.fill('95.5');
  const download = page.waitForEvent('download');
  await field.press('ControlOrMeta+Shift+s');
  const bytes = await readFile(await (await download).path());
  await expect(input).toHaveCount(0);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    const pdfPage = await (await task.promise).getPage(1);
    const { items } = await pdfPage.getTextContent();
    const lines = items.filter((item) => item.str.trim());
    expect(lines.map((item) => item.str)).toEqual(['One two three', 'four five.']);
    expect(lines.every((item) => Math.abs(item.transform[4] - 95.5) < 0.0001)).toBe(true);
  } finally {
    await task.destroy();
  }
});

test('applying a focused, unchanged coordinate preserves the source precision and history', async ({
  page,
}) => {
  const input = await openParagraph(page);
  const field = page.getByRole('spinbutton', { name: 'Text X in points', exact: true });
  await expect(field).toHaveValue('40.123');
  await field.focus();
  await field.press('ControlOrMeta+Enter');
  await expect(input).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('Apply shortcut keeps an invalid paragraph width available for correction', async ({
  page,
}) => {
  const input = await openParagraph(page);
  const field = page.getByRole('spinbutton', { name: 'Paragraph width in points', exact: true });
  await field.fill('0');
  await field.press('ControlOrMeta+Enter');
  await expect(input).toBeVisible();
  await expect(field).toHaveValue('0');
  await expect(field).toBeFocused();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await field.fill('220.5');
  await field.press('ControlOrMeta+Enter');
  await expect(input).toHaveCount(0);
  await page.locator('.text-target').click();
  await expect(field).toHaveValue('220.5');
});

for (const axis of ['X', 'Y']) {
  for (const action of ['clicking away', 'shortcut']) {
    test(`an empty ${axis} coordinate keeps the text draft when applying by ${action}`, async ({
      page,
    }) => {
      const input = await openParagraph(page);
      await input.fill('Keep these pending words');
      const field = page.getByRole('spinbutton', { name: `Text ${axis} in points`, exact: true });
      await field.fill('');
      if (action === 'clicking away') await clickAway(page);
      else await field.press('ControlOrMeta+Enter');
      await expect(input).toBeVisible();
      await expect(field).toHaveValue('');
      await expect(field).toBeFocused();
      expect(await input.evaluate((el) => el.value)).toBe('Keep these pending words');
      const value = axis === 'X' ? '85.5' : '360.25';
      await field.fill(value);
      await field.press('ControlOrMeta+Enter');
      await expect(input).toHaveCount(0);
      await page.locator('.text-target').click();
      await expect(field).toHaveValue(value);
      expect(await input.evaluate((el) => el.value)).toBe('Keep these pending words');
    });
  }
}

for (const action of ['Escape from toolbar', 'Escape from field']) {
  test(`${action} discards a text draft with an empty coordinate`, async ({ page }) => {
    const input = await openParagraph(page);
    const field = page.getByRole('spinbutton', { name: 'Text X in points', exact: true });
    await field.fill('');
    if (action === 'Escape from toolbar') {
      await page.getByLabel('Text size').focus();
      await page.keyboard.press('Escape');
    } else await field.press('Escape');
    await expect(input).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });
}

test('an empty new-text coordinate blocks download until corrected', async ({ page }) => {
  const original = await openParagraph(page);
  await page.keyboard.press('Escape');
  await expect(original).toHaveCount(0);
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Text to add', exact: true });
  await input.fill('New pending text');
  const field = page.getByRole('spinbutton', { name: 'Text Y in points', exact: true });
  await field.fill('');
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await field.press('ControlOrMeta+Shift+s');
  await expect(field).toBeFocused();
  await expect(input).toBeVisible();
  await expect(page.locator('#toast')).toContainText('Choose a valid text position.');
  expect(downloads).toHaveLength(0);
  await field.fill('250');
  const downloaded = page.waitForEvent('download');
  await field.press('ControlOrMeta+Shift+s');
  await downloaded;
  await expect(input).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit text: New pending text', exact: true }).click();
  await expect(field).toHaveValue('250');
});

for (const [label, value] of [
  ['Text X in points', '85.5'],
  ['Text Y in points', '360.25'],
  ['Paragraph width in points', '220.5'],
]) {
  test(`typing in ${label} protects the pending draft before blur`, async ({ page }) => {
    const input = await openParagraph(page);
    const field = page.getByRole('spinbutton', { name: label, exact: true });
    const original = await field.inputValue();
    const warnsBeforeLeaving = () =>
      page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });
    expect(await warnsBeforeLeaving()).toBe(false);
    await field.fill(value);
    expect(await warnsBeforeLeaving()).toBe(true);
    await expect(field).toBeFocused();
    await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
    await expect(page).toHaveTitle(/^\* /);
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeEnabled();
    await field.fill(original);
    expect(await warnsBeforeLeaving()).toBe(false);
    await expect(page.locator('.save-status')).toHaveText('Local file');
    await expect(undo).toBeDisabled();
    await field.fill(value);
    await undo.click();
    await expect(input).toHaveCount(0);
    await expect(undo).toBeDisabled();
    expect(await warnsBeforeLeaving()).toBe(false);
  });
}

for (const [label, value] of [
  ['Text X in points', ''],
  ['Paragraph width in points', '0'],
]) {
  test(`Undo discards invalid pending input in ${label}`, async ({ page }) => {
    const input = await openParagraph(page);
    const field = page.getByRole('spinbutton', { name: label, exact: true });
    await field.fill(value);
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(input).toHaveCount(0);
    await expect(undo).toBeDisabled();
    await expect(page.locator('.save-status')).toHaveText('Local file');
  });
}

for (const kind of ['position', 'width']) {
  test(`a ${kind} drag starts from the typed value and cancellation retains it`, async ({
    page,
  }) => {
    const input = await openParagraph(page);
    const field = page.getByRole('spinbutton', {
      name: kind === 'position' ? 'Text X in points' : 'Paragraph width in points',
      exact: true,
    });
    const control = page.getByRole('button', {
      name: kind === 'position' ? 'Move text' : 'Resize paragraph width',
      exact: true,
    });
    const zoom = (await page.locator('.paper').boundingBox()).width / 500;
    const typed = kind === 'position' ? 85.5 : 220.5;
    await field.fill(String(typed));
    const start = await control.boundingBox();
    await page.mouse.move(
      start.x + start.width / 2,
      start.y + (kind === 'position' ? 2 : start.height / 2),
    );
    await page.mouse.down();
    await page.mouse.move(
      start.x + start.width / 2 + 12,
      start.y + (kind === 'position' ? 2 : start.height / 2),
    );
    await page.mouse.up();
    await expect
      .poll(async () => Number(await field.inputValue()))
      .toBeCloseTo(typed + 12 / zoom, 2);
    // A cancelled drag restores the value typed before the drag, not the older PDF value.
    await field.fill(String(typed + 10));
    const next = await control.boundingBox();
    await page.mouse.move(
      next.x + next.width / 2,
      next.y + (kind === 'position' ? 2 : next.height / 2),
    );
    await page.mouse.down();
    await page.mouse.move(
      next.x + next.width / 2 + 15,
      next.y + (kind === 'position' ? 2 : next.height / 2),
    );
    await control.press('Escape');
    await page.mouse.up();
    await expect(field).toHaveValue(String(typed + 10));
    await expect(input).toBeVisible();
    await clickAway(page);
    await expect(input).toHaveCount(0);
    await page.locator('.text-target').click();
    await expect(field).toHaveValue(String(typed + 10));
  });
}

for (const axis of ['X', 'Y']) {
  test(`editing the other coordinate preserves an incomplete ${axis} value`, async ({ page }) => {
    const input = await openParagraph(page);
    const field = page.getByRole('spinbutton', { name: `Text ${axis} in points`, exact: true });
    const other = page.getByRole('spinbutton', {
      name: `Text ${axis === 'X' ? 'Y' : 'X'} in points`,
      exact: true,
    });
    await field.fill('');
    await other.fill('250');
    await other.press('Tab');
    await expect(field).toHaveValue('');
    await clickAway(page);
    await expect(input).toBeVisible();
    await expect(field).toBeFocused();
    await field.fill('150');
    await field.press('ControlOrMeta+Enter');
    await expect(input).toHaveCount(0);
    await page.locator('.text-target').click();
    await expect(field).toHaveValue('150');
    await expect(other).toHaveValue('250');
  });
}

for (const value of ['', '0', '10000']) {
  test(`editing paragraph text preserves invalid width ${JSON.stringify(value)}`, async ({
    page,
  }) => {
    const input = await openParagraph(page);
    const field = page.getByRole('spinbutton', { name: 'Paragraph width in points', exact: true });
    await field.fill(value);
    await input.click();
    await expect(input).toBeFocused();
    await input.fill('Keep these words');
    await expect(field).toHaveValue(value);
    await clickAway(page);
    await expect(input).toBeVisible();
    await expect(field).toBeFocused();
    await field.fill('220.5');
    await field.press('ControlOrMeta+Enter');
    await expect(input).toHaveCount(0);
    await page.locator('.text-target').click();
    await expect(field).toHaveValue('220.5');
    expect(await input.evaluate((el) => el.value)).toBe('Keep these words');
  });
}

for (const kind of ['position', 'width']) {
  test(`the ${kind} handle can replace incomplete numeric input`, async ({ page }) => {
    const input = await openParagraph(page);
    const field = page.getByRole('spinbutton', {
      name: kind === 'position' ? 'Text X in points' : 'Paragraph width in points',
      exact: true,
    });
    const original = Number(await field.inputValue());
    await field.fill('');
    const control = page.getByRole('button', {
      name: kind === 'position' ? 'Move text' : 'Resize paragraph width',
      exact: true,
    });
    await control.focus();
    await control.press('ArrowRight');
    await expect.poll(async () => Number(await field.inputValue())).toBeCloseTo(original + 1, 2);
    await clickAway(page);
    await expect(input).toHaveCount(0);
  });
}

test('a keyboard paragraph resize is one redoable action and leaves selection ready', async ({
  page,
}) => {
  await openParagraph(page);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.locator('.text-target').click();
  const field = page.getByLabel('Paragraph width in points', { exact: true });
  const before = Number(await field.inputValue());
  const resize = page.getByRole('button', { name: 'Resize paragraph width', exact: true });
  await resize.press('Shift+ArrowRight');
  await expect(field).toHaveValue(String(before + 10));
  await expect(resize).toBeFocused();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.locator('.text-target').click();
  await expect(field).toHaveValue(String(before + 10));
  await resize.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(field).toHaveValue(String(before + 9));
});

for (const kind of ['position', 'width'])
  test(`text ${kind} accounts for page scrolling before pointer release`, async ({ page }) => {
    await openParagraph(page);
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByLabel('Zoom', { exact: true }).selectOption('2');
    await expect(page.locator('.paper')).toHaveAttribute('aria-busy', 'false');
    await page.locator('.text-target').click();
    const field = page.getByLabel(
      kind === 'position' ? 'Text X in points' : 'Paragraph width in points',
      { exact: true },
    );
    const before = Number(await field.inputValue());
    const control = page.getByRole('button', {
      name: kind === 'position' ? 'Move text' : 'Resize paragraph width',
      exact: true,
    });
    await control.scrollIntoViewIfNeeded();
    const bounds = await control.boundingBox();
    const workspace = page.locator('.workspace');
    const scroll = await workspace.evaluate((el) => el.scrollLeft);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    // The pointer stays still while the document moves beneath it.
    await page.mouse.wheel(40, 0);
    await expect.poll(() => workspace.evaluate((el) => el.scrollLeft)).toBeGreaterThan(scroll);
    const distance = (await workspace.evaluate((el) => el.scrollLeft)) - scroll;
    await expect
      .poll(async () => Number(await field.inputValue()) - before)
      .toBeCloseTo(distance / 2, 1);
    await page.mouse.up();
    await expect
      .poll(async () => Number(await field.inputValue()) - before)
      .toBeCloseTo(distance / 2, 1);
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  });
