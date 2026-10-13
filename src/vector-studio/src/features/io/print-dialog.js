/**
 * File > Print, and the editor for print presets (Edit > Print Presets).
 *
 *   General           copies, collation, reverse order, artboards, media,
 *                     orientation, print layers, placement, scaling
 *   Marks and Bleed   printer's marks (Roman or Japanese trim marks) and bleed
 *   Output            composite or host-based separations (with the inks to
 *                     print), emulsion, positive/negative, grayscale, spot
 *                     colors to process, overprint black
 *   Graphics          text as text or outlines
 *   Color Management  let the printer handle color, or simulate a press
 *   Advanced          print as bitmap, overprints, flattener preset
 *   Summary           every option and the warnings for this job
 *
 * A live preview shows every page (and plate). The browser's print dialog
 * follows for the printer itself.
 */
import { h } from '../../lib/dom.js';
import { formatLength, parseLength } from '../../lib/units.js';
import { drawArtwork } from '../../render/draw.js';
import { visualBounds, rectsIntersect } from '../../model/geometry.js';
import { parseRange, outlinesFor } from './jobs.js';
import { MEDIA, DEFAULT_PRINT, layoutContent } from './print-layout.js';
import { printView, layoutPageRules, printRoot } from './print.js';
import { PRINT_DEFAULTS, normalizePrint } from './print-settings.js';
import { documentPlates, printPlates, pageSequence, rasterOutput, buildPrintOutput, printSummary, processPlatePixels, outputProfile } from './print-output.js';
import '../prepress/print-presets.js';
import { keepFocus } from './pdf-dialog.js';
import { presetPicker, savePreset, listPresets, uniqueName } from '../prepress/presets.js';
import { CMYK_PROFILES, INTENTS, PROCESS_INKS } from '../prepress/color-management.js';
import { plateView } from '../prepress/separations.js';

const LAST_KEY = 'printSettings';

const ANCHORS = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'];

/** Artboards with nothing visible on them. */
function isBlank(doc, a) {
  let found = false;
  doc.walk((n) => {
    if (found || n.hidden) return false;
    if (n.type === 'layer') return true;
    const b = visualBounds(doc, n);
    if (b && rectsIntersect(b, a)) found = true;
    return false;
  });
  return !found;
}

/** All pages for the settings: each chosen artboard (or the artwork bounds) laid out. */
export function printJob(doc, settings, { activeArtboard = 0, fileName = '' } = {}) {
  const view = printView(doc, settings.layers);
  const date = new Date().toLocaleString();
  const contents = [];
  if (settings.ignoreArtboards) {
    let b = null;
    for (const id of doc.root.children) {
      const l = view.get(id);
      if (!l || l.hidden) continue;
      const v = visualBounds(view, l);
      if (v) b = b ? { x: Math.min(b.x, v.x), y: Math.min(b.y, v.y), w: Math.max(b.x + b.w, v.x + v.w) - Math.min(b.x, v.x), h: Math.max(b.y + b.h, v.y + v.h) - Math.min(b.y, v.y) } : v;
    }
    if (b) contents.push({ rect: b, info: `${fileName}  ${date}` });
  } else {
    let indices;
    if (settings.which === 'current') indices = [activeArtboard];
    else if (settings.which === 'range') indices = parseRange(settings.range, doc.artboards.length) || [];
    else indices = doc.artboards.map((_, i) => i);
    for (const i of indices) {
      const a = doc.artboards[i];
      if (!a || (settings.skipBlank && isBlank(view, a))) continue;
      contents.push({ rect: { x: a.x, y: a.y, w: a.w, h: a.h }, info: `${fileName}  ${a.name || `Artboard ${i + 1}`}  ${date}` });
    }
  }
  const bleed = settings.useDocBleed ? { ...DEFAULT_PRINT.bleed, ...(doc.root.bleed || {}) } : settings.bleed;
  return contents.flatMap((c) => layoutContent(c.rect, { ...settings, bleed }, c.info));
}

function defaults(app) {
  return { ...PRINT_DEFAULTS, ...normalizePrint(app.prefs.get(LAST_KEY) || {}), which: 'all', range: '' };
}

/**
 * Print, or edit a print preset with { name, values, title, names }
 * (resolves to { name, values } or null instead of printing).
 */
export async function printDialog(app, presetEdit = null) {
  const editor = app.editor;
  const doc = editor?.doc || null;
  if (!doc && !presetEdit) return null;
  const unit = doc?.root.units || 'pt';
  let st = presetEdit ? { ...normalizePrint(presetEdit.values), which: 'all', range: '' } : defaults(app);
  const count = doc?.artboards.length || 0;
  st.range ||= count ? `1-${count}` : '';
  let pageIndex = 0;
  let pages = [];
  let seq = [];

  // ---- controls ----
  const len = (v) => formatLength(v, unit);
  const lenInput = (value, label, onSet) => {
    const el = h('input.pd-len', { type: 'text', value: len(value), 'aria-label': label, inputmode: 'decimal', spellcheck: false, autocomplete: 'off' });
    el.addEventListener('change', () => {
      const v = parseLength(el.value, unit);
      if (Number.isFinite(v)) onSet(v);
      el.value = len(v);
      refresh();
    });
    return el;
  };
  const sel = (options, value, onSet, label) => {
    const el = h('select', { 'aria-label': label }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
    el.addEventListener('change', () => {
      onSet(el.value);
      refresh();
    });
    return el;
  };
  const check = (label, value, onSet, attrs = {}) => {
    const input = h('input', { type: 'checkbox', checked: Boolean(value), ...attrs });
    input.addEventListener('change', () => {
      onSet(input.checked);
      refresh();
    });
    return { el: h('label.pd-check', input, label), input };
  };
  const field = (label, ...controls) => h('div.pd-field', h('span.pd-label', label), h('div.pd-controls', ...controls));
  const seg = (label, options, value, onSet, disabled = false) => h('div.pd-seg', { role: 'radiogroup', 'aria-label': label }, options.map(([v, l]) => h('button.btn.small', { type: 'button', role: 'radio', 'aria-checked': String(value === v), disabled, onclick: () => {
    onSet(v);
    rebuild();
  } }, l)));

  // ---- presets ----
  const presetValues = () => normalizePrint(st);
  const picker = presetPicker(app, 'print', { values: presetValues(), label: 'Print preset', onPick: (v) => {
    st = { ...normalizePrint(v), which: st.which, range: st.range };
    rebuild();
  } });
  const savePresetBtn = presetEdit ? null : h('button.btn.small', { type: 'button', onclick: async () => {
    const names = listPresets(app, 'print').map((p) => p.name);
    const v = await app.dialogs.form({ title: 'Save Print Preset', fields: [{ key: 'name', label: 'Name', type: 'text', value: uniqueName(names, 'Print Preset', true) }] });
    const name = v?.name?.trim();
    if (!name) return;
    try {
      savePreset(app, 'print', name, presetValues());
    } catch (err) {
      app.notify(err.message, { error: true });
      return;
    }
    picker.sync(presetValues());
  } }, 'Save Preset…');
  const nameInput = presetEdit ? h('input.pd-name', { type: 'text', value: presetEdit.name || '', 'aria-label': 'Preset name', spellcheck: false, autocomplete: 'off' }) : null;

  const panes = ['General', 'Marks and Bleed', 'Output', 'Graphics', 'Color Management', 'Advanced', 'Summary'].map((label) => ({ label, panel: h('div.pd-section', { role: 'tabpanel', hidden: label !== 'General', 'aria-label': label }) }));
  const tabs = panes.map((p, i) => {
    p.btn = h('button.pd-tab', { type: 'button', role: 'tab', 'aria-selected': String(i === 0), onclick: () => showPane(p), onkeydown: (e) => {
      const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = panes[(i + d + panes.length) % panes.length];
      showPane(next);
      next.btn.focus();
    } }, p.label);
    return p.btn;
  });
  const showPane = (p) => {
    for (const q of panes) {
      q.btn.setAttribute('aria-selected', String(q === p));
      q.btn.tabIndex = q === p ? 0 : -1;
      q.panel.hidden = q !== p;
    }
  };
  const pane = (label) => panes.find((p) => p.label === label).panel;

  const rebuild = () => {
    const focus = keepFocus(bodyRef.el);
    rebuildPanes();
    focus();
  };
  const bodyRef = { el: null };
  const rebuildPanes = () => {
    const rangeInput = h('input.pd-range', { type: 'text', value: st.range, 'aria-label': 'Artboard range', spellcheck: false, autocomplete: 'off', disabled: !doc });
    rangeInput.addEventListener('change', () => {
      st.range = rangeInput.value;
      st.which = 'range';
      rebuild();
    });
    const which = h('div.pd-radios', { role: 'radiogroup', 'aria-label': 'Artboards' }, [['all', `All (${count})`], ['current', 'Current'], ['range', 'Range']].map(([v, l]) => {
      const r = h('input', { type: 'radio', name: 'pd-which', value: v, checked: st.which === v, disabled: st.ignoreArtboards || !doc });
      r.addEventListener('change', () => {
        st.which = v;
        refresh();
      });
      return h('label.pd-radio', r, l);
    }), rangeInput);
    const copies = h('input.pd-pct', { type: 'number', min: 1, max: 999, value: st.copies, 'aria-label': 'Copies' });
    copies.addEventListener('change', () => {
      st.copies = Math.max(1, Math.min(999, Math.round(Number(copies.value) || 1)));
      copies.value = st.copies;
      rebuild();
    });
    const collate = check('Collate', st.collate, (v) => (st.collate = v), { disabled: st.copies < 2 });
    const reverse = check('Reverse order', st.reverse, (v) => (st.reverse = v));
    const ignore = check('Ignore artboards (print all artwork)', st.ignoreArtboards, (v) => {
      st.ignoreArtboards = v;
      rebuild();
    });
    const skip = check('Skip blank artboards', st.skipBlank, (v) => (st.skipBlank = v));
    const media = sel([['artboard', 'Defined by artboard'], ...Object.entries(MEDIA).map(([k, m]) => [k, `${m.label} (${len(m.w)} × ${len(m.h)})`]), ['custom', 'Custom']], st.media, (v) => {
      st.media = v;
      if (v === 'artboard' && (st.scaling === 'fit' || st.scaling === 'tile')) st.scaling = 'none';
      rebuild();
    }, 'Media size');
    const custom = st.media === 'custom' ? [lenInput(st.mediaW, 'Media width', (v) => (st.mediaW = Math.max(36, v))), h('span.pd-x', '×'), lenInput(st.mediaH, 'Media height', (v) => (st.mediaH = Math.max(36, v)))] : [];
    const orient = seg('Orientation', [['auto', 'Auto'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], st.orientation, (v) => (st.orientation = v), st.media === 'artboard');
    const layers = sel([['printable', 'Visible & Printable Layers'], ['visible', 'Visible Layers'], ['all', 'All Layers']], st.layers, (v) => (st.layers = v), 'Print layers');
    const anchor = h('div.pd-anchor', { role: 'radiogroup', 'aria-label': 'Placement' }, ANCHORS.map((a) => h('button.pd-anchor-cell', { type: 'button', role: 'radio', 'aria-checked': String(st.anchor === a), 'aria-label': `Place at ${a}`, onclick: () => {
      st.anchor = a;
      st.offsetX = 0;
      st.offsetY = 0;
      rebuild();
    } })));
    const offX = lenInput(st.offsetX, 'Horizontal offset', (v) => (st.offsetX = v));
    const offY = lenInput(st.offsetY, 'Vertical offset', (v) => (st.offsetY = v));
    const scaling = sel([['none', 'Do Not Scale'], ...(st.media === 'artboard' ? [] : [['fit', 'Fit to Page']]), ['custom', 'Custom Scale'], ...(st.media === 'artboard' ? [] : [['tile', 'Tile Full Pages']])], st.scaling, (v) => {
      st.scaling = v;
      rebuild();
    }, 'Scaling');
    const pct = h('input.pd-pct', { type: 'number', min: 1, max: 1000, value: st.scale, 'aria-label': 'Scale percent', disabled: !(st.scaling === 'custom' || st.scaling === 'tile') });
    pct.addEventListener('change', () => {
      st.scale = Math.max(1, Math.min(1000, Number(pct.value) || 100));
      refresh();
    });
    const overlap = lenInput(st.overlap, 'Tile overlap', (v) => (st.overlap = Math.max(0, v)));
    overlap.disabled = st.scaling !== 'tile';
    pane('General').replaceChildren(
      field('Copies', copies, collate.el, reverse.el),
      field('Artboards', which),
      h('div.pd-indent', ignore.el, skip.el),
      field('Media', media, ...custom),
      field('Orientation', orient),
      field('Print layers', layers),
      field('Placement', anchor, h('div.pd-offsets', h('label', 'X', offX), h('label', 'Y', offY))),
      field('Scaling', scaling, h('label.pd-inline', pct, '%'), h('label.pd-inline', 'Overlap', overlap)),
    );

    // Marks and Bleed
    const m = st.marks;
    const all = check("All printer's marks", m.trim && m.registration && m.colorBars && m.pageInfo, (v) => {
      st.marks = { trim: v, registration: v, colorBars: v, pageInfo: v };
      rebuild();
    });
    const mark = (key, label) => check(label, m[key], (v) => {
      st.marks = { ...st.marks, [key]: v };
      rebuild();
    }).el;
    const markType = sel([['roman', 'Roman'], ['japanese', 'Japanese']], st.markType, (v) => (st.markType = v), "Printer's mark type");
    const weight = sel([['0.125', '0.125 pt'], ['0.25', '0.25 pt'], ['0.5', '0.5 pt']], String(st.markWeight), (v) => (st.markWeight = Number(v)), 'Trim mark weight');
    const offset = lenInput(st.markOffset, 'Mark offset', (v) => (st.markOffset = Math.max(0, Math.min(72, v))));
    const docBleed = check('Use document bleed settings', st.useDocBleed, (v) => {
      st.useDocBleed = v;
      rebuild();
    });
    const b = st.useDocBleed ? { ...DEFAULT_PRINT.bleed, ...(doc?.root.bleed || {}) } : st.bleed;
    const bleedInput = (side) => {
      const el = lenInput(b[side], `Bleed ${side}`, (v) => (st.bleed = { ...st.bleed, [side]: Math.max(0, Math.min(72, v)) }));
      el.disabled = st.useDocBleed;
      return h('label.pd-bleed', side[0].toUpperCase() + side.slice(1), el);
    };
    pane('Marks and Bleed').replaceChildren(
      h('h3.pd-heading', 'Marks'),
      all.el,
      h('div.pd-grid2', mark('trim', 'Trim marks'), mark('registration', 'Registration marks'), mark('colorBars', 'Color bars'), mark('pageInfo', 'Page information')),
      field("Printer's mark type", markType),
      field('Trim mark weight', weight),
      field('Offset', offset),
      h('h3.pd-heading', 'Bleed'),
      docBleed.el,
      h('div.pd-grid2', bleedInput('top'), bleedInput('bottom'), bleedInput('left'), bleedInput('right')),
    );

    // Output
    const seps = st.mode === 'separations';
    const plates = doc ? documentPlates(app, doc, st) : PROCESS_INKS.map((k) => ({ id: k, name: { c: 'Cyan', m: 'Magenta', y: 'Yellow', k: 'Black' }[k], spot: false, used: true }));
    const skipSet = new Set(st.skipPlates);
    const inks = h('ul.pd-inks', { 'aria-label': 'Document inks' }, plates.map((p) => {
      const input = h('input', { type: 'checkbox', checked: !skipSet.has(p.id), disabled: !seps, 'aria-label': `Print ${p.name}` });
      input.addEventListener('change', () => {
        const s = new Set(st.skipPlates);
        if (input.checked) s.delete(p.id);
        else s.add(p.id);
        st.skipPlates = [...s];
        refresh();
      });
      return h('li.pd-ink', h('label.pd-check', input, p.name, p.spot ? h('span.pd-muted', ' (spot)') : null, !p.used ? h('span.pd-muted', ' — not used') : null));
    }));
    pane('Output').replaceChildren(
      field('Mode', sel([['composite', 'Composite'], ['separations', 'Separations (host-based)']], st.mode, (v) => {
        st.mode = v;
        rebuild();
      }, 'Output mode')),
      field('Color', Object.assign(sel([['color', 'Color'], ['gray', 'Grayscale']], st.color, (v) => (st.color = v), 'Color'), { disabled: seps })),
      field('Emulsion', seg('Emulsion', [['up', 'Up (right reading)'], ['down', 'Down (mirrored)']], st.emulsion, (v) => (st.emulsion = v))),
      field('Image', seg('Image', [['positive', 'Positive'], ['negative', 'Negative']], st.image, (v) => (st.image = v))),
      h('div.pd-indent', check('Convert all spot colors to process', st.spotToProcess, (v) => {
        st.spotToProcess = v;
        rebuild();
      }).el, check('Overprint black', st.overprintBlack, (v) => (st.overprintBlack = v)).el),
      h('h3.pd-heading', 'Document Inks'),
      inks,
      h('p.form-help', seps ? 'Each checked ink prints on its own page as a grayscale plate.' : 'Choose Separations to print one page per ink.'),
    );

    // Graphics
    pane('Graphics').replaceChildren(
      field('Text', sel([['text', 'Print as text'], ['outlines', 'Convert to outlines']], st.textMode, (v) => (st.textMode = v), 'Text')),
      h('p.form-help', 'Outlines print every glyph exactly, independent of the fonts the printer or browser has.'),
    );

    // Color Management
    const proof = st.colorHandling === 'proof';
    pane('Color Management').replaceChildren(
      field('Color handling', sel([['browser', 'Let the browser and printer manage colors'], ['proof', 'Simulate a press']], st.colorHandling, (v) => {
        st.colorHandling = v;
        rebuild();
      }, 'Color handling')),
      field('Printer profile', sel([['document', 'Document press model'], ...Object.entries(CMYK_PROFILES).map(([k, p]) => [k, p.label])], st.printerProfile, (v) => (st.printerProfile = v), 'Printer profile')),
      field('Rendering intent', sel(Object.entries(INTENTS), st.intent, (v) => (st.intent = v), 'Rendering intent')),
      h('p.form-help', proof ? 'Colors print as the chosen press would reproduce them.' : 'Separations always use the printer profile’s press model.'),
    );

    // Advanced
    const flat = listPresets(app, 'flattener');
    const bitmapPpi = sel([['150', '150 ppi'], ['300', '300 ppi'], ['600', '600 ppi']], String(st.bitmapPpi), (v) => (st.bitmapPpi = Number(v)), 'Bitmap resolution');
    bitmapPpi.disabled = !st.bitmap;
    pane('Advanced').replaceChildren(
      field('', check('Print as bitmap', st.bitmap, (v) => {
        st.bitmap = v;
        rebuild();
      }).el, bitmapPpi),
      h('h3.pd-heading', 'Overprint and Transparency Flattener Options'),
      field('Overprints', sel([['discard', 'Discard'], ['simulate', 'Simulate']], st.overprints, (v) => (st.overprints = v), 'Overprints')),
      field('Preset', sel(flat.map((p) => [p.name, p.name]), st.flattener, (v) => (st.flattener = v), 'Flattener preset')),
      h('p.form-help', 'Simulated overprints and separations print as images at the flattener preset’s line art resolution.'),
    );
    refresh();
  };

  // ---- preview ----
  const canvas = h('canvas.pd-canvas', { width: 260, height: 300, 'aria-label': 'Page preview', role: 'img' });
  const pageLabel = h('span.pd-page-label');
  const prev = h('button.btn.small', { type: 'button', 'aria-label': 'Previous page', onclick: () => ((pageIndex = Math.max(0, pageIndex - 1)), draw()) }, '‹');
  const next = h('button.btn.small', { type: 'button', 'aria-label': 'Next page', onclick: () => ((pageIndex = Math.min(seq.length - 1, pageIndex + 1)), draw()) }, '›');
  const summary = h('p.pd-summary', { role: 'status' });
  let view = null; // { s, ox, oy } for dragging

  const draw = () => {
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.fillRect !== 'function') return;
    const dpr = window.devicePixelRatio || 1;
    const W = 260;
    const H = 300;
    if (canvas.width !== W * dpr) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const item = seq[pageIndex];
    pageLabel.textContent = seq.length ? `${pageIndex + 1} of ${seq.length}${item.plate.name ? ` · ${item.plate.name}` : ''}` : 'No pages';
    prev.disabled = pageIndex <= 0;
    next.disabled = pageIndex >= seq.length - 1;
    // Mirrored and negative output show in the preview as they print.
    const filters = [];
    if (st.image === 'negative') filters.push('invert(1)');
    if (st.mode === 'composite' && st.color === 'gray') filters.push('grayscale(1)');
    canvas.style.filter = filters.join(' ');
    canvas.style.transform = st.emulsion === 'down' ? 'scaleX(-1)' : '';
    if (!item) return;
    const p = item.page;
    const s = Math.min((W - 24) / p.w, (H - 24) / p.h);
    const ox = (W - p.w * s) / 2;
    const oy = (H - p.h * s) / 2;
    view = { s, ox, oy };
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(ox + 2, oy + 3, p.w * s, p.h * s);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(ox, oy, p.w * s, p.h * s);
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, p.w * s, p.h * s);
    ctx.clip();
    const plate = item.plate;
    let src = printView(doc, st.layers);
    if (st.mode === 'separations') src = plate.spot ? plateView(src, plate.id) : st.spotToProcess ? src : plateView(src, 'process');
    for (const t of p.tiles) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox + t.x * s, oy + t.y * s, t.rect.w * t.s * s, t.rect.h * t.s * s);
      ctx.clip();
      const k = t.s * s;
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (ox + t.x * s - t.rect.x * k), dpr * (oy + t.y * s - t.rect.y * k));
      drawArtwork(ctx, src, { viewRect: t.rect, outline: false, hairline: 1 / k, scale: k * dpr, overprint: st.overprints === 'simulate' || st.overprintBlack });
      ctx.restore();
    }
    // Process plates show their ink density.
    if (st.mode === 'separations' && !plate.spot) {
      try {
        const img = ctx.getImageData(Math.round(ox * dpr), Math.round(oy * dpr), Math.max(1, Math.round(p.w * s * dpr)), Math.max(1, Math.round(p.h * s * dpr)));
        if (img?.data?.length === img.width * img.height * 4) {
          processPlatePixels(img.data, outputProfile(app, doc, st), PROCESS_INKS.indexOf(plate.id));
          ctx.putImageData(img, Math.round(ox * dpr), Math.round(oy * dpr));
        }
      } catch {
        /* preview without plate densities */
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#000';
    for (const mk of p.marks || []) {
      ctx.lineWidth = Math.max(0.5, (mk.w || 0.25) * s);
      if (mk.kind === 'line') {
        ctx.beginPath();
        ctx.moveTo(ox + mk.x1 * s, oy + mk.y1 * s);
        ctx.lineTo(ox + mk.x2 * s, oy + mk.y2 * s);
        ctx.stroke();
      } else if (mk.kind === 'registration') {
        ctx.beginPath();
        ctx.arc(ox + mk.x * s, oy + mk.y * s, mk.r * s, 0, Math.PI * 2);
        ctx.stroke();
      } else if (mk.kind === 'swatch') {
        ctx.fillStyle = mk.color;
        ctx.fillRect(ox + mk.x * s, oy + mk.y * s, mk.w * s, mk.h * s);
      }
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, p.w * s - 1, p.h * s - 1);
  };

  // Drag the artwork in the preview to move it on the page.
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!view || st.scaling === 'fit' || st.scaling === 'tile') return;
    drag = { x: e.clientX, y: e.clientY, ox: st.offsetX, oy: st.offsetY };
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dir = st.emulsion === 'down' ? -1 : 1;
    st.offsetX = drag.ox + (dir * (e.clientX - drag.x)) / view.s;
    st.offsetY = drag.oy + (e.clientY - drag.y) / view.s;
    refresh();
  });
  canvas.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    rebuild();
  });

  function refresh() {
    pages = doc ? printJob(doc, st, { activeArtboard: editor.activeArtboard, fileName: editor.name || doc.root.name || '' }) : [];
    seq = doc ? pageSequence(pages, printPlates(app, doc, st), { ...st, copies: 1 }) : [];
    pageIndex = Math.min(pageIndex, Math.max(0, seq.length - 1));
    const p = pages[0];
    const scale = p?.tiles[0]?.s;
    summary.textContent = pages.length ? `${seq.length} page${seq.length === 1 ? '' : 's'}${st.copies > 1 ? ` × ${st.copies} copies` : ''} · ${len(p.w)} × ${len(p.h)} · ${Math.round((scale || 1) * 1000) / 10}%` : doc ? 'Nothing to print with these settings.' : 'Open a document to preview pages.';
    picker.sync(presetValues());
    const sum = pane('Summary');
    if (doc) {
      const { options, warnings } = printSummary(app, editor, pages, st);
      sum.replaceChildren(
        h('h3.pd-heading', 'Options'),
        h('dl.pd-summary-list', options.flatMap(([k, v]) => [h('dt', k), h('dd', v)])),
        h('h3.pd-heading', 'Warnings'),
        warnings.length ? h('ul.pd-warnings', warnings.map((w) => h('li', w))) : h('p.form-help', 'None.'),
      );
    } else sum.replaceChildren(h('p.form-help', 'Open a document to see a summary.'));
    draw();
  }

  rebuild();
  const error = h('p.form-error', { role: 'alert' });
  const body = (bodyRef.el = h(
    'div.pd',
    h('div.pd-top', nameInput ? h('label.pd-preset-label', 'Name', nameInput) : null, h('label.pd-preset-label', presetEdit ? 'Based on' : 'Preset', picker.el), savePresetBtn),
    h(
      'div.pd-main',
      h('div.pd-preview', canvas, h('div.pd-nav', prev, pageLabel, next), summary),
      h('div.pd-settings', h('div.pd-tabs', { role: 'tablist', 'aria-orientation': 'vertical' }, tabs), ...panes.map((p) => p.panel)),
    ),
    error,
  ));
  showPane(panes[0]);
  if (presetEdit) {
    return app.dialogs.open({
      title: presetEdit.title || 'Print Preset Options',
      className: 'wide print-dialog',
      body,
      initialFocus: () => nameInput,
      buttons: [
        { label: 'Cancel', value: null },
        {
          label: 'OK',
          primary: true,
          validate: () => {
            const nm = nameInput.value.trim();
            if (!nm) error.textContent = 'Enter a name.';
            else if ((presetEdit.names || []).includes(nm)) error.textContent = `A preset named "${nm}" already exists.`;
            else return true;
            nameInput.focus();
            return false;
          },
          value: () => ({ name: nameInput.value.trim(), values: presetValues() }),
        },
      ],
    });
  }
  const ok = await app.dialogs.open({
    title: 'Print',
    className: 'wide print-dialog',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Print', primary: true, value: () => true, validate: () => seq.length > 0 },
    ],
  });
  if (!ok) return null;
  app.prefs.set(LAST_KEY, normalizePrint(st));
  const outlines = st.textMode === 'outlines' && !rasterOutput(st) ? await outlinesFor(app, editor, null, true) : null;
  if (rasterOutput(st)) app.notify('Preparing pages…', { timeout: 2000 });
  const { root, urls } = await buildPrintOutput(app, editor, pages, st, { outlines });
  const order = pageSequence(pages, printPlates(app, doc, st), st);
  try {
    await printRoot(root, layoutPageRules(order.map((x) => x.page)));
  } finally {
    for (const u of urls) URL.revokeObjectURL?.(u);
  }
  return true;
}
