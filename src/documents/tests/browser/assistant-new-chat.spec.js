import { test, expect } from '@playwright/test';

// The mock's chat answers after 700 ms, long enough to start a new chat while a reply is on its way.
test('New chat while a reply is on its way starts afresh at once', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
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
