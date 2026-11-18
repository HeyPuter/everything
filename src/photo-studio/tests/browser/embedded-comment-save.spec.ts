import { expect, test } from '@playwright/test';
import { boot, openImage, run } from './helpers';

for (const late of [false, true]) {
  test(`saving embedded comments ${late ? 'preserves edits made during the save' : 'clears the saved dirty state'}`, async ({ page }) => {
    await boot(page);
    await openImage(page, 24, 24, '#ffffff', 'parent.png');
    await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(16, 16);
      canvas.getContext('2d')!.fillRect(0, 0, 16, 16);
      const { openFile } = await import('/src/features/files/open.ts');
      await openFile(window.photoStudio, await canvas.convertToBlob(), 'child.png', true);
    });
    await run(page, 'layer.embed-edit');
    const result = await page.evaluate(async (late) => {
      const e = window.photoStudio;
      const s = e.session;
      const { commentsOf } = await import('/src/features/collab/state.ts');
      const { saveContents, ownerOf } = await import('/src/features/embedded/edit.ts');
      const { deserialize } = await import('/src/model/serialization.ts');
      const comments = commentsOf(e);
      comments.add({ x: 4, y: 4 }, 'First');
      const saving = saveContents(e, s);
      if (late) comments.add({ x: 8, y: 8 }, 'Later');
      await saving;
      const owner = ownerOf(s)!;
      const blob = owner.parent.assets.blob(owner.parent.doc.embeds![owner.contents!]!.project!);
      const saved = (await deserialize(blob)).document.comments?.map((t) => t.messages[0].text);
      return { dirty: s.dirty, saved };
    }, late);
    expect(result).toEqual({ dirty: late, saved: ['First'] });
    await run(page, 'file.save');
    expect(await page.evaluate(() => window.photoStudio.session.dirty)).toBe(false);
    await run(page, 'file.close');
    expect(await page.evaluate(() => window.photoStudio.sessions.length)).toBe(1);
  });
}

test('contents of a parent that refuses edits (view-only sharing) stay unsaved', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 24, 24, '#ffffff', 'parent.png');
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(16, 16);
    canvas.getContext('2d')!.fillRect(0, 0, 16, 16);
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, await canvas.convertToBlob(), 'child.png', true);
  });
  await run(page, 'layer.embed-edit');
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const s = e.session;
    const { saveContents, ownerOf } = await import('/src/features/embedded/edit.ts');
    const parent = ownerOf(s)!.parent;
    // As a shared document opened for viewing: edits are refused.
    const refusal = 'You can view this shared document but not change it.';
    Object.defineProperty(parent.history, 'refusal', { get: () => refusal });
    parent.history.execute = () => e.message(refusal);
    const before = parent.doc;
    e.command('Hide', (d) => (d.layers[0].visible = false));
    await saveContents(e, s);
    return {
      dirty: s.dirty,
      parentChanged: parent.doc !== before,
      status: document.querySelector('#status')!.textContent,
    };
  });
  expect(result.dirty).toBe(true);
  expect(result.parentChanged).toBe(false);
  expect(result.status).toContain('stay unsaved');
});

test('Replace Contents leaves a locked embedded object as it is', async ({ page }) => {
  await boot(page);
  await openImage(page, 24, 24, '#ffffff', 'parent.png');
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(16, 16);
    canvas.getContext('2d')!.fillRect(0, 0, 16, 16);
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, await canvas.convertToBlob(), 'child.png', true);
  });
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const id = e.layer!.id;
    e.command('Lock', (d) => (d.layers.find((l) => l.id === id)!.locked = true));
    const before = JSON.stringify(e.doc.layers.find((l) => l.id === id));
    const canvas = new OffscreenCanvas(30, 10);
    canvas.getContext('2d')!.fillRect(0, 0, 30, 10);
    const file = new File([await canvas.convertToBlob()], 'other.png', { type: 'image/png' });
    const { replaceContents } = await import('/src/features/embedded/convert.ts');
    let error = '';
    try {
      await replaceContents(e, file);
    } catch (x) {
      error = String(x);
    }
    return { error, same: JSON.stringify(e.doc.layers.find((l) => l.id === id)) === before };
  });
  expect(result.error).toContain('Unlock');
  expect(result.same).toBe(true);
});
