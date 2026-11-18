// A linked file that was touched but not changed (same bytes, newer date)
// shows as changed once; Update Modified Content then records its new date,
// so it is not reported as changed again on every return to the page.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

const status = (page: Page) =>
  page.evaluate(async () => {
    const e = window.photoStudio;
    const { linkStatus } = await import('/src/features/embedded/link-state.ts');
    const c = Object.values(e.doc.embeds ?? {})[0];
    return c ? linkStatus(c) : 'none';
  });
const focus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

test('Update Modified Content clears a touched linked file for good', async ({ page }) => {
  await boot(page);
  await openImage(page, 64, 48, '#ffffff');
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(8, 8);
    const c = canvas.getContext('2d')!;
    c.fillStyle = '#ff0000';
    c.fillRect(0, 0, 8, 8);
    const bytes = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
    const w = window as unknown as { bytes: ArrayBuffer; file: File; showOpenFilePicker: unknown };
    w.bytes = bytes;
    w.file = new File([bytes], 'logo.png', { type: 'image/png', lastModified: 1_000_000 });
    w.showOpenFilePicker = async () => [{ getFile: async () => w.file }];
  });
  await run(page, 'file.place-linked');
  await expect.poll(() => status(page)).toBe('current');
  // Saved again elsewhere with the same content: a newer date.
  await page.evaluate(() => {
    const w = window as unknown as { bytes: ArrayBuffer; file: File };
    w.file = new File([w.bytes], 'logo.png', { type: 'image/png', lastModified: 2_000_000 });
  });
  await focus(page);
  await expect.poll(() => status(page)).toBe('modified');
  await page.evaluate(() =>
    window.photoStudio.selectLayers([window.photoStudio.doc.layers.at(-1)!.id]),
  );
  await run(page, 'layer.embed-update');
  await expect.poll(() => status(page)).toBe('current');
  await focus(page);
  await idle(page);
  // Give the focus check time to read the file.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
  expect(await status(page)).toBe('current');
});

test('contents converted to a linked file are up to date when the page regains focus', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 64, 48, '#ffffff');
  // An image to place.
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(8, 8);
    canvas.getContext('2d')!.fillRect(0, 0, 8, 8);
    const file = new File([await canvas.convertToBlob({ type: 'image/png' })], 'mark.png', {
      type: 'image/png',
    });
    const w = window as unknown as {
      showOpenFilePicker: unknown;
      showSaveFilePicker: unknown;
      written?: File;
    };
    w.showOpenFilePicker = async () => [{ getFile: async () => file }];
    // A save picker whose file gets its date when it is written.
    w.showSaveFilePicker = async (o: { suggestedName: string }) => ({
      name: o.suggestedName,
      getFile: async () => w.written!,
      createWritable: async () => {
        const parts: Blob[] = [];
        return {
          write: async (b: Blob) => void parts.push(b),
          close: async () =>
            void (w.written = new File(parts, o.suggestedName, { lastModified: 1_234_567 })),
        };
      },
    });
  });
  // Placed linked, then embedded: an embedded object without a link.
  await run(page, 'file.place-linked');
  await page.evaluate(() =>
    window.photoStudio.selectLayers([window.photoStudio.doc.layers.at(-1)!.id]),
  );
  await run(page, 'layer.embed-embed-linked');
  expect(await status(page)).toBeUndefined();
  await page.evaluate(() => void window.photoStudio.runCommand('layer.embed-convert-linked'));
  const dialog = page.locator('#dialog[open]');
  await dialog.getByRole('button', { name: 'Save and Link' }).click();
  await expect.poll(() => status(page)).toBe('current');
  await focus(page);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
  expect(await status(page)).toBe('current');
});
