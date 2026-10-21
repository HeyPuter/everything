// @vitest-environment happy-dom
// Line rendering style modules: scripts that declare line sets, styles and stroke shaders.
import { describe, expect, it } from 'vitest';
import { compileModules, moduleLineSet, moduleLineStyle, shadeStrokes, MODULE_TEMPLATE } from '../../src/lines/modules';

const texts: Record<string, { name: string; body: string }> = {
  a: { name: 'outline.js', body: "lines.draw({ select: { edge_types: ['silhouette'], exclude_edge_types: ['border'], visibility: 'HIDDEN' }, style: { color: [1, 0, 0], thickness: 4, color_modifiers: [{ type: 'ALONG_STROKE' }] } });" },
  b: { name: 'broken.js', body: 'lines.draw(' },
  t: { name: 'template.js', body: MODULE_TEMPLATE },
};
const code = (id: string) => texts[id] ?? null;

describe('style modules', () => {
  it('turn lines.draw calls into line sets and line styles, in module order', () => {
    const c = compileModules({ modules: [{ script: 'a', use: true }, { script: 't', use: true }, { script: 'a', use: false }] }, code);
    expect(c.errors).toEqual([]);
    expect(c.sets).toHaveLength(2);
    const [s0] = c.sets;
    expect(s0.select_silhouette).toBe(true);
    expect(s0.select_crease).toBe(false);
    expect(s0.select_border).toBe(true);
    expect(s0.exclude_border).toBe(true);
    expect(s0.visibility).toBe('HIDDEN');
    const st = c.styles[s0.linestyle!];
    expect(st.color).toEqual([1, 0, 0]);
    expect(st.thickness).toBe(4);
    expect(st.color_modifiers[0].type).toBe('ALONG_STROKE');
    // the template shades its strokes
    expect(c.shaders.has(c.sets[1])).toBe(true);
  });

  it('report module errors and keep running the others', () => {
    const c = compileModules({ modules: [{ script: 'b', use: true }, { script: 'missing', use: true }, { script: 'a', use: true }] }, code);
    expect(c.errors).toHaveLength(2);
    expect(c.errors[0]).toMatch(/broken\.js/);
    expect(c.sets).toHaveLength(1);
  });

  it('shaders change the finished strokes in place', () => {
    const n = 3;
    const f = () => new Float32Array(n).fill(1);
    const s = { x: f(), y: f(), r: f(), g: f(), b: f(), a: f(), tl: f(), tr: f(), caps: 'ROUND' as const };
    expect(shadeStrokes([s], (st) => st.a.fill(0.25))).toBeNull();
    expect(Array.from(s.a)).toEqual([0.25, 0.25, 0.25]);
    expect(shadeStrokes([s], () => { throw new Error('bad'); })).toBe('bad');
  });

  it('ignore unknown fields', () => {
    const set = moduleLineSet('x', 'id', { nonsense: 1, qi_end: 5 } as never);
    expect((set as never as Record<string, unknown>).nonsense).toBeUndefined();
    expect(set.qi_end).toBe(5);
    expect(moduleLineStyle('id', 'n', { bogus: true } as never)).not.toHaveProperty('bogus');
  });
});
