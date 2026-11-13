import { expect, test } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

for (const existing of [false, true]) {
  test(`opening a project with Comments visible loads its notes in ${existing ? 'a new tab' : 'the empty workspace'}`, async ({ page }) => {
    await boot(page);
    if (existing) await openImage(page, 16, 16, '#336699');
    await run(page, 'window.panel.comments');
    await expect(page.locator('.comments-panel')).toBeVisible();
    await page.evaluate(async () => {
      const { newDocument } = await import('/src/model/document.ts');
      const { Assets } = await import('/src/model/assets.ts');
      const { newThread } = await import('/src/collab/comments.ts');
      const { serialize } = await import('/src/model/serialization.ts');
      const { openFile } = await import('/src/features/files/open.ts');
      const doc = newDocument(16, 16, 'With notes');
      doc.comments = [newThread({ x: 4, y: 4 }, { id: 'author', name: 'Author' }, 'Saved note')];
      await openFile(window.photoStudio, await serialize(doc, new Assets()), 'with-notes.photo');
    });
    await idle(page);
    const state = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { commentsOf } = await import('/src/features/collab/state.ts');
      const { serialize, deserialize } = await import('/src/model/serialization.ts');
      const live = commentsOf(e).threads().map((t) => t.messages[0].text);
      const saved = (await deserialize(await serialize(e.doc, e.assets))).document.comments?.map((t) => t.messages[0].text) ?? [];
      return { live, saved, dirty: e.session.dirty };
    });
    expect(state).toEqual({ live: ['Saved note'], saved: ['Saved note'], dirty: false });
    await expect(page.locator('.comments-panel')).toContainText('Saved note');
  });
}
