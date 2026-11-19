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

const MIN_RATE = 1000;
const MAX_RATE = 384000;
const clampNum = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

const TITLES = { saveAs: 'Save As', copy: 'Save a Copy', export: 'Export Audio File', selection: 'Save Selection As', download: 'Download to This Device', mixdown: 'Export Multitrack Mixdown' };

/** "Master only", "Master and 2 tracks", "3 tracks": what a mixdown export writes. */
export function describeMixdown(mix) {
  const n = mix.tracks.size ?? mix.tracks.length;
  const tracks = `${n} track${n === 1 ? '' : 's'}`;
  if (mix.master) return n ? `Master and ${tracks}, each as its own file` : 'Master only';
  return n ? `${tracks}, each as its own file` : 'Nothing selected';
}

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
  const source = { sampleRate: doc.sampleRate, channels: doc.channelCount, bitDepth: docBitDepth(doc), int32: doc.info?.int32 };
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
 * `mixdown` ({ tracks: [{ id, name, type, channels }] }) adds Mixdown Options: the master and/or
 * tracks to write as separate files; the result then has `mixdown: { master, tracks: [ids] }`.
 * `initial` is an earlier result of this dialog to start from (the user is asked again, e.g.
 * after declining to replace an existing file): its name, folder and options are kept.
 */
export async function exportFileDialog(app, doc, { mode = 'export', frames = doc.length, initial = null, mixdown = null } = {}) {
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
  // Save As, Save a Copy and a mixdown start in the folder of the document's (session's) own Puter file.
  const ownPath = doc.source?.type === 'puter' ? doc.source.path : null;
  const ownDir = (mode === 'saveAs' || mode === 'copy' || mode === 'mixdown') && ownPath ? puter.dirname(ownPath) : null;
  let dir = initial?.location.dir || ownDir || app.prefs.get('exportFolder') || null;
  let notes = [];
  const mixTracks = mixdown?.tracks || [];
  const mix = mixdown ? { master: initial?.mixdown?.master ?? true, tracks: new Set((initial?.mixdown?.tracks || []).filter((id) => mixTracks.some((t) => t.id === id))) } : null;

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
  const mixText = h('span.io-summary');
  const mixBtn = h('button.btn', { type: 'button', 'aria-label': 'Change mixdown options' }, 'Change...');
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
      ...(mix ? [h('label', 'Mixdown Options:'), h('div.io-row', mixText, mixBtn)] : []),
    ),
    h('label.check.io-check', metaCheck, 'Include markers and other metadata'),
    h('div.io-foot-info', h('span.muted', 'Estimated file size:'), sizeText),
    noteText,
    error,
  );

  // Sample type page (replaces the main form while open).
  const rateSel = h('select.select', { 'aria-label': 'Sample rate' });
  // "Custom..." in the rate list: any rate the converter takes (formats with a fixed set have none).
  const customRate = h('input.input.num.io-rate', { type: 'number', min: MIN_RATE, max: MAX_RATE, step: 1, 'aria-label': 'Custom sample rate (Hz)', hidden: true });
  const srcQuality = h('input.slider', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Conversion quality' });
  const srcQualityNum = h('input.input.num', { type: 'number', min: 0, max: 100, step: 1, 'aria-label': 'Conversion quality (percent)' });
  const srcFilter = h('input', { type: 'checkbox' });
  srcQuality.addEventListener('input', () => (srcQualityNum.value = srcQuality.value));
  srcQualityNum.addEventListener('change', () => (srcQuality.value = srcQualityNum.value = clampNum(srcQualityNum.value, 0, 100, 50)));
  const rateAdv = h(
    'details.dlg-adv.io-adv',
    h('summary', 'Advanced'),
    h('div.form-grid', h('label', 'Quality:'), h('div.io-row', srcQuality, srcQualityNum, h('span.muted', '%')), h('span'), h('label.check', srcFilter, 'Pre/Post Filter')),
    h('p.muted.io-sample-note', 'Higher quality uses a longer filter and takes longer. The filter keeps the top of the band from folding back as aliasing.'),
  );
  const chSel = h('select.select', { 'aria-label': 'Channels' });
  const mixLeft = h('input.input.num', { type: 'number', min: 0, max: 200, step: 1, 'aria-label': 'Left mix (percent)' });
  const mixRight = h('input.input.num', { type: 'number', min: 0, max: 200, step: 1, 'aria-label': 'Right mix (percent)' });
  const mixNote = h('p.muted.io-sample-note');
  const mixAdv = h('details.dlg-adv.io-adv', h('summary', 'Advanced'), h('div.form-grid', h('label', 'Left Mix:'), h('div.io-row', mixLeft, h('span.muted', '%')), h('label', 'Right Mix:'), h('div.io-row', mixRight, h('span.muted', '%'))), mixNote);
  const sampleError = h('div.io-error', { role: 'alert' });
  const bitSel = h('select.select', { 'aria-label': 'Bit depth' });
  const ditherSel = h('select.select', { 'aria-label': 'Dither' }, DITHER_MODES.map((d) => h('option', { value: d.id }, d.label)));
  const bitRow = [h('label', 'Bit Depth:'), bitSel];
  const ditherRow = [h('label', 'Dither:'), ditherSel];
  const sampleBack = h('button.btn', { type: 'button' }, 'Cancel');
  const sampleOk = h('button.btn.primary', { type: 'button' }, 'OK');
  const samplePage = h(
    'div.io-sample-page',
    { hidden: true, role: 'group', 'aria-label': 'Sample type' },
    h('p.muted.io-sample-note', `Source: ${describeSampleType({ sampleRate: doc.sampleRate, channels: doc.channelCount, bitDepth: docBitDepth(doc), int32: doc.info?.int32 })}. Conversion is applied to the exported file only.`),
    h('div.form-grid', h('label', 'Sample Rate:'), h('div.io-row', rateSel, customRate)),
    rateAdv,
    h('div.form-grid', h('label', 'Channels:'), chSel),
    mixAdv,
    h('div.form-grid', ...bitRow, ...ditherRow),
    sampleError,
    h('div.io-sample-actions', sampleBack, sampleOk),
  );

  // Mixdown options page: the master and the tracks to write, each as its own file.
  const masterCheck = h('input', { type: 'checkbox', 'aria-label': 'Master' });
  const trackChecks = mixTracks.map((t) => h('input', { type: 'checkbox', value: t.id, 'aria-label': t.name }));
  const setAll = (on) => trackChecks.forEach((c) => (c.checked = on));
  const mixCancel = h('button.btn', { type: 'button' }, 'Cancel');
  const mixOk = h('button.btn.primary', { type: 'button' }, 'OK');
  const mixPage = mix
    ? h(
        'div.io-sample-page.io-mix-page',
        { hidden: true, role: 'group', 'aria-label': 'Mixdown options' },
        h('label.check', masterCheck, h('span', h('strong', 'Master'), h('span.muted', ' \u2014 the whole session mix'))),
        h(
          'div.io-mix-head',
          h('span', 'Tracks and buses, each as its own file:'),
          h('span.io-mix-tools', h('button.btn', { type: 'button', onclick: () => setAll(true), disabled: !mixTracks.length }, 'All'), h('button.btn', { type: 'button', onclick: () => setAll(false), disabled: !mixTracks.length }, 'None')),
        ),
        h(
          'div.io-mix-list',
          mixTracks.length
            ? mixTracks.map((t, i) => h('label.check.io-mix-track', trackChecks[i], h('span.io-mix-name', t.name), h('span.muted.io-mix-kind', `${t.type === 'bus' ? 'Bus' : 'Track'}, ${channelLabel(t.channels)}${t.empty ? ' (empty)' : ''}`)))
            : h('p.muted', 'This session has no tracks.'),
        ),
        h('p.muted.io-sample-note', 'A track file holds the track after its own volume, pan and effects, plus anything routed to it, without the master track. It is named after the file name above and the track, for example "Mix_Vocals.wav".'),
        h('div.io-sample-actions', mixCancel, mixOk),
      )
    : null;

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
    const files = mix ? (mix.master ? 1 : 0) + mix.tracks.size : 1;
    sizeText.textContent = formatBytesShort(estimateSize(state.options, frames, doc.sampleRate) * files) + (files > 1 ? ` in ${files} files` : '');
    if (mix) mixText.textContent = describeMixdown(mix);
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

  // The open sub-page ('sample' | 'mixdown') replaces the form until OK or Cancel.
  let page = null;
  const pickedBits = () => (bitSel.value === '32i' ? 32 : Number(bitSel.value));
  const pickedRate = () => Math.round(Number(rateSel.value === 'custom' ? customRate.value : rateSel.value));
  const showPage = (el, title) => {
    main.hidden = true;
    el.hidden = false;
    setTitle(title);
    footer()?.classList.add('io-hidden');
  };
  const hidePage = (el, focus) => {
    el.hidden = true;
    main.hidden = false;
    page = null;
    setTitle(TITLES[mode] || 'Export');
    footer()?.classList.remove('io-hidden');
    focus.focus();
  };
  const openSamplePage = () => {
    const f = fmt();
    const rates = f.rates || [...new Set([...COMMON_RATES, doc.sampleRate])].sort((a, b) => a - b);
    const custom = !f.rates && !rates.includes(state.options.sampleRate);
    rateSel.replaceChildren(...rates.map((r) => h('option', { value: r }, `${r} Hz`)), ...(f.rates ? [] : [h('option', { value: 'custom' }, 'Custom...')]));
    rateSel.value = custom ? 'custom' : String(state.options.sampleRate);
    customRate.value = String(state.options.sampleRate);
    const rs = state.options.resampler || remembered.resampler || {};
    srcQuality.value = srcQualityNum.value = String(rs.quality ?? app.prefs.get('srcQuality') ?? 50);
    srcFilter.checked = rs.filter ?? app.prefs.get('srcFilter') !== false;
    const chans = [1, 2, ...(doc.channelCount > 2 && f.maxChannels >= doc.channelCount ? [doc.channelCount] : [])];
    chSel.replaceChildren(...chans.map((c) => h('option', { value: c }, channelLabel(c))));
    chSel.value = String(state.options.channels);
    delete mixLeft.dataset.mode;
    const syncRate = () => {
      customRate.hidden = rateSel.value !== 'custom';
      rateAdv.hidden = pickedRate() === doc.sampleRate;
    };
    const syncMix = () => {
      const toMono = Number(chSel.value) === 1 && doc.channelCount === 2;
      const toStereo = Number(chSel.value) === 2 && doc.channelCount === 1;
      mixAdv.hidden = !toMono && !toStereo;
      const mode = toMono ? 'mono' : toStereo ? 'stereo' : '';
      if (mode && mixLeft.dataset.mode !== mode) {
        const kept = state.options.mix && state.options.channels === Number(chSel.value) ? state.options.mix : null;
        const d = toMono ? 50 : 100;
        mixLeft.value = String(Math.round((kept?.left ?? d / 100) * 100));
        mixRight.value = String(Math.round((kept?.right ?? d / 100) * 100));
        mixLeft.dataset.mode = mode;
      }
      mixNote.textContent = toMono ? 'How much of each side goes into the mono channel.' : 'The level of the mono channel on each side.';
    };
    rateSel.onchange = () => {
      syncRate();
      if (rateSel.value === 'custom') customRate.focus();
    };
    customRate.oninput = syncRate;
    chSel.onchange = syncMix;
    syncRate();
    syncMix();
    sampleError.textContent = '';
    bitRow.forEach((el) => (el.hidden = !f.bitDepths));
    if (f.bitDepths) {
      // "32i": 32-bit integer samples, where the format has them.
      bitSel.replaceChildren(...f.bitDepths.flatMap((b) => (b === 32 && f.int32 ? [h('option', { value: '32i' }, '32-bit integer'), h('option', { value: 32 }, '32-bit (float)')] : [h('option', { value: b }, b === 32 ? '32-bit (float)' : `${b}-bit`)])));
      bitSel.value = state.options.int32 ? '32i' : String(state.options.bitDepth);
    }
    const syncDither = () => {
      const show = usesDither({ ...state.options, bitDepth: f.bitDepths ? pickedBits() : undefined });
      ditherRow.forEach((el) => (el.hidden = !show));
    };
    bitSel.onchange = syncDither;
    ditherSel.value = state.options.dither;
    syncDither();
    page = 'sample';
    showPage(samplePage, 'Change Sample Type');
    rateSel.focus();
  };
  const closeSamplePage = (apply) => {
    if (apply) {
      const rate = pickedRate();
      if (!(rate >= MIN_RATE && rate <= MAX_RATE)) {
        sampleError.textContent = `Enter a sample rate from ${MIN_RATE} to ${MAX_RATE} Hz.`;
        customRate.focus();
        return;
      }
      notes = [];
      const channels = Number(chSel.value);
      const remix = !mixAdv.hidden;
      state.options = {
        ...state.options,
        sampleRate: rate,
        channels,
        bitDepth: fmt().bitDepths ? pickedBits() : undefined,
        int32: fmt().bitDepths ? bitSel.value === '32i' : undefined,
        dither: ditherSel.value,
        resampler: { quality: clampNum(srcQualityNum.value, 0, 100, 50), filter: srcFilter.checked },
        mix: remix ? { left: clampNum(mixLeft.value, 0, 200, 100) / 100, right: clampNum(mixRight.value, 0, 200, 100) / 100 } : undefined,
      };
      if (!remix) delete state.options.mix;
      refresh();
    }
    hidePage(samplePage, changeBtn);
  };
  const openMixPage = () => {
    masterCheck.checked = mix.master;
    trackChecks.forEach((c) => (c.checked = mix.tracks.has(c.value)));
    page = 'mixdown';
    showPage(mixPage, 'Mixdown Options');
    masterCheck.focus();
  };
  const closeMixPage = (apply) => {
    if (apply) {
      mix.master = masterCheck.checked;
      mix.tracks = new Set(trackChecks.filter((c) => c.checked).map((c) => c.value));
      error.textContent = '';
      refresh();
    }
    hidePage(mixPage, mixBtn);
  };
  const closePage = (apply) => (page === 'mixdown' ? closeMixPage(apply) : closeSamplePage(apply));
  if (mix) {
    mixBtn.addEventListener('click', openMixPage);
    mixCancel.addEventListener('click', () => closeMixPage(false));
    mixOk.addEventListener('click', () => closeMixPage(true));
  }
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
    if (page && e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      closePage(false);
    }
  };
  window.addEventListener('keydown', escape, true);
  const primaryLabel = mode === 'export' || mode === 'mixdown' ? 'Export' : mode === 'download' ? 'Download' : 'Save';
  const shown = openDialog({
    title: TITLES[mode] || 'Export',
    className: 'io-export-dialog',
    body: () => {
      dialogEl = h('div.io-export-wrap', main, samplePage, mixPage);
      return dialogEl;
    },
    buttons: [
      { label: 'Cancel', value: null },
      { label: primaryLabel, value: 'ok', primary: true },
    ],
    onSubmit: () => {
      if (page) {
        closePage(true);
        return false;
      }
      const name = sanitizeFileName(nameInput.value);
      if (!name || /^\.[a-z0-9]+$/i.test(name)) {
        error.textContent = 'Enter a file name.';
        nameInput.focus();
        return false;
      }
      if (mix && !mix.master && !mix.tracks.size) {
        error.textContent = 'Choose the master or at least one track to export (Mixdown Options).';
        mixBtn.focus();
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
    ...(state.options.resampler ? { resampler: state.options.resampler } : remembered.resampler ? { resampler: remembered.resampler } : {}),
    includeMeta: state.options.meta !== false,
    settings: { ...(remembered.settings || {}), [state.options.format]: state.options.settings },
  });
  if (mode !== 'download') app.prefs.set('exportLocation', location.type);
  if (location.dir) app.prefs.set('exportFolder', location.dir);
  return { fileName, location, options: state.options, ...(mix ? { mixdown: { master: mix.master, tracks: mixTracks.map((t) => t.id).filter((id) => mix.tracks.has(id)) } } : {}) };
}

export { mp3Bitrates };
