import { test, expect } from '@playwright/test';
import { openApp } from './helpers.js';

test('the assistant runs the functions the AI asks for and shows the answer', async ({ page }) => {
  const errors = await openApp(page, '?sample');
  // A stand-in for Puter's AI: first it asks for a door schedule, then it answers.
  await page.evaluate(() => {
    let round = 0;
    window.__aiCalls = [];
    window.puter = {
      ...(window.puter || {}),
      auth: { isSignedIn: () => true, getUser: async () => ({ username: 'me' }) },
      ai: {
        chat: async (messages, opts) => {
          window.__aiCalls.push({ messages, tools: opts?.tools?.map((t) => t.function.name) });
          round++;
          if (round === 1) return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_schedule', arguments: JSON.stringify({ category: 'door', sortBy: 'level' }) } }] } };
          return { message: { role: 'assistant', content: 'I made a door schedule:\n- sorted by level' } };
        },
      },
    };
  });
  await page.getByRole('button', { name: 'Assistant' }).click();
  const input = page.getByRole('textbox', { name: 'Message to the assistant' });
  await input.fill('Make a door schedule sorted by level');
  await input.press('Enter');
  await expect(page.locator('.as-step')).toContainText('Created Door');
  await expect(page.locator('.as-bot').last()).toContainText('sorted by level');
  const result = await page.evaluate(() => ({
    view: window.bd.activeView?.kind,
    sortBy: window.bd.activeView?.sortBy,
    tools: window.__aiCalls[0].tools,
    toolReply: window.__aiCalls[1].messages.find((m) => m.role === 'tool')?.content,
  }));
  expect(result.view).toBe('schedule');
  expect(result.sortBy).toBe('level');
  expect(result.tools).toContain('find_elements');
  expect(result.toolReply).toContain('created');
  // The change is one undo step.
  await page.evaluate(() => window.bd.undo());
  expect(await page.evaluate(() => window.bd.doc.all('schedule').some((s) => s.sortBy === 'level' && s.category === 'door'))).toBe(false);
  expect(errors).toEqual([]);
});
