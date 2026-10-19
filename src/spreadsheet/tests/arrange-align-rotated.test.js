import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// What a turned object covers on the sheet: its box turned about its centre.
function shown(wb, id, obj) {
  const r = wb.objectRect(id, obj), ch = wb.chartById(id, obj), t = (ch.rotation || 0) * Math.PI / 180;
  const w = r.w * Math.abs(Math.cos(t)) + r.h * Math.abs(Math.sin(t)), h = r.w * Math.abs(Math.sin(t)) + r.h * Math.abs(Math.cos(t));
  return { left: r.x + (r.w - w) / 2, top: r.y + (r.h - h) / 2, right: r.x + (r.w + w) / 2, bottom: r.y + (r.h + h) / 2 };
}
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  const a = wb.addChart(id, { type: 'text', text: 'Upright', anchor: { r: 2, c: 5 }, dx: 0, dy: 0, w: 200, h: 60 });
  const b = wb.addChart(id, { type: 'text', text: 'Turned', anchor: { r: 8, c: 9 }, dx: 0, dy: 0, w: 200, h: 60, rotation: 90 });
  return { wb, id, a, b };
}

it.each([['left', 'left'], ['right', 'right'], ['top', 'top'], ['bottom', 'bottom']])('Align %s lines a turned text box up by the edge it shows', (how, edge) => {
  const { wb, id, a, b } = book();
  expect(wb.alignObjects(id, [a, b], how)).toBe(true);
  expect(Math.abs(shown(wb, id, a)[edge] - shown(wb, id, b)[edge])).toBeLessThanOrEqual(1);
});

it('aligns upright objects as before', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const a = wb.addChart(id, { type: 'text', text: 'One', anchor: { r: 2, c: 1 }, dx: 0, dy: 0, w: 200, h: 60 });
  const b = wb.addChart(id, { type: 'text', text: 'Two', anchor: { r: 8, c: 4 }, dx: 10, dy: 0, w: 120, h: 60 });
  wb.alignObjects(id, [a, b], 'left');
  expect(wb.objectRect(id, b).x).toBe(wb.objectRect(id, a).x);
});
