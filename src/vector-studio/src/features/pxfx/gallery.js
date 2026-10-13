/**
 * The Effect Gallery dialog: a large live preview, the filters by category
 * with thumbnails (and a search field), the selected filter's settings and
 * the stack of filters the effect applies in order (add, delete, reorder,
 * hide). Every filter command of the Effect menu opens it on that filter;
 * editing a gallery effect from the Appearance panel opens it on the
 * effect's stack.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../ui/icons.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { sliderField, selectRow, checkField } from '../effects/dialog-kit.js';
import { createEffect, normalizeEffect } from '../paint/effects-model.js';
import { CATEGORIES, FILTERS, FILTER, newLayer, layerParams, cleanLayer } from './catalog.js';
import { EffectPreview } from './preview.js';
import { effectSession } from './session.js';
import { queueThumb, THUMB_W, THUMB_H } from './thumbs.js';

let uid = 0;

/** Per-filter settings last used (kept in preferences). */
function lastParams(app) {
  if (!app.pxfxLast) app.pxfxLast = { ...(app.prefs?.get?.('pxfxLast') || {}) };
  return app.pxfxLast;
}

function rememberLayers(app, stack) {
  const m = lastParams(app);
  for (const l of stack) m[l.filter] = layerParams(l);
  app.prefs?.set?.('pxfxLast', m);
}

/** The stack a new gallery session starts with. */
export function startStack(app, { existing = null, params = null, focus = null } = {}) {
  const last = lastParams(app);
  const layerFor = (id) => newLayer(id, last[id] || {});
  if (focus && FILTER.has(focus)) return [layerFor(focus)];
  const from = existing || params || app.lastEffects?.gallery;
  const stack = (from?.stack || []).map(cleanLayer).filter(Boolean);
  return stack.length ? stack : [layerFor(app.pxfxLastFilter && FILTER.has(app.pxfxLastFilter) ? app.pxfxLastFilter : 'watercolor')];
}

/**
 * Open the gallery. `focus` starts on one filter (a filter command),
 * `params` from a gallery record (Last Effect), `edit` ({ id, index })
 * edits an existing effect. Resolves true when applied.
 */
export async function openGallery(app, { params = null, edit = null, focus = null } = {}) {
  const ses = effectSession(app, 'gallery', { edit });
  if (!ses) return false;
  const unit = ses.doc.root.units || 'pt';
  let stack = startStack(app, { existing: ses.existing, params, focus });
  const seed = ses.existing?.seed || params?.seed || createEffect('gallery', {}).seed;
  let sel = stack.length - 1;
  const record = () => (stack.length ? normalizeEffect({ type: 'gallery', stack, seed }) : null);
  const id = `pxg-${++uid}`;

  const preview = new EffectPreview({ source: () => ses.view(record()), label: 'Effect preview' });

  // ---- catalog ----
  const tiles = new Map();
  const tile = (f) => {
    const canvas = h('canvas.pxg-thumb', { width: THUMB_W, height: THUMB_H, 'aria-hidden': 'true' });
    const btn = h('button.pxg-tile', { type: 'button', 'aria-pressed': 'false', dataset: { filter: f.id }, onclick: () => pick(f.id) }, canvas, h('span.pxg-tile-label', f.label));
    tiles.set(f.id, { btn, canvas, queued: false });
    return btn;
  };
  const thumbs = (cat) => {
    for (const f of FILTERS) {
      if (f.category !== cat) continue;
      const t = tiles.get(f.id);
      if (t.queued) continue;
      t.queued = true;
      queueThumb(f.id, t.canvas);
    }
  };
  const cats = CATEGORIES.map((cat) => {
    const items = FILTERS.filter((f) => f.category === cat.id);
    const details = h('details.pxg-cat', { dataset: { cat: cat.id } }, h('summary.pxg-cat-title', cat.label), h('div.pxg-grid', items.map(tile)));
    details.addEventListener('toggle', () => details.open && thumbs(cat.id));
    return { cat, details, items };
  });
  const search = h('input.pxg-search', { type: 'search', placeholder: 'Find a filter', 'aria-label': 'Find a filter', autocomplete: 'off', spellcheck: false });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const c of cats) {
      let any = false;
      for (const f of c.items) {
        const hit = !q || f.label.toLowerCase().includes(q) || c.cat.label.toLowerCase().includes(q);
        tiles.get(f.id).btn.hidden = !hit;
        any ||= hit;
      }
      c.details.hidden = !any;
      if (q && any) c.details.open = true;
    }
  });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = FILTERS.find((f) => !tiles.get(f.id).btn.hidden && !tiles.get(f.id).btn.closest('details').hidden);
    if (!first) return;
    e.preventDefault();
    e.stopPropagation();
    pick(first.id);
  });
  const catalog = h('section.pxg-catalog', { 'aria-label': 'Filters' }, search, h('div.pxg-cats', cats.map((c) => c.details)));

  // ---- settings ----
  const filterSel = h(
    'select.select.pxg-filter',
    { id: `${id}-filter` },
    CATEGORIES.map((c) => h('optgroup', { label: c.label }, FILTERS.filter((f) => f.category === c.id).map((f) => h('option', { value: f.id }, f.label)))),
  );
  filterSel.addEventListener('change', () => pick(filterSel.value));
  const paramsBox = h('div.pxg-params.fx-body');
  const list = h('ul.pxg-stack', { role: 'listbox', tabindex: '0', 'aria-label': 'Applied filters, first to last' });
  const tool = (label, name, fn) => h('button.icon-btn.pxg-tool', { type: 'button', 'aria-label': label, 'data-tip': label, onclick: fn }, icon(name, 16));
  const tools = h(
    'div.pxg-tools',
    tool('New filter layer (copy of the selected one)', 'plus', () => addLayer()),
    tool('Move up', 'chevron-up', () => move(-1)),
    tool('Move down', 'chevron-down', () => move(1)),
    tool('Delete filter layer', 'trash', () => removeLayer()),
  );
  const settings = h(
    'section.pxg-settings',
    { 'aria-label': 'Filter settings' },
    h('div.fx-row.fx-select', h('label.fx-label', { for: filterSel.id }, 'Filter'), filterSel),
    paramsBox,
    h('div.pxg-stack-head', h('span.pxg-stack-title', { id: `${id}-stack` }, 'Applied Filters'), tools),
    list,
  );

  function pick(fid) {
    const keep = stack[sel];
    const next = newLayer(fid, lastParams(app)[fid] || {});
    if (keep?.hidden) next.hidden = true;
    if (!stack.length) {
      stack = [next];
      sel = 0;
    } else stack = stack.map((l, i) => (i === sel ? next : l));
    app.pxfxLastFilter = fid;
    refresh(true);
  }

  function setParam(key, v) {
    const l = stack[sel];
    if (!l) return;
    const next = cleanLayer({ ...l, [key]: v });
    stack = stack.map((x, i) => (i === sel ? next : x));
    lastParams(app)[next.filter] = layerParams(next);
    refresh(false);
  }

  function addLayer() {
    const base = stack[sel] || newLayer('watercolor');
    const copy = { ...base };
    delete copy.hidden;
    stack = [...stack.slice(0, sel + 1), copy, ...stack.slice(sel + 1)];
    sel += 1;
    refresh(true);
  }

  function removeLayer() {
    if (!stack.length) return;
    stack = stack.filter((_, i) => i !== sel);
    sel = Math.min(sel, stack.length - 1);
    refresh(true);
  }

  function move(d) {
    const j = sel + d;
    if (sel < 0 || j < 0 || j >= stack.length) return;
    const next = stack.slice();
    [next[sel], next[j]] = [next[j], next[sel]];
    stack = next;
    sel = j;
    refresh(true);
  }

  function toggle(i) {
    stack = stack.map((l, k) => (k === i ? (l.hidden ? cleanLayer({ ...l, hidden: false }) : { ...l, hidden: true }) : l));
    refresh(false);
  }

  function buildParams() {
    paramsBox.replaceChildren();
    const l = stack[sel];
    const f = l && FILTER.get(l.filter);
    filterSel.disabled = !f;
    if (!f) {
      paramsBox.append(h('p.fx-note', 'No filters. Pick one from the list to add it.'));
      return;
    }
    filterSel.value = f.id;
    for (const s of f.params) {
      const v = l[s.key];
      if (s.type === 'number') {
        const kind = s.unit === 'pt' ? 'length' : s.unit === '%' ? 'percent' : s.unit === '°' ? 'angle' : 'number';
        paramsBox.append(sliderField({ label: s.label, value: v, min: s.min, max: s.max, step: s.step, kind, unit, integer: kind !== 'length' && s.step >= 1, onInput: (x) => setParam(s.key, x) }).el);
      } else if (s.type === 'select') {
        paramsBox.append(selectRow({ label: s.label, value: v, options: s.options, onChange: (x) => setParam(s.key, x) }).el);
      } else if (s.type === 'check') {
        paramsBox.append(checkField({ label: s.label, value: v, onChange: (x) => setParam(s.key, x) }).el);
      } else if (s.type === 'color') {
        const cid = `${id}-${s.key}`;
        const input = h('input.pxg-color', { type: 'color', id: cid, value: v });
        input.addEventListener('input', () => setParam(s.key, input.value));
        paramsBox.append(h('div.fx-row.fx-select', h('label.fx-label', { for: cid }, s.label), input));
      }
    }
  }

  function buildStack() {
    list.replaceChildren();
    stack.forEach((l, i) => {
      const f = FILTER.get(l.filter);
      // The eye is a pointer target inside the option (Space toggles it from the keyboard).
      const eye = h('span.icon-btn.pxg-eye', { 'aria-hidden': 'true', 'data-tip': l.hidden ? `Show ${f.label}` : `Hide ${f.label}`, onclick: (e) => (e.stopPropagation(), toggle(i)) }, icon(l.hidden ? 'eye-off' : 'eye', 14));
      const row = h(
        'li.pxg-layer',
        { id: `${id}-l${i}`, role: 'option', 'aria-selected': String(i === sel), draggable: 'true', dataset: { index: String(i) }, onclick: () => select(i) },
        eye,
        h(`span.pxg-layer-name${l.hidden ? '.off' : ''}`, f.label),
        l.hidden ? h('span.sr-only', ' (hidden)') : null,
      );
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/plain', String(i));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer?.getData('text/plain'));
        if (!Number.isInteger(from) || from === i) return;
        const next = stack.slice();
        const [m] = next.splice(from, 1);
        next.splice(i, 0, m);
        stack = next;
        sel = i;
        refresh(true);
      });
      list.append(row);
    });
    if (!stack.length) list.append(h('li.pxg-empty', { role: 'presentation' }, 'Empty: OK removes nothing and adds nothing.'));
    if (sel >= 0 && stack.length) list.setAttribute('aria-activedescendant', `${id}-l${sel}`);
    else list.removeAttribute('aria-activedescendant');
    tools.children[1].disabled = sel <= 0;
    tools.children[2].disabled = sel < 0 || sel >= stack.length - 1;
    tools.children[3].disabled = !stack.length;
  }

  function select(i) {
    sel = i;
    refresh(true);
  }

  list.addEventListener('keydown', (e) => {
    if (!stack.length) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const d = e.key === 'ArrowUp' ? -1 : 1;
      if (e.altKey) move(d);
      else select(Math.max(0, Math.min(stack.length - 1, sel + d)));
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeLayer();
    } else if (e.key === ' ') {
      e.preventDefault();
      toggle(sel);
    }
  });

  function markTiles() {
    const cur = stack[sel]?.filter;
    for (const [fid, t] of tiles) t.btn.setAttribute('aria-pressed', String(fid === cur));
    const cat = cur && FILTER.get(cur).category;
    for (const c of cats) {
      if (c.cat.id === cat && !c.details.open) c.details.open = true;
    }
    if (cat) thumbs(cat);
    if (cur) tiles.get(cur).btn.scrollIntoView?.({ block: 'nearest' });
  }

  let frame = 0;
  function refresh(structure) {
    if (structure) {
      buildParams();
      markTiles();
    }
    buildStack();
    // Settle slider drags into one document update per frame.
    if (frame) return;
    const run = () => {
      frame = 0;
      ses.apply(record());
      preview.redraw();
    };
    frame = typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(run) : setTimeout(run, 0);
  }

  const previewBox = h('input', { type: 'checkbox', id: `${id}-pv`, checked: ses.preview });
  previewBox.addEventListener('change', () => {
    ses.preview = previewBox.checked;
  });
  const previewRow = h('label.fx-preview-toggle', { for: previewBox.id }, previewBox, 'Preview on canvas');

  const body = h('div.pxg', h('section.pxg-view', { 'aria-label': 'Preview' }, preview.el), catalog, settings);
  refresh(true);
  let ok = false;
  try {
    ok = await openDialog({
      title: 'Effect Gallery',
      className: 'pxg-dialog',
      body,
      buttons: [
        { label: 'Cancel', value: false },
        { label: 'OK', primary: true, value: true },
      ],
      initialFocus: () => (focus ? paramsBox.querySelector('input, select') || filterSel : search),
      onOpen: ({ footer }) => {
        footer.prepend(previewRow);
        preview.fit();
      },
    });
  } catch (err) {
    preview.dispose();
    ses.cancel();
    throw err;
  }
  preview.dispose();
  if (frame) (typeof cancelAnimationFrame !== 'undefined' ? cancelAnimationFrame : clearTimeout)(frame);
  if (!ok) {
    ses.cancel();
    return false;
  }
  const fx = record();
  ses.commit(fx);
  rememberLayers(app, stack);
  return Boolean(fx);
}
