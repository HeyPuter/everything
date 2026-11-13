import { expect, test } from '@playwright/test';
import { boot, openImage } from './helpers';

for (const failFirst of [false, true]) {
  test(`overlapping recovery passes keep the newest document when the first write ${failFirst ? 'fails' : 'is slow'}`, async ({ page }) => {
    await boot(page);
    await openImage(page, 16, 16, '#336699', 'picture.png');
    const result = await page.evaluate(async (failFirst) => {
      const e = window.photoStudio;
      const { recoveryTick } = await import('/src/features/versions/recovery.ts');
      const { RecoveryStore } = await import('/src/persistence/versions.ts');
      const { deserialize } = await import('/src/model/serialization.ts');
      let release = () => {};
      let started = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const writing = new Promise<void>((resolve) => { started = resolve; });
      const save = RecoveryStore.prototype.save;
      let writes = 0;
      RecoveryStore.prototype.save = async function (record) {
        if (++writes === 1) {
          started();
          await gate;
          if (failFirst) throw new Error('Temporary storage failure');
        }
        return save.call(this, record);
      };
      e.command('First edit', (d) => { d.name = 'First'; });
      const first = recoveryTick(e).then(() => '', (error: Error) => error.message);
      await writing;
      e.command('Later edit', (d) => { d.name = 'Latest'; d.layers[0].opacity = 0.5; });
      const later = recoveryTick(e);
      // Give a concurrent write time to finish; an ordered pass waits for the
      // first one instead. Release either way so this also verifies the fix.
      await Promise.race([later, new Promise((resolve) => setTimeout(resolve, 1000))]);
      release();
      const [error] = await Promise.all([first, later]);
      const record = (await new RecoveryStore().list()).find((r) => r.sessionId === e.session.id)!;
      const loaded = await deserialize(record.project);
      const result = { name: record.name, savedName: loaded.document.name, opacity: loaded.document.layers[0].opacity, writes, error };
      loaded.assets.clear();
      return result;
    }, failFirst);
    expect(result).toEqual({ name: 'Latest', savedName: 'Latest', opacity: 0.5, writes: 2, error: failFirst ? 'Temporary storage failure' : '' });
  });
}
