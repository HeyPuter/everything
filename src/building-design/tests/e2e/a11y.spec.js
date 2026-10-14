import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { openApp } from './helpers.js';

const require = createRequire(import.meta.url);
const axeSource = require('fs').readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

async function audit(page) {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, { resultTypes: ['violations'] });
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.length} (${v.nodes[0]?.target})`);
  });
}

test('the home screen has no serious accessibility violations', async ({ page }) => {
  await openApp(page);
  expect(await audit(page)).toEqual([]);
});

test('the main interface has no serious accessibility violations', async ({ page }) => {
  await openApp(page, '?sample');
  await page.evaluate(() => window.bd.select([window.bd.doc.all('wall')[0].id]));
  expect(await audit(page)).toEqual([]);
});
