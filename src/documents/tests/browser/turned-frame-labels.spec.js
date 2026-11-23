import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { onTab } from './helpers/editor-tools.js';

// The selection frame of a turned picture turns with it; its Move button keeps its text upright rather than
// reading sideways or upside down.
const PNG = readFileSync('icon-128.png');

/** The Move button's turn on screen in degrees: the frame's transform and its own, combined. */
const moveTurn = page => page.locator('.canvas-image-frame').evaluate(frame => {
  const button = frame.querySelector('.canvas-image-move');
  const matrix = new DOMMatrix(getComputedStyle(frame).transform).multiply(new DOMMatrix(getComputedStyle(button).transform));
  return Math.round(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI) || 0;
});

test('the Move button reads upright on a picture turned 90 and 180 degrees', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('A picture follows. ');
  await onTab(page, 'insert');
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('button', { name: 'Move selected image', exact: true })).toBeVisible();
  const ribbon = page.locator('#ribbon-panel-picture');
  const turn = async () => {
    await ribbon.getByRole('button', { name: 'Rotate', exact: true }).click();
    await page.getByRole('menuitem', { name: /Rotate Right 90/ }).click();
  };
  await turn();
  await expect.poll(() => page.locator('.canvas-image-frame').evaluate(frame => frame.style.transform)).toBe('rotate(90deg)');
  expect(await moveTurn(page)).toBe(0);
  await turn();
  await expect.poll(() => page.locator('.canvas-image-frame').evaluate(frame => frame.style.transform)).toBe('rotate(180deg)');
  expect(await moveTurn(page)).toBe(0);
  expect(errors).toEqual([]);
});
