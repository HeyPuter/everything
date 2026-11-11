// Layout rules that jsdom can't lay out, checked in the stylesheets themselves.
// Each was seen broken in a real browser; see the commit that added the check.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = (name) => readFileSync(resolve(import.meta.dirname, '../src/styles', name), 'utf8');

/** The declarations of the first rule whose selector is exactly sel. */
function rule(source, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, 'm').exec(source);
  return m ? m[2] : '';
}

/** Evaluate a grid track minimum like "min(200px, 50%)" for a container height. */
function trackMin(expr, height) {
  const px = (s) => {
    s = s.trim();
    if (s.endsWith('px')) return parseFloat(s);
    if (s.endsWith('%')) return (parseFloat(s) / 100) * height;
    const calc = /^calc\((.+)\s-\s(.+)\)$/.exec(s);
    if (calc) return px(calc[1]) - px(calc[2]);
    const min = /^min\((.+)\)$/.exec(s);
    if (min) return Math.min(...splitArgs(min[1]).map(px));
    throw new Error(`can't evaluate ${s}`);
  };
  return px(expr);
}

function splitArgs(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

describe('phone layout', () => {
  it('fits the player, the gap and the timeline in a phone held sideways', () => {
    const decl = rule(css('responsive.css'), ".editor[data-layout='phone'] .workspace");
    const rows = /grid-template-rows:\s*([^;]+);/.exec(decl)[1];
    // minmax(a, b) gap minmax(c, d)
    const tracks = [];
    let depth = 0;
    let cur = '';
    for (const ch of rows) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ' ' && depth === 0) {
        if (cur) tracks.push(cur);
        cur = '';
      } else cur += ch;
    }
    tracks.push(cur);
    expect(tracks).toHaveLength(3);
    const minOf = (t) => (t.startsWith('minmax(') ? splitArgs(t.slice(7, -1))[0] : t);
    // An iPhone SE sideways leaves 256px between the title bar and the dock; a tall phone 693px.
    for (const height of [256, 271, 400, 693]) {
      const sum = tracks.reduce((s, t) => s + trackMin(minOf(t), height), 0);
      expect(sum).toBeLessThanOrEqual(height);
    }
    // Tall phones keep the comfortable minimums.
    expect(trackMin(minOf(tracks[0]), 693)).toBe(200);
    expect(trackMin(minOf(tracks[2]), 693)).toBe(150);
  });
});
