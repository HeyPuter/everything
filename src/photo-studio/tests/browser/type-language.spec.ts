import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  canvasDrag,
  historyLabels,
  idle,
  menu,
  openImage,
  panel,
  run,
  start,
  tool,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 600, 400, '#ffffff');
});

async function paragraphText(page: Page, text: string) {
  await tool(page, 'Horizontal Type Tool');
  await canvasDrag(page, [
    [40, 40],
    [300, 300],
  ]);
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  await idle(page);
}
const paraStyle = (page: Page) =>
  page.evaluate(() => window.photoStudio.layer!.textData!.content.paragraphs[0].style);
const charStyle = (page: Page) =>
  page.evaluate(() => window.photoStudio.layer!.textData!.content.paragraphs[0].runs[0].style);

test('feature sets choose which language options the panels show', async ({ page }) => {
  await paragraphText(page, 'Some paragraph text');
  const para = await panel(page, 'Paragraph');
  const direction = para.locator('[data-features="middle-eastern"]');
  const leading = para.locator('[data-features="east-asian"]');
  await expect(direction).toBeHidden();
  await expect(leading).toBeHidden();

  await menu(page, 'Type', 'Language Options', 'Middle Eastern Features');
  await expect(direction).toBeVisible();
  await expect(leading).toBeHidden();
  expect(await page.evaluate(() => window.photoStudio.preferences.typeFeatures)).toBe(
    'middle-eastern',
  );
  // Kashidas from the panel: one undo step on the layer.
  const before = (await historyLabels(page)).length;
  await para.getByLabel('Kashidas').check();
  await idle(page);
  expect((await paraStyle(page)).kashida).toBe(true);
  expect(await historyLabels(page)).toHaveLength(before + 1);
  // Right-to-left from the direction buttons.
  await para.getByRole('button', { name: 'Right-to-left paragraph' }).click();
  await idle(page);
  expect((await paraStyle(page)).direction).toBe('rtl');
  await expect(para.getByRole('button', { name: 'Right-to-left paragraph' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await menu(page, 'Type', 'Language Options', 'East Asian Features');
  await expect(direction).toBeHidden();
  await expect(leading).toBeVisible();
  await para.getByLabel('How line spacing is measured').selectOption('top');
  await idle(page);
  expect((await paraStyle(page)).leadingModel).toBe('top');
  // The menu shows the same choice and toggles it back.
  await menu(page, 'Type', 'Language Options', 'Top-to-Top Leading');
  expect((await paraStyle(page)).leadingModel || '').toBe('');
  await run(page, 'type.leading-bottom');
  expect((await paraStyle(page)).leadingModel).toBe('bottom');

  // The Character panel shows digit shapes with Middle Eastern features.
  await run(page, 'type.features-middle-eastern');
  const char = await panel(page, 'Character');
  await expect(char.getByLabel('Digit shapes')).toBeVisible();
  await char.getByLabel('Digit shapes').selectOption('arabic');
  await idle(page);
  expect((await charStyle(page)).digits).toBe('arabic');
  await run(page, 'type.features-default');
  await expect(char.getByLabel('Digit shapes')).toBeHidden();
});

test('justification and hyphenation dialogs, composers and resets change paragraph text', async ({
  page,
}) => {
  await paragraphText(
    page,
    'Typography settings change how justified paragraphs space their words and letters',
  );
  await run(page, 'type.composer-every');
  expect((await paraStyle(page)).composer).toBe('every-line');

  // Justification: tighter word spacing, looser letters, auto leading.
  await start(page, 'type.justification');
  const j = page.getByRole('dialog', { name: 'Justification' });
  await j.getByLabel('Word spacing minimum (%)').fill('70');
  await j.getByLabel('Word spacing desired (%)').fill('95');
  await j.getByLabel('Word spacing maximum (%)').fill('150');
  await j.getByLabel('Letter spacing maximum (%)').fill('10');
  await j.getByLabel('Auto leading (%)').fill('140');
  const before = (await historyLabels(page)).length;
  await j.getByRole('button', { name: 'OK' }).click();
  await idle(page);
  let p = await paraStyle(page);
  expect(p.wordSpacing).toEqual([70, 95, 150]);
  expect(p.letterSpacing).toEqual([0, 0, 10]);
  expect(p.autoLeading).toBe(140);
  expect(await historyLabels(page)).toHaveLength(before + 1);

  // Hyphenation: on, with its rules.
  await start(page, 'type.hyphenation');
  const h = page.getByRole('dialog', { name: 'Hyphenation' });
  await h.getByLabel('Hyphenate', { exact: true }).check();
  await h.getByLabel('Words with at least (letters)').fill('7');
  await h.getByLabel('Most hyphens in a row (0: no limit)').fill('2');
  await h.getByLabel('Hyphenate capitalized words').check();
  await h.getByRole('button', { name: 'OK' }).click();
  await idle(page);
  p = await paraStyle(page);
  expect(p).toMatchObject({
    hyphenate: true,
    hyphenMinWord: 7,
    hyphenLimit: 2,
    hyphenCapitalized: true,
  });
  // Escape cancels without a change.
  const n = (await historyLabels(page)).length;
  await start(page, 'type.hyphenation');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  expect(await historyLabels(page)).toHaveLength(n);

  await run(page, 'type.hanging');
  expect((await paraStyle(page)).hanging).toBe(true);

  // Character options from the panel menu commands.
  await run(page, 'type.no-break');
  await run(page, 'type.fractional-widths');
  expect(await charStyle(page)).toMatchObject({ noBreak: true, wholeWidths: true });
  await run(page, 'type.reset-character');
  const c = await charStyle(page);
  expect(!!c.noBreak || !!c.wholeWidths).toBe(false);

  // Reset Paragraph clears every option.
  await run(page, 'type.reset-paragraph');
  p = await paraStyle(page);
  for (const k of [
    'wordSpacing',
    'letterSpacing',
    'autoLeading',
    'hyphenMinWord',
    'hyphenLimit',
    'composer',
    'hanging',
    'leadingModel',
  ] as const)
    expect(p[k]).toBeUndefined();
  expect(p.align).toBe('left');
});

test('kashidas justify Arabic paragraph text', async ({ page }) => {
  await paragraphText(page, 'x');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const m = (
      window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }
    ).photoStudioType;
    await m.editLayers(e, 'Arabic', (d) => ({
      ...d,
      content: {
        paragraphs: [
          {
            runs: [
              {
                text: 'كتب كتب كتب كتب كتب كتب كتب كتب كتب كتب كتب كتب',
                style: { ...d.content.paragraphs[0].runs[0].style, family: 'Noto Sans Arabic' },
              },
            ],
            style: { ...d.content.paragraphs[0].style, align: 'justify-right', direction: 'rtl' },
          },
        ],
      },
    }));
  });
  await idle(page);
  const tatweels = () =>
    page.evaluate(async () => {
      const e = window.photoStudio;
      const { layoutOf, ppiOf } = await import('/src/features/type/text-utils.ts');
      return [
        ...layoutOf(e.layer!.textData!, ppiOf(e))
          .runs.map((r) => r.text)
          .join(''),
      ].filter((c) => c === 'ـ').length;
    });
  expect(await tatweels()).toBe(0);
  await run(page, 'type.kashida');
  expect((await paraStyle(page)).kashida).toBe(true);
  expect(await tatweels()).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath('kashida.png') });
});
