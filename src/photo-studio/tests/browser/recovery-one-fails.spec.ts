// A document whose recovery copy cannot be written (here: more File Info text
// than a project holds) does not stop the copies of the other open documents,
// and the failure is reported instead of only logged.
import { expect, test } from '@playwright/test';
import { boot } from './helpers';

test('one document that cannot be kept for recovery does not stop the others', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { newDocument, layer } = await import('/src/model/document.ts');
    const { recoveryTick } = await import('/src/features/versions/recovery.ts');
    const { RecoveryStore } = await import('/src/persistence/versions.ts');
    const store = new RecoveryStore();
    const open = (name: string) => {
      const s = e.sessionForOpen();
      s.history.reset(newDocument(64, 48, name));
      s.hasDocument = true;
      e.session = s;
      e.command('Add', (d) => d.layers.push(layer('solid', 'X', 10, 10)));
      return s;
    };
    const big = open('Huge');
    e.command('Info', (d) => (d.info = { description: 'x'.repeat(17 * 1024 * 1024) }));
    const small = open('Small');
    const messages: string[] = [];
    const message = e.message.bind(e);
    e.message = (text: string) => {
      messages.push(text);
      message(text);
    };
    let thrown = '';
    try {
      await recoveryTick(e);
    } catch (error) {
      thrown = String(error);
    }
    const ids = (await store.list()).map((r) => r.sessionId);
    await store.remove(big.id);
    await store.remove(small.id);
    return { small: ids.includes(small.id), big: ids.includes(big.id), messages, thrown };
  });
  expect(result.thrown).toBe('');
  expect(result.small).toBe(true);
  expect(result.big).toBe(false);
  expect(result.messages.join(' ')).toContain('“Huge” could not be kept for recovery');
});
