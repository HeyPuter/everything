// Layout rules that jsdom can't lay out, checked in the stylesheets themselves.
// Each was seen broken in a real browser; see the commit that added the check.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = (name) => readFileSync(resolve(import.meta.dirname, '../src/styles', name), 'utf8');

/** The declarations of the first rule whose selector is exactly sel. */
function rule(source, sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Preceded by the end of another rule (or comments after it), so a selector list's last line doesn't count.
  const m = new RegExp(`(?:^|\\})\\s*(?:/\\*[\\s\\S]*?\\*/\\s*)*${esc}\\s*\\{([^}]*)\\}`).exec(source);
  return m ? m[1] : '';
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

/** Hex color tokens of a theme block in tokens.css. */
function tokens(theme) {
  const src = css('tokens.css');
  const sel = theme === 'dark' ? ":root[data-theme-resolved='dark']" : ":root[data-theme-resolved='light']";
  const block = new RegExp(`${sel.replace(/[[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(src)[1];
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]));
}

function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** The color token a rule sets, e.g. "--text-2". */
const colorVar = (file, sel) => /(?:^|\s)color:\s*var\((--[\w-]+)\)/.exec(rule(css(file), sel))[1];

describe('text contrast', () => {
  it('keeps undone steps and step numbers in the history panel readable in both themes', () => {
    for (const theme of ['dark', 'light']) {
      const t = tokens(theme);
      for (const sel of ['.history-step.undone', '.history-num']) {
        expect(contrast(t[colorVar('organize.css', sel)], t['--bg-elev'])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('buttons', () => {
  it('let a full-width button wrap a label that does not fit, at the usual height otherwise', () => {
    const base = css('base.css');
    const block = rule(base, '.btn.block');
    expect(block).toMatch(/white-space:\s*normal/);
    expect(block).toMatch(/height:\s*auto/);
    expect(block).toMatch(/min-height:\s*32px/);
    expect(rule(base, '.btn.small.block')).toMatch(/min-height:\s*28px/);
  });
});

describe('focus rings', () => {
  it('mark a focused media tile or template card differently from a hovered one', () => {
    const ring = /outline:\s*2px solid var\(--focus\)/;
    // Hover only changes the border color; focus adds the ring.
    expect(rule(css('editor.css'), '.tile:focus-visible .tile-preview')).toMatch(ring);
    expect(rule(css('home.css'), '.tpl-card:focus-visible .tpl-thumb')).toMatch(ring);
    // The template strip scrolls sideways: it leaves room so the ring isn't clipped.
    expect(rule(css('home.css'), '.tpl-strip')).toMatch(/padding:\s*3px/);
  });
});

describe('menus', () => {
  it('fit the visible height on phones, with a fallback for older browsers', () => {
    const decl = rule(css('editor.css'), '.menu');
    const heights = [...decl.matchAll(/max-height:\s*([^;]+);/g)].map((m) => m[1]);
    // The later declaration wins where dvh is understood.
    expect(heights).toEqual(['calc(100vh - 16px)', 'calc(100dvh - 16px)']);
  });

});
