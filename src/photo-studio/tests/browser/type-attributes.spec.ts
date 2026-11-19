import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  canvasClick,
  historyLabels,
  idle,
  menu,
  openImage,
  run,
  tool,
  undo,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 600, 400, '#ffffff');
});

async function typeText(page: Page, x: number, y: number, text: string) {
  await tool(page, 'Horizontal Type Tool');
  await canvasClick(page, x, y);
  await page.keyboard.type(text);
}
const styleOf = (page: Page, name: string, index = 0) =>
  page.evaluate(
    ([name, index]) => {
      const l = window.photoStudio.doc.layers.find((x) => x.name === name)!;
      let at = index as number;
      for (const p of l.textData!.content.paragraphs)
        for (const r of p.runs) {
          if (at < r.text.length) return { char: r.style, paragraph: p.style, text: l.text };
          at -= r.text.length;
        }
      const p = l.textData!.content.paragraphs[0];
      return { char: p.runs[0].style, paragraph: p.style, text: l.text };
    },
    [name, index] as const,
  );

test('Paste Text Attributes styles type layers and text ranges, keeping their words', async ({
  page,
}) => {
  // The source: bold, large, red, centered.
  await typeText(page, 300, 80, 'Source');
  await page.keyboard.press('Meta+A');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { applyChar, applyParagraph } = (
      window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }
    ).photoStudioType;
    await applyChar(e, { size: 40, weight: 700, color: [200, 20, 20], tracking: 40 });
    await applyParagraph(e, { align: 'center' });
  });
  await page.keyboard.press('Escape');
  await idle(page);
  await run(page, 'edit.copy');

  // A plain layer takes all of them in one step.
  await typeText(page, 40, 200, 'plain words here');
  await page.keyboard.press('Escape');
  await idle(page);
  const before = (await historyLabels(page)).length;
  await menu(page, 'Edit', 'Paste Special', 'Paste Text Attributes');
  await idle(page);
  let s = await styleOf(page, 'plain words here');
  expect(s.text).toBe('plain words here');
  expect(s.char).toMatchObject({ size: 40, weight: 700, color: [200, 20, 20], tracking: 40 });
  expect(s.paragraph.align).toBe('center');
  expect(await historyLabels(page)).toHaveLength(before + 1);
  expect((await historyLabels(page)).at(-1)).toBe('Paste Text Attributes');
  await undo(page);
  expect((await styleOf(page, 'plain words here')).char.size).not.toBe(40);

  // While editing, only the selected range changes; one undo step reverts it.
  await canvasClick(page, 60, 192);
  await page.keyboard.press('Meta+ArrowUp');
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await run(page, 'edit.paste-text-attributes');
  expect(
    await page.evaluate(async () =>
      (
        window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }
      ).photoStudioType.session?.data.content.paragraphs[0].runs.map((r) => [r.text, r.style.size]),
    ),
  ).toEqual([
    ['plain ', 24],
    ['words', 40],
    [' here', 24],
  ]);
  await page.keyboard.press('Meta+Z');
  expect(
    await page.evaluate(
      async () =>
        (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') })
          .photoStudioType.session?.data.content.paragraphs[0].runs.length,
    ),
  ).toBe(1);
  await page.keyboard.press('Meta+Shift+Z');
  await page.keyboard.press('Escape');
  await idle(page);
  s = await styleOf(page, 'plain words here', 7);
  expect(s.char.size).toBe(40);
  expect((await styleOf(page, 'plain words here', 0)).char.size).toBe(24);
  expect(s.text).toBe('plain words here');

  // Copying a range while editing makes it the source.
  await canvasClick(page, 60, 192);
  await page.keyboard.press('Meta+ArrowUp');
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await page.keyboard.press('Meta+C');
  await page.keyboard.press('Escape');
  await idle(page);
  // The source layer takes the copied range's attributes.
  await page.evaluate(() =>
    window.photoStudio.selectLayer(
      window.photoStudio.doc.layers.find((l) => l.name === 'Source')!.id,
    ),
  );
  await run(page, 'edit.paste-text-attributes');
  expect((await styleOf(page, 'Source')).char).toMatchObject({ size: 24, weight: 400 });
  expect((await styleOf(page, 'Source')).text).toBe('Source');
});
