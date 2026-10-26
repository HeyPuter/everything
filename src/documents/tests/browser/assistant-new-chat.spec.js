import { test, expect } from '@playwright/test';

// The mock's chat answers after 700 ms, long enough to start a new chat while a reply is on its way.
test('New chat while a reply is on its way starts afresh at once', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.evaluate(() => { const chat = puter.ai.chat.bind(puter.ai); window.prompts = []; puter.ai.chat = (prompt, ...rest) => { window.prompts.push(prompt); return chat(prompt, ...rest); }; });
  await page.getByRole('textbox', { name: 'Document text' }).fill('Plans for the old project.');
  await page.locator('.as-title-button').click();
  const pane = page.getByRole('complementary', { name: 'Assistant pane' });
  await pane.getByRole('radio', { name: 'Whole document' }).click();
  const box = pane.getByRole('textbox', { name: 'Message the assistant' });
  await box.fill('First question about the old chat?');
  await box.press('Enter');
  await expect(pane.getByText('Thinking…')).toBeVisible();
  await pane.getByRole('button', { name: 'New chat' }).click();
  // The new chat takes a message straight away, rather than ignoring it until the old reply lands.
  await box.fill('Second question?');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await expect(pane.getByText(/answers: Second question/)).toBeVisible();
  await expect(pane.getByText(/First question/)).toHaveCount(0);
  // Once the old reply has come and gone, it is not part of the new conversation.
  await page.waitForTimeout(800);
  await box.fill('Third question?');
  await box.press('Enter');
  await expect(pane.getByText(/answers: Third question/)).toBeVisible();
  const prompts = await page.evaluate(() => window.prompts);
  expect(prompts).toHaveLength(3);
  expect(prompts[2]).toContain('Person: Second question?');
  expect(prompts[2]).not.toContain('First question');
  await expect(pane.getByRole('button', { name: 'Send' })).toBeEnabled();
});

test('Insert Below puts the reply under the selected paragraph when the selection takes in its mark', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled({ timeout: 20000 });
  const text = page.getByRole('textbox', { name: 'Document text' });
  await text.fill('First para.\nSecond para.\nThird para.');
  // Shift+Down from the start of the first paragraph: the selection ends where the second begins.
  await text.evaluate(el => { el.focus(); el.setSelectionRange(0, 0); el.dispatchEvent(new Event('select')); });
  await text.press('Shift+ArrowDown');
  await page.locator('.as-title-button').click();
  const pane = page.getByRole('complementary', { name: 'Assistant pane' });
  await pane.getByRole('button', { name: 'Make it shorter' }).click();
  await pane.getByRole('button', { name: 'Insert Below' }).click();
  await expect(text).toHaveValue('First para.\nFirst para. (revised)\nSecond para.\nThird para.');
});

test('A reply that echoes a note reference puts no invisible object character into the document', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.evaluate(() => { const chat = puter.ai.chat.bind(puter.ai); window.prompts = []; puter.ai.chat = (prompt, ...rest) => { window.prompts.push(prompt); return chat(prompt, ...rest); }; });
  const text = page.getByRole('textbox', { name: 'Document text' });
  await text.focus();
  await page.keyboard.type('First claim. Second claim.');
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model; m.select(m.text.indexOf('.')); });
  await page.locator('#ribbon-tab-references').click();
  await page.locator('#ribbon-panel-references').getByRole('button', { name: 'Insert Footnote', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Footnote text' })).toBeFocused();
  await page.keyboard.type('A footnote.');
  await page.keyboard.press('Escape');
  await text.focus(); await text.press('ControlOrMeta+a');
  await page.locator('.as-title-button').click();
  const pane = page.getByRole('complementary', { name: 'Assistant pane' });
  // The offline assistant answers with the text it was sent, as a model fixing grammar often does.
  await pane.getByRole('button', { name: 'Fix spelling and grammar' }).click();
  await pane.getByRole('button', { name: 'Replace Selection' }).click();
  await expect(text).toHaveValue('First claim. Second claim. (revised)');
  expect(await page.evaluate(() => window.__docs.current.view.engine.model.text)).not.toContain('￼');
  expect((await page.evaluate(() => window.prompts)).join('')).not.toContain('￼');
});

test('A reply with bullets and numbers goes in as list paragraphs, not as text with markers', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.evaluate(() => { puter.ai.chat = async () => ({ message: { content: 'TEXT:\nKey points:\n\n- Faster saves\n- New templates\n\nNext steps:\n\n1. Install\n2. Restart' } }); });
  const text = page.getByRole('textbox', { name: 'Document text' });
  await text.focus();
  await page.keyboard.type('Release notes');
  await page.locator('.as-title-button').click();
  const pane = page.getByRole('complementary', { name: 'Assistant pane' });
  await pane.getByRole('radio', { name: 'Whole document' }).click();
  await pane.getByRole('textbox', { name: 'Message the assistant' }).fill('Draft the key points and next steps as lists.');
  await pane.getByRole('textbox', { name: 'Message the assistant' }).press('Enter');
  await pane.getByRole('button', { name: 'Insert at Cursor' }).click();
  await expect(text).toHaveValue('Release notesKey points:\nFaster saves\nNew templates\nNext steps:\nInstall\nRestart');
  const lists = await page.evaluate(async () => { const { listKind } = await import('/src/engine/numbering.js'); const m = window.__docs.current.view.engine.model; return m.paragraphs.map(p => (p.list ? listKind(m.numbering, p.list) : '-')); });
  expect(lists).toEqual(['-', 'bullet', 'bullet', '-', 'number', 'number']);
  // One undo takes the whole reply back.
  await pane.getByRole('button', { name: 'Undo' }).click();
  await expect(text).toHaveValue('Release notes');
});

test('what the Assistant sends is one radio group that the arrow keys switch', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled({ timeout: 20000 });
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Plans for the old project.');
  await input.evaluate(el => { el.focus(); el.setSelectionRange(0, 5); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await page.locator('.as-title-button').click();
  const pane = page.getByRole('complementary', { name: 'Assistant pane' });
  const group = pane.getByRole('radiogroup', { name: 'Send with your message' });
  const selection = group.getByRole('radio', { name: 'Selection' }), whole = group.getByRole('radio', { name: 'Whole document' });
  await expect(selection).toBeEnabled();
  const stops = () => group.getByRole('radio').evaluateAll(radios => radios.filter(r => r.tabIndex >= 0).length);
  expect(await stops()).toBe(1);
  const checked = group.getByRole('radio', { checked: true });
  await checked.focus();
  const before = await checked.textContent();
  await page.keyboard.press('ArrowRight');
  const after = before === 'Selection' ? whole : selection;
  await expect(after).toBeFocused();
  await expect(after).toHaveAttribute('aria-checked', 'true');
  expect(await stops()).toBe(1);
  await page.keyboard.press('ArrowLeft');
  await expect(before === 'Selection' ? selection : whole).toBeFocused();
  await expect(before === 'Selection' ? selection : whole).toHaveAttribute('aria-checked', 'true');
});
