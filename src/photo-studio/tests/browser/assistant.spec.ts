// The Assistant and Generation History in the running app, with Puter's AI
// replaced by a scripted stub: plans from tool-calling replies, running them
// as one undo step, step-by-step runs and edits, answers with "Show me", the
// start screen's describe-an-edit box, and recording and placing AI results.
import { test, expect, type Page } from '@playwright/test';
import { boot, historyLabels, idle, openImage, start, undo } from './helpers';

// puter.ai.chat answers from window.__chatScript (one reply per call, in
// order) and records every call; txt2img returns flat images.
const PUTER = `window.__chatCalls=[];window.__chatScript=[];
window.puter={env:"app",auth:{isSignedIn:()=>true},ai:{
chat:async(messages,test,options)=>{window.__chatCalls.push({messages:JSON.parse(JSON.stringify(messages)),options:JSON.parse(JSON.stringify({...options,signal:undefined}))});const r=window.__chatScript.shift();return r??{message:{role:"assistant",content:"Nothing more to do."}};},
txt2img:async(prompt,opts)=>{const c=document.createElement('canvas');c.width=128;c.height=96;const g=c.getContext('2d');g.fillStyle='#d03030';g.fillRect(0,0,128,96);return {src:c.toDataURL()};}}};`;

type Call = { name: string; args: unknown };
/** Queue model replies: each is text and/or tool calls. */
async function script(page: Page, ...replies: { text?: string; calls?: Call[] }[]) {
  await page.evaluate((replies) => {
    const w = window as unknown as { __chatScript: unknown[] };
    w.__chatScript.push(
      ...replies.map((r, i) => ({
        message: { role: 'assistant', content: r.text ?? '', tool_calls: (r.calls ?? []).map((c, k) => ({ id: `call_${i}_${k}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) },
      })),
    );
  }, replies);
}
const chatCalls = (page: Page) => page.evaluate(() => (window as unknown as { __chatCalls: { messages: { role: string; content: unknown; tool_call_id?: string }[]; options: { model?: string; tools?: { function: { name: string } }[] } }[] }).__chatCalls);

async function openAssistant(page: Page) {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Window', exact: true }).click();
  await page.locator('.menubar-entry.open .menu-item[data-command="window.panel.assistant"]').click();
  await expect(page.locator('.assistant-panel .ast-input')).toBeVisible();
}
async function send(page: Page, text: string) {
  const input = page.getByRole('textbox', { name: 'Describe an edit or ask a question' });
  await input.fill(text);
  await input.press('Enter');
}

test('a described edit becomes a checked plan that runs as one undo step', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await openImage(page, 200, 150, '#808080', 'photo.png');
  await openAssistant(page);
  await expect(page.locator('.ast-intro')).toBeVisible();
  await script(
    page,
    { calls: [{ name: 'search_catalog', args: { query: 'crop' } }] },
    {
      text: 'Here is a plan.',
      calls: [
        {
          name: 'propose_plan',
          args: {
            title: 'Brighter, 16:9',
            summary: 'Brightens the photo with an adjustment layer and crops it to 16:9.',
            steps: [
              { action: 'op.crop', args: { aspect: '16:9' }, note: 'Wide frame' },
              { action: 'op.add_adjustment_layer', args: { kind: 'brightness-contrast', params: { brightness: '40', contrast: 500 } } },
            ],
          },
        },
      ],
    },
  );
  const before = (await historyLabels(page)).length;
  await send(page, 'brighten it and crop to 16:9');
  const plan = page.locator('.ast-plan');
  await expect(plan).toBeVisible();
  await expect(plan.locator('.ast-plan-title')).toHaveText('Brighter, 16:9');
  await expect(plan.locator('.ast-step')).toHaveCount(2);
  await expect(plan.locator('.ast-step').nth(0)).toContainText('To 16:9, centered');
  // Coerced and clamped settings, with a note about the clamp.
  await expect(plan.locator('.ast-step').nth(1)).toContainText('brightness 40, contrast 100');
  await expect(plan.locator('.ast-step').nth(1)).toContainText('above the maximum');
  // The model saw the document, the tools and (by default) a preview image; the search ran.
  const calls = await chatCalls(page);
  expect(calls).toHaveLength(2);
  expect(calls[0].options.model).toBe('claude-fable-5-1');
  expect(calls[0].options.tools!.map((t) => t.function.name)).toEqual(['search_catalog', 'get_details', 'propose_plan', 'answer']);
  const user = calls[0].messages.find((m) => m.role === 'user')!;
  expect(JSON.stringify(user.content)).toContain('200 × 150 px');
  expect(JSON.stringify(user.content)).toContain('image_url');
  const toolResult = calls[1].messages.find((m) => m.role === 'tool')!;
  expect(String(toolResult.content)).toContain('image.crop | Crop | Image');
  // Nothing changed before Run.
  expect((await historyLabels(page)).length).toBe(before);
  await plan.getByRole('button', { name: 'Run All' }).click();
  await expect(plan.locator('.ast-outcome')).toContainText('Done: 2 steps applied as one undo step.');
  await idle(page);
  const after = await page.evaluate(() => ({ w: window.photoStudio.doc.width, h: window.photoStudio.doc.height, layers: window.photoStudio.doc.layers.map((l) => l.kind), adj: window.photoStudio.doc.layers.at(-1)?.adjustment }));
  expect(after).toMatchObject({ w: 200, h: 113, layers: ['pixel', 'adjustment'] });
  expect(after.adj).toMatchObject({ kind: 'brightness-contrast', params: { brightness: 40, contrast: 100 } });
  const labels = await historyLabels(page);
  expect(labels.length).toBe(before + 1);
  expect(labels.at(-1)).toBe('Assistant: Brighter, 16:9');
  await undo(page);
  expect(await page.evaluate(() => [window.photoStudio.doc.height, window.photoStudio.doc.layers.length])).toEqual([150, 1]);
  // The next request carries the plan and its outcome as conversation history.
  await script(page, { text: 'You are welcome.' });
  await send(page, 'thanks');
  await expect(page.locator('.ast-bot').last()).toContainText('You are welcome.');
  const last = (await chatCalls(page)).at(-1)!;
  expect(JSON.stringify(last.messages)).toContain('Outcome: Done: 2 steps applied');
});

test('plans are validated, edited, run step by step and stopped', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await openImage(page, 160, 120, '#406080', 'photo.png');
  await openAssistant(page);
  await script(page, {
    calls: [
      {
        name: 'propose_plan',
        args: {
          title: 'Test plan',
          steps: [
            { action: 'image.crop' },
            { action: 'filter.apply.not-a-filter' },
            { action: 'filter.apply.gaussian-blur', args: { radius: 'four' } },
            { action: 'op.set_layer', args: { opacity: 50 } },
            { action: 'op.add_text', args: { text: 'Hello', size: 20, color: 'white' } },
            { action: 'op.add_fill_layer', args: { color: '#ff8800', opacity: 30, blendMode: 'Soft Light' } },
          ],
        },
      },
    ],
  });
  await send(page, 'do things');
  const plan = page.locator('.ast-plan');
  const steps = plan.locator('.ast-step');
  await expect(steps).toHaveCount(6);
  await expect(steps.nth(0)).toContainText('needs a selection, and there is none at this point');
  await expect(steps.nth(1)).toContainText('There is no command “filter.apply.not-a-filter”');
  await expect(steps.nth(2)).toContainText('must be a number');
  await expect(plan.getByRole('button', { name: 'Run All' })).toBeDisabled();
  // Remove two bad steps from the keyboard and fix the third in its settings form.
  await steps.nth(0).getByRole('button', { name: 'Remove step 1' }).press('Enter');
  await steps.nth(0).getByRole('button', { name: 'Remove step 1' }).press('Enter');
  await expect(steps).toHaveCount(4);
  await steps.nth(0).getByRole('button', { name: 'Edit' }).click();
  const radius = steps.nth(0).getByRole('spinbutton', { name: /Radius/ });
  await radius.fill('2.5');
  await steps.nth(0).getByRole('button', { name: 'Apply' }).click();
  await expect(steps.nth(0)).toContainText('Radius 2.5');
  await expect(plan.getByRole('button', { name: 'Run All' })).toBeEnabled();
  // Step by step: the first step runs, then the rest is stopped.
  const before = (await historyLabels(page)).length;
  await plan.getByRole('button', { name: 'Step', exact: true }).click();
  await expect(plan.getByRole('button', { name: 'Next Step' })).toBeVisible();
  await expect(steps.nth(0)).toHaveClass(/status-done/);
  await plan.getByRole('button', { name: 'Next Step' }).click();
  await expect(steps.nth(1)).toHaveClass(/status-done/);
  await plan.getByRole('button', { name: 'Stop' }).click();
  await expect(plan.locator('.ast-outcome')).toContainText('Stopped after 2 of 4 steps.');
  await expect(steps.nth(2)).toHaveClass(/status-skipped/);
  const labels = await historyLabels(page);
  expect(labels.length).toBe(before + 1);
  expect(labels.at(-1)).toBe('Assistant: Test plan');
  expect(await page.evaluate(() => window.photoStudio.doc.layers[0].opacity)).toBe(0.5);
  // A new plan with the remaining edits runs all at once; text and fill layers appear.
  await script(page, { calls: [{ name: 'propose_plan', args: { title: 'Text', steps: [{ action: 'op.add_text', args: { text: 'Hello', size: 20, color: 'white' } }, { action: 'op.add_fill_layer', args: { color: '#ff8800', opacity: 30, blendMode: 'Soft Light' } }] } }] });
  await send(page, 'add the text');
  const second = page.locator('.ast-plan').last();
  await second.getByRole('button', { name: 'Run All' }).click();
  await expect(second.locator('.ast-outcome')).toContainText('Done');
  const layers = await page.evaluate(() => window.photoStudio.doc.layers.map((l) => [l.kind, l.blend, Math.round(l.opacity * 100)]));
  expect(layers).toEqual([['pixel', 'normal', 50], ['text', 'normal', 100], ['solid', 'soft light', 30]]);
  expect((await historyLabels(page)).length).toBe(before + 2);
});

test('answers point at commands, tools and panels with Show me', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await openImage(page, 120, 90, '#808080', 'photo.png');
  await openAssistant(page);
  await script(page, {
    calls: [{ name: 'answer', args: { text: 'Use **Image > Image Rotation > 90° Clockwise**, or the ruler to straighten.', pointers: ['image.rotate-cw', 'tool.ruler', 'panel.history', 'nonsense'] } }],
  });
  await send(page, 'how do I rotate a photo?');
  const answer = page.locator('.ast-bot').last();
  await expect(answer.locator('strong').first()).toHaveText('Image > Image Rotation > 90° Clockwise');
  await expect(answer.locator('.ast-pointers li')).toHaveCount(3);
  await answer.getByRole('button', { name: /Show me 90° Clockwise/ }).click();
  const item = page.locator('.menubar-entry.open .menu-item[data-command="image.rotate-cw"]');
  await expect(item).toBeVisible();
  await expect(item).toHaveClass(/menu-reveal/);
  await expect(item).toBeFocused();
  await page.keyboard.press('Escape');
  await answer.getByRole('button', { name: /Show me Ruler/ }).click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.tool)).toBe('ruler');
  // The model never ran a command: nothing changed.
  expect(await historyLabels(page)).not.toContain('Assistant');
});

test('the start screen hands a described edit to the Assistant', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await script(page, { calls: [{ name: 'propose_plan', args: { title: 'Square', steps: [{ action: 'op.crop', args: { aspect: '1:1' } }] } }] });
  const box = page.getByRole('region', { name: 'Describe an edit' });
  await expect(box).toBeVisible();
  await box.getByRole('button', { name: 'Start' }).click();
  await expect(page.locator('#status')).toHaveText('Describe the edit first.');
  await box.getByRole('textbox', { name: 'Describe an edit' }).fill('crop it to a square');
  await box.getByRole('textbox', { name: 'Describe an edit' }).press('Enter');
  await expect.poll(() => page.evaluate(() => window.photoStudio.hasDocument)).toBe(true);
  const plan = page.locator('.assistant-panel .ast-plan');
  await expect(plan).toBeVisible();
  await expect(page.locator('.assistant-panel .ast-user')).toContainText('crop it to a square');
  await plan.getByRole('button', { name: 'Run All' }).click();
  await expect(plan.locator('.ast-outcome')).toContainText('Done');
  const d = await page.evaluate(() => [window.photoStudio.doc.width, window.photoStudio.doc.height]);
  expect(d[0]).toBe(d[1]);
});

test('AI results are recorded in Generation History and placed again', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await openImage(page, 200, 150, '#808080', 'photo.png');
  await page.evaluate(async () => {
    const { generationStore } = await import('/src/features/generations/record.ts');
    await generationStore().clear();
  });
  // An Assistant plan opens Generate Image prefilled; nothing is generated until Generate.
  await openAssistant(page);
  await script(page, { calls: [{ name: 'propose_plan', args: { title: 'A kite', summary: 'Generates a kite (uses AI credits).', steps: [{ action: 'edit.generate-image', args: { prompt: 'a red kite', style: 'Watercolor', count: 1 } }] } }] });
  await send(page, 'add a red kite');
  const plan = page.locator('.ast-plan');
  await expect(plan.locator('.ast-tag.ai')).toHaveText('AI credits');
  await expect(plan.locator('.ast-ai-note')).toContainText('Nothing is generated or charged until you press Generate');
  const before = (await historyLabels(page)).length;
  await plan.getByRole('button', { name: 'Run All' }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog.locator('#as-prompt')).toHaveValue('a red kite');
  await expect(dialog.locator('#as-style')).toHaveValue('watercolor');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await dialog.getByRole('button', { name: 'Add Layer' }).click();
  await expect(plan.locator('.ast-outcome')).toContainText('Done');
  const labels = await historyLabels(page);
  expect(labels.length).toBe(before + 1);
  expect(labels.at(-1)).toBe('Assistant: A kite');
  // Generate Image from the menu records its variations too.
  await start(page, 'edit.generate-image');
  await expect(dialog.locator('#as-prompt')).toBeVisible();
  await dialog.locator('#as-prompt').fill('blue sky');
  await dialog.locator('#as-count').selectOption('2');
  await dialog.getByRole('button', { name: 'Generate' }).click();
  await dialog.getByRole('button', { name: 'Add Layer' }).click();
  await idle(page);
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Window', exact: true }).click();
  await page.locator('.menubar-entry.open .menu-item[data-command="window.panel.generations"]').click();
  const panel = page.locator('.generations-panel');
  await expect(panel.locator('.gen-row')).toHaveCount(3);
  await expect(panel.locator('.gen-row').first()).toContainText('blue sky');
  await expect(panel.locator('.gen-row').last()).toContainText('a red kite');
  await expect(panel.locator('.gen-row').last()).toContainText('Assistant');
  // Filter by kind and search prompts.
  await panel.getByRole('combobox', { name: 'Show results of' }).selectOption('assistant');
  await expect(panel.locator('.gen-row')).toHaveCount(1);
  await panel.getByRole('combobox', { name: 'Show results of' }).selectOption('all');
  await panel.getByRole('searchbox', { name: 'Search prompts' }).fill('kite');
  await expect(panel.locator('.gen-row')).toHaveCount(1);
  // Place it again as a new layer.
  const count = await page.evaluate(() => window.photoStudio.doc.layers.length);
  await panel.getByRole('button', { name: 'Place as a new layer: a red kite' }).last().click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(count + 1);
  const placed = await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!);
  expect(placed.generated).toMatchObject({ kind: 'generate', prompt: 'a red kite', style: 'watercolor' });
  expect((await historyLabels(page)).at(-1)).toBe('Place Generated Image');
  // Reuse settings opens the dialog prefilled.
  await panel.getByRole('button', { name: 'Reuse settings: a red kite' }).click();
  await expect(dialog.locator('#as-prompt')).toHaveValue('a red kite');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  // Delete removes the entry.
  await panel.getByRole('button', { name: 'Delete: a red kite' }).click();
  await expect(panel.locator('.gen-row')).toHaveCount(0);
});
