// A plan keeps editing the document it was made for when another document
// tab is chosen while it runs.
import { test, expect } from '@playwright/test';
import { boot, openImage } from './helpers';

const PUTER = `window.__chatScript=[];
window.puter={env:"app",auth:{isSignedIn:()=>true},ai:{chat:async()=>window.__chatScript.shift()??{message:{role:"assistant",content:"Done."}}}};`;

test('a running plan finishes in its own document after a tab switch', async ({ page }) => {
  await boot(page, 'default', PUTER);
  await openImage(page, 60, 40, '#808080', 'other.png');
  await openImage(page, 80, 50, '#808080', 'planned.png');
  await page.evaluate(() => window.photoStudio.dock.show('assistant'));
  const steps = [{ action: 'image.flip-horizontal' }, { action: 'image.rotate-cw' }];
  await page.evaluate((steps) => {
    const call = {
      id: 'c1',
      type: 'function',
      function: { name: 'propose_plan', arguments: JSON.stringify({ title: 'Turn', steps }) },
    };
    (window as unknown as { __chatScript: unknown[] }).__chatScript.push({
      message: { role: 'assistant', content: '', tool_calls: [call] },
    });
  }, steps);
  const input = page.getByRole('textbox', { name: 'Describe an edit or ask a question' });
  await input.fill('mirror and turn it');
  await input.press('Enter');
  const plan = page.locator('.ast-plan');
  await expect(plan.locator('.ast-step')).toHaveCount(2);
  // The person picks the other tab while the first step runs.
  await page.evaluate(async () => {
    const { commands } = await import('/src/app/registry.ts');
    const flip = commands.get('image.flip-horizontal')!;
    const run = flip.run;
    flip.run = async (e, arg) => {
      await run(e, arg);
      flip.run = run;
      await e.switchSession(e.sessions.find((s) => s.doc.name.startsWith('other'))!);
    };
  });
  await plan.getByRole('button', { name: 'Run All' }).click();
  await page.waitForFunction(() => {
    const s = window.photoStudio.sessions.find((x) => x.doc.name.startsWith('planned'))!;
    return s.history.labels.at(-1) === 'Assistant: mirror and turn it';
  });
  const docs = await page.evaluate(() =>
    window.photoStudio.sessions.map((s) => ({
      name: s.doc.name,
      width: s.doc.width,
      labels: s.history.labels.filter((l) => !/^(Open|New)/.test(l)),
    })),
  );
  expect(docs.find((d) => d.name.startsWith('other'))).toMatchObject({ width: 60, labels: [] });
  expect(docs.find((d) => d.name.startsWith('planned'))).toMatchObject({
    width: 50,
    labels: ['Assistant: mirror and turn it'],
  });
});
