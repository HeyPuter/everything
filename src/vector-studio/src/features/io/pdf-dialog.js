/**
 * PDF export options (Export As > PDF) and the editor for PDF presets
 * (Edit > PDF Presets): General, Compression, Marks and Bleeds, Output,
 * Advanced, Security and Summary panes. See pdf-settings.js for the values.
 */
import { h } from '../../lib/dom.js';
import { formatLength, parseLength } from '../../lib/units.js';
import { normalizePdf, presetPdf, pdfSummary, pdfWarnings, JPEG_QUALITIES } from './pdf-settings.js';
import { presetPicker, savePreset, listPresets, uniqueName } from '../prepress/presets.js';
import { CMYK_PROFILES, RGB_SPACES, documentCmykProfile } from '../prepress/color-management.js';
import { spotInks } from '../prepress/separations.js';
import '../prepress/pdf-presets.js';

let uidc = 0;

/** Remember the focused control (by its label) so focus survives rebuilding the panes. */
export function keepFocus(root) {
  const el = root && typeof document !== 'undefined' ? document.activeElement : null;
  if (!el || !root.contains(el)) return () => {};
  const label = el.getAttribute('aria-label') || el.closest('label')?.textContent;
  const tag = el.tagName;
  return () => {
    if (root.contains(el) || !label) return;
    const again = [...root.querySelectorAll(tag)].find((x) => (x.getAttribute('aria-label') || x.closest('label')?.textContent) === label);
    again?.focus();
  };
}

/**
 * Resolves to PDF settings, or null. With presetEdit ({ name, values,
 * title, names }) it edits a preset and resolves to { name, values }.
 */
export async function pdfOptionsDialog(app, { values = {}, presetEdit = null } = {}) {
  const doc = app.editor?.doc || null;
  const unit = doc?.root.units || 'pt';
  let st = normalizePdf(presetEdit ? presetEdit.values : values);
  const len = (v) => formatLength(v, unit);
  const id = (p) => `pdf-${p}-${++uidc}`;
  const field = (label, ...controls) => h('div.pd-field', h('span.pd-label', label), h('div.pd-controls', ...controls));
  const sel = (options, value, onSet, label, attrs = {}) => {
    const el = h('select', { 'aria-label': label, ...attrs }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
    el.addEventListener('change', () => {
      onSet(el.value);
      rebuild();
    });
    return el;
  };
  const check = (label, value, onSet, attrs = {}) => {
    const input = h('input', { type: 'checkbox', checked: Boolean(value), ...attrs });
    input.addEventListener('change', () => {
      onSet(input.checked);
      rebuild();
    });
    return h('label.pd-check', input, label);
  };
  const numInput = (value, label, onSet, attrs = {}) => {
    const el = h('input.pd-pct', { type: 'number', value, 'aria-label': label, ...attrs });
    el.addEventListener('change', () => {
      const v = Number(el.value);
      if (Number.isFinite(v)) onSet(v);
      rebuild();
    });
    return el;
  };
  const lenInput = (value, label, onSet, disabled) => {
    const el = h('input.pd-len', { type: 'text', value: len(value), 'aria-label': label, inputmode: 'decimal', spellcheck: false, autocomplete: 'off', disabled });
    el.addEventListener('change', () => {
      const v = parseLength(el.value, unit);
      if (Number.isFinite(v)) onSet(v);
      rebuild();
    });
    return el;
  };
  const password = (value, label, onSet, disabled) => {
    const el = h('input.pd-password', { type: 'password', value, 'aria-label': label, autocomplete: 'new-password', spellcheck: false, disabled });
    el.addEventListener('input', () => {
      onSet(el.value);
      refresh();
    });
    return el;
  };

  const picker = presetPicker(app, 'pdf', { values: presetPdf(st), label: 'PDF preset', onPick: (v) => {
    // Passwords are never stored in presets; keep the ones typed here.
    st = normalizePdf({ ...v, openPassword: st.openPassword, permissionsPassword: st.permissionsPassword });
    rebuild();
  } });
  const saveBtn = presetEdit ? null : h('button.btn.small', { type: 'button', onclick: async () => {
    const names = listPresets(app, 'pdf').map((p) => p.name);
    const v = await app.dialogs.form({ title: 'Save PDF Preset', fields: [{ key: 'name', label: 'Name', type: 'text', value: uniqueName(names, 'PDF Preset', true) }] });
    const name = v?.name?.trim();
    if (!name) return;
    try {
      savePreset(app, 'pdf', name, presetPdf(st));
    } catch (err) {
      app.notify(err.message, { error: true });
      return;
    }
    picker.sync(presetPdf(st));
  } }, 'Save Preset…');
  const nameInput = presetEdit ? h('input.pd-name', { type: 'text', value: presetEdit.name || '', 'aria-label': 'Preset name', spellcheck: false, autocomplete: 'off' }) : null;
  const top = h('div.pd-top');

  const panes = ['General', 'Compression', 'Marks and Bleeds', 'Output', 'Advanced', 'Security', 'Summary'].map((label) => ({ label, panel: h('div.pd-section', { role: 'tabpanel', 'aria-label': label, hidden: label !== 'General' }) }));
  const showPane = (p) => {
    for (const q of panes) {
      q.btn.setAttribute('aria-selected', String(q === p));
      q.btn.tabIndex = q === p ? 0 : -1;
      q.panel.hidden = q !== p;
    }
  };
  panes.forEach((p, i) => {
    p.btn = h('button.pd-tab', { type: 'button', role: 'tab', 'aria-selected': String(i === 0), onclick: () => showPane(p), onkeydown: (e) => {
      const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = panes[(i + d + panes.length) % panes.length];
      showPane(next);
      next.btn.focus();
    } }, p.label);
  });
  const pane = (label) => panes.find((p) => p.label === label).panel;

  function rebuild() {
    const focus = keepFocus(body);
    rebuildPanes();
    focus();
  }

  function rebuildPanes() {
    const v = st;
    const compat = Number(v.compat);
    top.replaceChildren(
      ...[nameInput ? h('label.pd-inline', 'Name', nameInput) : null, h('label.pd-preset-label', presetEdit ? 'Based on' : 'Preset', picker.el, saveBtn)].filter(Boolean),
      h('label.pd-inline', 'Standard', sel([['none', 'None'], ['press', 'Print production (output intent)']], v.standard, (x) => (st.standard = x), 'Standard')),
      h('label.pd-inline', 'Compatibility', sel([['1.4', 'PDF 1.4'], ['1.5', 'PDF 1.5'], ['1.6', 'PDF 1.6'], ['1.7', 'PDF 1.7']], v.compat, (x) => (st.compat = x), 'Compatibility')),
    );

    pane('General').replaceChildren(
      h('h3.pd-heading', 'Options'),
      check('Create layers from top-level layers', v.layers && compat >= 1.5, (x) => (st.layers = x), { disabled: compat < 1.5 }),
      check('Embed page thumbnails', v.thumbnails, (x) => (st.thumbnails = x)),
      check('View PDF after saving', v.viewAfter, (x) => (st.viewAfter = x)),
      compat < 1.5 ? h('p.form-help', 'Layers need PDF 1.5 or later.') : null,
    );

    pane('Compression').replaceChildren(
      h('h3.pd-heading', 'Images'),
      field('Downsampling', sel([['none', 'Do Not Downsample'], ['average', 'Average Downsampling'], ['bicubic', 'Bicubic Downsampling']], v.downsample, (x) => (st.downsample = x), 'Downsampling')),
      field('To', numInput(v.downsamplePpi, 'Downsample to (ppi)', (x) => (st.downsamplePpi = x), { min: 9, max: 2400, disabled: v.downsample === 'none' }), h('span', 'ppi for images above'), numInput(v.downsampleAbove, 'Downsample images above (ppi)', (x) => (st.downsampleAbove = x), { min: 9, max: 4800, disabled: v.downsample === 'none' }), h('span', 'ppi')),
      field('Compression', sel([['auto', 'Automatic (keep JPEG, ZIP otherwise)'], ['jpeg', 'JPEG'], ['zip', 'ZIP']], v.imageCompression, (x) => (st.imageCompression = x), 'Image compression')),
      field('Image quality', sel(JPEG_QUALITIES.map(([q, l]) => [String(q), l]), String(JPEG_QUALITIES.find(([q]) => Math.abs(q - v.jpegQuality) < 0.01)?.[0] ?? 0.85), (x) => (st.jpegQuality = Number(x)), 'Image quality', { disabled: v.imageCompression !== 'jpeg' })),
      h('h3.pd-heading', 'Text and Line Art'),
      check('Compress text and line art', v.compressArt, (x) => (st.compressArt = x)),
    );

    const m = v.marks;
    const mark = (key, label) => check(label, m[key], (x) => (st.marks = { ...st.marks, [key]: x }));
    const docBleed = doc?.root.bleed;
    const b = v.useDocBleed && docBleed != null ? (typeof docBleed === 'number' ? { top: docBleed, bottom: docBleed, left: docBleed, right: docBleed } : { top: 0, bottom: 0, left: 0, right: 0, ...docBleed }) : v.bleed;
    pane('Marks and Bleeds').replaceChildren(
      h('h3.pd-heading', 'Marks'),
      check("All printer's marks", m.trim && m.registration && m.colorBars && m.pageInfo, (x) => (st.marks = { trim: x, registration: x, colorBars: x, pageInfo: x })),
      h('div.pd-grid2', mark('trim', 'Trim marks'), mark('registration', 'Registration marks'), mark('colorBars', 'Color bars'), mark('pageInfo', 'Page information')),
      field("Printer's mark type", sel([['roman', 'Roman'], ['japanese', 'Japanese']], v.markType, (x) => (st.markType = x), "Printer's mark type")),
      field('Trim mark weight', sel([['0.125', '0.125 pt'], ['0.25', '0.25 pt'], ['0.5', '0.5 pt']], String(v.markWeight), (x) => (st.markWeight = Number(x)), 'Trim mark weight')),
      field('Offset', lenInput(v.markOffset, 'Mark offset', (x) => (st.markOffset = Math.max(0, Math.min(72, x))))),
      h('h3.pd-heading', 'Bleeds'),
      check('Use document bleed settings', v.useDocBleed, (x) => (st.useDocBleed = x)),
      h('div.pd-grid2', ...['top', 'bottom', 'left', 'right'].map((side) => h('label.pd-bleed', side[0].toUpperCase() + side.slice(1), lenInput(b[side] || 0, `Bleed ${side}`, (x) => (st.bleed = { ...st.bleed, [side]: Math.max(0, Math.min(72, x)) }), v.useDocBleed)))),
    );

    const convert = v.colorConversion === 'convert';
    const docProfile = doc ? `Document press (${CMYK_PROFILES[documentCmykProfile(app, doc)].label})` : 'Document press model';
    const destinations = [['cmyk:document', docProfile], ...Object.entries(CMYK_PROFILES).map(([k, p]) => [`cmyk:${k}`, p.label]), ['rgb:srgb', RGB_SPACES.srgb.label]];
    pane('Output').replaceChildren(
      h('h3.pd-heading', 'Color'),
      field('Color conversion', sel([['none', 'No Conversion'], ['convert', 'Convert to Destination']], v.colorConversion, (x) => (st.colorConversion = x), 'Color conversion')),
      field('Destination', sel(destinations, v.destination, (x) => (st.destination = x), 'Destination', { disabled: !convert })),
      check('Convert spot colors to process', v.spotsToProcess, (x) => (st.spotsToProcess = x)),
      h('p.form-help', convert && v.destination.startsWith('cmyk:') ? 'Colors are written as CMYK through the press model; colors converted to CMYK keep their numbers.' : 'Colors are written as RGB.'),
      h('h3.pd-heading', 'Output Intent'),
      field('Printing condition', sel([['document', 'Document press model'], ...Object.entries(CMYK_PROFILES).map(([k, p]) => [k, p.label])], v.outputIntent, (x) => (st.outputIntent = x), 'Output intent', { disabled: v.standard !== 'press' })),
      v.standard !== 'press' ? h('p.form-help', 'Choose the print production standard to name the printing condition in the file.') : null,
    );

    const flat = listPresets(app, 'flattener');
    pane('Advanced').replaceChildren(
      h('h3.pd-heading', 'Fonts'),
      check('Convert text to outlines', v.textOutlines && Boolean(app.textOutlines), (x) => (st.textOutlines = x), { disabled: !app.textOutlines }),
      h('h3.pd-heading', 'Overprint and Transparency Flattener Options'),
      field('Overprints', sel([['preserve', 'Preserve'], ['simulate', 'Simulate'], ['discard', 'Discard']], v.overprint, (x) => (st.overprint = x), 'Overprints')),
      check('Flatten transparency', v.flatten, (x) => (st.flatten = x)),
      field('Preset', sel(flat.map((p) => [p.name, p.name]), v.flattener, (x) => (st.flattener = x), 'Flattener preset', { disabled: !v.flatten })),
      h('p.form-help', 'Flattening turns transparent artwork into images for printers and older workflows without transparency.'),
    );

    const noSecurity = v.standard === 'press';
    pane('Security').replaceChildren(
      h('h3.pd-heading', 'Document Open Password'),
      check('Require a password to open the document', v.requireOpen, (x) => (st.requireOpen = x), { disabled: noSecurity }),
      field('Open password', password(v.openPassword, 'Document open password', (x) => (st.openPassword = x), noSecurity || !v.requireOpen)),
      h('h3.pd-heading', 'Permissions'),
      check('Restrict editing and printing', v.restrict, (x) => (st.restrict = x), { disabled: noSecurity }),
      field('Permissions password', password(v.permissionsPassword, 'Permissions password', (x) => (st.permissionsPassword = x), noSecurity || !v.restrict)),
      field('Printing allowed', sel([['none', 'None'], ['low', 'Low Resolution'], ['high', 'High Resolution']], v.printing, (x) => (st.printing = x), 'Printing allowed', { disabled: noSecurity || !v.restrict })),
      field('Changes allowed', sel([['none', 'None'], ['assemble', 'Inserting, deleting and rotating pages'], ['fill', 'Filling in form fields and signing'], ['comment', 'Commenting, filling in form fields and signing'], ['any', 'Any except extracting pages']], v.changes, (x) => (st.changes = x), 'Changes allowed', { disabled: noSecurity || !v.restrict })),
      check('Enable copying of text, images and other content', v.copy, (x) => (st.copy = x), { disabled: noSecurity || !v.restrict }),
      check('Enable text access for screen readers', v.accessibility, (x) => (st.accessibility = x), { disabled: noSecurity || !v.restrict }),
      h('p.form-help', 'Files are protected with 128-bit AES (PDF 1.6 and later). Passwords are not saved with presets.'),
    );
    refresh();
  }

  function refresh() {
    const v = normalizePdf(st);
    const warnings = pdfWarnings(v, { hasSpots: doc ? spotInks(doc).length > 0 : false, hasTextOutlines: Boolean(app.textOutlines) });
    pane('Summary').replaceChildren(
      h('h3.pd-heading', 'Options'),
      h('dl.pd-summary-list', pdfSummary(v).flatMap(([k, x]) => [h('dt', k), h('dd', x)])),
      h('h3.pd-heading', 'Warnings'),
      warnings.length ? h('ul.pd-warnings', warnings.map((w) => h('li', w))) : h('p.form-help', 'None.'),
    );
    picker.sync(presetPdf(v));
  }

  const error = h('p.form-error', { role: 'alert' });
  const body = h('div.pd.pdf-options', top, h('div.pd-settings', h('div.pd-tabs', { role: 'tablist', 'aria-orientation': 'vertical' }, panes.map((p) => p.btn)), ...panes.map((p) => p.panel)), error);
  rebuild();
  showPane(panes[0]);
  const validate = () => {
    const v = normalizePdf(st);
    if (presetEdit) {
      const nm = nameInput.value.trim();
      if (!nm) error.textContent = 'Enter a name.';
      else if ((presetEdit.names || []).includes(nm)) error.textContent = `A preset named "${nm}" already exists.`;
      else return true;
      nameInput.focus();
      return false;
    }
    if (v.standard !== 'press' && v.requireOpen && !v.openPassword) {
      error.textContent = 'Enter the password to open the document, or turn the password off.';
      showPane(panes.find((p) => p.label === 'Security'));
      return false;
    }
    if (v.requireOpen && v.restrict && v.openPassword && v.openPassword === v.permissionsPassword) {
      error.textContent = 'The open and permissions passwords must differ.';
      showPane(panes.find((p) => p.label === 'Security'));
      return false;
    }
    return true;
  };
  return app.dialogs.open({
    title: presetEdit ? presetEdit.title || 'PDF Preset Options' : 'PDF Options',
    className: 'wide print-dialog pdf-dialog',
    body,
    initialFocus: () => nameInput || picker.el,
    buttons: [
      { label: 'Cancel', value: null },
      { label: presetEdit ? 'OK' : 'Export PDF', primary: true, validate, value: () => (presetEdit ? { name: nameInput.value.trim(), values: presetPdf(st) } : normalizePdf(st)) },
    ],
  });
}
