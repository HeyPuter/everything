import { expect, it } from 'vitest';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// Charts in the app's own style (the assistant's, a script's): a legend of up to three rows along the bottom or top.
const pie = k => ({ categories: Array.from({ length: k }, (_, i) => `Category ${i + 1}`), series: [{ name: 'Share', values: Array.from({ length: k }, (_, i) => 40 - i) }] });
const lines = k => ({ categories: ['a', 'b', 'c'], series: Array.from({ length: k }, (_, j) => ({ name: `Series ${j + 1}`, values: [j, j + 1, j + 2] })) });
const legend = svg => [...svg.matchAll(/font-size="12" fill="var\(--ink-2\)">([^<]*)</g)].map(m => m[1]).filter(t => /^(Category|Series|…and)/.test(t));

it.each([['pie', pie(15), 'bottom'], ['line', lines(15), 'top'], ['column', lines(11), 'bottom']])(
  'a %s legend too long for three rows counts the entries it leaves out', (type, data, legendPos) => {
    const names = legend(renderChartSvg(data, { type, legend: true, legendPos }, 340, 210));
    const count = names.at(-1).match(/^…and (\d+) more$/);
    expect(count).toBeTruthy();
    expect(names.length - 1 + Number(count[1])).toBe(type === 'pie' ? 15 : data.series.length);
  });

it('a legend that fits three rows names every entry', () => {
  expect(legend(renderChartSvg(pie(5), { type: 'pie', legend: true }, 340, 210))).toEqual(['Category 1', 'Category 2', 'Category 3', 'Category 4', 'Category 5']);
});
