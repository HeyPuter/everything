import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { matchesNativePalette } from './helpers/native-color-palette.js';
import { expectBodyEditParts } from './helpers/expect-body-edit-parts.js';

const fixture = 'tests/fixtures/picture-bevel/source.docx';
const reference = JSON.parse(readFileSync('tests/fixtures/picture-bevel/reference.json', 'utf8'));
test('renders native bevel controls through editing, exact undo and reopening', async ({ page }, info) => {
  test.setTimeout(240000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByLabel('Open DOCX file').setInputFiles(fixture);
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^baseline\n/, { timeout: 90000 });
  await expect(input).toHaveJSProperty('readOnly', false);
  const original = await input.inputValue();
  const check = async () => {
    await expect(page.locator('canvas.canvas-page')).toHaveCount(reference.pages.length);
    for (const [i, ref] of reference.pages.entries()) {
      const canvas = page.locator('canvas.canvas-page').nth(i); await canvas.scrollIntoViewIfNeeded();
      // The outer coverage fringe and outline/contour material transitions
      // use boundary checks. Native raster resampling there is not a lighting
      // oracle. Curved highlight profiles have separate native-texel tests.
      const samples = ref.samples.filter(s => s.inset >= .75 && !s.outlineTransition && !s.contourTransition);
      const actual = await canvas.evaluate((canvas, samples) => {
        const ctx = canvas.getContext('2d'), ratio = canvas.width / 612;
        const colors = samples.map(s => [...ctx.getImageData(Math.round(s.x * ratio), Math.round(s.y * ratio), 1, 1).data].slice(0, 3));
        const left = Math.floor(75 * ratio), top = Math.floor(110 * ratio), w = Math.ceil(200 * ratio), h = Math.ceil(165 * ratio);
        const data = ctx.getImageData(left, top, w, h).data, boundary = [];
        const ink = (x, y) => Math.min(...data.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)) < 240;
        for (let y = 0; y < h; y++) {
          let first = -1, last = -1;
          for (let x = 0; x < w; x++) if (ink(x, y)) { if (first < 0) first = x; last = x; }
          if (first >= 0) boundary.push([(left + first) / ratio, (top + y) / ratio], [(left + last + 1) / ratio, (top + y) / ratio]);
        }
        for (let x = 0; x < w; x++) {
          let first = -1, last = -1;
          for (let y = 0; y < h; y++) if (ink(x, y)) { if (first < 0) first = y; last = y; }
          if (first >= 0) boundary.push([(left + x) / ratio, (top + first) / ratio], [(left + x) / ratio, (top + last + 1) / ratio]);
        }
        return { colors, boundary };
      }, samples);
      const color = rgb => ref.imageFilter === '/DCTDecode' ? Array(3).fill(.299 * rgb[0] + .587 * rgb[1] + .114 * rgb[2]) : rgb;
      for (const [j, rgb] of actual.colors.entries()) expect(matchesNativePalette(color(rgb), samples[j].palette.map(color), 4), `${ref.name} ${samples[j].edge} inset ${samples[j].inset}: ${rgb}`).toBe(true);
      expect(actual.boundary.length).toBeGreaterThan(0);
      for (const [from, to] of [[actual.boundary, ref.outline], [ref.outline, actual.boundary]]) {
        const buckets = new Map();
        for (const p of to) { const key = `${Math.floor(p[0] / 2)},${Math.floor(p[1] / 2)}`; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(p); }
        let worst = { distance: 0, point: null };
        for (const [x, y] of from) {
          const bx = Math.floor(x / 2), by = Math.floor(y / 2), nearby = [];
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) nearby.push(...(buckets.get(`${bx + dx},${by + dy}`) || []));
          const distance = Math.min(...nearby.map(([u, v]) => Math.hypot(x - u, y - v)));
          if (distance > worst.distance) worst = { distance, point: [x, y] };
        }
        expect(worst.distance, `${ref.name} boundary at ${worst.point}`).toBeLessThanOrEqual(1.25);
      }
    }
  };
  await check();
  const source = unzipSync(readFileSync(fixture));
  const download = async suffix => {
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
    const path = info.outputPath(`bevel-${suffix}.docx`); await (await pending).saveAs(path); return path;
  };
  const preserved = (path, edited = false) => {
    const saved = unzipSync(readFileSync(path)); expect(Object.keys(saved).sort()).toEqual(Object.keys(source).sort());
    // A body edit also resets saved clean proofing state in settings.xml (§17.15.1.65).
    if (edited) { expectBodyEditParts(saved, source); return; }
    for (const name of Object.keys(source)) expect(Buffer.from(saved[name]).equals(Buffer.from(source[name])), name).toBe(true);
  };
  preserved(await download('noedit'));
  await input.press('ControlOrMeta+Home'); await page.keyboard.insertText('Edited ');
  const edited = await download('edited'); preserved(edited, true);
  await input.press('ControlOrMeta+z'); await expect(input).toHaveValue(original); preserved(await download('undo'));
  const previous = await input.elementHandle(); page.once('dialog', d => d.accept());
  await page.getByLabel('Open DOCX file').setInputFiles(edited);
  await expect.poll(() => previous.evaluate(el => el.isConnected), { timeout: 90000 }).toBe(false);
  await previous.dispose(); await expect(input).toHaveValue('Edited ' + original); await expect(input).toHaveJSProperty('readOnly', false);
  await check(); expect(errors).toEqual([]);
});
