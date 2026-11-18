// Keyboard shortcuts, tool keys and tooltips in the running workspace.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 240, 160, '#808080', 'keys.png');
  await page.locator('#viewport').focus();
});

const tool = (page: Page) => page.evaluate(() => window.photoStudio.tool);
const value = (page: Page, selector: string) => page.locator(selector).inputValue();

test('the registered shortcuts and tool keys do not conflict', async ({ page }) => {
  const problems = await page.evaluate(async () => {
    const { commands, tools } = await import('/src/app/registry.ts');
    const { shortcutConflicts } = await import('/src/app/shortcuts.ts');
    return shortcutConflicts(commands.values(), tools.values());
  });
  expect(problems).toEqual([]);
});

test('tool keys select tools and Shift cycles through a slot', async ({ page }) => {
  for (const [key, id] of [['v', 'move'], ['m', 'rect-marquee'], ['l', 'lasso'], ['c', 'crop'], ['i', 'eyedropper'], ['j', 'spot-healing'], ['b', 'brush'], ['s', 'clone-stamp'], ['y', 'history-brush'], ['e', 'eraser'], ['o', 'dodge'], ['p', 'pen'], ['t', 'type'], ['a', 'path-select'], ['u', 'rect-shape'], ['k', 'frame'], ['h', 'hand'], ['r', 'rotate-view'], ['z', 'zoom']]) {
    await page.keyboard.press(key);
    expect(await tool(page), `key ${key}`).toBe(id);
    await page.locator('#viewport').focus();
  }
  await page.keyboard.press('m');
  await page.keyboard.press('Shift+M');
  expect(await tool(page)).toBe('ellipse-marquee');
  await page.keyboard.press('Shift+M');
  expect(await tool(page)).toBe('rect-marquee');
});

test('brush keys: [ ] size, Shift+[ ] hardness, number keys opacity and flow', async ({ page }) => {
  await page.keyboard.press('b');
  const size = Number(await value(page, '#brush-size'));
  await page.keyboard.press(']');
  expect(Number(await value(page, '#brush-size'))).toBeGreaterThan(size);
  await page.keyboard.press('[');
  expect(Number(await value(page, '#brush-size'))).toBe(size);
  const hardness = Number(await value(page, '#brush-hardness'));
  await page.keyboard.press('Shift+BracketLeft');
  expect(Number(await value(page, '#brush-hardness'))).toBeLessThan(hardness);
  await page.keyboard.press('5');
  await expect(page.locator('#brush-opacity')).toHaveValue('50');
  await page.waitForTimeout(800);
  // Two digits typed quickly give an exact value.
  await page.keyboard.press('4');
  await page.keyboard.press('5');
  await expect(page.locator('#brush-opacity')).toHaveValue('45');
  await page.waitForTimeout(800);
  await page.keyboard.press('0');
  await expect(page.locator('#brush-opacity')).toHaveValue('100');
  await page.waitForTimeout(800);
  await page.keyboard.press('Shift+Digit3');
  await expect(page.locator('#brush-flow')).toHaveValue('30');
  // Every tool with a brush size answers to ] the same way.
  for (const id of ['eraser', 'clone-stamp', 'dodge', 'mixer-brush', 'art-history', 'spot-healing', 'quick-selection']) {
    await page.evaluate((id) => window.photoStudio.setTool(id), id);
    const input = page.locator('#tool-options').locator('#brush-size, #retouch-size').first();
    const before = Number(await input.inputValue());
    await page.locator('#viewport').focus();
    await page.keyboard.press(']');
    expect(Number(await input.inputValue()), id).toBeGreaterThan(before);
  }
});

test('layer keys: opacity, stepping through layers, blend modes and fills', async ({ page }) => {
  await run(page, 'layer.new-quick');
  await run(page, 'layer.new-quick');
  const names = () => page.evaluate(() => window.photoStudio.layer?.name);
  expect(await names()).toBe('Layer 2');
  await page.keyboard.press('Alt+BracketLeft');
  expect(await names()).toBe('Layer 1');
  await page.keyboard.press('Alt+Comma');
  expect(await names()).toBe('Background');
  await page.keyboard.press('Alt+Period');
  expect(await names()).toBe('Layer 2');
  await page.keyboard.press('Alt+Shift+BracketLeft');
  expect(await page.evaluate(() => window.photoStudio.selectedIds.size)).toBe(2);
  await page.keyboard.press('Alt+BracketRight');
  expect(await page.evaluate(() => window.photoStudio.selectedIds.size)).toBe(1);
  // With the Move tool, number keys set the selected layer's opacity as one step.
  await page.keyboard.press('v');
  await page.keyboard.press('3');
  await idle(page);
  await page.waitForTimeout(800);
  await page.keyboard.press('6');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.layer?.opacity)).toBeCloseTo(0.6);
  expect((await page.evaluate(() => window.photoStudio.history.labels)).filter((l) => l === 'Layer Opacity')).toHaveLength(1);
  await page.keyboard.press('Shift+Equal');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.layer?.blend)).toBe('dissolve');
  await page.keyboard.press('Shift+Minus');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.layer?.blend)).toBe('normal');
  // Alt+Backspace fills with the foreground color; Shift+Backspace asks first.
  await page.keyboard.press('Alt+Backspace');
  await idle(page);
  expect((await page.evaluate(() => window.photoStudio.history.labels)).at(-1)).toMatch(/Fill/);
  await page.keyboard.press('Shift+Backspace');
  await expect(page.locator('dialog[open]')).toContainText('Fill');
  await page.keyboard.press('Escape');
});

test('Help lists shortcuts by menu, tools and other keys', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+Shift+Slash');
  const dialog = page.locator('dialog[open]');
  await expect(dialog.locator('h3', { hasText: 'File' })).toBeVisible();
  await expect(dialog.locator('h3', { hasText: 'Tools' })).toBeVisible();
  await expect(dialog.locator('.shortcut-row', { hasText: 'Brush size smaller' })).toHaveCount(1);
  await expect(dialog.locator('.shortcut-row', { hasText: 'Image Size' })).toHaveCount(1);
  await dialog.getByLabel('Filter shortcuts').fill('levels');
  await expect(dialog.locator('.shortcut-row:not([hidden])')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Customize…' }).click();
  await expect(page.locator('dialog[open] h2')).toHaveText('Keyboard Shortcuts');
  await expect(page.locator('dialog[open] .shortcut-editor')).toBeVisible();
});

test('every toolbar tool and options-bar control has a tooltip, with its keys', async ({ page }) => {
  const slots = await page.locator('.tool-slots [data-slot]').evaluateAll((list) => list.map((b) => ({ tool: (b as HTMLElement).dataset.tool, title: b.getAttribute('title') ?? '' })));
  const keys = await page.evaluate(async () => Object.fromEntries([...(await import('/src/app/registry.ts')).tools.values()].map((t) => [t.id, t.key ?? ''])));
  for (const s of slots) {
    expect(s.title.split('\n').length, `${s.tool}: ${s.title}`).toBeGreaterThan(1);
    if (s.tool && keys[s.tool]) expect(s.title).toContain(`(${keys[s.tool].toUpperCase()})`);
  }
  const missing = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { tools } = await import('/src/app/registry.ts');
    const out: string[] = [];
    for (const t of tools.values()) {
      e.setTool(t.id);
      if (e.tool !== t.id) continue;
      await new Promise((r) => setTimeout(r));
      for (const c of document.querySelectorAll<HTMLElement>('#tool-options :is(input:not([type=hidden]), select, button, textarea, [role=slider])'))
        if (!c.title && !c.closest('label')?.title) out.push(`${t.id}: ${c.id || c.getAttribute('aria-label') || c.textContent}`);
    }
    e.setTool('brush');
    await new Promise((r) => setTimeout(r));
    const tip = (id: string) => document.querySelector(`#${id}`)!.closest('label')?.title ?? '';
    if (!/\[.*\]/.test(tip('brush-size'))) out.push('brush size tip names [ ]');
    if (!/Shift\+\[/.test(tip('brush-hardness'))) out.push('hardness tip names Shift+[ ]');
    if (!/Number keys/.test(tip('brush-opacity'))) out.push('opacity tip names the number keys');
    if (!/Shift\+number/.test(tip('brush-flow'))) out.push('flow tip names Shift+number keys');
    return out;
  });
  expect(missing).toEqual([]);
});

test('tooltips name the modifier key of the platform, not a placeholder or the Mac key on Windows', async ({ page }) => {
  const tips = () =>
    page.evaluate(async () => {
      window.photoStudio.setTool('move');
      window.photoStudio.dock.show('swatches');
      await new Promise((r) => requestAnimationFrame(r));
      return { auto: document.querySelector('#auto-select')?.closest('label')?.title ?? document.querySelector('#auto-select')?.getAttribute('title') ?? '', swatch: document.querySelector('[data-swatch]')?.getAttribute('title') ?? '' };
    });
  const mac = await tips();
  expect(mac.auto).toContain('⌘');
  expect(mac.auto).not.toMatch(/\bMod\b/);
  expect(mac.swatch).toContain('⌘-click');
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { get: () => 'Win32' }));
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer, null, { timeout: 90_000 });
  const win = await tips();
  expect(win.auto).toContain('hold Ctrl');
  expect(win.swatch).toContain('Ctrl-click');
  expect(win.swatch).not.toContain('⌘');
});

test('on Windows the shortcut editor shows the alternative that can be typed and finds Ctrl and Mod conflicts', async ({ page }) => {
  // A shortcut recorded on a Mac with the Control key, now used on Windows.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    localStorage.setItem('photo-studio-shortcuts', JSON.stringify({ 'image.trim': 'Ctrl+J' }));
  });
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer, null, { timeout: 90_000 });
  await page.evaluate(() => void window.photoStudio.runCommand('edit.keyboard-shortcuts'));
  const d = page.locator('dialog[open]');
  await expect(d.locator('[data-shortcut="image.trim"]')).toHaveClass(/conflict/);
  await expect(d.locator('[data-shortcut="layer.via-copy"]')).toHaveClass(/conflict/);
  // Last Filter's Mac-only Mod+Ctrl+F cannot be typed here: its other shortcut is shown.
  await expect(d.locator('[data-shortcut="filter.last"]')).toHaveValue('Mod+Alt+F');
});

test('the Measurement Log names Record Measurements by its own shortcut on each platform', async ({ page }) => {
  const texts = () =>
    page.evaluate(async () => {
      window.photoStudio.dock.show('measurement-log');
      await new Promise((r) => requestAnimationFrame(r));
      const body = document.querySelector('[data-panel="measurement-log"]')!;
      return { title: body.querySelector('[data-command="analysis.record"]')?.getAttribute('title') ?? '', empty: body.querySelector('.log-empty')?.textContent ?? '' };
    });
  const mac = await texts();
  expect(mac.title).toBe('Record Measurements (⇧⌘M)');
  expect(mac.empty).toContain('(⇧⌘M)');
  // On Windows, with the shortcut changed in the shortcut editor.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    localStorage.setItem('photo-studio-shortcuts', JSON.stringify({ 'analysis.record': 'Mod+Alt+R' }));
  });
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer, null, { timeout: 90_000 });
  const win = await texts();
  expect(win.title).toBe('Record Measurements (Ctrl+Alt+R)');
  expect(win.empty).toContain('(Ctrl+Alt+R)');
  expect(win.empty).not.toContain('⌘');
});
