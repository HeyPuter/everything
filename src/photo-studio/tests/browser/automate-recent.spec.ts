// The Image Processor opens projects and PSDs in temporary tabs; those files
// are not the user's recent files and must not push them off Open Recent.
import { expect, test } from '@playwright/test';
import { boot, openImage } from './helpers';

test('processing projects leaves Open Recent as it was', async ({ page }) => {
  await boot(page);
  await openImage(page, 16, 12, '#336699', 'mine.png');
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { serialize } = await import('/src/model/serialization.ts');
    const { runProcessor } = await import('/src/features/files/automate.ts');
    const { recentEntries } = await import('/src/features/files/recent.ts');
    const project = await serialize(e.doc, e.assets);
    const before = recentEntries().map((x) => x.name);
    const inputs = [1, 2, 3].map((i) => ({ name: `batch-${i}.photo`, blob: project }));
    const opts = {
      resize: false,
      w: 0,
      h: 0,
      enlarge: false,
      format: 'png' as const,
      quality: 90,
      srgb: true,
      steps: [],
    };
    const files = await runProcessor(
      e,
      inputs,
      opts,
      () => {},
      () => false,
    );
    return {
      made: files.length,
      before,
      after: recentEntries().map((x) => x.name),
      tabs: e.sessions.length,
    };
  });
  expect(result.made).toBe(3);
  expect(result.tabs).toBe(1);
  expect(result.after).toEqual(result.before);
});
