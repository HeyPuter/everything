import { expect, test, type Page } from '@playwright/test';
import { boot, idle, openImage, panel } from './helpers';

// Properties panel sections for text layers.
async function textFixture(page: Page) {
  await boot(page);
  await openImage(page, 240, 160, '#ffffff');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const { textLayer } = await import('/src/imaging/text/model.ts');
    const l = layer('text', 'Hello', 180, 80);
    l.text = 'Hello';
    l.textData = textLayer('Hello', { family: 'Inter', size: 24 });
    e.command('Text fixture', (d) => {
      d.layers.push(l);
    });
    e.selectLayers([l.id]);
  });
  await idle(page);
  return panel(page, 'Properties');
}
const style = (page: Page) =>
  page.evaluate(() => {
    const d = window.photoStudio.layer!.textData!;
    return {
      ...d.content.paragraphs[0].runs[0].style,
      ...d.content.paragraphs[0].style,
      antiAlias: d.antiAlias,
    };
  });

test('text layer Properties edit character, paragraph and type options of the layer', async ({
  page,
}) => {
  const props = await textFixture(page);
  await expect(props.getByRole('region', { name: 'Character' })).toBeVisible();
  const size = props.getByLabel('Font size');
  await expect(size).toHaveValue('24');
  await size.fill('36');
  await size.press('Enter');
  await idle(page);
  expect((await style(page)).size).toBe(36);
  await props.getByRole('button', { name: 'Faux Bold' }).click();
  await idle(page);
  expect((await style(page)).fauxBold).toBe(true);
  await expect(props.getByRole('button', { name: 'Faux Bold' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await props.getByRole('button', { name: 'Right-to-left text' }).click();
  await idle(page);
  expect((await style(page)).direction).toBe('rtl');
  // A left-aligned paragraph starts on the right when it turns right to left.
  expect((await style(page)).align).toBe('right');
  await props.getByRole('button', { name: 'Center text' }).click();
  await idle(page);
  expect((await style(page)).align).toBe('center');
  await props.getByLabel('Anti-aliasing method').selectOption('crisp');
  await idle(page);
  expect((await style(page)).antiAlias).toBe('crisp');
  await props.getByLabel('Tracking').fill('50');
  await props.getByLabel('Tracking').press('Enter');
  await idle(page);
  expect((await style(page)).tracking).toBe(50);
  // Undo restores the stored value and the panel follows.
  await page.keyboard.press('Meta+z');
  await idle(page);
  expect((await style(page)).tracking).toBe(0);
  await expect(props.getByLabel('Tracking')).toHaveValue('0');
});

test('text layer Properties offer the layer quick actions', async ({ page }) => {
  const props = await textFixture(page);
  await props.getByRole('button', { name: 'Convert to shape' }).click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.layer?.kind)).toBe('vector');
});
