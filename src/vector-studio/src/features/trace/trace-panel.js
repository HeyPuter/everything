/**
 * Trace Image panel (Window > Trace Image).
 *
 * With a trace object selected, every change re-traces it (in the
 * background, shortly after the last change) and the info row shows the
 * live path, anchor and color counts. With a plain image selected, the
 * settings are those the Trace button will use. With neither, the panel
 * edits the settings for the next trace. Quick preset buttons, a preset
 * list with saved user presets, and an Advanced section cover every option.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { icon } from '../../ui/icons.js';
import { PRESETS, OPTION_RANGES, normalizeOptions, matchingPreset, findPreset, presetOptions } from './presets.js';
import { VIEWS, updateTrace, amendNode, traceImageNode } from './trace-live.js';
import { selectedTraces, selectedImages, traceSettings, setTraceSettings, savedPresets, traceSelection, statItem } from './trace-commands.js';

const MODES = [
  { value: 'color', label: 'Color' },
  { value: 'gray', label: 'Grayscale' },
  { value: 'bw', label: 'Black and White' },
];

const PALETTES = [
  { value: 'auto', label: 'Automatic' },
  { value: 'limited', label: 'Limited' },
  { value: 'fullTone', label: 'Full Tone' },
  { value: 'swatches', label: 'Document Swatches' },
];

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

/** A labeled slider with a numeric box. onCommit(value) fires on release, Enter or blur. */
export function sliderRow({ label, min, max, step = 1, value, suffix = '', onCommit, help }) {
  const id = nextId('trs');
  const range = h('input.trace-range', { type: 'range', id, min, max, step, value });
  const box = h('input.trace-num', { type: 'text', inputmode: 'decimal', 'aria-label': label, spellcheck: false, autocomplete: 'off' });
  const lab = h('label.trace-label', { for: id }, label);
  const fmt = (v) => `${v}${suffix}`;
  let current = value;
  const set = (v) => {
    current = v;
    range.value = String(v);
    range.setAttribute('aria-valuetext', fmt(v));
    if (document.activeElement !== box) box.value = String(v);
  };
  const commit = (v) => {
    const n = Math.max(min, Math.min(max, Math.round(Number(v) / step) * step));
    if (!Number.isFinite(n)) return set(current);
    set(n);
    if (n !== value) onCommit(n);
    value = n;
  };
  range.addEventListener('input', () => {
    box.value = range.value;
    range.setAttribute('aria-valuetext', fmt(range.value));
  });
  range.addEventListener('change', () => commit(range.value));
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit(parseFloat(box.value));
    else if (e.key === 'Escape') set(current);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      commit(current + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
      box.value = String(current);
    }
  });
  box.addEventListener('blur', () => commit(parseFloat(box.value)));
  set(value);
  const el = h('div.trace-row.trace-slider', lab, range, h('span.trace-num-wrap', box, suffix ? h('span.trace-suffix', suffix) : null), help ? h('p.trace-help', help) : null);
  return {
    el,
    set: (v) => {
      value = v;
      set(v);
    },
    setLabel: (t) => {
      lab.textContent = t;
      box.setAttribute('aria-label', t);
    },
    setRange: (lo, hi) => {
      min = lo;
      max = hi;
      range.min = lo;
      range.max = hi;
    },
  };
}

function selectRow(label, options, onChange) {
  const id = nextId('trsel');
  const sel = h('select.select', { id, onchange: () => onChange(sel.value) }, options.map((o) => h('option', { value: o.value }, o.label)));
  return { el: h('div.trace-row', h('label.trace-label', { for: id }, label), sel), sel };
}

function checkRow(label, onChange) {
  const id = nextId('trck');
  const input = h('input', { type: 'checkbox', id, onchange: () => onChange(input.checked) });
  return { el: h('div.trace-check', input, h('label', { for: id }, label)), input };
}

/** Radio group of buttons. */
function choiceRow(label, options, onChange) {
  const lid = nextId('trch');
  const buttons = options.map((o) =>
    h(
      'button.trace-choice',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': 'false',
        'data-value': o.value,
        'data-tip': o.tip || null,
        onclick: () => onChange(o.value),
        onkeydown: (e) => {
          const i = options.indexOf(o);
          const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          const n = options[(i + d + options.length) % options.length];
          onChange(n.value);
          buttons[options.indexOf(n)].focus();
        },
      },
      o.icon ? icon(o.icon, 16) : null,
      h('span', o.label),
    ),
  );
  const group = h('div.trace-choices', { role: 'radiogroup', 'aria-labelledby': lid }, buttons);
  return {
    el: h('div.trace-row', h('span.trace-label', { id: lid }, label), group),
    set: (v) =>
      buttons.forEach((b) => {
        const on = b.dataset.value === v;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }),
  };
}

export class TracePanel extends Panel {
  static id = 'traceImage';
  static title = 'Trace Image';
  static icon = 'trace-image';
  static placement = 'strip';

  build() {
    const app = this.app;
    this.state = traceSettings(app);

    // Quick presets.
    this.quick = PRESETS.filter((p) => p.quick).map((p) =>
      h('button.icon-btn.trace-quick', { type: 'button', 'aria-label': p.label, 'data-tip': p.label, 'aria-pressed': 'false', 'data-preset': p.id, onclick: () => this.choosePreset(p.id) }, icon(p.icon, 18)),
    );
    const quickRow = h('div.trace-quick-row', { role: 'group', 'aria-label': 'Quick presets' }, this.quick);

    // Preset list and its menu.
    const pid = nextId('trp');
    this.presetSel = h('select.select', { id: pid, onchange: () => this.presetSel.value && this.choosePreset(this.presetSel.value) });
    const presetMenu = h('button.icon-btn', { type: 'button', 'aria-label': 'Preset options', 'data-tip': 'Preset options', 'aria-haspopup': 'menu', onclick: (e) => this.presetMenu(e.currentTarget) }, icon('ellipsis', 16));
    const presetRow = h('div.trace-row.trace-with-btn', h('label.trace-label', { for: pid }, 'Preset'), this.presetSel, presetMenu);

    // View, with a compare button that shows the source image while pressed.
    const vid = nextId('trv');
    this.viewSel = h('select.select', { id: vid, onchange: () => this.setView(this.viewSel.value) }, VIEWS.map((v) => h('option', { value: v.value }, v.label)));
    this.compareBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Compare with source image', 'data-tip': 'Compare with source image', 'aria-pressed': 'false', onclick: () => this.toggleCompare() }, icon('trace-compare', 16));
    this.viewRow = h('div.trace-row.trace-with-btn', h('label.trace-label', { for: vid }, 'View'), this.viewSel, this.compareBtn);

    this.mode = selectRow('Mode', MODES, (v) => this.apply({ mode: v }));
    this.palette = selectRow('Palette', PALETTES, (v) => this.apply({ palette: v }));
    this.amount = sliderRow({ label: 'Colors', min: 2, max: 30, value: 12, onCommit: (v) => this.apply({ [this.amountKey]: v }) });

    // Advanced.
    const r = OPTION_RANGES;
    this.paths = sliderRow({ label: 'Paths', min: r.paths[0], max: r.paths[1], value: 70, suffix: '%', onCommit: (v) => this.apply({ paths: v }) });
    this.corners = sliderRow({ label: 'Corners', min: r.corners[0], max: r.corners[1], value: 70, suffix: '%', onCommit: (v) => this.apply({ corners: v }) });
    this.noise = sliderRow({ label: 'Noise', min: r.noise[0], max: r.noise[1], value: 16, suffix: 'px', onCommit: (v) => this.apply({ noise: v }) });
    this.detail = choiceRow('Detail', [
      { value: '1', label: 'Fast', tip: 'Trace a smaller copy of the image' },
      { value: '2', label: 'Balanced' },
      { value: '3', label: 'Fine', tip: 'Trace at the highest working resolution' },
    ], (v) => this.apply({ detail: Number(v) }));
    this.method = choiceRow('Method', [
      { value: 'abutting', label: 'Abutting', tip: 'Shapes meet edge to edge' },
      { value: 'overlapping', label: 'Overlapping', tip: 'Shapes stack; enclosed areas are filled underneath' },
    ], (v) => this.apply({ method: v }));
    this.fills = checkRow('Fills', (v) => this.apply({ fills: v }));
    this.strokes = checkRow('Strokes', (v) => this.apply({ strokes: v }));
    this.strokeWidth = sliderRow({ label: 'Max stroke', min: r.strokeWidth[0], max: r.strokeWidth[1], value: 8, suffix: 'px', onCommit: (v) => this.apply({ strokeWidth: v }) });
    this.snapLines = checkRow('Snap curves to lines', (v) => this.apply({ snapLines: v }));
    this.ignoreWhite = checkRow('Ignore white', (v) => this.apply({ ignoreWhite: v }));
    this.advanced = h(
      'details.trace-advanced',
      { ontoggle: () => app.prefs.set('traceAdvancedOpen', this.advanced.open) },
      h('summary', 'Advanced'),
      this.paths.el,
      this.corners.el,
      this.noise.el,
      this.detail.el,
      this.method.el,
      h('div.trace-row', h('span.trace-label', 'Create'), h('div.trace-checks', this.fills.el, this.strokes.el)),
      this.strokeWidth.el,
      h('div.trace-row', h('span.trace-label', 'Options'), h('div.trace-checks', this.snapLines.el, this.ignoreWhite.el)),
    );
    this.advanced.open = Boolean(app.prefs.get('traceAdvancedOpen'));

    // Info and actions.
    this.stats = { paths: statItem('trace-paths', 'Paths'), anchors: statItem('trace-anchors', 'Anchors'), colors: statItem('trace-colors', 'Colors') };
    this.status = h('p.trace-status', { role: 'status', 'aria-live': 'polite' });
    this.progressBar = h('span.trace-progress-bar');
    this.progress = h('div.trace-inline-progress', { hidden: true, 'aria-hidden': 'true' }, h('span.trace-progress-track', this.progressBar));
    this.info = h('div.trace-info', h('span.trace-info-label', 'Info'), this.stats.paths.el, this.stats.anchors.el, this.stats.colors.el);
    this.traceBtn = h('button.btn.primary', { type: 'button', onclick: () => traceSelection(app, { options: this.state.options, preset: this.state.preset }) }, 'Trace');
    this.expandBtn = h('button.btn', { type: 'button', onclick: () => app.commands.run('trace.expand') }, 'Expand');
    this.releaseBtn = h('button.btn', { type: 'button', onclick: () => app.commands.run('trace.release') }, 'Release');
    this.cancelBtn = h('button.btn.small', { type: 'button', onclick: () => this.cancelTrace() }, 'Cancel');
    this.retraceBtn = h('button.btn.small', { type: 'button', onclick: () => this.retrace() }, 'Update');
    this.hint = h('p.trace-hint');
    this.actions = h('div.trace-actions', this.traceBtn, this.expandBtn, this.releaseBtn);

    this.el.append(
      h('section.panel-section.trace-top', quickRow, presetRow, this.viewRow, this.mode.el, this.palette.el, this.amount.el),
      h('section.panel-section', this.advanced),
      h('section.panel-section.trace-bottom', this.info, this.progress, h('div.trace-status-row', this.status, this.cancelBtn, this.retraceBtn), this.hint, this.actions),
    );

    app.on('trace-progress', ({ doc, id }) => {
      if (!this.visible || doc !== app.editor?.doc) return;
      if (selectedTraces(app.editor).some((n) => n.id === id)) this.updateStatus();
    });
  }

  /** What the panel edits: { traces, images }. */
  targets() {
    const ed = this.app.editor;
    return { traces: selectedTraces(ed), images: selectedImages(ed) };
  }

  apply(patch, presetId) {
    const app = this.app;
    const next = normalizeOptions({ ...this.state.options, ...patch });
    const saved = savedPresets(app);
    const preset = presetId !== undefined ? presetId : (matchingPreset(next, saved)?.id ?? null);
    this.state = { preset, options: next };
    const { traces } = this.targets();
    if (traces.length) {
      const doc = app.editor.doc;
      doc.transact('Trace Options', () => traces.forEach((n) => updateTrace(doc, n.id, { options: next, preset })), { coalesce: 'trace-options' });
    }
    setTraceSettings(app, { preset, options: next });
    this.update();
  }

  choosePreset(id) {
    const p = findPreset(id, savedPresets(this.app));
    if (!p) return;
    this.apply(presetOptions(id, savedPresets(this.app)), id);
  }

  setView(view) {
    const { traces } = this.targets();
    if (!traces.length) return;
    this.endCompare();
    const doc = this.app.editor.doc;
    doc.transact('Trace View', () => traces.forEach((n) => updateTrace(doc, n.id, { view })));
  }

  /** Show the source image of the selected trace objects without changing the document's history. */
  toggleCompare() {
    if (this.comparing) return this.endCompare();
    const { traces } = this.targets();
    if (!traces.length) return;
    const doc = this.app.editor.doc;
    this.comparing = { doc, views: new Map(traces.map((n) => [n.id, n.live.view || 'result'])) };
    for (const n of traces) amendNode(doc, n.id, { live: { ...n.live, view: 'source' } });
    this.compareBtn.setAttribute('aria-pressed', 'true');
  }

  endCompare() {
    const c = this.comparing;
    if (!c) return;
    this.comparing = null;
    for (const [id, view] of c.views) {
      const n = c.doc.get(id);
      if (n?.live?.view === 'source') amendNode(c.doc, id, { live: { ...n.live, view } });
    }
    this.compareBtn.setAttribute('aria-pressed', 'false');
  }

  presetMenu(anchor) {
    this.app.showMenuAt(anchor, this.presetItems(), 'Preset options');
  }

  presetItems() {
    const saved = savedPresets(this.app);
    const cur = saved.find((p) => p.id === this.state.preset);
    return [
      { label: 'Save as New Preset...', run: () => this.savePreset() },
      { label: cur ? `Rename "${cur.label}"...` : 'Rename Preset...', enabled: Boolean(cur), run: () => this.renamePreset(cur) },
      { label: cur ? `Delete "${cur.label}"` : 'Delete Preset', enabled: Boolean(cur), run: () => this.deletePreset(cur) },
      '-',
      { label: 'Import Presets...', run: () => this.importPresets() },
      { label: 'Export Presets...', enabled: saved.length > 0, run: () => this.exportPresets() },
      '-',
      { label: 'Reset to Default', run: () => this.choosePreset('auto-color') },
    ];
  }

  menu() {
    return [...this.presetItems(), '-', 'trace.make', 'trace.makeExpand', 'trace.expand', 'trace.release'];
  }

  async renamePreset(p) {
    if (!p) return;
    const v = await this.app.dialogs.form({ title: 'Rename Trace Preset', fields: [{ key: 'name', type: 'text', label: 'Name', value: p.label }] });
    const name = v?.name?.trim();
    if (!name) return;
    this.app.prefs.set('tracePresets', savedPresets(this.app).map((q) => (q.id === p.id ? { ...q, label: name } : q)));
    this.update();
  }

  exportPresets() {
    const data = { format: 'vector-studio-trace-presets', version: 1, presets: savedPresets(this.app) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: 'Trace Presets.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Import presets from a file written by Export Presets (names that exist are replaced). */
  async importPresets(file = null) {
    if (!file) {
      const { pickWithInput } = await import('../files/service.js');
      [file] = await pickWithInput('.json,application/json');
    }
    if (!file) return 0;
    let list;
    try {
      const data = JSON.parse(await file.text());
      if (data?.format !== 'vector-studio-trace-presets' || !Array.isArray(data.presets)) throw new Error('bad');
      list = data.presets.filter((p) => p?.label && p.options).map((p, i) => ({ id: `user-${Date.now().toString(36)}-${i}`, label: String(p.label), options: normalizeOptions(p.options) }));
    } catch {
      this.app.notify('This file does not contain trace presets.', { error: true });
      return 0;
    }
    const names = new Set(list.map((p) => p.label));
    this.app.prefs.set('tracePresets', [...savedPresets(this.app).filter((p) => !names.has(p.label)), ...list]);
    this.app.notify(`Imported ${list.length} trace preset${list.length === 1 ? '' : 's'}.`, { polite: true });
    this.update();
    return list.length;
  }

  async savePreset() {
    const app = this.app;
    const saved = savedPresets(app);
    const values = await app.dialogs.form({ title: 'Save Trace Preset', fields: [{ key: 'name', type: 'text', label: 'Name', value: `Custom ${saved.length + 1}` }], okLabel: 'Save' });
    const name = values?.name?.trim();
    if (!name) return;
    const id = `user-${Date.now().toString(36)}`;
    app.prefs.set('tracePresets', [...saved.filter((p) => p.label !== name), { id, label: name, options: { ...this.state.options } }]);
    this.state = { ...this.state, preset: id };
    setTraceSettings(app, this.state);
    const { traces } = this.targets();
    if (traces.length) {
      const doc = app.editor.doc;
      doc.transact('Trace Options', () => traces.forEach((n) => updateTrace(doc, n.id, { preset: id })));
    }
    this.update();
  }

  deletePreset(p) {
    if (!p) return;
    const app = this.app;
    app.prefs.set('tracePresets', savedPresets(app).filter((q) => q.id !== p.id));
    this.state = { ...this.state, preset: null };
    this.update();
  }

  cancelTrace() {
    const ed = this.app.editor;
    for (const n of selectedTraces(ed)) this.app.traceService?.cancel(ed.doc, n.id);
    this.updateStatus();
  }

  retrace() {
    const ed = this.app.editor;
    for (const n of selectedTraces(ed)) this.app.traceService?.schedule(ed.doc, n.id, 0);
    this.updateStatus();
  }

  updateStatus() {
    const ed = this.app.editor;
    const traces = ed ? selectedTraces(ed) : [];
    const svc = this.app.traceService;
    let busy = null;
    let stale = false;
    for (const n of traces) {
      const p = svc?.progress(ed.doc, n.id);
      if (p != null) busy = Math.max(busy ?? 0, p);
      else if (svc && n.live.result && traceImageNode(ed.doc, n) && svc.isStale?.(ed.doc, n)) stale = true;
    }
    this.progress.hidden = busy == null;
    this.progressBar.style.width = `${Math.round((busy ?? 0) * 100)}%`;
    this.cancelBtn.hidden = busy == null;
    this.retraceBtn.hidden = busy != null || !stale;
    this.status.textContent = busy != null ? `Tracing... ${Math.round(busy * 100)}%` : stale ? 'Showing an earlier result.' : '';
    const total = { paths: 0, anchors: 0, colors: 0 };
    let any = false;
    for (const n of traces) {
      const s = n.live.result?.stats;
      if (!s) continue;
      any = true;
      total.paths += s.paths;
      total.anchors += s.anchors;
      total.colors = Math.max(total.colors, s.colors);
    }
    this.stats.paths.set(any ? total.paths : null);
    this.stats.anchors.set(any ? total.anchors : null);
    this.stats.colors.set(any ? total.colors : null);
  }

  update() {
    const app = this.app;
    const ed = app.editor;
    const { traces, images } = this.targets();
    if (this.comparing && (!ed || this.comparing.doc !== ed.doc || !traces.some((n) => this.comparing.views.has(n.id)))) this.endCompare();
    if (traces.length) {
      const live = traces[0].live;
      this.state = { preset: live.preset ?? null, options: normalizeOptions(live.options) };
    } else this.state = traceSettings(app);
    const { options: o, preset } = this.state;
    const saved = savedPresets(app);

    // Presets.
    const opts = [...PRESETS.map((p) => ({ value: p.id, label: p.label })), ...saved.map((p) => ({ value: p.id, label: p.label }))];
    const known = preset && findPreset(preset, saved);
    const key = `${opts.map((x) => x.value).join('|')}:${known ? '' : 'custom'}`;
    if (this.presetKey !== key) {
      this.presetKey = key;
      this.presetSel.replaceChildren(
        ...(known ? [] : [h('option', { value: '' }, 'Custom')]),
        h('optgroup', { label: 'Built-in' }, PRESETS.map((p) => h('option', { value: p.id }, p.label))),
        saved.length ? h('optgroup', { label: 'Saved' }, saved.map((p) => h('option', { value: p.id }, p.label))) : null,
      );
    }
    this.presetSel.value = known ? preset : '';
    for (const b of this.quick) b.setAttribute('aria-pressed', String(b.dataset.preset === preset));

    // View.
    this.viewRow.hidden = !traces.length;
    if (traces.length) this.viewSel.value = this.comparing?.views.get(traces[0].id) || traces[0].live.view || 'result';

    // Mode, palette and the main amount.
    this.mode.sel.value = o.mode;
    this.palette.sel.value = o.palette;
    this.palette.sel.disabled = o.mode !== 'color';
    this.palette.el.classList.toggle('disabled', o.mode !== 'color');
    this.amountKey = o.mode === 'bw' ? 'threshold' : o.mode === 'gray' ? 'grays' : 'colors';
    const [lo, hi] = OPTION_RANGES[this.amountKey];
    this.amount.setRange(lo, hi);
    this.amount.setLabel(o.mode === 'bw' ? 'Threshold' : o.mode === 'gray' ? 'Grays' : o.palette === 'auto' ? 'Max colors' : 'Colors');
    this.amount.set(o[this.amountKey]);
    this.amount.el.hidden = o.mode === 'color' && o.palette === 'swatches';

    // Advanced.
    this.paths.set(o.paths);
    this.corners.set(o.corners);
    this.noise.set(o.noise);
    this.detail.set(String(o.detail));
    this.method.set(o.method);
    this.fills.input.checked = o.fills;
    this.strokes.input.checked = o.strokes;
    this.strokeWidth.set(o.strokeWidth);
    this.strokeWidth.el.hidden = !o.strokes;
    this.snapLines.input.checked = o.snapLines;
    this.ignoreWhite.input.checked = o.ignoreWhite;

    // Actions.
    this.traceBtn.hidden = !images.length;
    this.traceBtn.textContent = images.length > 1 ? `Trace ${images.length} Images` : 'Trace';
    this.expandBtn.hidden = !traces.length;
    this.releaseBtn.hidden = !traces.length;
    this.info.hidden = !traces.length;
    this.hint.textContent = !ed ? 'Open a document to trace images.' : traces.length || images.length ? '' : 'Select a placed image to trace it. These settings are used for the next trace.';
    this.hint.hidden = !this.hint.textContent;
    this.updateStatus();
  }

  hidden() {
    this.endCompare();
    super.hidden();
  }
}
