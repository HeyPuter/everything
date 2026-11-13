import { expect, test } from '@playwright/test';
import { boot, downloadFrom, idle, openImage, run } from './helpers';

test('downloading a project marks its saved local comments clean', async ({ page }) => {
  await boot(page);
  await openImage(page, 16, 16, '#336699');
  await page.evaluate(async () => {
    const { commentsOf } = await import('/src/features/collab/state.ts');
    commentsOf(window.photoStudio).add({ x: 4, y: 4 }, 'Saved note');
  });
  const file = await downloadFrom(page, () => run(page, 'file.download-project'));
  const project = JSON.parse(file.bytes.subarray(12, 12 + file.bytes.readUInt32LE(8)).toString());
  expect(project.document.comments[0].messages[0].text).toBe('Saved note');
  expect(await page.evaluate(() => window.photoStudio.session.dirty)).toBe(false);
});

for (const late of [false, true]) {
  test(`saving comments with ${late ? 'a later edit preserves' : 'no later edit clears'} the dirty state`, async ({ page }) => {
    await boot(page, 'default', `window.puter={env:'app',ui:{showSaveFilePicker:(blob,name)=>{
      window.savedCommentProject=blob;
      return new Promise(resolve=>window.finishCommentSave=()=>resolve({path:'/saved/'+name,name}));
    }}};`);
    await openImage(page, 16, 16, '#336699');
    await page.evaluate(async () => {
      const { commentsOf } = await import('/src/features/collab/state.ts');
      commentsOf(window.photoStudio).add({ x: 4, y: 4 }, 'Saved note');
    });
    await run(page, 'file.save-as');
    await page.waitForFunction(() => !!(window as unknown as { finishCommentSave?: () => void }).finishCommentSave);
    await page.evaluate(async (late) => {
      if (late) {
        const { commentsOf } = await import('/src/features/collab/state.ts');
        commentsOf(window.photoStudio).add({ x: 8, y: 8 }, 'Later note');
      }
      (window as unknown as { finishCommentSave(): void }).finishCommentSave();
    }, late);
    await expect.poll(() => page.evaluate(() => window.photoStudio.session.storage.path)).toMatch(/^\/saved\//);
    await idle(page);
    expect(await page.evaluate(() => window.photoStudio.session.dirty)).toBe(late);
    const saved = await page.evaluate(async () => {
      const { deserialize } = await import('/src/model/serialization.ts');
      const { document } = await deserialize((window as unknown as { savedCommentProject: Blob }).savedCommentProject);
      return document.comments?.map((t) => t.messages[0].text);
    });
    expect(saved).toEqual(['Saved note']);
  });
}
