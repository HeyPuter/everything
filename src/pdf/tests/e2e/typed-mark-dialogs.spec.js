import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { inspectPaths } from '../../src/core/path-edit.js';

async function openDialog(page, kind) {
  if (kind === 'signature') {
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    await page.getByRole('tab', { name: 'Type', exact: true }).click();
  } else {
    const bar = page.getByRole('menubar', { name: 'PDF menus' });
    if (await bar.isVisible())
      await bar.getByRole('menuitem', { name: 'Insert', exact: true }).click();
    else {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Insert', exact: true }).click();
    }
    await page.getByRole('menuitem', { name: 'Stamp…', exact: true }).click();
  }
  return page.getByRole('dialog', { name: `Add ${kind}` });
}

for (const kind of ['signature', 'stamp'])
  test(`equivalent Unicode spellings produce the same ${kind} in downloaded PDFs`, async ({
    page,
  }) => {
    await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Open a PDF/ }).click();
    await (
      await chooser
    ).setFiles({
      name: 'blank.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await doc.save()),
    });
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    const text = `Ä\u0301 ${kind === 'signature' ? 'Ӂ' : '≠'}`;
    let first;
    for (const form of ['NFC', 'NFD']) {
      const dialog = await openDialog(page, kind);
      const input = dialog.getByLabel(kind === 'signature' ? 'Signature text' : 'Text', {
        exact: true,
      });
      const original = text.normalize(form);
      await input.fill(original);
      if (kind === 'signature')
        await dialog.getByLabel('Remember drawn and typed signatures').check();
      await dialog.getByRole('button', { name: `Place ${kind}`, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('group', { name: `Edit ${kind}` })).toBeVisible();
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download', exact: true }).click();
      const downloaded = await PDFDocument.load(await readFile(await (await pending).path()));
      const paths = inspectPaths(downloaded, 0);
      expect(paths).toHaveLength(1);
      expect(paths[0].svg).toContain('C');
      if (first) expect(paths[0].svg).toBe(first);
      else first = paths[0].svg;
      if (kind === 'signature') {
        const saved = await page.evaluate(() =>
          JSON.parse(localStorage.getItem('pdf-editor:signatures')),
        );
        expect(saved.items).toContainEqual({ type: 'type', text: original });
      }
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    }
  });

for (const kind of ['signature', 'stamp'])
  test(`invisible-only ${kind} text stays editable without changing the PDF`, async ({ page }) => {
    await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
    await page.goto('/');
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    const dialog = await openDialog(page, kind);
    const input = dialog.getByLabel(kind === 'signature' ? 'Signature text' : 'Text', {
      exact: true,
    });
    await input.fill('\u200b');
    if (kind === 'signature')
      await dialog.getByLabel('Remember drawn and typed signatures').check();
    await dialog.getByRole('button', { name: `Place ${kind}`, exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('visible character');
    await expect(input).toHaveValue('\u200b');
    await expect(input).toBeFocused();
    await expect(page.locator('.save-status')).toHaveText('Local file');
    expect(await page.evaluate(() => localStorage.getItem('pdf-editor:signatures'))).toBeNull();
    await input.fill('Ada Lovelace');
    await dialog.getByRole('button', { name: `Place ${kind}`, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('group', { name: `Edit ${kind}` })).toBeVisible();
  });

for (const kind of ['signature', 'stamp'])
  for (const fails of [false, true])
    test(`cancelled ${kind} preparation ignores a late ${fails ? 'failure' : 'success'}`, async ({
      page,
    }) => {
      await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
      const font = kind === 'signature' ? 'GreatVibes-Regular.ttf' : 'NotoSans-Regular.ttf';
      let release;
      const ready = new Promise((resolve) => (release = resolve));
      await page.route(`**/fonts/${font}`, async (route) => {
        if (route.request().resourceType() !== 'fetch') return route.continue();
        await ready;
        if (fails) await route.fulfill({ status: 503, body: 'Unavailable' });
        else await route.continue();
      });
      await page.goto('/');
      await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
      const request = (r) => r.url().endsWith(`/fonts/${font}`) && r.resourceType() === 'fetch';
      const requested = page.waitForRequest(request);
      const dialog = await openDialog(page, kind);
      const input = dialog.getByLabel(kind === 'signature' ? 'Signature text' : 'Text', {
        exact: true,
      });
      await input.fill('Ada Lovelace');
      if (kind === 'signature')
        await dialog.getByLabel('Remember drawn and typed signatures').check();
      await dialog.getByRole('button', { name: `Place ${kind}`, exact: true }).click();
      await requested;
      await expect(dialog).toHaveAttribute('aria-busy', 'true');
      await expect(input).toBeDisabled();
      await expect(
        dialog.getByRole('button', { name: `Place ${kind}`, exact: true }),
      ).toBeDisabled();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const reopened = await openDialog(page, kind);
      const response = page.waitForResponse((r) => request(r.request()));
      release();
      await (await response).finished();
      // Deliver the completed fetch and its continuations before inspecting the new dialog.
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await expect(reopened).toBeVisible();
      await expect(reopened.getByRole('alert')).toBeHidden();
      await expect(
        reopened.getByRole('button', { name: `Place ${kind}`, exact: true }),
      ).toBeEnabled();
      await expect(page.locator('.save-status')).toHaveText('Local file');
      expect(await page.evaluate(() => localStorage.getItem('pdf-editor:signatures'))).toBeNull();
    });

for (const kind of ['signature', 'stamp'])
  for (const moved of [false, true])
    test(`failed ${kind} preparation ${moved ? 'preserves newer Cancel focus' : 'returns focus to editable text'}`, async ({
      page,
    }) => {
      await page.route('https://js.puter.com/**', (route) => route.fulfill({ body: '' }));
      const font = kind === 'signature' ? 'GreatVibes-Regular.ttf' : 'NotoSans-Regular.ttf';
      let release;
      const ready = new Promise((resolve) => (release = resolve));
      let failed = false;
      await page.route(`**/fonts/${font}`, async (route) => {
        if (route.request().resourceType() !== 'fetch' || failed) return route.continue();
        await ready;
        failed = true;
        await route.fulfill({ status: 503, body: 'Unavailable' });
      });
      await page.goto('/');
      await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
      const dialog = await openDialog(page, kind);
      const input = dialog.getByLabel(kind === 'signature' ? 'Signature text' : 'Text', {
        exact: true,
      });
      await input.fill('Ada Lovelace');
      await dialog.getByRole('button', { name: `Place ${kind}`, exact: true }).click();
      await expect(dialog).toHaveAttribute('aria-busy', 'true');
      await expect(input).toBeDisabled();
      const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
      if (moved) {
        await cancel.focus();
        await expect(cancel).toBeFocused();
      }
      release();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await expect(input).toBeEnabled();
      await expect(input).toHaveValue('Ada Lovelace');
      await expect(moved ? cancel : input).toBeFocused();
      await expect(page.locator('.save-status')).toHaveText('Local file');
      if (moved) {
        await page.keyboard.press('Enter');
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole('group', { name: `Edit ${kind}` })).toHaveCount(0);
      } else {
        await dialog.getByRole('button', { name: `Place ${kind}`, exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole('group', { name: `Edit ${kind}` })).toBeVisible();
      }
    });
