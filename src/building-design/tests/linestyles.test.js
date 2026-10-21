import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { lineStyleOf } from '../src/core/plan.js';
import { lineStyleOptions } from '../src/core/props.js';
import { Scene } from '../src/core/scene.js';

describe('line styles', () => {
  it('resolve built-in names and project styles', () => {
    const { doc, add } = project();
    expect(lineStyleOf(doc, 'dashed')).toEqual([1, 1, null]);
    const st = add({ kind: 'lineStyle', name: 'Demolition', weight: 3, dash: 2, color: '#ff0000' });
    expect(lineStyleOf(doc, st.id)).toEqual([3, 2, [255, 0, 0, 255]]);
    expect(lineStyleOptions(doc).map((o) => o.label)).toContain('Demolition');
  });

  it('draw detail lines in their style', () => {
    const { doc, add } = project();
    const view = doc.all('plan')[0];
    const st = add({ kind: 'lineStyle', name: 'Red', weight: 4, dash: 0, color: '#ff0000' });
    const l = add({ kind: 'detailLine', viewId: view.id, a: [0, 0], b: [1000, 0], style: st.id });
    const g = new Scene(doc).planOf(view, doc.get(l.id));
    expect(g.lines[0].w).toBe(4);
    expect(g.lines[0].c).toEqual([255, 0, 0, 255]);
  });
});
