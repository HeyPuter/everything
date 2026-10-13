import { test, expect, type Page } from '@playwright/test';
import { boot, downloadFrom, idle, openFiles, openImage, run, start } from './helpers';

async function showPanel(page: Page) {
  await page.evaluate(() => window.photoStudio.dock.show('provenance'));
  const body = page.locator('.panel-body[aria-label="Provenance"]');
  await expect(body).toBeVisible();
  return body;
}
async function setAttach(page: Page, mode: 'none' | 'record' | 'signed', prompts = false) {
  await page.evaluate(
    ({ mode, prompts }) => {
      const e = window.photoStudio;
      e.preferences.provenanceAttach = mode;
      e.preferences.provenancePrompts = prompts;
      e.preferencesChanged();
    },
    { mode, prompts },
  );
}
async function exportAs(page: Page, format: string) {
  await start(page, 'file.export-as');
  const dialog = page.locator('dialog.export-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('select[name="format"]').selectOption(format);
  await expect(dialog.locator('.export-busy')).toBeHidden();
  return downloadFrom(page, () => dialog.locator('button[data-act="export"]').click());
}
const inspect = (page: Page, bytes: Buffer) =>
  page.evaluate(async (data) => {
    const { inspectProvenance } = await import('/src/imaging/provenance/index.ts');
    const r = await inspectProvenance(new Uint8Array(data));
    const m = r.c2pa?.manifests[0];
    return {
      format: r.format,
      pixelMatches: r.xmp?.pixelHashMatches,
      steps: r.xmp?.record?.steps.map((s) => [s.label, s.command ?? s.tool ?? '']),
      sources: r.xmp?.record?.sources.map((s) => [s.name, s.role, s.sha256.length]),
      exports: r.xmp?.record?.exports.length,
      signature: m?.signature.valid,
      selfSigned: m?.signature.selfSigned,
      dataHash: m?.dataHashValid,
      assertions: m?.assertionHashesValid,
      actions: m?.actions.map((a) => a.action),
      errors: [...r.errors, ...(r.c2pa?.errors ?? []), ...(m?.errors ?? [])],
    };
  }, [...bytes]);

test.describe('Provenance', () => {
  test('records sources and edits, exports a signed PNG and JPEG and inspects them', async ({ page }) => {
    await boot(page);
    await openImage(page, 64, 48, '#3366cc', 'photo.png');
    await run(page, 'adjust.invert');
    // Invert finishes in a worker after its command returns.
    await expect.poll(() => page.evaluate(() => window.photoStudio.history.labels)).toEqual(['Invert']);
    await run(page, 'image.flip-horizontal');
    await run(page, 'image.flip-horizontal');
    const body = await showPanel(page);
    await expect(body.locator('.prov-timeline')).toContainText('Opened photo.png');
    await expect(body.locator('.prov-entry.prov-edits')).toHaveCount(2);
    await expect(body.locator('.prov-entry.prov-edits').last()).toContainText('×2');
    await expect(body.locator('.prov-summary')).toContainText('3 edit steps');
    // The filters are one tab stop; arrow keys move between them.
    const filters = body.getByRole('radiogroup', { name: 'Show' });
    await filters.getByRole('radio', { name: 'All' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(filters.getByRole('radio', { name: 'Edits' })).toBeFocused();
    await expect(filters.getByRole('radio', { name: 'Edits' })).toHaveAttribute('aria-checked', 'true');
    await expect(body.locator('.prov-entry.prov-sources')).toHaveCount(0);
    await page.keyboard.press('ArrowLeft');
    await expect(filters.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
    await expect(body.locator('.prov-entry.prov-sources')).toHaveCount(1);

    // Undo, then a different edit: the undone step stays, marked as undone.
    await page.evaluate(() => window.photoStudio.runCommand('edit.undo'));
    await idle(page);
    await run(page, 'adjust.desaturate');
    await expect(body.locator('.prov-undone')).toHaveCount(1);

    await setAttach(page, 'signed');
    const png = await exportAs(page, 'png');
    expect(png.name).toMatch(/\.png$/);
    const report = await inspect(page, png.bytes);
    expect(report.errors).toEqual([]);
    expect(report).toMatchObject({ format: 'png', pixelMatches: true, signature: true, selfSigned: true, dataHash: true, assertions: true });
    expect(report.sources).toEqual([['photo.png', 'opened', 64]]);
    expect(report.steps!.map((s) => s[1])).toEqual(expect.arrayContaining(['adjust.invert', 'image.flip-horizontal', 'adjust.desaturate']));
    expect(report.actions).toContain('c2pa.opened');
    // The export is in the record (panel and file).
    await expect(body.locator('.prov-entry.prov-exports')).toHaveCount(1);
    expect(report.exports).toBe(1);

    // Changing metadata breaks the signed byte hash but not the pixel hash.
    const tampered = await page.evaluate(async (data) => {
      const { insertPngChunks, makeTextChunk } = await import('/src/imaging/codecs/png-chunks.ts');
      return [...insertPngChunks(new Uint8Array(data), [makeTextChunk('Comment', 'edited elsewhere')])];
    }, [...png.bytes]);
    const after = await inspect(page, Buffer.from(tampered));
    expect(after).toMatchObject({ pixelMatches: true, signature: true, dataHash: false });

    const jpeg = await exportAs(page, 'jpeg');
    expect(await inspect(page, jpeg.bytes)).toMatchObject({ format: 'jpeg', pixelMatches: true, signature: true, dataHash: true });
    // WebP gets the record only.
    const webp = await exportAs(page, 'webp');
    const w = await inspect(page, webp.bytes);
    expect(w).toMatchObject({ format: 'webp', pixelMatches: true });
    expect(w.signature).toBeUndefined();

    // File → Inspect Provenance shows the checks.
    const chooser = page.waitForEvent('filechooser');
    await start(page, 'file.inspect-provenance');
    await (await chooser).setFiles({ name: 'exported.png', mimeType: 'image/png', buffer: png.bytes });
    const dialog = page.locator('dialog.inspect-provenance');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.prov-check.prov-ok')).toContainText(['Match', 'Valid', 'Intact', 'Bound']);
    await expect(dialog).toContainText('self-signed');
    await expect(dialog.locator('.prov-timeline')).toContainText('Invert');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
    await idle(page);
  });

  test('exports without provenance by default and keeps the record in .photo projects', async ({ page }) => {
    await boot(page);
    await openImage(page, 40, 30, '#aa5500', 'base.png');
    await run(page, 'adjust.invert');
    await expect.poll(() => page.evaluate(() => window.photoStudio.history.labels)).toEqual(['Invert']);
    const plain = await exportAs(page, 'png');
    const none = await inspect(page, plain.bytes);
    expect(none.pixelMatches).toBeUndefined();
    expect(none.signature).toBeUndefined();

    // Save as a project and open it again: the record comes back and continues.
    const sidecar = (bytes: Buffer) => {
      const length = bytes.readUInt32LE(8);
      const r = JSON.parse(bytes.subarray(12, 12 + length).toString('utf8')).sidecars.provenance;
      return { id: r.id, steps: r.steps.map((s: { label: string }) => s.label), exports: r.exports.length, sources: r.sources.map((s: { name: string }) => s.name) };
    };
    const saved = await downloadFrom(page, () => page.evaluate(() => window.photoStudio.runCommand('file.download-project')));
    const first = sidecar(saved.bytes);
    expect(first).toMatchObject({ steps: ['Invert'], exports: 1, sources: ['base.png'] });
    const id = first.id;
    await openFiles(page, { name: 'base.photo', mimeType: 'application/octet-stream', buffer: saved.bytes });
    await run(page, 'image.flip-vertical');
    const again = await downloadFrom(page, () => page.evaluate(() => window.photoStudio.runCommand('file.download-project')));
    const reopened = sidecar(again.bytes);
    reopened.steps = reopened.steps.slice(0, 1);
    expect(reopened).toEqual({ id, steps: ['Invert'], exports: 1, sources: ['base.png'] });
  });
});
