/**
 * Match Font panel (Window > Match Font, Type > Match Font): pick the
 * region of a placed image or outlined type that holds lettering (drag
 * on the preview, or use the whole selection), match it, then choose
 * among the suggested fonts (each previewed in its own face) to set the
 * lettering as editable type or to restyle selected type.
 */
import { h, announce } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { icon } from '../../ui/icons.js';
import { drawNode } from '../../render/draw.js';
import { quoteFamily } from '../../model/text-layout.js';
import { ensureFamily } from '../type/fonts.js';
import { isAbort, aiErrorMessage, aiStatus } from '../generative/ai.js';
import { matchSources, matchTextTargets, boundsOf, clipRect, identifyFont, placeMatchedText, applyFontTo } from './match-font.js';

const THUMB_W = 248;
const THUMB_H = 140;

export class MatchFontPanel extends Panel {
  static id = 'matchFont';
  static title = 'Match Font';
  static icon = 'match-font';

  constructor(app) {
    super(app);
    this.region = null;
    this.result = null;
    this.chosen = 0;
    this.busy = null;
    this.sourceKey = '';
  }

  menu() {
    return [
      { label: 'Match Font', enabled: Boolean(this.sources().length) && !this.busy, run: () => this.match() },
      { label: 'Use Whole Selection', enabled: Boolean(this.region), run: () => this.setRegion(null) },
      '-',
      { label: 'Clear Results', enabled: Boolean(this.result), run: () => this.clearResults() },
    ];
  }

  sources() {
    return matchSources(this.editor);
  }

  build() {
    this.intro = h(
      'div.mockup-intro',
      h('div.mockup-intro-art', { 'aria-hidden': 'true' }, icon('match-font', 40)),
      h('p.mockup-intro-title', 'Start with a selection'),
      h('p.mockup-intro-text', 'Select a placed image with lettering, or type converted to outlines, to find matching fonts and make the text editable again.'),
    );
    // Preview with a region drawn by dragging.
    this.canvas = h('canvas.mf-thumb', { width: THUMB_W, height: THUMB_H, 'aria-hidden': 'true' });
    this.box = h('div.mf-region', { hidden: true });
    this.stage = h('div.mf-stage', { role: 'img', 'aria-label': 'Selection preview. Drag to choose the region with the lettering.' }, this.canvas, this.box);
    this.stage.addEventListener('pointerdown', (e) => this.dragRegion(e));
    this.wholeBtn = h('button.btn.small', { type: 'button', onclick: () => this.setRegion(null) }, 'Whole Selection');
    this.regionNote = h('span.mf-note');
    this.matchBtn = h('button.btn.primary.mf-match', { type: 'button', onclick: () => this.match() }, icon('match-font', 14), h('span', 'Match Font'));
    this.cancelBtn = h('button.btn.small', { type: 'button', hidden: true, onclick: () => this.busy?.abort() }, 'Cancel');
    this.status = h('p.mockup-status', { role: 'status', 'aria-live': 'polite' });
    this.picker = h('section.panel-section', h('h3.section-title', 'Region'), this.stage, h('div.mockup-row.mf-region-row', this.wholeBtn, this.regionNote), h('div.mockup-row', this.matchBtn, this.cancelBtn), this.status);

    // Results.
    this.textInput = h('textarea.mf-text', { rows: 2, 'aria-label': 'Detected text', spellcheck: false });
    this.list = h('div.mf-list', { role: 'listbox', 'aria-label': 'Matching fonts', tabindex: '0' });
    this.list.addEventListener('keydown', (e) => this.listKey(e));
    const coverId = `mf-cover-${Math.random().toString(36).slice(2, 8)}`;
    this.cover = h('input', { type: 'checkbox', id: coverId, checked: true });
    this.coverRow = h('label.mockup-check', { for: coverId }, this.cover, 'Cover the lettering in the image');
    this.replaceBtn = h('button.btn.small.primary', { type: 'button', onclick: () => this.replace() }, 'Replace with Text');
    this.applyBtn = h('button.btn.small', { type: 'button', onclick: () => this.apply() }, 'Apply to Selected Type');
    this.results = h(
      'section.panel-section.mf-results',
      h('h3.section-title', 'Matches'),
      h('label.mf-label', 'Text'),
      this.textInput,
      this.list,
      this.coverRow,
      h('div.quick-actions', this.replaceBtn, this.applyBtn),
    );
    this.el.append(this.intro, this.picker, this.results);
  }

  // ---- region ----

  /** Doc rect of the whole selection, and the thumb mapping. */
  frame() {
    const ed = this.editor;
    const nodes = this.sources();
    const b = ed && nodes.length ? boundsOf(ed.doc, nodes) : null;
    if (!b || !(b.w > 0) || !(b.h > 0)) return null;
    const k = Math.min(THUMB_W / b.w, THUMB_H / b.h);
    const ox = (THUMB_W - b.w * k) / 2;
    const oy = (THUMB_H - b.h * k) / 2;
    return { b, k, ox, oy, nodes };
  }

  setRegion(r) {
    this.region = r;
    this.drawRegion();
  }

  drawRegion() {
    const f = this.frame();
    const r = this.region && f ? clipRect(this.region, f.b) : null;
    this.box.hidden = !r;
    this.wholeBtn.disabled = !r;
    if (!r) {
      this.regionNote.textContent = 'Using the whole selection';
      return;
    }
    // Box position in percent of the stage so it scales with the panel.
    Object.assign(this.box.style, {
      left: `${((f.ox + (r.x - f.b.x) * f.k) / THUMB_W) * 100}%`,
      top: `${((f.oy + (r.y - f.b.y) * f.k) / THUMB_H) * 100}%`,
      width: `${((r.w * f.k) / THUMB_W) * 100}%`,
      height: `${((r.h * f.k) / THUMB_H) * 100}%`,
    });
    this.regionNote.textContent = 'Using the drawn region';
  }

  dragRegion(e) {
    const f = this.frame();
    if (!f || e.button) return;
    e.preventDefault();
    const rect = this.stage.getBoundingClientRect();
    const toDoc = (ev) => {
      const sx = rect.width ? ((ev.clientX - rect.left) / rect.width) * THUMB_W : 0;
      const sy = rect.height ? ((ev.clientY - rect.top) / rect.height) * THUMB_H : 0;
      return { x: f.b.x + (sx - f.ox) / f.k, y: f.b.y + (sy - f.oy) / f.k };
    };
    const a = toDoc(e);
    this.stage.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const b = toDoc(ev);
      const r = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      this.setRegion(r.w * f.k >= 4 && r.h * f.k >= 4 ? r : null);
    };
    const up = (ev) => {
      move(ev);
      this.stage.removeEventListener('pointermove', move);
      this.stage.removeEventListener('pointerup', up);
    };
    this.stage.addEventListener('pointermove', move);
    this.stage.addEventListener('pointerup', up);
  }

  drawThumb(f) {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, THUMB_W, THUMB_H);
    if (!f) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(f.ox, f.oy, f.b.w * f.k, f.b.h * f.k);
    ctx.setTransform(f.k, 0, 0, f.k, f.ox - f.b.x * f.k, f.oy - f.b.y * f.k);
    const doc = this.editor.doc;
    for (const id of doc.sortByPaintOrder(f.nodes.map((n) => n.id))) drawNode(ctx, doc, doc.get(id), { viewRect: f.b, outline: false, hairline: 1 / f.k, scale: f.k });
  }

  // ---- matching ----

  async match() {
    const ed = this.editor;
    const f = this.frame();
    if (!ed || !f || this.busy) return null;
    const rect = this.region ? clipRect(this.region, f.b) : f.b;
    if (!rect) return null;
    const controller = new AbortController();
    this.busy = controller;
    this.matchBtn.disabled = true;
    this.cancelBtn.hidden = false;
    this.status.textContent = 'Reading the lettering...';
    try {
      const r = await identifyFont(this.app, { nodes: f.nodes, rect, signal: controller.signal });
      if (!r) {
        this.status.textContent = '';
        return null;
      }
      this.result = { ...r, doc: ed.doc, sources: f.nodes.map((n) => n.id), rect };
      this.chosen = 0;
      this.textInput.value = r.answer.text;
      this.status.textContent = r.suggestions.length ? '' : 'No similar fonts were found among your fonts.';
      for (const s of r.suggestions) ensureFamily(s.family, s.weight, s.style);
      announce(r.suggestions.length ? `${r.suggestions.length} matching fonts. Best match: ${r.suggestions[0].family}` : 'No matching fonts');
      return r;
    } catch (err) {
      this.status.textContent = isAbort(err) ? 'Cancelled.' : aiErrorMessage(err);
      return null;
    } finally {
      this.busy = null;
      this.cancelBtn.hidden = true;
      this.update();
    }
  }

  clearResults() {
    this.result = null;
    this.update();
  }

  font() {
    return this.result?.suggestions[this.chosen] || null;
  }

  choose(i) {
    if (!this.result) return;
    this.chosen = Math.max(0, Math.min(this.result.suggestions.length - 1, i));
    this.renderList();
  }

  listKey(e) {
    if (!this.result) return;
    const n = this.result.suggestions.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      this.choose((this.chosen + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      this.choose(e.key === 'Home' ? 0 : n - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matchTextTargets(this.editor).length) this.apply();
      else this.replace();
    }
  }

  renderList() {
    const r = this.result;
    if (!r) {
      this.list.replaceChildren();
      return;
    }
    const sample = (r.answer.text || 'Aa Bb Cc 123').split('\n')[0].slice(0, 28);
    const opts = r.suggestions.map((s, i) => {
      const id = `mf-opt-${i}`;
      return h(
        'div.mf-option',
        { id, role: 'option', 'aria-selected': String(i === this.chosen), onclick: () => this.choose(i), ondblclick: () => this.replace() },
        h('span.mf-sample', { style: { fontFamily: `${quoteFamily(s.family)}, var(--font-ui)`, fontWeight: String(s.weight), fontStyle: s.style } }, sample),
        h('span.mf-meta', h('span.mf-family', s.family), h('span.mf-reason', `${s.reason} · ${Math.round(s.score * 100)}%`)),
      );
    });
    this.list.replaceChildren(...opts);
    this.list.setAttribute('aria-activedescendant', `mf-opt-${this.chosen}`);
  }

  // ---- actions ----

  replace() {
    const ed = this.editor;
    const r = this.result;
    const font = this.font();
    if (!ed || !r || !font || r.doc !== ed.doc) return null;
    const doc = ed.doc;
    const sources = r.sources.map((id) => doc.get(id)).filter(Boolean);
    if (!sources.length) {
      this.status.textContent = 'The matched objects are gone. Select them and match again.';
      return null;
    }
    const top = doc.sortByPaintOrder(sources.map((n) => n.id));
    const last = doc.get(top[top.length - 1]);
    const parentId = last.parent;
    const index = doc.get(parentId).children.indexOf(last.id) + 1;
    let id = null;
    try {
      doc.transact('Replace with Matched Text', () => {
        id = placeMatchedText(doc, { sources, rect: r.rect, text: this.textInput.value, font, answer: r.answer, cover: this.cover.checked, parentId, index });
      });
    } catch (err) {
      this.status.textContent = err.message;
      return null;
    }
    ed.select([id]);
    announce(`Set as editable text in ${font.family}`);
    return id;
  }

  apply() {
    const ed = this.editor;
    const font = this.font();
    const targets = matchTextTargets(ed);
    if (!font || !targets.length) return;
    ed.doc.transact('Apply Matched Font', () => applyFontTo(ed.doc, targets.map((n) => n.id), font));
    announce(`Applied ${font.family}`);
  }

  update() {
    if (!this.built) return;
    const ed = this.editor;
    const f = this.frame();
    const key = f ? f.nodes.map((n) => n.id).join(',') : '';
    if (key !== this.sourceKey) {
      this.sourceKey = key;
      this.region = null;
      this.drawThumb(f);
    }
    this.intro.hidden = Boolean(f) || Boolean(this.result);
    this.picker.hidden = !f;
    this.drawRegion();
    const st = this.app ? aiStatus(this.app) : { ok: true };
    this.matchBtn.disabled = !f || Boolean(this.busy);
    if (!this.busy && !st.ok && st.reason !== 'signedOut' && !this.status.textContent) this.status.textContent = st.message;
    this.results.hidden = !this.result;
    const hasImage = this.result?.sources.some((id) => ed?.doc.get(id)?.type === 'image');
    this.coverRow.hidden = !hasImage;
    this.replaceBtn.disabled = !this.result || !this.font();
    this.applyBtn.disabled = !this.font() || !matchTextTargets(ed).length;
    this.renderList();
  }
}
