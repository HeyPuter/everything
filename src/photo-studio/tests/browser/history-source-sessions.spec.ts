import { expect, test, type Page } from '@playwright/test';
import { boot, canvasDrag, compositePixel, idle, openImage, panel, run, start } from './helpers';

async function fill(page: Page, color: string) {
  await page.evaluate((color) => window.photoStudio.setForeground(color), color);
  await run(page, 'edit.fill-foreground');
}

async function snapshot(page: Page, name: string) {
  await start(page, 'history.snapshot');
  const dialog = page.locator('#dialog[open]');
  await dialog.locator('[name=name]').fill(name);
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await idle(page);
  const history = await panel(page, 'History');
  await history.getByRole('button', { name: `Use ${name} as History Brush source`, exact: true }).click();
  await idle(page);
}

test('each document keeps its selected History Brush snapshot across tab switches', async ({ page }) => {
  await boot(page);
  await openImage(page, 64, 48, '#ff0000', 'first.png');
  await fill(page, '#0000ff');
  await snapshot(page, 'Blue');
  await fill(page, '#00ffff');

  await openImage(page, 64, 48, '#808080', 'second.png');
  await fill(page, '#00ff00');
  await snapshot(page, 'Green');
  await fill(page, '#ff00ff');

  for (const [name, source, color] of [
    ['first', 'Blue', [0, 0, 255, 255]],
    ['second', 'Green', [0, 255, 0, 255]],
  ] as const) {
    await page.evaluate(async (name) => {
      const e = window.photoStudio;
      await e.switchSession(e.sessions.find((s) => s.doc.name === name)!);
      e.setTool('history-brush');
    }, name);
    await idle(page);
    await canvasDrag(page, [[24, 24], [40, 24]]);
    await idle(page);
    expect(await compositePixel(page, 32, 24)).toEqual(color);
    const history = await panel(page, 'History');
    await expect(history.getByRole('button', { name: `Use ${source} as History Brush source`, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  // Clearing one document's source must not clear the other one's choice.
  await run(page, 'history.set-source');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    await e.switchSession(e.sessions.find((s) => s.doc.name === 'first')!);
  });
  const history = await panel(page, 'History');
  await expect(history.getByRole('button', { name: 'Use Blue as History Brush source', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
