import { expect, test } from '@playwright/test';
import { boot, openImage } from './helpers';

for (const during of [false, true]) {
  test(`recovery includes comments added ${during ? 'during' : 'after'} the previous write`, async ({ page }) => {
    await boot(page);
    await openImage(page, 16, 16, '#336699');
    const result = await page.evaluate(async (during) => {
      const e = window.photoStudio;
      const s = e.session;
      const doc = s.doc;
      s.saved = doc;
      const { commentsOf } = await import('/src/features/collab/state.ts');
      const { recoveryTick } = await import('/src/features/versions/recovery.ts');
      const { RecoveryStore } = await import('/src/persistence/versions.ts');
      const { deserialize } = await import('/src/model/serialization.ts');
      let writes = 0;
      const save = RecoveryStore.prototype.save;
      RecoveryStore.prototype.save = async function (record) { writes++; return save.call(this, record); };
      const comments = commentsOf(e);
      comments.add({ x: 4, y: 4 }, 'First');
      const first = recoveryTick(e);
      if (!during) await first;
      comments.add({ x: 8, y: 8 }, 'Later');
      await first;
      await recoveryTick(e);
      await recoveryTick(e);
      const record = (await new RecoveryStore().list()).find((r) => r.sessionId === s.id)!;
      const recovered = await deserialize(record.project);
      return { comments: recovered.document.comments?.map((t) => t.messages[0].text), writes, sameDocument: doc === s.doc };
    }, during);
    expect(result).toEqual({ comments: ['First', 'Later'], writes: 2, sameDocument: true });
  });
}
