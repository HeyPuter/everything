// Text Editor and Python Console operators used by scripts and keymaps.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const run = (page: Page, op: string, props: Record<string, unknown> = {}) =>
  page.evaluate(([o, p]) => {
    const a = (window as any).app;
    return a.run(o, p, { area: a.hoverArea });
  }, [op, props] as const);
const body = (page: Page) => page.evaluate(() => Object.values((window as any).app.doc.texts as Record<string, { body: string }>)[0].body);
const sel = (page: Page) => page.evaluate(() => { const t = document.querySelector('.te-input') as HTMLTextAreaElement; return [t.selectionStart, t.selectionEnd]; });

async function scripting(page: Page, editor: string) {
  await page.locator('.ws-tab', { hasText: 'Scripting' }).first().click();
  const el = page.locator(`.area[data-editor="${editor}"]`);
  const box = (await el.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return el;
}

test('Text Editor: insert, delete, line break, indent or autocomplete, set selection, replace set selected', async ({ page }) => {
  const errors = await openApp(page);
  const te = await scripting(page, 'TEXT');
  await run(page, 'text.new');
  await page.waitForTimeout(100);
  await run(page, 'text.insert', { text: 'def f():' });
  await run(page, 'text.line_break');
  await run(page, 'text.insert', { text: 'return alpha beta' });
  // the block opener indents the new line
  expect(await body(page)).toBe('def f():\n    return alpha beta');
  await run(page, 'text.delete', { type: 'PREVIOUS_WORD' });
  expect(await body(page)).toBe('def f():\n    return alpha ');
  await run(page, 'text.delete', { type: 'PREVIOUS_CHARACTER' });
  // Home goes to the first non-blank character; the next word goes
  await run(page, 'text.move', { type: 'LINE_BEGIN' });
  await run(page, 'text.delete', { type: 'NEXT_WORD' });
  expect(await body(page)).toBe('def f():\n     alpha');
  // undo steps are pushed per operator
  expect(await page.evaluate(() => (window as any).app.undo.history.at(-1).label)).toBe('Edit Text');
  // Tab after blanks indents the line
  await run(page, 'text.indent_or_autocomplete');
  expect(await body(page)).toMatch(/^def f\(\):\n {6,}alpha$/);
  const len = (await body(page)).length;
  // cursor_set / selection_set from pointer positions over the text
  const lines = te.locator('.te-line');
  const l1 = (await lines.nth(0).boundingBox())!;
  await page.evaluate(([x, y]) => { const a = (window as any).app; a.run('text.cursor_set', {}, { area: a.hoverArea, invoke: true, event: { x, y } }); }, [l1.x + 1, l1.y + l1.height / 2]);
  expect(await sel(page)).toEqual([0, 0]);
  const l2 = (await lines.nth(1).boundingBox())!;
  await page.evaluate(([x, y]) => { const a = (window as any).app; a.run('text.selection_set', {}, { area: a.hoverArea, event: { x, y } }); }, [l2.x + 2000, l2.y + l2.height / 2]);
  expect(await sel(page)).toEqual([0, len]);
  // the selection becomes the replacement text
  await run(page, 'text.move', { type: 'FILE_TOP' });
  await run(page, 'text.move_select', { type: 'NEXT_WORD' });
  await run(page, 'text.replace_set_selected');
  await expect(te.locator('.te-sidebar')).toBeVisible();
  expect(await page.evaluate(() => (window as any).app.hoverArea.editor.replaceText)).toBe('def');
  // scrolling by lines
  await run(page, 'text.scroll', { lines: 1 });
  await expectNoErrors(errors);
});

test('Text Editor: jump to a text by name at a line and column', async ({ page }) => {
  const errors = await openApp(page);
  await scripting(page, 'TEXT');
  await run(page, 'text.new');
  await page.evaluate(() => {
    const a = (window as any).app;
    const t = Object.values(a.doc.texts as Record<string, any>)[0];
    t.name = 'tool.py';
    t.body = 'a = 1\nbb = 2\nccc = 3\n';
    a.changed('doc');
  });
  await run(page, 'text.new');
  await page.waitForTimeout(100);
  await run(page, 'text.jump_to_file_at_point', { filepath: '/some/dir/tool.py', line: 2, column: 2 });
  await expect.poll(() => sel(page)).toEqual([15, 15]);
  expect(await page.evaluate(() => (window as any).app.hoverArea.editor.text.name)).toBe('tool.py');
  await expectNoErrors(errors);
});

test('Console: execute, history append, scrollback append, select word / all, banner, language', async ({ page }) => {
  const errors = await openApp(page);
  const con = await scripting(page, 'CONSOLE');
  const input = con.locator('.pc-input');
  await run(page, 'console.language', { language: 'javascript' });
  await run(page, 'console.history_append', { text: '6 * 7', current_character: 1 });
  await expect(input).toHaveValue('6 * 7');
  expect(await input.evaluate((i: HTMLInputElement) => i.selectionStart)).toBe(1);
  await run(page, 'console.execute');
  await expect(con.locator('.pc-line.output', { hasText: /^42$/ })).toHaveCount(1);
  await run(page, 'console.scrollback_append', { text: 'hello from a script', type: 'INFO' });
  await expect(con.locator('.pc-line.info', { hasText: 'hello from a script' })).toHaveCount(1);
  await input.fill('alpha beta');
  await input.evaluate((i: HTMLInputElement) => i.setSelectionRange(7, 7));
  await run(page, 'console.select_word');
  expect(await input.evaluate((i: HTMLInputElement) => [i.selectionStart, i.selectionEnd])).toEqual([6, 10]);
  await run(page, 'console.select_all');
  expect(await input.evaluate((i: HTMLInputElement) => [i.selectionStart, i.selectionEnd])).toEqual([0, 10]);
  // Tab on an empty line indents; after a name it completes
  await input.fill('');
  await run(page, 'console.indent_or_autocomplete');
  await expect(input).toHaveValue('    ');
  const n = await con.locator('.pc-line').count();
  await run(page, 'console.banner');
  expect(await con.locator('.pc-line').count()).toBeGreaterThan(n + 3);
  expect(await run(page, 'console.language', { language: 'cobol' })).toBe('CANCELLED');
  await expectNoErrors(errors.filter((e) => !/cobol/i.test(e)));
});

test('Info: select a report by index, extend toggles', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.ws-tab', { hasText: 'Scripting' }).first().click();
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('mesh.primitive_cube_add', { location: [3, 0, 0] }, { invoke: false });
    a.run('mesh.primitive_cube_add', { location: [-3, 0, 0] }, { invoke: false });
  });
  const info = page.locator('.area[data-editor="INFO"]');
  const b = (await info.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await run(page, 'info.select_pick', { report_index: 0 });
  await expect(info.locator('.info-row.sel')).toHaveCount(1);
  await run(page, 'info.select_pick', { report_index: 1, extend: true });
  await expect(info.locator('.info-row.sel')).toHaveCount(2);
  await run(page, 'info.select_pick', { report_index: 1 });
  await expect(info.locator('.info-row.sel')).toHaveCount(1);
  await expectNoErrors(errors);
});
