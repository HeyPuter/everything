import { clickAway } from './editing-helpers.js';
import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFRef, PDFString } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { addNote, listNotes } from '../../src/core/notes.js';
import { addHighlight, rectQuad } from '../../src/core/highlight.js';
import { addLink, listLinks } from '../../src/core/links.js';

async function annotatedLayers(membership) {
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([400, 400]);
  const ctx = doc.context,
    n = PDFName.of;
  const hidden = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Hidden') }));
  const visible = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Visible') }));
  doc.catalog.set(n('OCProperties'), ctx.obj({ OCGs: [hidden, visible], D: { OFF: [hidden] } }));
  for (const [i, title] of ['Hidden', 'Visible'].entries()) {
    const start = sheet.node.Annots()?.size() || 0;
    const x = 20 + 200 * i;
    const field = doc.getForm().createTextField(`${title} field`);
    field.addToPage(sheet, { x, y: 280, width: 140, height: 28 });
    field.setText(`${title} value`);
    addNote(doc, 0, { x, y: 220, text: `${title} note` });
    addHighlight(doc, 0, {
      quads: [rectQuad({ x, y: 160, width: 140, height: 20 })],
      hex: '#ffff00',
      text: `${title} highlight`,
    });
    addLink(doc, 0, {
      rect: { x, y: 90, width: 140, height: 25 },
      url: `https://example.com/${title.toLowerCase()}`,
    });
    const group = membership
      ? ctx.register(
          ctx.obj({
            Type: 'OCMD',
            OCGs: [hidden, visible],
            P: i ? 'AnyOn' : 'AllOn',
            VE: i ? ['Not', hidden] : ['And', hidden, visible],
          }),
        )
      : i
        ? visible
        : hidden;
    for (const ref of sheet.node.Annots().asArray().slice(start))
      ctx.lookup(ref).set(n('OC'), group);
  }
  if (membership) {
    // PDF.js and pdf-lib spell annotation IDs differently, including nonzero generations.
    const annotations = sheet.node.Annots();
    for (let i = 0; i < annotations.size(); i++) {
      const ref = annotations.get(i),
        dict = ctx.lookup(ref);
      if (!['Text', 'Highlight'].includes(dict.lookup(n('Subtype')).decodeText())) continue;
      const next = PDFRef.of(ref.objectNumber, 2);
      ctx.assign(next, dict);
      ctx.delete(ref);
      annotations.set(i, next);
      dict.lookup(n('Popup'))?.set(n('Parent'), next);
    }
  }
  return doc.save();
}

for (const membership of [false, true]) {
  test(`hidden layer annotations have no active controls or comments (membership=${membership})`, async ({
    page,
  }) => {
    await page.route('https://js.puter.com/**', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username: 'test-user'}) }, fs: { readdir: async () => [] }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`,
      }),
    );
    await page.goto('/#library');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Open a PDF/ }).click();
    await (
      await chooser
    ).setFiles({
      name: 'layers.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await annotatedLayers(membership)),
    });
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByLabel('Visible field (on page)', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Edit note: Visible note', exact: true }),
    ).toBeVisible();
    const visibleLink = page.getByRole('button', {
      name: 'Link to example.com/visible',
      exact: true,
    });
    const hiddenLink = page.getByRole('button', {
      name: 'Link to example.com/hidden',
      exact: true,
    });
    await expect(visibleLink).toBeVisible();
    await expect.soft(page.getByLabel('Hidden field (on page)', { exact: true })).toHaveCount(0);
    await expect
      .soft(page.getByRole('button', { name: 'Edit note: Hidden note', exact: true }))
      .toHaveCount(0);
    await expect.soft(hiddenLink).toHaveCount(0);
    await visibleLink.click();
    const linkEditor = page.getByRole('dialog', { name: 'Edit link' });
    await expect(linkEditor.getByRole('textbox', { name: 'Web address to link to' })).toHaveValue(
      'https://example.com/visible',
    );
    await linkEditor
      .getByRole('textbox', { name: 'Web address to link to' })
      .fill('https://example.com/edited-visible');
    await linkEditor.getByRole('button', { name: 'Save link', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Link to example.com/edited-visible', exact: true }),
    ).toBeVisible();
    await expect(hiddenLink).toHaveCount(0);
    await expect.soft(page.locator('.highlight-target')).toHaveCount(1);
    const tabs = page.getByRole('tablist', { name: 'Side panel' });
    if (!(await tabs.isVisible()))
      await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
    await tabs.getByRole('tab', { name: /Comments/ }).click();
    const list = page.getByRole('group', { name: 'Comments' });
    await expect.soft(list.getByRole('button')).toHaveCount(2);
    await expect.soft(list).not.toContainText('Hidden');
    await list.getByRole('button', { name: 'Note on page 1: Visible note', exact: true }).click();
    const editor = page.getByRole('group', { name: 'Edit note' });
    await editor.getByLabel('Note text').fill('Edited visible note');
    await clickAway(page);
    await expect(
      page.getByRole('button', { name: 'Edit note: Edited visible note', exact: true }),
    ).toBeVisible();
    await page.getByLabel('Visible field (on page)', { exact: true }).fill('Edited visible value');
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const saved = await PDFDocument.load(await readFile(await (await pending).path()));
    expect(listLinks(saved, 0).map((link) => link.url)).toEqual([
      'https://example.com/hidden',
      'https://example.com/edited-visible',
    ]);
    expect(saved.getForm().getTextField('Visible field').getText()).toBe('Edited visible value');
    expect(saved.getForm().getTextField('Hidden field').getText()).toBe('Hidden value');
    expect(listNotes(saved, 0).map((note) => note.text)).toEqual([
      'Hidden note',
      'Edited visible note',
    ]);
    expect(saved.catalog.lookup(PDFName.of('OCProperties')).lookup(PDFName.of('OCGs')).size()).toBe(
      2,
    );
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByLabel('Visible field (on page)', { exact: true })).toHaveValue(
      'Visible value',
    );
    await expect(page.getByLabel('Hidden field (on page)', { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Edit note: Hidden note', exact: true }),
    ).toHaveCount(0);
  });
}

test('a layer hidden in the Layers panel stays hidden after an edit', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username: 'test-user'}) }, fs: { readdir: async () => [] }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`,
    }),
  );
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'layers.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await annotatedLayers(false)),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const link = page.getByRole('button', { name: 'Link to example.com/visible', exact: true });
  await expect(link).toBeVisible();
  const tabs = page.getByRole('tablist', { name: 'Side panel' });
  if (!(await tabs.isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await tabs.getByRole('tab', { name: 'Layers' }).click();
  const layer = page.getByRole('checkbox', { name: 'Visible', exact: true });
  await layer.uncheck();
  await expect(link).toHaveCount(0);
  // Every edit reloads the PDF; the reader's choice outlives it.
  await page.getByRole('region', { name: 'PDF page view' }).focus();
  await page.keyboard.press('ControlOrMeta+Shift+R');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(layer).not.toBeChecked();
  await expect(page.locator('.link-target')).toHaveCount(0);
});

test('a layer switch keeps the focus when an Undo redraws the Layers panel', async ({ page }) => {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username: 'test-user'}) }, fs: { readdir: async () => [] }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`,
    }),
  );
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'layers.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await annotatedLayers(false)),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('region', { name: 'PDF page view' }).focus();
  await page.keyboard.press('ControlOrMeta+Shift+R');
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeEnabled();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const tabs = page.getByRole('tablist', { name: 'Side panel' });
  if (!(await tabs.isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await tabs.getByRole('tab', { name: 'Layers' }).click();
  const layer = page.getByRole('checkbox', { name: 'Visible', exact: true });
  await layer.focus();
  await page.keyboard.press('Space');
  await expect(layer).not.toBeChecked();
  // Undo belongs to the app on a switch; the reload it causes draws the list again.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(undo).toBeDisabled();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(layer).toBeFocused();
  await expect(layer).not.toBeChecked();
});
