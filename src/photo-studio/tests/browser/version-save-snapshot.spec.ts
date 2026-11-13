import { expect, test } from '@playwright/test';
import { boot, openImage, run } from './helpers';

for (const edit of ['document', 'comments']) {
  test(`an on-save version keeps the saved snapshot and autosaves later ${edit} edits`, async ({ page }) => {
    await boot(page, 'default', `window.puter={env:'app',ui:{showSaveFilePicker:(blob,name)=>
      new Promise(resolve=>window.finishVersionSave=()=>resolve({path:'/saved/'+name,name}))}};`);
    await openImage(page, 16, 16, '#336699', 'picture.png');
    await page.evaluate(async () => {
      const e = window.photoStudio;
      e.preferences.versionsOnSave = true;
      const { VersionStore } = await import('/src/persistence/versions.ts');
      const add = VersionStore.prototype.add;
      VersionStore.prototype.add = async function (...args) {
        const version = await add.apply(this, args);
        (window as unknown as { versionStored: boolean }).versionStored = true;
        return version;
      };
      const { commentsOf } = await import('/src/features/collab/state.ts');
      commentsOf(e).add({ x: 4, y: 4 }, 'First');
    });
    await run(page, 'file.save-as');
    await page.waitForFunction(() => !!(window as unknown as { finishVersionSave?: () => void }).finishVersionSave);
    await page.evaluate(async (edit) => {
      const e = window.photoStudio;
      if (edit === 'document') e.command('Later edit', (d) => { d.name = 'Later'; d.layers[0].opacity = 0.5; });
      else {
        const { commentsOf } = await import('/src/features/collab/state.ts');
        commentsOf(e).add({ x: 8, y: 8 }, 'Later');
      }
      (window as unknown as { finishVersionSave(): void }).finishVersionSave();
    }, edit);
    await page.waitForFunction(() => (window as unknown as { versionStored: boolean }).versionStored);
    const result = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { autosaveVersions } = await import('/src/features/versions/index.ts');
      const { VersionStore } = await import('/src/persistence/versions.ts');
      const { deserialize } = await import('/src/model/serialization.ts');
      await autosaveVersions(e);
      const store = new VersionStore();
      const versions = await store.list(e.doc.id);
      return Promise.all(versions.sort((a, b) => a.kind === 'save' ? -1 : b.kind === 'save' ? 1 : 0).map(async (v) => {
        const doc = (await deserialize((await store.project(v.id))!)).document;
        const bitmap = await createImageBitmap(v.thumb!);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        return { kind: v.kind, name: v.docName, savedName: doc.name, comments: doc.comments?.map((t) => t.messages[0].text), alpha: context.getImageData(8, 8, 1, 1).data[3] };
      }));
    });
    expect(result).toEqual([
      { kind: 'save', name: 'picture', savedName: 'picture', comments: ['First'], alpha: 255 },
      { kind: 'auto', name: edit === 'document' ? 'Later' : 'picture', savedName: edit === 'document' ? 'Later' : 'picture', comments: edit === 'comments' ? ['First', 'Later'] : ['First'], alpha: edit === 'document' ? 128 : 255 },
    ]);
  });
}
