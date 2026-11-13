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
