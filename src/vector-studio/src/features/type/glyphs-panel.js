/**
 * Glyphs panel: every glyph of a font, drawn from the font file, with
 * filters (categories, Unicode blocks, alternates of the selected
 * characters), the alternates of the focused glyph in a strip below the
 * grid, a recently used row and a zoom control. Double-click or Enter
 * inserts a glyph at the insertion point; an alternate without a code point
 * of its own goes in as its base character with that glyph chosen
 * (`altGlyph`), so the text stays searchable and spell-checkable.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { allFamilies, familyFaces, styleName, otFontFor, fontEvents } from './fonts.js';
import { currentCharStyle, session, MIXED } from './type-ops.js';
import { fontAlternates, glyphChar } from './shaping.js';
import { overridesAt, replaceRange } from '../../model/text-runs.js';

const BLOCKS = [
  [0x0000, 0x007f, 'Basic Latin'],
  [0x0080, 0x00ff, 'Latin-1 Supplement'],
  [0x0100, 0x017f, 'Latin Extended-A'],
  [0x0180, 0x024f, 'Latin Extended-B'],
  [0x0250, 0x02af, 'IPA Extensions'],
  [0x02b0, 0x02ff, 'Spacing Modifier Letters'],
  [0x0300, 0x036f, 'Combining Diacritical Marks'],
  [0x0370, 0x03ff, 'Greek and Coptic'],
  [0x0400, 0x052f, 'Cyrillic'],
  [0x0590, 0x05ff, 'Hebrew'],
  [0x0600, 0x06ff, 'Arabic'],
  [0x0900, 0x097f, 'Devanagari'],
  [0x0e00, 0x0e7f, 'Thai'],
  [0x1e00, 0x1eff, 'Latin Extended Additional'],
  [0x1f00, 0x1fff, 'Greek Extended'],
  [0x2000, 0x206f, 'General Punctuation'],
  [0x2070, 0x209f, 'Superscripts and Subscripts'],
  [0x20a0, 0x20cf, 'Currency Symbols'],
  [0x2100, 0x214f, 'Letterlike Symbols'],
  [0x2150, 0x218f, 'Number Forms'],
  [0x2190, 0x21ff, 'Arrows'],
  [0x2200, 0x22ff, 'Mathematical Operators'],
  [0x2300, 0x23ff, 'Miscellaneous Technical'],
  [0x2460, 0x24ff, 'Enclosed Alphanumerics'],
  [0x2500, 0x257f, 'Box Drawing'],
  [0x2580, 0x259f, 'Block Elements'],
  [0x25a0, 0x25ff, 'Geometric Shapes'],
  [0x2600, 0x26ff, 'Miscellaneous Symbols'],
  [0x2700, 0x27bf, 'Dingbats'],
  [0x2c60, 0x2c7f, 'Latin Extended-C'],
  [0x3000, 0x303f, 'CJK Symbols and Punctuation'],
  [0x3040, 0x30ff, 'Kana'],
  [0x4e00, 0x9fff, 'CJK Ideographs'],
  [0xa720, 0xa7ff, 'Latin Extended-D'],
  [0xac00, 0xd7af, 'Hangul Syllables'],
  [0xe000, 0xf8ff, 'Private Use Area'],
  [0xfb00, 0xfb4f, 'Alphabetic Presentation Forms'],
  [0xfe70, 0xfeff, 'Arabic Presentation Forms-B'],
  [0xff00, 0xffef, 'Halfwidth and Fullwidth Forms'],
  [0x1f300, 0x1faff, 'Emoji and Pictographs'],
];

const CATEGORIES = [
  ['all', 'Entire Font'],
  ['alternates', 'Alternates for Current Selection'],
  ['letters', 'Letters'],
  ['numbers', 'Numbers'],
  ['punctuation', 'Punctuation'],
  ['symbols', 'Symbols'],
];

const ZOOMS = [24, 32, 40, 52, 68];
const RECENT_MAX = 14;

const codeOf = (g) => g.unicode ?? g.unicodes?.[0] ?? null;
const hex = (u) => `U+${u.toString(16).toUpperCase().padStart(4, '0')}`;

function blockOf(u) {
  for (const b of BLOCKS) if (u >= b[0] && u <= b[1]) return b[2];
  return 'Other';
}

function categoryOf(u) {
  if (u == null) return null;
  const c = String.fromCodePoint(u);
  if (/\p{L}|\p{M}/u.test(c)) return 'letters';
  if (/\p{N}/u.test(c)) return 'numbers';
  if (/\p{P}/u.test(c)) return 'punctuation';
  if (/\p{S}/u.test(c)) return 'symbols';
  return null;
}

/** SVG markup of a glyph fitted to a cell of `size` px. */
export function glyphSvg(font, glyphIndex, size) {
  const g = font.glyphs.get(glyphIndex);
  const em = size * 0.72;
  const asc = (font.ascender / font.unitsPerEm) * em;
  const desc = (-font.descender / font.unitsPerEm) * em;
  const base = (size - (asc + desc)) / 2 + asc;
  // Center the ink (marks and spaces have no useful advance), keep the baseline shared.
  const path = g ? g.getPath(0, base, em) : null;
  const bb = path?.getBoundingBox();
  const ink = bb && Number.isFinite(bb.x1) && bb.x2 > bb.x1 ? bb : null;
  const x = ink ? size / 2 - (ink.x1 + ink.x2) / 2 : (size - ((g?.advanceWidth || 0) / font.unitsPerEm) * em) / 2;
  const d = g ? g.getPath(x, base, em).toPathData(2) : '';
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true" focusable="false"><path d="${d}" fill="currentColor"/></svg>`;
}

/**
 * Insert a glyph at the insertion point of the active type session. The
 * inserted character takes the font (family and face) the glyph came from.
 * Returns false (with a message) when there is nowhere to insert.
 */
export function insertGlyph(app, font, glyphIndex, face) {
  const s = session(app);
  if (!s) {
    app.notify('Click in type with a type tool to insert glyphs.');
    return false;
  }
  const ch = glyphChar(font, glyphIndex);
  if (!ch) {
    app.notify('This glyph has no character to insert.');
    return false;
  }
  const n = s.node();
  if (!n) return false;
  const [a, b] = s.range();
  const { altGlyph, ...inherited } = overridesAt(n, a > 0 ? a - 1 : a); // eslint-disable-line no-unused-vars
  const enc = font.glyphs.get(glyphIndex);
  const isEncoded = codeOf(enc) != null;
  const overrides = { ...inherited, ...(s.pending || {}), altGlyph: isEncoded ? null : glyphIndex };
  if (face) Object.assign(overrides, { fontFamily: face.family, fontWeight: face.weight, fontStyle: face.style });
  s.doc.transact('Insert Glyph', () => s.doc.update(n.id, replaceRange(n, a, b, ch, overrides)));
  s.caret = s.anchor = a + ch.length;
  s.burst++;
  s.lastKind = null;
  s.sync({ keepPending: true });
  s.focus();
  return true;
}

export class GlyphsPanel extends Panel {
  static id = 'glyphs';
  static title = 'Glyphs';
  static icon = 'glyphs';
  static placement = 'strip';

  build() {
    const app = this.app;
    this.family = null;
    this.face = { weight: 400, style: 'normal' };
    this.followed = null; // the text font the panel last followed
    this.font = null;
    this.loading = null;
    this.filter = 'all';
    this.focus = null; // focused glyph index
    this.zoom = ZOOMS.includes(app.prefs.get('glyphsZoom')) ? app.prefs.get('glyphsZoom') : 40;
    const uid = Math.random().toString(36).slice(2, 7);
    this.show = h('select.select.gl-show', { id: `gl-show-${uid}`, onchange: () => this.setFilter(this.show.value) });
    this.famSel = h('select.select.gl-family', { 'aria-label': 'Font family', onchange: () => this.pickFont(this.famSel.value, null) });
    this.faceSel = h('select.select.gl-face', {
      'aria-label': 'Font style',
      onchange: () => {
        const [w, st] = this.faceSel.value.split('|');
        this.pickFont(this.family, { weight: Number(w), style: st });
      },
    });
    this.recentRow = h('div.gl-recent', { role: 'listbox', 'aria-label': 'Recently used glyphs', 'aria-orientation': 'horizontal' });
    this.grid = h('div.gl-grid', { role: 'listbox', 'aria-label': 'Glyphs', tabindex: '-1' });
    this.grid.addEventListener('keydown', (e) => this.onKey(e));
    this.altRow = h('div.gl-alts', { role: 'listbox', 'aria-label': 'Alternates of the selected glyph', 'aria-orientation': 'horizontal' });
    this.status = h('p.gl-status', { role: 'status', 'aria-live': 'polite' });
    this.zoomOut = iconButton('zoom-out', 'Smaller glyphs', () => this.setZoom(-1), { className: 'small' });
    this.zoomIn = iconButton('zoom-in', 'Larger glyphs', () => this.setZoom(1), { className: 'small' });
    this.el.append(
      h('div.gl-top', h('label.gl-label', { for: this.show.id }, 'Show'), this.show),
      h('div.gl-recent-wrap', h('span.gl-caption', 'Recently used'), this.recentRow),
      this.grid,
      this.altRow,
      h('div.gl-bottom', this.famSel, this.faceSel, this.zoomOut, this.zoomIn),
      this.status,
    );
    this.observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => this.onVisible(entries), { root: this.grid, rootMargin: '120px' }) : null;
    fontEvents.on('local', () => this.visible && this.fillFamilies());
    this.fillFamilies();
    this.applyZoom();
  }

  fillFamilies() {
    const fams = allFamilies();
    this.famSel.replaceChildren(...fams.map((f) => h('option', { value: f.family }, f.family)));
    if (this.family && !fams.some((f) => f.family === this.family)) this.famSel.append(h('option', { value: this.family }, this.family));
    if (this.family) this.famSel.value = this.family;
  }

  /** Follow the current text's font when it changes; otherwise keep the user's pick. */
  update() {
    const cur = this.app.editor ? currentCharStyle(this.app) : null;
    const fam = cur && cur.fontFamily !== MIXED ? cur.fontFamily : null;
    const face = cur && cur.fontWeight !== MIXED && cur.fontStyle !== MIXED ? { weight: cur.fontWeight, style: cur.fontStyle } : { weight: 400, style: 'normal' };
    const key = fam ? `${fam}|${face.weight}|${face.style}` : null;
    const follow = this.app.prefs.get('glyphsFollow') !== false;
    if (key && key !== this.followed && (follow || !this.family)) {
      this.followed = key;
      this.pickFont(fam, face);
    } else if (!this.family) this.pickFont(allFamilies()[0]?.family || 'Inter', null);
    else if (this.filter === 'alternates') this.render();
  }

  async pickFont(family, face) {
    const faces = familyFaces(family);
    const want = face || this.face;
    const best = faces.find((f) => f.weight === want.weight && f.style === want.style) || faces.find((f) => f.weight === 400 && f.style === 'normal') || faces[0] || { weight: 400, style: 'normal' };
    this.family = family;
    this.face = { weight: best.weight, style: best.style };
    this.fillFamilies();
    this.faceSel.replaceChildren(...faces.map((f) => h('option', { value: `${f.weight}|${f.style}` }, styleName(f.weight, f.style))));
    this.faceSel.value = `${this.face.weight}|${this.face.style}`;
    const key = `${family}|${this.face.weight}|${this.face.style}`;
    this.loading = key;
    this.status.textContent = `Loading ${family}…`;
    let font = null;
    try {
      font = await otFontFor({ fontFamily: family, fontWeight: this.face.weight, fontStyle: this.face.style });
    } catch {
      font = null;
    }
    if (this.loading !== key) return;
    this.font = font;
    this.focus = null;
    this.fillShow();
    this.render();
    if (!font) this.status.textContent = `The glyphs of ${family} are not available.`;
  }

  fillShow() {
    const opts = CATEGORIES.map(([v, l]) => h('option', { value: v }, l));
    if (this.font) {
      const blocks = new Set();
      for (let i = 0; i < this.font.numGlyphs; i++) {
        const u = codeOf(this.font.glyphs.get(i));
        if (u != null) blocks.add(blockOf(u));
      }
      const present = BLOCKS.filter((b) => blocks.has(b[2]));
      if (present.length) opts.push(h('optgroup', { label: 'Unicode blocks' }, present.map((b) => h('option', { value: `block:${b[2]}` }, b[2]))));
    }
    this.show.replaceChildren(...opts);
    if (![...this.show.querySelectorAll('option')].some((o) => o.value === this.filter)) this.filter = 'all';
    this.show.value = this.filter;
  }

  setFilter(f) {
    this.filter = f;
    this.focus = null;
    if (this.show && [...this.show.options].some((o) => o.value === f)) this.show.value = f;
    this.render();
  }

  setZoom(dir) {
    const i = Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(this.zoom) + dir));
    this.zoom = ZOOMS[i];
    this.app.prefs.set('glyphsZoom', this.zoom);
    this.applyZoom();
    this.render();
  }

  applyZoom() {
    this.el.style.setProperty('--gl-cell', `${this.zoom}px`);
    this.zoomOut.disabled = this.zoom === ZOOMS[0];
    this.zoomIn.disabled = this.zoom === ZOOMS[ZOOMS.length - 1];
  }

  menu() {
    const recent = this.app.prefs.get('glyphsRecent') || [];
    return [
      { label: 'Show', submenu: CATEGORIES.map(([v, l]) => ({ label: l, checked: this.filter === v, run: () => this.setFilter(v) })) },
      '-',
      { label: 'Insert Glyph', enabled: this.focus != null && Boolean(this.font && session(this.app)), run: () => this.insert(this.focus) },
      { label: 'Follow the Selected Text', checked: this.app.prefs.get('glyphsFollow') !== false, run: () => this.app.prefs.set('glyphsFollow', this.app.prefs.get('glyphsFollow') === false) },
      '-',
      { label: 'Smaller Glyphs', enabled: this.zoom > ZOOMS[0], run: () => this.setZoom(-1) },
      { label: 'Larger Glyphs', enabled: this.zoom < ZOOMS[ZOOMS.length - 1], run: () => this.setZoom(1) },
      '-',
      {
        label: 'Clear Recently Used Glyphs',
        enabled: recent.length > 0,
        run: () => {
          this.app.prefs.set('glyphsRecent', []);
          this.renderRecent();
        },
      },
    ];
  }

  /** Glyph indexes the current filter shows. */
  glyphList() {
    const font = this.font;
    if (!font) return [];
    const out = [];
    if (this.filter === 'alternates') {
      const s = session(this.app);
      const n = s?.node();
      let text = '';
      if (n) {
        const [a, b] = s.range();
        text = n.text.slice(a, b) || n.text.slice(Math.max(0, a - 1), a);
      }
      const { alts } = fontAlternates(font);
      const seen = new Set();
      for (const c of new Set(text)) {
        const g = font.charToGlyphIndex(c);
        if (!g || seen.has(g)) continue;
        seen.add(g);
        out.push(g);
        for (const a of alts.get(g) || []) if (!seen.has(a.glyph)) seen.add(a.glyph), out.push(a.glyph);
      }
      return out;
    }
    const block = this.filter.startsWith('block:') ? this.filter.slice(6) : null;
    for (let i = 1; i < font.numGlyphs; i++) {
      const u = codeOf(font.glyphs.get(i));
      if (this.filter === 'all') out.push(i);
      else if (block) {
        if (u != null && blockOf(u) === block) out.push(i);
      } else if (categoryOf(u) === this.filter) out.push(i);
    }
    return out;
  }

  cell(glyph, { role = 'option', small = false } = {}) {
    const font = this.font;
    const g = font.glyphs.get(glyph);
    const u = codeOf(g);
    const hasAlts = (fontAlternates(font).alts.get(glyph) || []).length > 0;
    const label = `${g?.name || `glyph ${glyph}`}${u != null ? ` ${hex(u)}` : ''}`;
    const el = h(`div.gl-cell${small ? '.small' : ''}`, { role, tabindex: '-1', 'aria-label': label, 'data-glyph': String(glyph), 'aria-selected': String(glyph === this.focus) });
    if (hasAlts) el.classList.add('has-alts');
    el.addEventListener('click', () => this.select(glyph));
    el.addEventListener('dblclick', () => this.insert(glyph));
    return el;
  }

  render() {
    if (!this.built) return;
    const font = this.font;
    this.observer?.disconnect();
    if (!font) {
      this.grid.replaceChildren(h('p.panel-empty', this.app.editor ? 'No font' : 'No document'));
      this.altRow.replaceChildren();
      this.renderRecent();
      return;
    }
    const list = this.glyphList();
    const cells = list.map((g) => this.cell(g));
    this.grid.replaceChildren(...cells);
    if (!cells.length) {
      this.grid.append(h('p.panel-empty', this.filter === 'alternates' ? 'Select characters in type to see their alternates.' : 'No glyphs in this category.'));
    }
    const focusCell = (this.focus != null && this.grid.querySelector(`[data-glyph="${this.focus}"]`)) || cells[0];
    if (focusCell) focusCell.tabIndex = 0;
    // Draw cells as they scroll into view (fonts can have thousands of glyphs).
    if (this.observer) for (const c of cells) this.observer.observe(c);
    else for (const c of cells.slice(0, 400)) this.paint(c);
    this.renderAlternates();
    this.renderRecent();
    this.describe();
  }

  paint(cell, font = this.font, size = this.zoom) {
    if (cell.dataset.painted) return;
    cell.dataset.painted = '1';
    cell.innerHTML = glyphSvg(font, Number(cell.dataset.glyph), size);
  }

  onVisible(entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      this.paint(e.target);
      this.observer.unobserve(e.target);
    }
  }

  select(glyph, { focus = true } = {}) {
    this.focus = glyph;
    for (const c of this.grid.querySelectorAll('.gl-cell')) {
      const on = Number(c.dataset.glyph) === glyph;
      c.setAttribute('aria-selected', String(on));
      c.tabIndex = on ? 0 : -1;
      if (on && focus) {
        c.focus({ preventScroll: false });
        c.scrollIntoView?.({ block: 'nearest' });
      }
    }
    this.renderAlternates();
    this.describe();
  }

  renderAlternates() {
    const font = this.font;
    const alts = font && this.focus != null ? fontAlternates(font).alts.get(this.focus) || [] : [];
    if (!alts.length) {
      this.altRow.replaceChildren();
      this.altRow.hidden = true;
      return;
    }
    this.altRow.hidden = false;
    this.altRow.replaceChildren(
      h('span.gl-caption', 'Alternates'),
      ...alts.map((a) => {
        const c = this.cell(a.glyph, { small: true });
        c.title = a.tag;
        c.setAttribute('aria-label', `${c.getAttribute('aria-label')} (${a.tag})`);
        c.tabIndex = 0;
        c.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this.insert(a.glyph);
          }
        });
        this.paint(c, font, 30);
        return c;
      }),
    );
  }

  describe() {
    const font = this.font;
    if (!font) return;
    if (this.focus == null) {
      this.status.textContent = `${this.family} ${styleName(this.face.weight, this.face.style)}: ${font.numGlyphs} glyphs`;
      return;
    }
    const g = font.glyphs.get(this.focus);
    const u = codeOf(g);
    const alts = (fontAlternates(font).alts.get(this.focus) || []).length;
    const base = u == null ? glyphChar(font, this.focus) : null;
    this.status.textContent = [g?.name || `Glyph ${this.focus}`, u != null ? hex(u) : base ? `alternate of ${base}` : 'unencoded', alts ? `${alts} alternate${alts > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ');
  }

  insert(glyph) {
    if (!this.font) return;
    if (insertGlyph(this.app, this.font, glyph, { family: this.family, ...this.face })) this.remember({ family: this.family, weight: this.face.weight, style: this.face.style, glyph });
  }

  /** Put a glyph ({ family, weight, style, glyph }) at the front of the recently used row. */
  remember(item) {
    const list = (this.app.prefs.get('glyphsRecent') || []).filter((r) => !(r.family === item.family && r.weight === item.weight && r.style === item.style && r.glyph === item.glyph));
    this.app.prefs.set('glyphsRecent', [item, ...list].slice(0, RECENT_MAX));
    this.renderRecent();
  }

  renderRecent() {
    const list = this.app.prefs.get('glyphsRecent') || [];
    this.recentRow.parentElement.hidden = !list.length;
    const token = (this.recentToken = (this.recentToken || 0) + 1);
    this.recentRow.replaceChildren(
      ...list.map((r) => {
        const el = h('div.gl-cell.small', { role: 'option', tabindex: '0', 'aria-label': `${r.family} glyph ${r.glyph}`, 'data-glyph': String(r.glyph), title: r.family });
        const insert = async () => {
          const font = await otFontFor({ fontFamily: r.family, fontWeight: r.weight, fontStyle: r.style });
          if (font && insertGlyph(this.app, font, r.glyph, { family: r.family, weight: r.weight, style: r.style })) this.remember(r);
        };
        el.addEventListener('dblclick', insert);
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            insert();
          }
        });
        otFontFor({ fontFamily: r.family, fontWeight: r.weight, fontStyle: r.style }).then((font) => {
          if (font && token === this.recentToken && r.glyph < font.numGlyphs) el.innerHTML = glyphSvg(font, r.glyph, 30);
        });
        return el;
      }),
    );
  }

  onKey(e) {
    const cells = [...this.grid.querySelectorAll('.gl-cell')];
    if (!cells.length) return;
    let i = cells.findIndex((c) => Number(c.dataset.glyph) === this.focus);
    if (i < 0) i = 0;
    const first = cells[0].getBoundingClientRect();
    const cols = Math.max(1, Math.round(this.grid.clientWidth / Math.max(1, first.width || this.zoom + 2)) || 1);
    let next = i;
    switch (e.key) {
      case 'ArrowRight':
        next = i + 1;
        break;
      case 'ArrowLeft':
        next = i - 1;
        break;
      case 'ArrowDown':
        next = i + cols;
        break;
      case 'ArrowUp':
        next = i - cols;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = cells.length - 1;
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this.insert(Number(cells[i].dataset.glyph));
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    next = Math.max(0, Math.min(cells.length - 1, next));
    this.paint(cells[next]);
    this.select(Number(cells[next].dataset.glyph));
  }
}
