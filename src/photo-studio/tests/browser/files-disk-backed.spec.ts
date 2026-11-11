// Chromium reads a File picked from disk lazily, so content kept from it
// fails with NotReadableError once the file changes on disk. Linked files
// change on disk by design; placed and imported files must be kept in memory.
import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { boot, idle, openImage, start } from './helpers';

async function png(page: Page, size: number, color: string) {
  const bytes = await page.evaluate(
    async ({ size, color }) => {
      const c = new OffscreenCanvas(size, size);
      const g = c.getContext('2d')!;
      g.fillStyle = color;
      g.fillRect(0, 0, size, size);
      return Array.from(new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()));
    },
    { size, color },
  );
  return Buffer.from(bytes);
}
/** Write the open document as a project, reading every asset it keeps. */
const saveProject = (page: Page) =>
  page.evaluate(async () => {
    const { serialize } = await import('/src/model/serialization.ts');
    const e = window.photoStudio;
    try {
      return (await (await serialize(e.doc, e.assets)).arrayBuffer()).byteLength > 0 ? 'saved' : 'empty';
    } catch (error) {
      return String(error);
    }
  });
async function pickFrom(page: Page, command: string, path: string) {
  const chooser = page.waitForEvent('filechooser');
  await start(page, command);
  await (await chooser).setFiles(path);
}

test('a linked file and imported layers stay readable after the files change on disk', async ({ page }, info) => {
  await boot(page);
  await openImage(page, 64, 64);
  // Without the File System Access picker, files come from a file input.
  await page.evaluate(() => ((window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker = undefined));
  const linked = info.outputPath('linked.png');
  writeFileSync(linked, await png(page, 20, '#f00'));
  await pickFrom(page, 'file.place-linked', linked);
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(2);
  await idle(page);
  writeFileSync(linked, await png(page, 30, '#00f'));
  expect(await saveProject(page)).toBe('saved');

  // Import Layers from a project on disk that is saved again afterwards.
  const project = info.outputPath('layers.photo');
  const bytes = await page.evaluate(async () => {
    const { serialize } = await import('/src/model/serialization.ts');
    const e = window.photoStudio;
    return Array.from(new Uint8Array(await (await serialize(e.doc, e.assets)).arrayBuffer()));
  });
  writeFileSync(project, Buffer.from(bytes));
  await pickFrom(page, 'file.import-layers', project);
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(3);
  await idle(page);
  writeFileSync(project, Buffer.concat([Buffer.from(bytes), Buffer.alloc(100)]));
  expect(await saveProject(page)).toBe('saved');
});
