import { expect, test } from '@playwright/test';
import { boot, openImage } from './helpers';

for (const during of [false, true]) {
  test(`version autosave includes comments added ${during ? 'during' : 'after'} the previous write`, async ({ page }) => {
    await boot(page);
    await openImage(page, 16, 16, '#336699');
    const result = await page.evaluate(async (during) => {
      const e = window.photoStudio;
      const s = e.session;
      const doc = s.doc;
      s.saved = doc;
      e.preferences.versionsOnSave = true;
      const { commentsOf } = await import('/src/features/collab/state.ts');
      const { autosaveVersions } = await import('/src/features/versions/index.ts');
      const { VersionStore } = await import('/src/persistence/versions.ts');
      const { deserialize } = await import('/src/model/serialization.ts');
      const comments = commentsOf(e);
      comments.add({ x: 4, y: 4 }, 'First');
      const first = autosaveVersions(e);
      if (!during) await first;
      comments.add({ x: 8, y: 8 }, 'Later');
      await first;
      await autosaveVersions(e);
      await autosaveVersions(e);
      const store = new VersionStore();
      const versions = await store.list(doc.id);
      const saved = await Promise.all(versions.map(async (v) => (await deserialize((await store.project(v.id))!)).document.comments?.map((t) => t.messages[0].text)));
      return { saved: saved.sort((a, b) => a!.length - b!.length), sameDocument: doc === s.doc };
    }, during);
    expect(result).toEqual({ saved: [['First'], ['First', 'Later']], sameDocument: true });
  });
}
