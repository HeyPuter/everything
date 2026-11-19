// An action run by a script event holds the editor like a script does: a
// tab chosen while it plays is shown when it finishes, so every step edits
// the document the event was about.
import { test, expect } from '@playwright/test';
import { boot, idle, openImage } from './helpers';

test('an event action keeps editing its document when another tab is chosen meanwhile', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const steps = [{ command: 'image.flip-horizontal' }, { command: 'image.rotate-cw' }];
    localStorage.setItem(
      'photo-studio-actions',
      JSON.stringify([
        { id: 'evt', name: 'Events', actions: [{ id: 'evt-turn', name: 'Turn', steps }] },
      ]),
    );
  });
  await boot(page);
  await openImage(page, 60, 40, '#808080', 'other.png');
  await page.evaluate(async () => {
    const store = await import('/src/features/scripting/store.ts');
    await store.saveEvents({
      enabled: true,
      rules: [
        { id: 'r1', event: 'open-document', kind: 'action', target: 'evt-turn', enabled: true },
      ],
    });
    // The person picks the other tab while the first step runs.
    const { commands } = await import('/src/app/registry.ts');
    const flip = commands.get('image.flip-horizontal')!;
    const run = flip.run;
    flip.run = async (e, arg) => {
      await run(e, arg);
      flip.run = run;
      const e2 = e as unknown as {
        views: { session: { doc: { name: string } } }[];
        showView(v: unknown): Promise<void>;
      };
      await e2.showView(e2.views.find((v) => v.session.doc.name.startsWith('other'))!);
    };
  });
  await openImage(page, 80, 50, '#808080', 'planned.png');
  const docs = () =>
    page.evaluate(() =>
      window.photoStudio.sessions.map((s) => ({ name: s.doc.name, width: s.doc.width })),
    );
  await expect
    .poll(async () => (await docs()).find((d) => d.name.startsWith('planned'))?.width, {
      timeout: 30_000,
    })
    .toBe(50);
  await idle(page);
  expect((await docs()).find((d) => d.name.startsWith('other'))).toMatchObject({ width: 60 });
  // The chosen tab is shown once the action finished.
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.name)).toMatch(/^other/);
});
