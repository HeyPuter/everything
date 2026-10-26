import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx, menuBarMenu } from './helpers/editor-tools.js';

async function newDocument(page, text) {
  await page.goto('/playground.html');
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('documents:')) localStorage.removeItem(key); });
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(text);
  return input;
}
async function openFixture(page, name) {
  await page.goto('/playground.html');
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('documents:')) localStorage.removeItem(key); });
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.waitFor();
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('Open DOCX file').setInputFiles(`tests/fixtures/review/${name}`);
  await expect(page.locator('.canvas-message')).not.toContainText('Opening');
  return input;
}
const select = (input, start, end = start) => input.evaluate((el, [a, b]) => { el.setSelectionRange(a, b); el.dispatchEvent(new Event('select', { bubbles: true })); }, [start, end]);
const review = page => page.locator('#ribbon-panel-review');
// The ribbon folds groups to fit the window's fonts and width; open the folded group when its command is hidden.
async function reviewButton(page, name, group) {
  const button = review(page).getByRole('button', { name, exact: true });
  if (!(await button.isVisible())) await review(page).getByRole('button', { name: group, exact: true }).click();
  return page.getByRole('button', { name, exact: true }).filter({ visible: true }).first();
}
async function exported(page, info, name) {
  const download = page.waitForEvent('download');
  await downloadDocx(page);
  const path = info.outputPath(name);
  await (await download).saveAs(path);
  return { path, parts: unzipSync(readFileSync(path)) };
}

test('the Review tab holds proofing, accessibility, language, tracking, compare and protect groups', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await newDocument(page, 'Review tools sample text.');
  await onTab(page, 'review');
  for (const name of ['Editor', 'Thesaurus', 'Word Count', 'Check Accessibility', 'Translate', 'Language', 'New Comment', 'Track Changes', 'Show Markup', 'Tracking Options', 'Accept', 'Compare', 'Restrict Editing']) {
    await expect(review(page).getByRole('button', { name, exact: true, includeHidden: true }).first(), name).toBeAttached();
  }
  await page.screenshot({ path: info.outputPath('review-ribbon.png') });
  expect(errors).toEqual([]);
});

test('the Editor pane corrects spelling and reports readability computed locally', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await newDocument(page, 'Teh report was written by the team. It is clear.');
  await onTab(page, 'review');
  await review(page).getByRole('button', { name: 'Editor', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Editor pane' });
  const issue = pane.getByRole('listitem').filter({ hasText: 'Teh' });
  await expect(issue).toBeVisible();
  await expect(issue.getByRole('button')).toHaveCount(1);
  await issue.click();
  await pane.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(input).toHaveValue('The report was written by the team. It is clear.');
  await expect(pane.locator('.rv-stats')).toContainText('Passive sentences');
  await expect(pane.locator('.rv-stats')).toContainText('50%');
  // AI suggestions stay off until asked for, and say what they send.
  await expect(pane.getByRole('checkbox', { name: /Suggest with/ })).not.toBeChecked();
  await page.screenshot({ path: info.outputPath('editor-pane.png') });
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveValue('Teh report was written by the team. It is clear.');
  expect(errors).toEqual([]);
});

test('the Thesaurus inserts a synonym with the word\'s capitalization, and Word Count counts', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await newDocument(page, 'Happy people smile. A big dog.');
  await select(input, 0, 5);
  await input.press('Shift+F7');
  const pane = page.getByRole('complementary', { name: 'Thesaurus pane' });
  const chip = pane.locator('.rv-word').first();
  await expect(chip).toBeVisible({ timeout: 20000 });
  const word = (await chip.textContent()).trim();
  await chip.click();
  await page.getByRole('menuitem', { name: /^Insert “/ }).click();
  const expected = word[0].toUpperCase() + word.slice(1);
  await expect(input).toHaveValue(`${expected} people smile. A big dog.`);
  await page.screenshot({ path: info.outputPath('thesaurus.png') });
  // Look up another word from the pane, and find antonyms.
  await expect(pane).not.toContainText('null');
  await pane.getByRole('searchbox', { name: 'Look up a word' }).fill('big');
  await pane.getByRole('button', { name: 'Look up', exact: true }).click();
  await expect(pane.locator('.rv-words').first()).toContainText('large');
  await select(input, 0);
  // Ctrl+Shift+G off the Mac; there Cmd+Shift+G is Find Previous, so the status bar's count opens it.
  if (process.platform === 'darwin') await page.locator('.ed-word-count').click(); else await input.press('Control+Shift+g');
  const dialog = page.getByRole('dialog', { name: 'Word Count' });
  await expect(dialog.getByRole('row', { name: /^Words/ })).toContainText('6');
  await expect(dialog.getByRole('row', { name: /^Lines/ })).toContainText('1');
  await page.screenshot({ path: info.outputPath('word-count.png') });
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
});

test('the Thesaurus replaces a selected word together with the space after it, leaving the space', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await newDocument(page, 'A happy dog runs.');
  // Ctrl+Shift+Right off the Mac, or a drag, selects the word and the space after it.
  await select(input, 2, 8);
  expect(await input.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd))).toBe('happy ');
  await input.press('Shift+F7');
  const pane = page.getByRole('complementary', { name: 'Thesaurus pane' });
  const chip = pane.locator('.rv-word').first();
  await expect(chip).toBeVisible({ timeout: 20000 });
  const word = (await chip.textContent()).trim();
  await chip.click();
  await page.getByRole('menuitem', { name: /^Insert “/ }).click();
  await expect(input).toHaveValue(`A ${word} dog runs.`);
  expect(errors).toEqual([]);
});

test('Check Accessibility finds problems and applies quick fixes', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await openFixture(page, 'accessibility.docx');
  await expect(input).toHaveValue(/Accessible report/);
  await onTab(page, 'review');
  await review(page).getByRole('button', { name: 'Check Accessibility', exact: true, includeHidden: true }).first().click({ force: true }).catch(() => {});
  const pane = page.getByRole('complementary', { name: 'Accessibility pane' });
  if (!await pane.isVisible()) await page.evaluate(() => document.querySelector('[aria-label="Check Accessibility"]')?.click());
  await expect(pane).toBeVisible();
  for (const title of ['Missing alternative text', 'Table has no header row', 'Low text contrast', 'Skipped heading level', 'Unclear link text', 'Empty paragraphs used for spacing']) await expect(pane).toContainText(title);
  await page.screenshot({ path: info.outputPath('accessibility.png') });
  const before = await input.inputValue();
  await pane.getByRole('button', { name: 'Remove empty paragraphs' }).click();
  await expect.poll(async () => (await input.inputValue()).split('\n').length).toBe(before.split('\n').length - 2);
  await pane.getByRole('button', { name: 'Add description…' }).click();
  const prompt = page.getByRole('dialog', { name: 'Picture description' });
  await prompt.getByRole('textbox').fill('A small blue square');
  await prompt.getByRole('button', { name: 'Apply' }).click();
  await expect(pane).not.toContainText('Missing alternative text');
  await pane.getByRole('button', { name: 'Use first row as header' }).click();
  await expect(pane).not.toContainText('Table has no header row');
  const { parts } = await exported(page, info, 'accessibility-fixed.docx');
  const xml = strFromU8(parts['word/document.xml']);
  expect(xml).toContain('descr="A small blue square"');
  expect(xml).toMatch(/<w:tblHeader( w:val="1")?\/>/);
  expect(errors).toEqual([]);
});

test('an accessibility quick fix applies where its issue is now after an edit before it', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await newDocument(page, 'Hello    world and text');
  await onTab(page, 'review');
  await (await reviewButton(page, 'Check Accessibility', 'Accessibility')).click();
  const pane = page.getByRole('complementary', { name: 'Accessibility pane' });
  const fix = pane.getByRole('button', { name: 'Use a single space' });
  await expect(fix).toBeVisible();
  // One issue is counted in the singular.
  await expect(pane.getByRole('status')).toHaveText('0 errors · 0 warnings · 1 tip');
  // Typed just before the fix is chosen, before the list is checked again.
  await input.focus();
  await select(input, 0);
  await page.keyboard.type('Big ');
  await fix.click();
  await expect(input).toHaveValue('Big Hello world and text');
  expect(errors).toEqual([]);
});

test('Language marks text and Set As Default updates the document default', async ({ page }, info) => {
  const input = await newDocument(page, 'Hello and bonjour tout le monde.');
  await select(input, 10, 31);
  await onTab(page, 'review');
  await page.evaluate(() => document.querySelector('#ribbon-panel-review [aria-label="Language"][aria-haspopup="menu"]')?.click());
  await page.getByRole('menuitem', { name: 'Set Proofing Language…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Language' });
  await dialog.getByRole('searchbox', { name: 'Find a language' }).fill('fr-FR');
  await dialog.getByRole('option').first().click();
  await dialog.getByRole('checkbox', { name: 'Do not check spelling or grammar' }).check();
  await page.screenshot({ path: info.outputPath('language-dialog.png') });
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  const { parts } = await exported(page, info, 'language.docx');
  const xml = strFromU8(parts['word/document.xml']);
  expect(xml).toMatch(/<w:noProof w:val="1"\/>.*<w:lang w:val="fr-FR"\/>|<w:noProof\/>.*<w:lang w:val="fr-FR"\/>/s);
});

test('tracked formatting shows in the Reviewing Pane and balloons, and rejecting restores it', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await newDocument(page, 'Plain words stay plain.');
  await onTab(page, 'review');
  await input.press('ControlOrMeta+Shift+e');
  await expect(review(page).getByRole('button', { name: 'Track Changes', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await select(input, 6, 11);
  await input.press('ControlOrMeta+b');
  await review(page).getByRole('button', { name: 'Reviewing Pane', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Reviewing Pane' });
  await expect(pane).toContainText('Formatted');
  await expect(pane).toContainText('Bold');
  // Balloons show the formatting change in the margin by default.
  await expect(page.locator('.ed-revision-card')).toContainText('Formatted: Bold');
  await page.screenshot({ path: info.outputPath('tracked-formatting.png') });
  const { parts } = await exported(page, info, 'tracked-formatting.docx');
  expect(strFromU8(parts['word/document.xml'])).toMatch(/<w:rPrChange w:id="\d+" w:author="[^"]*" w:date="[^"]+"><w:rPr\/><\/w:rPrChange>/);
  await select(input, 7);
  await page.locator('#ribbon-panel-review [aria-label="Reject"]').evaluate(button => button.click());
  await expect(pane).not.toContainText('Formatted');
  const { parts: after } = await exported(page, info, 'tracked-formatting-rejected.docx');
  expect(strFromU8(after['word/document.xml'])).not.toMatch(/rPrChange|<w:b\b/);
  expect(errors).toEqual([]);
});

test('Restrict Editing enforces read-only with an editable region and a password', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await newDocument(page, 'Locked text. Open text.');
  await select(input, 13, 23);
  await onTab(page, 'review');
  await (await reviewButton(page, 'Restrict Editing', 'Protect')).click();
  const pane = page.getByRole('complementary', { name: 'Restrict Editing pane' });
  await pane.getByRole('checkbox', { name: 'Limit formatting to a selection of styles' }).check();
  await pane.getByRole('button', { name: 'Choose styles…' }).click();
  const styles = page.getByRole('dialog', { name: 'Formatting Restrictions' });
  await styles.getByRole('checkbox', { name: 'Title', exact: true }).uncheck();
  await styles.getByRole('button', { name: 'OK', exact: true }).click();
  await pane.getByRole('checkbox', { name: 'Allow only this type of editing in the document:' }).check();
  await expect(pane.getByRole('combobox', { name: 'Type of editing allowed' })).toHaveValue('readOnly');
  await select(input, 13, 23);
  await pane.getByRole('checkbox', { name: 'Everyone' }).check();
  await page.screenshot({ path: info.outputPath('restrict-setup.png') });
  await pane.getByRole('button', { name: 'Yes, Start Enforcing Protection' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start Enforcing Protection' });
  await dialog.getByLabel('Password', { exact: true }).fill('pw');
  await dialog.getByLabel('Reenter password').fill('pw');
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(pane).toContainText('protected from unintentional editing');
  await page.screenshot({ path: info.outputPath('restrict-enforced.png') });
  // Outside the region nothing changes; inside it typing works.
  await select(input, 0);
  await input.pressSequentially('X');
  await expect(input).toHaveValue('Locked text. Open text.');
  await pane.getByRole('button', { name: 'Find Next Region I Can Edit' }).click();
  await input.press('End');
  await input.pressSequentially('!');
  await expect(input).toHaveValue('Locked text. Open text.!');
  const { parts, path } = await exported(page, info, 'protected.docx');
  expect(strFromU8(parts['word/settings.xml'])).toMatch(/<w:documentProtection w:edit="readOnly" w:formatting="1" w:enforcement="1" w:algorithmName="SHA-512" w:hashValue="[^"]+" w:saltValue="[^"]+" w:spinCount="100000"\/>/);
  expect(strFromU8(parts['word/styles.xml'])).toMatch(/w:styleId="Title"><w:name w:val="Title"\/><w:basedOn w:val="Normal"\/><w:next w:val="Normal"\/><w:qFormat\/><w:locked\/>/);
  expect(strFromU8(parts['word/document.xml'])).toMatch(/<w:permStart w:id="1" w:edGrp="everyone"\/>/);
  void path;
  // Stopping needs the password.
  await pane.getByRole('button', { name: 'Stop Protection' }).click();
  const unlock = page.getByRole('dialog', { name: 'Stop Protection' });
  await unlock.getByLabel('Password', { exact: true }).fill('nope');
  await unlock.getByRole('button', { name: 'Unprotect' }).click();
  await expect(unlock.getByRole('alert')).toHaveText('The password is incorrect.');
  await unlock.getByLabel('Password', { exact: true }).fill('pw');
  await unlock.getByRole('button', { name: 'Unprotect' }).click();
  await expect(pane.getByRole('button', { name: 'Yes, Start Enforcing Protection' })).toBeVisible();
  await select(input, 0);
  await input.pressSequentially('X');
  await expect(input).toHaveValue('XLocked text. Open text.!');
  expect(errors).toEqual([]);
});

test('Compare Documents shows both sources beside the result and opens it with tracked changes', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await newDocument(page, 'Placeholder.');
  await onTab(page, 'review');
  await page.evaluate(() => document.querySelector('#ribbon-panel-review [aria-label="Compare"][aria-haspopup="menu"]')?.click());
  await page.getByRole('menuitem', { name: 'Compare…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Compare Documents' });
  const [original, revised] = await dialog.locator('input[type="file"]').all();
  await original.setInputFiles('tests/fixtures/review/original.docx');
  await revised.setInputFiles('tests/fixtures/review/revised.docx');
  await page.screenshot({ path: info.outputPath('compare-dialog.png') });
  await dialog.getByRole('button', { name: 'Compare', exact: true }).click();
  const result = page.getByRole('dialog', { name: 'Compared Document' });
  await expect(result.locator('.rv-compare-column')).toHaveCount(3);
  await expect(result).toContainText('labeled “Rae Viewer”');
  await expect(result.locator('ins').first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('compare-result.png') });
  page.once('dialog', d => d.accept());
  await result.getByRole('button', { name: 'Open Document' }).click();
  await expect(input).toHaveValue(/Sales grew by tentwelve percent/, { timeout: 20000 });
  const { path } = await exported(page, info, 'compared.docx');
  void path;
  expect(errors).toEqual([]);
});

test('closing Compare Documents while it works abandons the comparison', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await newDocument(page, 'Placeholder.');
  await onTab(page, 'review');
  await page.evaluate(() => document.querySelector('#ribbon-panel-review [aria-label="Compare"][aria-haspopup="menu"]')?.click());
  await page.getByRole('menuitem', { name: 'Compare…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Compare Documents' });
  const [original, revised] = await dialog.locator('input[type="file"]').all();
  await original.setInputFiles('tests/fixtures/review/original.docx');
  await revised.setInputFiles('tests/fixtures/review/revised.docx');
  // Escape while the documents are still being read: the result must not appear afterwards.
  await dialog.evaluate(node => {
    node.querySelector('button[type="submit"]').click();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await expect(dialog).toHaveCount(0);
  await page.waitForTimeout(1500);
  await expect(page.getByRole('dialog', { name: 'Compared Document' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('comments mention reviewers, list in the Comments pane and filter by author', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await openFixture(page, 'tracked.docx');
  await expect(input).toHaveValue(/Centered by Ada/);
  await select(input, 0, 8);
  await onTab(page, 'review');
  await review(page).getByRole('button', { name: 'New Comment', exact: true }).click();
  const box = page.locator('.ed-comment-draft textarea');
  await box.pressSequentially('Please check, @Gr');
  await expect(page.locator('.wcc-mentions')).toContainText('Grace');
  await box.press('Enter');
  await expect(box).toHaveValue('Please check, @Grace ');
  await box.press('ControlOrMeta+Enter');
  await expect(page.locator('.ed-comment-card .rv-mention')).toHaveText('@Grace');
  await page.evaluate(() => document.querySelector('#ribbon-panel-review [aria-label="Show Comments options"]')?.click());
  await page.getByRole('menuitemradio', { name: 'List' }).click();
  const pane = page.getByRole('complementary', { name: 'Comments pane' });
  await expect(pane.getByRole('listitem')).toHaveCount(1);
  // Each comment is a button within its list item, so screen readers announce it as one.
  await expect(pane.getByRole('list', { name: 'Comments' }).getByRole('listitem').getByRole('button')).toHaveCount(1);
  await pane.getByRole('combobox', { name: 'Show comments by or mentioning' }).selectOption('Grace');
  await expect(pane.getByRole('listitem')).toHaveCount(1); // Mentions count as involvement.
  await page.screenshot({ path: info.outputPath('comments-pane.png') });
  // Show Markup: hide insertions and deletions, then show deletions in balloons.
  await review(page).getByRole('button', { name: 'Show Markup', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Balloons' }).click();
  await page.getByRole('menuitemradio', { name: 'Show Revisions in Balloons' }).click();
  await expect(page.locator('.ed-revision-card[data-kind="del"]').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('Review panes fit a phone screen', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const input = await newDocument(page, 'Phones review too. Teh end.');
  await onTab(page, 'review');
  await page.locator('#ribbon-panel-review [aria-label="Restrict Editing"]').evaluate(b => b.click());
  await expect(page.getByRole('complementary', { name: 'Restrict Editing pane' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('phone-restrict.png') });
  await page.locator('#ribbon-panel-review [aria-label="Editor"]').evaluate(b => b.click());
  await expect(page.getByRole('complementary', { name: 'Editor pane' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('phone-editor.png') });
  await select(input, 0, 6);
  await input.press('Shift+F7');
  const pane = page.getByRole('complementary', { name: 'Thesaurus pane' });
  await expect(pane.locator('.rv-word').first()).toBeVisible({ timeout: 20000 });
  const box = await pane.boundingBox();
  expect(box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath('phone-thesaurus.png') });
});

/** A stand-in for Puter's AI: it reviews and translates deterministically, so the flows can be checked offline. */
async function fakeAi(page) {
  await page.addInitScript(() => {
    window.__prompts = [];
    window.puter = { ai: { chat: async prompt => {
      window.__prompts.push(prompt);
      const items = [...prompt.matchAll(/^\[(\d+)\] (.*)$/gm)].map(m => m[2]);
      if (prompt.includes('proofreader')) return { message: { content: JSON.stringify(items.flatMap((text, i) => text.includes('alot') ? [{ paragraph: i + 1, original: 'alot', suggestion: 'a lot', kind: 'grammar', reason: 'Two words.' }] : [])) } };
      if (prompt.includes('Translate each numbered paragraph')) return JSON.stringify(items.map(text => `«${text.toUpperCase()}»`));
      return '[]';
    } } };
  });
}

test('AI grammar suggestions are opt-in, marked and applied as ordinary edits', async ({ page }, info) => {
  await fakeAi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await newDocument(page, 'Thanks alot for the review.');
  await onTab(page, 'review');
  await review(page).getByRole('button', { name: 'Editor', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Editor pane' });
  await pane.getByRole('checkbox', { name: /Suggest with/ }).check();
  await pane.getByRole('button', { name: 'Check with AI' }).click();
  const item = pane.locator('.rv-ai-item');
  await expect(item).toContainText('alot → a lot');
  await expect(item).toContainText('Grammar');
  await page.screenshot({ path: info.outputPath('editor-ai.png') });
  await item.getByRole('button', { name: 'Accept' }).click();
  await expect(input).toHaveValue('Thanks a lot for the review.');
  expect(await page.evaluate(() => window.__prompts.length)).toBe(1);
});

test('an AI suggestion is accepted while a header is being edited', async ({ page }) => {
  await fakeAi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await newDocument(page, 'Thanks alot for the review.');
  await onTab(page, 'review');
  await review(page).getByRole('button', { name: 'Editor', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Editor pane' });
  await pane.getByRole('checkbox', { name: /Suggest with/ }).check();
  await pane.getByRole('button', { name: 'Check with AI' }).click();
  const item = pane.locator('.rv-ai-item');
  await expect(item).toContainText('alot → a lot');
  await (await onTab(page, 'insert')).locator('#ribbon-panel-insert').getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Header' }).click();
  await expect(page.locator('#ribbon-tab-headerFooter')).toHaveAttribute('aria-selected', 'true');
  await item.getByRole('button', { name: 'Accept' }).click();
  await expect(input).toHaveValue('Thanks a lot for the review.');
  await expect(page.locator('.toast')).toHaveCount(0);
});

test('Translate puts the selection\'s translation in a pane to insert', async ({ page }, info) => {
  await fakeAi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await newDocument(page, 'Good morning. Keep this.');
  await select(input, 0, 13);
  await onTab(page, 'review');
  await page.evaluate(() => document.querySelector('#ribbon-panel-review [aria-label="Translate"][aria-haspopup="menu"]')?.click());
  await page.getByRole('menuitem', { name: 'Translate Selection' }).click();
  const pane = page.getByRole('complementary', { name: 'Translator pane' });
  await pane.getByRole('combobox', { name: 'Translate into' }).selectOption('fr-FR');
  await pane.getByRole('button', { name: 'Translate', exact: true }).click();
  await expect(pane.locator('.rv-translation')).toHaveText('«GOOD MORNING.»');
  await page.screenshot({ path: info.outputPath('translator.png') });
  await pane.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(input).toHaveValue('«GOOD MORNING.» Keep this.');
  const { parts } = await exported(page, info, 'translated.docx');
  expect(strFromU8(parts['word/document.xml'])).toMatch(/<w:lang w:val="fr-FR"\/>/);
});

test('Lock Tracking keeps Track Changes on until unlocked with the password', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await newDocument(page, 'Draft text.');
  await onTab(page, 'review');
  await page.locator('#ribbon-panel-review [aria-label="Track Changes options"]').evaluate(b => b.click());
  await page.getByRole('menuitem', { name: 'Lock Tracking…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Lock Tracking' });
  await dialog.getByLabel('Password', { exact: true }).fill('lock');
  await dialog.getByLabel('Reenter password').fill('lock');
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(review(page).getByRole('button', { name: 'Track Changes', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await input.press('ControlOrMeta+Shift+e');
  await expect(review(page).getByRole('button', { name: 'Track Changes', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await select(input, 11);
  await input.pressSequentially(' More');
  await expect(input).toHaveValue('Draft text. More');
  const { parts } = await exported(page, info, 'locked.docx');
  expect(strFromU8(parts['word/settings.xml'])).toMatch(/<w:trackRevisions\/>.*<w:documentProtection w:edit="trackedChanges" w:enforcement="1" w:algorithmName="SHA-512"/s);
  expect(strFromU8(parts['word/document.xml']).replace(/<\/w:t><\/w:r><w:r><w:t xml:space="preserve">/g, '')).toMatch(/<w:ins [^>]*><w:r><w:t xml:space="preserve"> More<\/w:t>/);
  await page.locator('#ribbon-panel-review [aria-label="Track Changes options"]').evaluate(b => b.click());
  await page.getByRole('menuitem', { name: 'Unlock Tracking…' }).click();
  const unlock = page.getByRole('dialog', { name: 'Unlock Tracking' });
  await unlock.getByLabel('Password', { exact: true }).fill('lock');
  await unlock.getByRole('button', { name: 'Unprotect' }).click();
  await expect(unlock).toBeHidden({ timeout: 20000 });
  await input.press('ControlOrMeta+Shift+e');
  await expect(review(page).getByRole('button', { name: 'Track Changes', exact: true })).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('a document marked Always Open Read-Only offers to open read-only', async ({ page }, info) => {
  const input = await newDocument(page, 'Recommend reading.');
  await (await menuBarMenu(page, 'File')).getByRole('menuitemcheckbox', { name: 'Always Open Read-Only' }).click();
  const { path, parts } = await exported(page, info, 'read-only-recommended.docx');
  expect(strFromU8(parts['word/settings.xml'])).toMatch(/<w:settings[^>]*><w:writeProtection w:recommended="1"\/>/);
  const previous = await input.elementHandle();
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('Open DOCX file').setInputFiles(path);
  await expect.poll(() => previous.evaluate(el => el.isConnected)).toBe(false);
  const ask = page.getByRole('dialog', { name: 'Open read-only?' });
  await ask.getByRole('button', { name: 'Open Read-Only' }).click();
  const reopened = page.getByRole('textbox', { name: 'Document text' });
  await expect(reopened).toHaveValue('Recommend reading.');
  await select(reopened, 0);
  await reopened.pressSequentially('X');
  await expect(reopened).toHaveValue('Recommend reading.');
  const pane = page.getByRole('complementary', { name: 'Restrict Editing pane' });
  await pane.getByRole('button', { name: 'Edit Anyway' }).click();
  await select(reopened, 0);
  await reopened.pressSequentially('X');
  await expect(reopened).toHaveValue('XRecommend reading.');
});

test('the context menu offers synonyms and translation for the word at the caret', async ({ page }) => {
  const input = await newDocument(page, 'A quick test.');
  await select(input, 3);
  const caret = await input.evaluate(el => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top), height: parseFloat(el.style.height) }));
  const surface = await page.locator('.canvas-pages').boundingBox();
  await page.mouse.click(surface.x + caret.left, surface.y + caret.top + caret.height / 2, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Document menu' });
  await menu.getByRole('menuitem', { name: 'Synonyms' }).click();
  const synonyms = page.getByRole('menu', { name: 'Synonyms' });
  await expect(synonyms.getByRole('menuitem').first()).toBeVisible({ timeout: 20000 });
  const first = (await synonyms.getByRole('menuitem').first().textContent()).trim();
  await synonyms.getByRole('menuitem').first().click();
  await expect(input).toHaveValue(`A ${first} test.`);
});

test('Tracking Options change how changes look, and Specific People hides a reviewer', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await openFixture(page, 'tracked.docx');
  await expect(input).toHaveValue(/Centered by Ada/);
  await onTab(page, 'review');
  await page.locator('#ribbon-panel-review [aria-label="Tracking Options"]').evaluate(b => b.click());
  const dialog = page.getByRole('dialog', { name: 'Tracking Options' });
  await dialog.getByRole('combobox', { name: 'Deletion mark' }).selectOption('doubleStrikethrough');
  await dialog.getByRole('combobox', { name: 'Change bar position' }).selectOption('right');
  await dialog.getByRole('combobox', { name: 'Grace color' }).selectOption('2F8A3A');
  await expect(dialog.locator('.rv-preview')).toContainText('deleted text');
  await page.screenshot({ path: info.outputPath('tracking-options.png') });
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await page.screenshot({ path: info.outputPath('tracking-applied.png') });
  // Hide Grace's changes: her balloons and bars go, Ada's stay.
  await review(page).getByRole('button', { name: 'Show Markup', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Specific People' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Grace' }).click();
  await expect(page.locator('.ed-revision-card').filter({ hasText: 'Grace' })).toHaveCount(0);
  await expect(page.locator('.ed-revision-card').filter({ hasText: 'Ada' }).first()).toBeVisible();
  // Accept All Changes Shown leaves Grace's.
  await page.locator('#ribbon-panel-review [aria-label="Accept options"]').evaluate(b => b.click());
  await page.getByRole('menuitem', { name: 'Accept All Changes Shown' }).click();
  await review(page).getByRole('button', { name: 'Show Markup', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Specific People' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'All Reviewers' }).click();
  await review(page).getByRole('button', { name: 'Reviewing Pane', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Reviewing Pane' });
  await expect(pane).toContainText('Grace');
  await expect(pane).not.toContainText('Ada');
  expect(errors).toEqual([]);
});

test('Combine Documents adds the copy\'s differences to the original and the Reviewing Pane can sit below', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await newDocument(page, 'Placeholder.');
  await onTab(page, 'review');
  await page.evaluate(() => document.querySelector('#ribbon-panel-review [aria-label="Compare"][aria-haspopup="menu"]')?.click());
  await page.getByRole('menuitem', { name: 'Combine…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Combine Documents' });
  const [original, revised] = await dialog.locator('input[type="file"]').all();
  await original.setInputFiles('tests/fixtures/review/original.docx');
  await revised.setInputFiles('tests/fixtures/review/revised.docx');
  await dialog.getByRole('textbox', { name: 'Label changes with' }).fill('Copy Editor');
  await page.screenshot({ path: info.outputPath('combine-dialog.png') });
  await dialog.getByRole('button', { name: 'Combine', exact: true }).click();
  const result = page.getByRole('dialog', { name: 'Combined Document' });
  await expect(result).toContainText('labeled “Copy Editor”');
  page.once('dialog', d => d.accept());
  await result.getByRole('button', { name: 'Open Document' }).click();
  await expect(input).toHaveValue(/Sales grew by tentwelve percent/, { timeout: 20000 });
  await page.locator('#ribbon-panel-review [aria-label="Reviewing Pane options"]').evaluate(b => b.click());
  await page.getByRole('menuitemradio', { name: 'Reviewing Pane Horizontal' }).click();
  const pane = page.getByRole('complementary', { name: 'Reviewing Pane' });
  await expect(pane).toHaveAttribute('data-orientation', 'horizontal');
  await expect(pane).toContainText('Copy Editor');
  await page.screenshot({ path: info.outputPath('reviewing-horizontal.png') });
  await exported(page, info, 'combined.docx');
});

test('in the app, Translate Document opens a translated copy', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/mock.html#/new');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input.fill('Hello world.\nSecond line.');
  await onTab(page, 'review');
  await page.evaluate(() => document.querySelector('#ribbon-panel-review [aria-label="Translate"][aria-haspopup="menu"]')?.click());
  await page.getByRole('menuitem', { name: 'Translate Document' }).click();
  const pane = page.getByRole('complementary', { name: 'Translator pane' });
  page.on('dialog', d => d.accept());
  await pane.getByRole('button', { name: 'Translate document…' }).click();
  await expect(input).toHaveValue('[Translated] Hello world.\n[Translated] Second line.', { timeout: 20000 });
  expect(errors).toEqual([]);
});

test('a protected document opens with its permissions shown and unlocks with its password', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await openFixture(page, 'protected.docx');
  await expect(input).toHaveValue(/Policy title/);
  const pane = page.getByRole('complementary', { name: 'Restrict Editing pane' });
  await expect(pane).toContainText('protected from unintentional editing');
  await page.screenshot({ path: info.outputPath('protected-open.png') });
  await select(input, 0);
  await input.pressSequentially('X');
  await expect(input).toHaveValue(/^Policy title/);
  await pane.getByRole('button', { name: 'Find Next Region I Can Edit' }).click();
  await input.pressSequentially('Everyone can change this.');
  await expect(input).toHaveValue(/This sentence is protected\. Everyone can change this\./);
  // The fixture's verifier was computed by a separate implementation (tools/review_fixture.py).
  await pane.getByRole('button', { name: 'Stop Protection' }).click();
  const unlock = page.getByRole('dialog', { name: 'Stop Protection' });
  await unlock.getByLabel('Password', { exact: true }).fill('secret');
  await unlock.getByRole('button', { name: 'Unprotect' }).click();
  await expect(unlock).toBeHidden({ timeout: 20000 });
  await select(input, 0);
  await input.pressSequentially('X');
  await expect(input).toHaveValue(/^XPolicy title/);
  const { parts } = await exported(page, info, 'unprotected.docx');
  expect(strFromU8(parts['word/settings.xml'])).toMatch(/<w:documentProtection w:edit="readOnly" w:enforcement="0"\/>/);
  expect(errors).toEqual([]);
});

test('a comment being written survives edits elsewhere in the document', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input.fill('Alpha beta gamma.');
  await select(input, 6, 10);
  await onTab(page, 'review');
  await review(page).getByRole('button', { name: 'New Comment', exact: true }).click();
  const box = page.locator('.ed-comment-draft textarea');
  await box.pressSequentially('Half written');
  // Someone else's edit (a collaborator, an autosave rewrite) lands before the anchored word.
  const edit = (at, text) => page.evaluate(([at, text]) => {
    const engine = window.__docs.current.view.engine, range = [...engine.model.range];
    engine.execute(() => { engine.model.select(at); engine.model.replace(text); engine.model.select(...range); });
  }, [at, text]);
  await edit(0, 'Intro ');
  await expect(box).toHaveValue('Half written');
  // Even when the box does not have focus, a rebuilt column keeps the words typed so far.
  await input.focus();
  await edit(0, 'More ');
  await page.evaluate(() => {
    const engine = window.__docs.current.view.engine, at = engine.model.text.indexOf('gamma');
    engine.execute(() => engine.model.addComment({ author: 'Grace', text: 'Elsewhere', range: [at, at + 5] }));
  });
  await expect(page.locator('.ed-comment-card:not(.ed-comment-draft)')).toHaveCount(1);
  await expect(box).toHaveValue('Half written');
  await box.evaluate(b => { b.focus(); b.setSelectionRange(b.value.length, b.value.length); });
  await box.pressSequentially(' and finished');
  await box.press('ControlOrMeta+Enter');
  // The comment keeps what was typed and is still anchored on the word it was started on.
  const comments = () => page.evaluate(() => {
    const model = window.__docs.current.view.engine.model, text = model.text;
    return model.commentList.map(c => [c.text, text.slice(c.start, c.end)]);
  });
  await expect.poll(comments).toEqual([['Half written and finished', 'beta'], ['Elsewhere', 'gamma']]);
  await expect(input).toHaveValue('More Intro Alpha beta gamma.');
  expect(errors).toEqual([]);
});

test('a comment card that grows while a reply is typed pushes the cards below it down', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = await newDocument(page, 'Alpha beta gamma delta.\nSecond line here.\nThird line.');
  await onTab(page, 'review');
  for (const [start, end, text] of [[6, 10, 'First comment'], [24, 30, 'Second comment']]) {
    await select(input, start, end);
    await review(page).getByRole('button', { name: 'New Comment', exact: true }).click();
    await page.locator('.ed-comment-draft textarea').fill(text);
    await page.locator('.ed-comment-draft').getByRole('button', { name: 'Post' }).click();
  }
  const cards = page.locator('.ed-comment-card');
  await expect(cards).toHaveCount(2);
  await cards.first().click();
  const reply = cards.first().locator('.wcc-reply textarea');
  await reply.click();
  await reply.pressSequentially('First line');
  for (let i = 0; i < 5; i++) { await reply.press('Shift+Enter'); await reply.pressSequentially(`More text ${i}`); }
  // The second card sits below the first, however tall the first has grown.
  await expect.poll(() => cards.evaluateAll(nodes => {
    const [first, second] = nodes.map(n => n.getBoundingClientRect());
    return second.top >= first.bottom;
  })).toBe(true);
  expect(errors).toEqual([]);
});
