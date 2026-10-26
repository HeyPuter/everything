import { test, expect } from '@playwright/test';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

async function newDocument(page, text) {
  await page.goto('/playground.html');
  await page.evaluate(() => { localStorage.removeItem('documents:dictionary'); localStorage.removeItem('documents:spellcheck'); });
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(text);
  return input;
}
const proofing = page => page.locator('.ed-proofing');
/** The right-click menu for a word, opened where its first letter is drawn. */
async function wordMenu(page, input, word) {
  await input.evaluate((el, word) => { const at = el.value.indexOf(word) + 1; el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); }, word);
  const caret = await input.evaluate(el => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top), height: parseFloat(el.style.height) }));
  const surface = await page.locator('.canvas-pages').boundingBox();
  await page.mouse.click(surface.x + caret.left, surface.y + caret.top + caret.height / 2, { button: 'right' });
  return page.getByRole('menu', { name: 'Document menu' });
}

test('marks misspellings as you type, corrects from the menu and the pane, and keeps the document clean', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await newDocument(page, 'Teh quick fox jumpd over the dog. Plain words here.');
  await expect(proofing(page)).toHaveAttribute('aria-label', /2 errors found/);
  const plain = await page.locator('canvas.canvas-page').first().screenshot({ path: info.outputPath('squiggles.png') });
  expect(plain.length).toBeGreaterThan(0);
  // Right-click a misspelled word: suggestions lead the menu.
  const menu = await wordMenu(page, input, 'jumpd');
  await expect(menu.getByRole('menuitem').first()).toHaveText('jumped');
  await menu.getByRole('menuitem', { name: 'jumped', exact: true }).click();
  await expect(input).toHaveValue('Teh quick fox jumped over the dog. Plain words here.');
  await expect(proofing(page)).toHaveAttribute('aria-label', /1 error found/);
  // Review → Spelling (F7) walks through the rest.
  await input.press('ControlOrMeta+Home');
  await input.press('F7');
  const pane = page.getByRole('complementary', { name: 'Spelling' });
  await expect(pane.locator('mark')).toHaveText('Teh');
  await expect(pane.getByRole('option').first()).toHaveText('The');
  await pane.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(input).toHaveValue('The quick fox jumped over the dog. Plain words here.');
  await expect(pane.getByRole('status')).toContainText('complete');
  await expect(proofing(page)).toHaveAttribute('aria-label', 'Spelling: no errors');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(input).toHaveValue('Teh quick fox jumped over the dog. Plain words here.');
  // Marks never reach the saved document.
  const path = info.outputPath('spelling.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  await reopenDocx(page, input, path, 'Teh quick fox jumped over the dog. Plain words here.');
  await expect(proofing(page)).toHaveAttribute('aria-label', /1 error found/);
  expect(errors).toEqual([]);
});

test('Ignore All, Add to Dictionary and turning checking off', async ({ page }) => {
  const input = await newDocument(page, 'Zorblax met Quuxly and Zorblax again.');
  await expect(proofing(page)).toHaveAttribute('aria-label', /3 errors found/);
  await (await wordMenu(page, input, 'Zorblax')).getByRole('menuitem', { name: 'Ignore All' }).click();
  await expect(proofing(page)).toHaveAttribute('aria-label', /1 error found/);
  await (await wordMenu(page, input, 'Quuxly')).getByRole('menuitem', { name: 'Add to Dictionary' }).click();
  await expect(proofing(page)).toHaveAttribute('aria-label', 'Spelling: no errors');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('documents:dictionary')))).toEqual(['Quuxly']);
  await onTab(page, 'review');
  await page.getByRole('button', { name: 'Spelling options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Check Spelling as You Type' }).click();
  await expect(proofing(page)).toHaveAttribute('aria-label', 'Spelling check is off');
  await input.press('End'); await page.keyboard.type(' Blorp.');
  await expect(proofing(page)).toHaveAttribute('aria-label', 'Spelling check is off');
  await page.getByRole('button', { name: 'Spelling options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Check Spelling as You Type' }).click();
  await expect(proofing(page)).toHaveAttribute('aria-label', /1 error found/);
  await page.getByRole('button', { name: 'Spelling options' }).click();
  await page.getByRole('menuitem', { name: 'Recheck Document' }).click();
  await expect(proofing(page)).toHaveAttribute('aria-label', /3 errors found/);
});

test('the Spelling pane corrects the word where it is now after the text before it changed', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  for (const button of ['Change', 'Change All']) {
    const input = await newDocument(page, 'Hello teh world, and teh end.');
    await input.press('ControlOrMeta+Home');
    await input.press('F7');
    const pane = page.getByRole('complementary', { name: 'Spelling' });
    await expect(pane.locator('mark')).toHaveText('teh');
    // The pane stays open while the writer types before the word.
    await input.focus();
    await input.press('ControlOrMeta+Home');
    await page.keyboard.type('Big ');
    await pane.getByRole('button', { name: button, exact: true }).click();
    await expect(input).toHaveValue(button === 'Change' ? 'Big Hello the world, and teh end.' : 'Big Hello the world, and the end.');
    // One correction is one undo step.
    await input.press('ControlOrMeta+z');
    await expect(input).toHaveValue('Big Hello teh world, and teh end.');
  }
  expect(errors).toEqual([]);
});

test('Thai text is not checked against the English dictionary, and Thai can be chosen as its language', async ({ page }) => {
  await newDocument(page, 'ฉันไปโรงเรียนทุกวัน hello wrold now ');
  await expect(proofing(page)).toHaveAttribute('aria-label', /1 error found/);
  await page.locator('.ed-status-language').click();
  const dialog = page.getByRole('dialog', { name: 'Language' });
  await dialog.getByRole('searchbox', { name: 'Search languages' }).fill('Thai');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await expect(dialog.getByRole('option')).toContainText('th-TH');
});

test('a picture in front of the text covers the spelling marks under it, as it covers the words', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.evaluate(() => { localStorage.removeItem('documents:dictionary'); localStorage.removeItem('documents:spellcheck'); });
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Zorblaxx quuxlyy wordsz heree and more misspelld wordz here.');
  await expect(proofing(page)).toHaveAttribute('aria-label', /errors found/);
  await page.evaluate(async () => {
    const e = window.__docs.current.view.engine; e.model.select(0); e.syncInput();
    const canvas = Object.assign(document.createElement('canvas'), { width: 300, height: 80 }), g = canvas.getContext('2d');
    g.fillStyle = '#22aa66'; g.fillRect(0, 0, 300, 80);
    await e.insertImageFile(new File([await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))], 'cover.png', { type: 'image/png' }));
  });
  await page.getByRole('button', { name: /Wrap Text/ }).first().click();
  await page.getByRole('menuitemradio', { name: 'In Front of Text' }).click();
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.layout.floatingObjects.length)).toBe(1);
  // Every pixel of the picture is the picture: no red wave over it where the words under it are misspelled.
  const marks = () => page.evaluate(() => {
    const e = window.__docs.current.view.engine; e.model.select(e.model.text.length); e.syncInput(); e.paint();
    const f = e.layout.floatingObjects[0], canvas = e.canvases[0], scale = canvas.width / e.layout.page.width;
    const count = (left, top, width, height) => {
      const data = canvas.getContext('2d').getImageData(Math.ceil(left * scale), Math.ceil(top * scale), Math.floor(width * scale), Math.floor(height * scale)).data; let red = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] - data[i + 1] > 60 && data[i] - data[i + 2] > 60) red++;
      return red;
    };
    return { covered: count(f.x + 2, f.y + 2, f.width - 4, f.height - 4), beside: count(f.x + f.width + 2, f.y, e.layout.page.width - e.layout.page.right - f.x - f.width - 4, 30) };
  });
  // The misspelled words beside the picture keep their marks once checking has caught up with the change.
  await expect.poll(async () => (await marks()).beside).toBeGreaterThan(0);
  expect((await marks()).covered).toBe(0);
});
