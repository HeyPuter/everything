// Save As / Save a Copy / Export File dialog, modelled on a pro editor's
// export dialog: file name, location (a Puter folder or this device), format,
// sample type (with a Change... page for rate, channels, bit depth and
// dither), format settings, metadata/markers and an estimated size.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { openDialog } from '../ui/dialog.js';
import * as puter from '../storage/puter.js';
import { FORMATS, getFormat, conformOptions, defaultOptions, estimateSize, formatBytesShort, describeSampleType, describeSettings, usesDither, withExtension, stripExtension, sanitizeFileName, channelLabel, COMMON_RATES, docBitDepth, formatForName } from './formats.js';
import { DITHER_MODES } from '../audio/quantize.js';
import { codecSupported } from './webcodecs.js';
import { mp3Bitrates } from './mp3.js';

const TITLES = { saveAs: 'Save As', copy: 'Save a Copy', export: 'Export Audio File', selection: 'Save Selection As', download: 'Download to This Device' };

let supportCache = null;
/** Which WebCodecs formats this browser can encode (checked once). */
export function webCodecsSupport() {
  if (!supportCache) {
    supportCache = Promise.all([codecSupported('opus', { sampleRate: 48000 }), codecSupported('m4a', { sampleRate: 48000 })]).then(([opus, m4a]) => ({ opus, m4a }));
  }
  return supportCache;
}

/**
 * Initial dialog state for a document. Pure apart from reading prefs.
 * `remembered` holds the last used { format, settings, dither, includeMeta };
 * `includeMeta` (Preferences > Markers & Metadata) overrides the remembered choice.
 */
export function initialState(doc, { mode, frames, remembered = {}, includeMeta } = {}) {
  const meta = includeMeta ?? remembered.includeMeta !== false;
  const sourceFormat = formatForName(doc.source?.path || doc.name);
  const format = mode === 'saveAs' ? sourceFormat || remembered.format || 'wav' : remembered.format || sourceFormat || 'wav';
  const source = { sampleRate: doc.sampleRate, channels: doc.channelCount, bitDepth: docBitDepth(doc) };
  const base = defaultOptions(source, format);
  const options = conformOptions(format, {
    ...base,
    dither: remembered.dither || base.dither,
    settings: { ...base.settings, ...(remembered.settings?.[format] || {}), ...(mode === 'saveAs' && doc.info?.exportOptions?.format === format ? doc.info.exportOptions.settings : {}) },
    markers: meta,
    meta,
  }).options;
  const stem = stripExtension(doc.name);
  const name = mode === 'selection' ? `${stem} Selection` : stem;
  return { name: withExtension(name, format), options, frames, sourceRate: doc.sampleRate };
}

/**
 * Shows the dialog. Resolves { fileName, location: { type: 'puter', dir } | { type: 'download' }, options } or null.
 * `initial` is an earlier result of this dialog to start from (the user is asked again, e.g.
 * after declining to replace an existing file): its name, folder and options are kept.
 */
export async function exportFileDialog(app, doc, { mode = 'export', frames = doc.length, initial = null } = {}) {
  const remembered = app.prefs.get('exportPrefs') || {};
  const state = initialState(doc, { mode, frames, remembered, includeMeta: app.prefs.get('exportMarkers') !== false });
  if (initial) {
    state.options = conformOptions(initial.options.format, initial.options).options;
    state.name = withExtension(initial.fileName, state.options.format);
  }
  const support = await webCodecsSupport();
  const sdk = Boolean(puter.sdk());
  let locationType = mode === 'download' || !sdk ? 'download' : app.prefs.get('exportLocation') === 'download' ? 'download' : 'puter';
  if (initial && sdk && mode !== 'download') locationType = initial.location.type;
  // Save As and Save a Copy start in the folder of the document's own Puter file.
  const ownPath = doc.source?.type === 'puter' ? doc.source.path : null;
  const ownDir = (mode === 'saveAs' || mode === 'copy') && ownPath ? puter.dirname(ownPath) : null;
  let dir = initial?.location.dir || ownDir || app.prefs.get('exportFolder') || null;
  let notes = [];

  // ---------------------------------------------------------------- controls
  const nameInput = h('input.input.io-name', { type: 'text', value: state.name, 'aria-label': 'File name', spellcheck: 'false', autocomplete: 'off' });
  const locSelect = h(
    'select.select',
    { 'aria-label': 'Location' },
    h('option', { value: 'puter', disabled: !sdk }, sdk ? 'Puter folder' : 'Puter folder (not available offline)'),
    h('option', { value: 'download' }, 'This device (download)'),
  );
  locSelect.value = locationType;
  const dirText = h('span.io-path', { title: '' });
  const browse = h('button.btn', { type: 'button' }, 'Browse...');
  const locRow = h('div.io-loc', locSelect, h('div.io-loc-path', icon('folder', 14), dirText, browse));
  const formatSelect = h(
    'select.select',
    { 'aria-label': 'Format' },
    FORMATS.map((f) => {
      const unsupported = (f.id === 'opus' && !support.opus) || (f.id === 'm4a' && !support.m4a);
      return h('option', { value: f.id, disabled: unsupported }, unsupported ? `${f.label} (not supported by this browser)` : f.label);
    }),
  );
  formatSelect.value = state.options.format;
  const sampleText = h('span.io-summary');
  const changeBtn = h('button.btn', { type: 'button', 'aria-label': 'Change sample type' }, 'Change...');
  const settingsHost = h('div.io-settings');
  const settingsText = h('span.io-summary');
  const metaCheck = h('input', { type: 'checkbox', checked: state.options.meta !== false });
  const sizeText = h('span.io-size.tabular', { 'aria-live': 'polite' });
  const noteText = h('div.io-notes', { role: 'status' });
  const error = h('div.io-error', { role: 'alert' });

  const main = h(
    'div.io-export',
    h(
      'div.form-grid.io-grid',
      h('label', { for: 'io-file-name' }, 'File Name:'),
      Object.assign(nameInput, { id: 'io-file-name' }),
      h('label', 'Location:'),
      locRow,
      h('label', 'Format:'),
      formatSelect,
      h('label', 'Sample Type:'),
      h('div.io-row', sampleText, changeBtn),
      h('label', 'Format Settings:'),
      h('div.io-col', settingsText, settingsHost),
    ),
    h('label.check.io-check', metaCheck, 'Include markers and other metadata'),
    h('div.io-foot-info', h('span.muted', 'Estimated file size:'), sizeText),
    noteText,
    error,
  );

  // Sample type page (replaces the main form while open).
  const rateSel = h('select.select', { 'aria-label': 'Sample rate' });
  const chSel = h('select.select', { 'aria-label': 'Channels' });
  const bitSel = h('select.select', { 'aria-label': 'Bit depth' });
  const ditherSel = h('select.select', { 'aria-label': 'Dither' }, DITHER_MODES.map((d) => h('option', { value: d.id }, d.label)));
  const bitRow = [h('label', 'Bit Depth:'), bitSel];
  const ditherRow = [h('label', 'Dither:'), ditherSel];
  const sampleBack = h('button.btn', { type: 'button' }, 'Cancel');
  const sampleOk = h('button.btn.primary', { type: 'button' }, 'OK');
  const samplePage = h(
    'div.io-sample-page',
    { hidden: true, role: 'group', 'aria-label': 'Sample type' },
    h('p.muted.io-sample-note', `Source: ${describeSampleType({ sampleRate: doc.sampleRate, channels: doc.channelCount, bitDepth: docBitDepth(doc) })}. Conversion is applied to the exported file only.`),
    h('div.form-grid', h('label', 'Sample Rate:'), rateSel, h('label', 'Channels:'), chSel, ...bitRow, ...ditherRow),
    h('div.io-sample-actions', sampleBack, sampleOk),
  );

  // ----------------------------------------------------------------- logic
  const fmt = () => getFormat(state.options.format);
  const showDir = () => {
    const puterLoc = locSelect.value === 'puter';
    locRow.querySelector('.io-loc-path').hidden = !puterLoc;
    dirText.textContent = dir || `~/${puter.APP_DIR}`;
    dirText.title = dirText.textContent;
  };
  const renderSettings = () => {
    const f = fmt();
    settingsHost.replaceChildren();
    for (const s of f.settings) {
      const opts = typeof s.options === 'function' ? s.options(state.options) : s.options;
      const sel = h('select.select', { 'aria-label': s.label }, opts.map((o) => h('option', { value: o.value }, o.label)));
      sel.value = String(state.options.settings[s.id]);
      sel.addEventListener('change', () => {
        state.options.settings[s.id] = Number(sel.value);
        refresh();
      });
      settingsHost.append(h('label.io-setting', h('span.muted', `${s.label}:`), sel));
    }
  };
  const refresh = () => {
    const r = conformOptions(state.options.format, state.options);
    state.options = r.options;
    if (r.notes.length) notes = r.notes;
    sampleText.textContent = describeSampleType(state.options);
    settingsText.textContent = describeSettings(state.options);
    settingsText.hidden = fmt().settings.length > 0;
    sizeText.textContent = formatBytesShort(estimateSize(state.options, frames, doc.sampleRate));
    noteText.textContent = notes.join(' ');
    noteText.hidden = !notes.length;
    renderSettings();
    showDir();
  };
  formatSelect.addEventListener('change', () => {
    notes = [];
    const before = state.options;
    const next = getFormat(formatSelect.value);
    const settings = { ...(remembered.settings?.[next.id] || {}) };
    // Start from the source's sample type so a lossy detour does not stick.
    state.options = conformOptions(next.id, { ...before, format: next.id, sampleRate: doc.sampleRate, channels: doc.channelCount, bitDepth: next.bitDepths ? before.bitDepth ?? docBitDepth(doc) : undefined, settings, dither: next.defaultDither || remembered.dither || 'triangular' }).options;
    if (next.bitDepths && !before.bitDepth) state.options = conformOptions(next.id, { ...state.options, bitDepth: docBitDepth(doc) }).options;
    nameInput.value = withExtension(nameInput.value || state.name, next.id);
    refresh();
  });
  locSelect.addEventListener('change', () => {
    showDir();
  });
  metaCheck.addEventListener('change', () => {
    state.options.meta = metaCheck.checked;
    state.options.markers = metaCheck.checked;
  });
  browse.addEventListener('click', async () => {
    error.textContent = '';
    try {
      if (!puter.isSignedIn() && !(await puter.signIn())) return;
      const item = await puter.pickDirectory();
      if (item?.path) {
        dir = item.path;
        showDir();
      }
    } catch (err) {
      error.textContent = err?.message || 'The folder could not be chosen.';
    }
  });

  let samplePageOpen = false;
  const openSamplePage = () => {
    const f = fmt();
    const rates = f.rates || [...new Set([...COMMON_RATES, doc.sampleRate])].sort((a, b) => a - b);
    rateSel.replaceChildren(...rates.map((r) => h('option', { value: r }, `${r} Hz`)));
    rateSel.value = String(state.options.sampleRate);
    const chans = [1, 2, ...(doc.channelCount > 2 && f.maxChannels >= doc.channelCount ? [doc.channelCount] : [])];
    chSel.replaceChildren(...chans.map((c) => h('option', { value: c }, channelLabel(c))));
    chSel.value = String(state.options.channels);
    bitRow.forEach((el) => (el.hidden = !f.bitDepths));
    if (f.bitDepths) {
      bitSel.replaceChildren(...f.bitDepths.map((b) => h('option', { value: b }, b === 32 ? '32-bit (float)' : `${b}-bit`)));
      bitSel.value = String(state.options.bitDepth);
    }
    const syncDither = () => {
      const show = usesDither({ ...state.options, bitDepth: f.bitDepths ? Number(bitSel.value) : undefined });
      ditherRow.forEach((el) => (el.hidden = !show));
    };
    bitSel.onchange = syncDither;
    ditherSel.value = state.options.dither;
    syncDither();
    main.hidden = true;
    samplePage.hidden = false;
    samplePageOpen = true;
    setTitle('Change Sample Type');
    footer()?.classList.add('io-hidden');
    rateSel.focus();
  };
  const closeSamplePage = (apply) => {
    if (apply) {
      notes = [];
      state.options = { ...state.options, sampleRate: Number(rateSel.value), channels: Number(chSel.value), bitDepth: fmt().bitDepths ? Number(bitSel.value) : undefined, dither: ditherSel.value };
      refresh();
    }
    samplePage.hidden = true;
    main.hidden = false;
    samplePageOpen = false;
    setTitle(TITLES[mode] || 'Export');
    footer()?.classList.remove('io-hidden');
    changeBtn.focus();
  };
  changeBtn.addEventListener('click', openSamplePage);
  sampleBack.addEventListener('click', () => closeSamplePage(false));
  sampleOk.addEventListener('click', () => closeSamplePage(true));
  let dialogEl = null;
  const footer = () => dialogEl?.closest('.dialog')?.querySelector('.dialog-foot');
  const setTitle = (t) => {
    const el = dialogEl?.closest('.dialog')?.querySelector('.dialog-title');
    if (el) el.textContent = t;
  };

  refresh();
  // Resolve the default Puter folder in the background.
  if (!dir && sdk && puter.isSignedIn()) puter.appDir().then((d) => {
    if (!dir) {
      dir = d;
      showDir();
    }
  });

  // Escape on the sample type page goes back instead of closing the dialog.
  // Window capture runs before the dialog's own document-level handler.
  const escape = (e) => {
    if (samplePageOpen && e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeSamplePage(false);
    }
  };
  window.addEventListener('keydown', escape, true);
  const primaryLabel = mode === 'export' ? 'Export' : mode === 'download' ? 'Download' : 'Save';
  const shown = openDialog({
    title: TITLES[mode] || 'Export',
    className: 'io-export-dialog',
    body: () => {
      dialogEl = h('div.io-export-wrap', main, samplePage);
      return dialogEl;
    },
    buttons: [
      { label: 'Cancel', value: null },
      { label: primaryLabel, value: 'ok', primary: true },
    ],
    onSubmit: () => {
      if (samplePageOpen) {
        closeSamplePage(true);
        return false;
      }
      const name = sanitizeFileName(nameInput.value);
      if (!name || /^\.[a-z0-9]+$/i.test(name)) {
        error.textContent = 'Enter a file name.';
        nameInput.focus();
        return false;
      }
      return true;
    },
  });
  // Typing replaces the name, not its extension (the dialog selected the whole text).
  const stem = stripExtension(nameInput.value).length;
  if (document.activeElement === nameInput) nameInput.setSelectionRange(0, stem);
  const result = await shown;
  window.removeEventListener('keydown', escape, true);
  if (result !== 'ok') return null;
  const fileName = withExtension(sanitizeFileName(nameInput.value), state.options.format);
  const location = locSelect.value === 'puter' ? { type: 'puter', dir: dir || null } : { type: 'download' };
  // Remember choices for next time.
  app.prefs.set('exportPrefs', {
    format: state.options.format,
    dither: state.options.dither,
    includeMeta: state.options.meta !== false,
    settings: { ...(remembered.settings || {}), [state.options.format]: state.options.settings },
  });
  if (mode !== 'download') app.prefs.set('exportLocation', location.type);
  if (location.dir) app.prefs.set('exportFolder', location.dir);
  return { fileName, location, options: state.options };
}

export { mp3Bitrates };
