// Color ramp eyedroppers: E drags a sampling line, Alt E samples points; both fill the ramp
// under the pointer with the sampled colors (one undo step).
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
async function script(page: Page, code: string) {
  await page.evaluate(async (c) => {
    const { runJavaScript } = await import('/src/scripting/runner.ts' as string);
    const r = runJavaScript(c);
    if (!r.ok) throw new Error(`${r.error} (line ${r.line})`);
  }, code);
}

/** A fixed canvas on top of the page: left half red, right half blue. */
async function swatchCanvas(page: Page) {
  return page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 40;
    Object.assign(c.style, { position: 'fixed', left: '300px', top: '300px', width: '200px', height: '40px', zIndex: '850' });
    c.id = 'test-swatch';
    const g = c.getContext('2d')!;
    g.fillStyle = '#ff0000';
    g.fillRect(0, 0, 100, 40);
    g.fillStyle = '#0000ff';
    g.fillRect(100, 0, 100, 40);
    document.body.append(c);
    return { x: 300, y: 300 };
  });
}

const ramp = (page: Page) => page.evaluate(() => {
  const a = (window as any).app;
  const ma = Object.values(a.doc.materials as Record<string, any>).find((m: any) => m.name === 'RampMat') as any;
  const n = (ma.tree.nodes as any[]).find((x: any) => x.type === 'ShaderNodeValToRGB');
  return n.props.color_ramp as number[];
});

test('E drags a line over colors into the color ramp; Esc restores it', async ({ page }) => {
  const errors = await openApp(page);
  await script(page, `
    const ma = C.object.active_material; ma.name = 'RampMat';
    const r = ma.node_tree.nodes.new('ShaderNodeValToRGB'); r.location = [-300, 0];
    ma.node_tree.nodes.active = r;
  `);
  await page.locator('.ws-tab', { hasText: 'Shading' }).first().click();
  const bar = page.locator('.area[data-editor="SHADER"] .nd-ramp').first();
  await expect(bar).toBeVisible();
  // let the editor finish framing the nodes
  await page.waitForTimeout(600);
  const before = await ramp(page);
  const sw = await swatchCanvas(page);
  const b = (await bar.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 });
  await page.keyboard.press('e');
  await expect(page.locator('.ramp-dropper')).toHaveCount(1);
  await page.mouse.move(sw.x + 5, sw.y + 20);
  await page.mouse.down();
  await page.mouse.move(sw.x + 100, sw.y + 20, { steps: 4 });
  await page.mouse.move(sw.x + 195, sw.y + 20, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('.ramp-dropper')).toHaveCount(0);
  const after = await ramp(page);
  const n = after.length / 5;
  expect(n).toBeGreaterThan(4);
  // first stop red, last stop blue, positions spread over 0..1
  expect(after.slice(0, 5)).toEqual([0, 1, 0, 0, 1]);
  expect(after.slice(-5)).toEqual([1, 0, 0, 1, 1]);
  expect(await page.evaluate(() => (window as any).app.undo.history.at(-1).label)).toBe('Eyedropper Colorband');
  // Alt E: click points, Enter confirms; Esc in a new run restores
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.press('Alt+e');
  await page.mouse.click(sw.x + 150, sw.y + 10);
  await page.mouse.click(sw.x + 50, sw.y + 10);
  await page.keyboard.press('Enter');
  expect(await ramp(page)).toEqual([0, 0, 0, 1, 1, 1, 1, 0, 0, 1]);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.press('Alt+e');
  await page.mouse.click(sw.x + 150, sw.y + 10);
  await page.keyboard.press('Escape');
  expect(await ramp(page)).toEqual([0, 0, 0, 1, 1, 1, 1, 0, 0, 1]);
  void before;
  await expectNoErrors(errors);
});
