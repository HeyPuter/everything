import { test, expect } from '@playwright/test';
import { menuBarMenu } from './helpers/editor-tools.js';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const runs = page => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs[0].runs.map(r => [r.text, r.revision?.type || '']));
const caret = page => input(page).evaluate(el => [el.selectionStart, el.selectionEnd]);
async function markup(page, label) {
  await (await menuBarMenu(page, 'View')).getByRole('menuitem', { name: 'Markup', exact: true }).click();
  await page.getByRole('menuitemradio', { name: label, exact: true }).click();
  await input(page).focus();
}

test('with deletions hidden, arrows, Backspace, Delete and typing pass over them', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Alpha beta gamma.');
  await input(page).press('ControlOrMeta+Shift+e');
  await input(page).evaluate(el => { el.setSelectionRange(6, 11); el.dispatchEvent(new Event('select')); });
  await input(page).press('Backspace');
  expect(await runs(page)).toEqual([['Alpha ', ''], ['beta ', 'del'], ['gamma.', '']]);
  for (const view of ['No Markup', 'Simple Markup']) {
    await markup(page, view);
    // Before "gamma": one Left goes before the space that shows before it.
    await input(page).evaluate(el => { el.setSelectionRange(11, 11); el.dispatchEvent(new Event('select')); });
    await input(page).press('ArrowLeft');
    expect(await caret(page)).toEqual([5, 5]);
    await input(page).press('ArrowRight');
    expect(await caret(page)).toEqual([6, 6]);
    await input(page).press('ArrowRight');
    expect(await caret(page)).toEqual([12, 12]);
    await input(page).press('Shift+ArrowLeft'); await input(page).press('Shift+ArrowLeft');
    expect(await caret(page)).toEqual([5, 12]);
    await input(page).press('ArrowRight');
  }
  // The reported case: Backspace deletes the space a reader sees, and typing lands in shown text.
  await input(page).evaluate(el => { el.setSelectionRange(11, 11); el.dispatchEvent(new Event('select')); });
  await input(page).press('Backspace');
  await input(page).press('ArrowLeft'); await input(page).press('ArrowLeft');
  await page.keyboard.type('Z');
  await markup(page, 'All Markup');
  expect(await runs(page)).toEqual([['Alp', ''], ['Z', 'ins'], ['ha', ''], [' beta ', 'del'], ['gamma.', '']]);
  // Delete before hidden text deletes the character after it.
  await markup(page, 'No Markup');
  await input(page).evaluate(el => { el.setSelectionRange(6, 6); el.dispatchEvent(new Event('select')); });
  await input(page).press('Delete');
  await markup(page, 'All Markup');
  expect(await runs(page)).toEqual([['Alp', ''], ['Z', 'ins'], ['ha', ''], [' beta ', 'del'], ['g', 'del'], ['amma.', '']]);
});

test('hidden text is passed over while it is not shown', async ({ page }) => {
  await page.goto('/playground.html');
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/format-features.docx');
  await expect(input(page)).toHaveValue(/Visible hidden words end\./);
  const at = await input(page).evaluate(el => el.value.indexOf('Visible hidden words end.'));
  await input(page).evaluate((el, at) => { el.focus(); el.setSelectionRange(at + 20, at + 20); el.dispatchEvent(new Event('select')); }, at);
  await input(page).press('ArrowLeft');
  expect(await caret(page)).toEqual([at + 7, at + 7]);
  await input(page).press('ArrowRight'); await input(page).press('ArrowRight');
  expect(await caret(page)).toEqual([at + 21, at + 21]);
});
