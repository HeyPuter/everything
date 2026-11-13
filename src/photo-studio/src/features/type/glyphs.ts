// Glyphs panel: every character the current font maps (read from the font
// file's cmap for bundled fonts), recently used glyphs, a category filter and
// double-click to insert into the text being edited.
import type { Editor } from '../../editor';
import { registerPanel, type Panel } from '../../app/registry';
import { escapeXML } from '../../model/assets';
import { BUNDLED_FONTS, discardFontFile, ensureFont, findBundled, loadFontFile } from '../../imaging/text/fonts';
import { parseFont } from '../../imaging/text/sfnt';
import { focusInput, insert, onSessionChange, ordered, session, startEdit, styleContext } from './session';
import { charStyleAt, type CharStyle } from '../../imaging/text/model';
import { familyList, familyStyles, styleName } from './options';
import './type-panels.css';

export type GlyphCategory = 'all' | 'letters' | 'accented' | 'numbers' | 'punctuation' | 'symbols' | 'currency' | 'math' | 'arrows' | 'greek' | 'cyrillic';
export const GLYPH_CATEGORIES: [GlyphCategory, string][] = [
  ['all', 'Entire Font'], ['letters', 'Basic Latin Letters'], ['accented', 'Accented Latin'], ['numbers', 'Numbers'], ['punctuation', 'Punctuation'],
  ['symbols', 'Symbols'], ['currency', 'Currency'], ['math', 'Math'], ['arrows', 'Arrows'], ['greek', 'Greek'], ['cyrillic', 'Cyrillic'],
];
/** Category of a code point for the panel's filter (pure, tested). */
export function glyphCategory(cp: number): Exclude<GlyphCategory, 'all'> {
  const ch = String.fromCodePoint(cp);
  if (cp >= 0x2190 && cp <= 0x21ff) return 'arrows';
  if (/\p{Sc}/u.test(ch)) return 'currency';
  if (/\p{Sm}/u.test(ch)) return 'math';
  if (/\p{N}/u.test(ch)) return 'numbers';
  if (/\p{Script=Greek}/u.test(ch)) return 'greek';
  if (/\p{Script=Cyrillic}/u.test(ch)) return 'cyrillic';
  if (/\p{L}/u.test(ch)) return /^[A-Za-z]$/.test(ch) ? 'letters' : /\p{Script=Latin}/u.test(ch) ? 'accented' : 'symbols';
  if (/\p{P}/u.test(ch)) return 'punctuation';
  return 'symbols';
}
// Characters that are not drawn as glyphs (controls, spaces, joiners).
export const isPrintable = (cp: number) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\s]/u.test(String.fromCodePoint(cp));

// Fonts without a readable file show common ranges; the browser draws any
// missing character with a fallback face.
const COMMON_RANGES: [number, number][] = [[0x21, 0x7e], [0xa1, 0xff], [0x100, 0x17f], [0x2010, 0x2027], [0x2030, 0x205e], [0x20a0, 0x20bf], [0x2100, 0x214f], [0x2190, 0x21ff], [0x2200, 0x22ff], [0x25a0, 0x25ff], [0x2600, 0x26ff]];
const fontCodePoints = new Map<string, Promise<number[]>>();
export function codePointsFor(family: string, italic: boolean): Promise<number[]> {
  const bundled = findBundled(family);
  const key = bundled ? `${bundled.family}|${italic && bundled.faces.some((f) => f.italic)}` : 'common';
  let p = fontCodePoints.get(key);
  if (!p) {
    p = bundled
      ? loadFontFile(bundled.family, italic).then(async (buf) => {
        try {
          return parseFont(buf).codePoints().filter(isPrintable);
        } catch (error) {
          await discardFontFile(bundled.family, italic, buf);
          throw error;
        }
      })
      : Promise.resolve(COMMON_RANGES.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i)).filter(isPrintable));
    p.catch(() => fontCodePoints.delete(key));
    fontCodePoints.set(key, p);
  }
  return p;
}

// Recently used glyphs (most recent first), shared by all documents.
const recentKey = 'photo-studio-recent-glyphs';
type Recent = { cp: number; family: string };
function recentGlyphs(): Recent[] {
  try {
    const v = JSON.parse(localStorage.getItem(recentKey) ?? '[]');
    return Array.isArray(v) ? v.filter((r) => r && Number.isInteger(r.cp) && r.cp >= 0 && r.cp <= 0x10ffff && typeof r.family === 'string').slice(0, 24) : [];
  } catch {
    return [];
  }
}
function remember(r: Recent) {
  const list = [r, ...recentGlyphs().filter((x) => x.cp !== r.cp || x.family !== r.family)].slice(0, 24);
  try {
    localStorage.setItem(recentKey, JSON.stringify(list));
  } catch {
    /* Optional. */
  }
}

/** Insert a character into the text being edited (or the selected text layer). */
export async function insertGlyph(e: Editor, ch: string, family?: string, face?: { weight: number; italic: boolean }) {
  if (!session) {
    const l = e.layer;
    if (l?.kind !== 'text') {
      e.message('Click in text with the Type tool, or select a text layer, to insert glyphs.');
      return false;
    }
    if (!e.tool.startsWith('type')) e.setTool('type');
    let inserted = false;
    await startEdit(e, l.id, 'end', undefined, () => {
      inserted = insertIntoText(e, ch, family, face, true);
    });
    return inserted;
  }
  return insertIntoText(e, ch, family, face);
}

function insertIntoText(e: Editor, ch: string, family?: string, face?: { weight: number; italic: boolean }, softFocus = false) {
  if (!session) return false;
  // A glyph from another font than the text's is inserted in that font.
  let style: CharStyle | undefined;
  if (family) {
    const s = session;
    const [a, b] = ordered(s);
    const base = a === b && s.caretStyle ? s.caretStyle : charStyleAt(s.data.content, a === b ? a : a + 1);
    const next = { ...base, family, ...(face ?? {}) };
    if (next.family !== base.family || next.weight !== base.weight || next.italic !== base.italic) {
      style = next;
    }
  }
  insert(e, ch, 'glyph', style);
  focusInput(e, softFocus);
  if (family) remember({ cp: ch.codePointAt(0)!, family });
  return true;
}

const state = { family: '', italic: false, weight: 400, follow: true, category: 'all' as GlyphCategory, size: 30 };
// The font a cell inserts in: a recent glyph's own family, else the panel's
// family (and style, once one was chosen here rather than followed from the text).
const glyphFont = (c: HTMLElement): [string, { weight: number; italic: boolean } | undefined] =>
  c.dataset.family ? [c.dataset.family, undefined] : [state.family, state.follow ? undefined : { weight: state.weight, italic: state.italic }];
const fontCss = (family: string) => `"${family.replace(/"/g, '')}", sans-serif`;

export const glyphsPanel: Panel = {
  id: 'glyphs',
  title: 'Glyphs',
  icon: 'glyphs',
  location: 'strip',
  hidden: true,
  mount: (e, el) => {
    el.classList.add('glyphs-panel');
    el.innerHTML = `<div class="gl-font"><select data-gl="family" aria-label="Font family"></select><select data-gl="style" aria-label="Font style"></select></div>
<div class="gl-head"><select data-gl="category" aria-label="Show">${GLYPH_CATEGORIES.map(([v, l]) => `<option value="${v}">${escapeXML(l)}</option>`).join('')}</select><input type="range" data-gl="size" min="20" max="56" aria-label="Glyph size"></div>
<div class="gl-label">Recently Used</div><div class="gl-recent" role="listbox" aria-label="Recently used glyphs"></div>
<div class="gl-grid" role="listbox" aria-label="Glyphs"></div>
<div class="gl-info" aria-live="polite"></div>`;
    el.addEventListener('change', (ev) => {
      const t = ev.target as HTMLSelectElement | HTMLInputElement;
      const k = t.dataset.gl;
      if (k === 'family') {
        state.family = t.value;
        state.follow = false;
        const styles = familyStyles(state.family);
        if (!styles.some((s) => s.weight === state.weight && s.italic === state.italic)) Object.assign(state, styles[0] ?? { weight: 400, italic: false });
      } else if (k === 'style') {
        const [w, i] = t.value.split('|');
        state.weight = Number(w);
        state.italic = i === '1';
        state.follow = false;
      } else if (k === 'category') state.category = t.value as GlyphCategory;
      else return;
      void render(e, el);
    });
    el.addEventListener('input', (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.dataset.gl !== 'size') return;
      state.size = Number(t.value);
      el.style.setProperty('--glyph-size', `${state.size}px`);
    });
    el.addEventListener('click', (ev) => {
      const retry = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-gl-retry]');
      if (!retry) return;
      retry.disabled = true;
      retry.textContent = 'Retrying…';
      el.querySelector('.gl-info')!.textContent = 'Loading glyphs…';
      renderedKey = '';
      void render(e, el);
    });
    const cell = (ev: Event) => (ev.target as HTMLElement).closest<HTMLElement>('[data-cp]');
    el.addEventListener('dblclick', (ev) => {
      const c = cell(ev);
      if (!c) return;
      void insertGlyph(e, String.fromCodePoint(Number(c.dataset.cp)), ...glyphFont(c)).then((ok) => ok && renderRecent(el));
    });
    el.addEventListener('keydown', (ev) => {
      const c = cell(ev);
      if (c && ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        void insertGlyph(e, String.fromCodePoint(Number(c.dataset.cp)), ...glyphFont(c)).then((ok) => ok && renderRecent(el));
      }
    });
    const info = (ev: Event) => {
      const c = cell(ev);
      if (!c) return;
      const cp = Number(c.dataset.cp);
      el.querySelector('.gl-info')!.textContent = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}  ${String.fromCodePoint(cp)}  ${GLYPH_CATEGORIES.find(([k]) => k === glyphCategory(cp))![1]}`;
    };
    el.addEventListener('pointerover', info);
    el.addEventListener('focusin', info);
  },
  update: (e, el) => void render(e, el),
};

let renderedKey = '';
async function render(e: Editor, el: HTMLElement) {
  if (state.follow || !state.family) {
    const c = styleContext(e).char;
    if (c.family) Object.assign(state, { family: c.family, weight: c.weight ?? 400, italic: !!c.italic });
    if (!state.family) state.family = BUNDLED_FONTS[0].family;
  }
  el.style.setProperty('--glyph-size', `${state.size}px`);
  const fam = el.querySelector<HTMLSelectElement>('[data-gl="family"]')!;
  const families = familyList();
  if (document.activeElement !== fam)
    fam.innerHTML = [...families.map((f) => f.family), ...(families.some((f) => f.family === state.family) ? [] : [state.family])].map((f) => `<option ${f === state.family ? 'selected' : ''}>${escapeXML(f)}</option>`).join('');
  const st = el.querySelector<HTMLSelectElement>('[data-gl="style"]')!;
  if (document.activeElement !== st)
    st.innerHTML = familyStyles(state.family).map((s) => `<option value="${s.weight}|${s.italic ? 1 : 0}" ${s.weight === state.weight && s.italic === state.italic ? 'selected' : ''}>${styleName(s.weight, s.italic)}</option>`).join('');
  el.querySelector<HTMLSelectElement>('[data-gl="category"]')!.value = state.category;
  el.querySelector<HTMLInputElement>('[data-gl="size"]')!.value = String(state.size);
  renderRecent(el);
  const key = `${state.family}|${state.weight}|${state.italic}|${state.category}`;
  if (key === renderedKey) return;
  renderedKey = key;
  void ensureFont(state.family, state.weight, state.italic);
  const grid = el.querySelector<HTMLElement>('.gl-grid')!;
  grid.style.fontFamily = fontCss(state.family);
  grid.style.fontWeight = String(state.weight);
  grid.style.fontStyle = state.italic ? 'italic' : 'normal';
  let cps: number[];
  try {
    cps = await codePointsFor(state.family, state.italic);
  } catch {
    if (renderedKey !== key) return;
    grid.innerHTML = '<button type="button" class="gl-retry secondary" data-gl-retry>Retry</button>';
    el.querySelector('.gl-info')!.textContent = 'Could not load glyphs. Try again.';
    return;
  }
  if (renderedKey !== key) return;
  const shown = state.category === 'all' ? cps : cps.filter((cp) => glyphCategory(cp) === state.category);
  grid.innerHTML = shown.length
    ? shown.map((cp) => `<button type="button" role="option" class="gl-cell" data-cp="${cp}" title="U+${cp.toString(16).toUpperCase().padStart(4, '0')}">${escapeXML(String.fromCodePoint(cp))}</button>`).join('')
    : `<p class="muted">No glyphs in this category.</p>`;
  el.querySelector('.gl-info')!.textContent = `${shown.length} glyphs${findBundled(state.family) ? '' : ' (common characters; this font’s file cannot be read)'}`;
}
function renderRecent(el: HTMLElement) {
  const list = recentGlyphs();
  const host = el.querySelector<HTMLElement>('.gl-recent')!;
  host.innerHTML = list.length
    ? list.map((r) => `<button type="button" role="option" class="gl-cell" data-cp="${r.cp}" data-family="${escapeXML(r.family)}" style="font-family:${escapeXML(fontCss(r.family))}" title="${escapeXML(r.family)} U+${r.cp.toString(16).toUpperCase().padStart(4, '0')}">${escapeXML(String.fromCodePoint(r.cp))}</button>`).join('')
    : '<span class="muted">Double-click a glyph to insert it.</span>';
}

export function installGlyphs(e: Editor) {
  registerPanel(glyphsPanel);
  onSessionChange(() => followSession(e));
}
// A manually chosen font sticks until the text being edited changes font.
let seen = '';
/** Show the font of the text being edited (unless one was chosen here). */
export function followSession(e: Editor) {
  const family = styleContext(e).char.family ?? '';
  if (family && family !== seen) state.follow = true;
  seen = family;
  const el = document.getElementById('panel-glyphs');
  if (el?.isConnected && state.follow) void render(e, el);
}
