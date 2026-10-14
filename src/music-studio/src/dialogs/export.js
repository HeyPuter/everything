// Audio export: the song or the current pattern to a WAV file, or one WAV
// per mixer insert (stems) in a ZIP. Renders offline through
// app.engine.render with a progress bar; closing the dialog cancels.
// When signed in, a copy can also go to Exports in the app's Puter folder.

import { h } from '../lib/dom.js';
import { openDialog } from '../ui/dialog.js';
import { encodeWav } from '../io/wav.js';
import { zipBytes } from '../io/zip.js';
import { downloadBlob, safeFileName } from '../io/download.js';
import { songLength, patternLength } from '../model/project.js';
import { formatTime } from '../model/time.js';
import * as puter from '../storage/puter.js';

export const EXPORT_RATES = [44100, 48000, 88200, 96000];
export const EXPORT_BITS = [
  { bits: 16, label: '16-bit (dithered)' },
  { bits: 24, label: '24-bit' },
  { bits: 32, label: '32-bit float' },
];

/** Mixer inserts that carry sound: a channel plays into them, or another insert sends to them. */
export function stemInserts(project) {
  const used = new Set(project.channels.filter((c) => c.mixer > 0).map((c) => c.mixer));
  // Buses fed by used inserts count too (follow sends until nothing new).
  let grew = true;
  while (grew) {
    grew = false;
    for (const i of [...used]) {
      for (const k of Object.keys(project.mixer[i]?.routes || {})) {
        const to = Number(k);
        if (to > 0 && !used.has(to)) {
          used.add(to);
          grew = true;
        }
      }
    }
  }
  return [...used].sort((a, b) => a - b).map((index) => ({ index, name: project.mixer[index]?.name || `Insert ${index}` }));
}

let seq = 0;

export async function openExportDialog(app, { stems = false } = {}) {
  const store = app.store;
  const p = store.project;
  const fmt = app.prefs.get('exportFormat');
  const hasSong = songLength(p) > 0;
  const inserts = stems ? stemInserts(p) : [];
  if (stems && !inserts.length) {
    app.notify('No channels play into mixer inserts, so there are no stems to export. Route channels to inserts in the channel rack.', { error: true });
    return;
  }

  const id = (s) => `exp-${s}-${++seq}`;
  const radio = (name, value, label, checked, detail) => {
    const rid = id(name);
    return h('label.exp-radio', { for: rid }, h('input', { type: 'radio', id: rid, name, value, checked }), h('span', label), detail ? h('span.faint', detail) : null);
  };
  const lenText = (ticks) => formatTime(ticks, p.bpm).replace(/:\d\d$/, '');
  const groupName = id('range');
  const range = h(
    'fieldset.exp-field',
    h('legend', 'Range'),
    radio(groupName, 'song', 'Song', hasSong, hasSong ? lenText(songLength(p)) : 'empty'),
    radio(groupName, 'pattern', `Pattern: ${store.pattern.name}`, !hasSong, lenText(patternLength(store.pattern, p.sig))),
  );
  if (!hasSong) range.querySelector('input[value="song"]').disabled = true;

  const rateId = id('rate');
  const rate = h('select.select', { id: rateId }, EXPORT_RATES.map((r) => h('option', { value: String(r), selected: r === fmt.rate }, `${(r / 1000).toFixed(r % 1000 ? 1 : 0)} kHz`)));
  const bitsId = id('bits');
  const bits = h('select.select', { id: bitsId }, EXPORT_BITS.map((b) => h('option', { value: String(b.bits), selected: b.bits === fmt.bits }, b.label)));
  const tailId = id('tail');
  const tail = h('input', { type: 'checkbox', id: tailId, checked: fmt.tail !== false });
  const signedIn = puter.isSignedIn();
  const cloudId = id('cloud');
  const cloud = h('input', { type: 'checkbox', id: cloudId, checked: Boolean(fmt.cloudCopy) });

  const bar = h('div.exp-bar', h('div.exp-fill'));
  const status = h('div.exp-status', { role: 'status', 'aria-live': 'polite' });
  const progress = h('div.exp-progress', { role: 'progressbar', 'aria-label': 'Export progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', hidden: true }, bar);
  const setProgress = (f) => {
    const pct = Math.round(Math.max(0, Math.min(1, f)) * 100);
    bar.firstChild.style.width = `${pct}%`;
    progress.setAttribute('aria-valuenow', String(pct));
  };

  const body = h(
    'div.export',
    stems ? h('p', `One WAV file per mixer insert (${inserts.length}): ${inserts.map((i) => i.name).join(', ')}. Each stem includes its insert's effects and sends.`) : null,
    range,
    h('div.form-grid', h('label', { for: rateId }, 'Sample rate'), rate, h('label', { for: bitsId }, 'Format'), bits),
    h('label.check', { for: tailId }, tail, h('span', 'Include effect tails (reverb and delay ring out)')),
    signedIn ? h('label.check', { for: cloudId }, cloud, h('span', 'Also save a copy to Exports in your Puter cloud')) : null,
    progress,
    status,
  );

  let controller = null;
  let busy = false;
  const dialogDone = openDialog({
    title: stems ? 'Export stems' : 'Export audio',
    className: 'dlg-export',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Export', value: 'export', primary: true },
    ],
    onSubmit: async () => {
      if (busy) return false;
      busy = true;
      const exportBtn = body.closest('.dialog')?.querySelector('.btn.primary');
      if (exportBtn) exportBtn.disabled = true;
      controller = new AbortController();
      const opts = {
        mode: range.querySelector('input:checked')?.value || 'pattern',
        rate: Number(rate.value),
        bits: Number(bits.value),
        tail: tail.checked,
      };
      app.prefs.merge('exportFormat', { rate: opts.rate, bits: opts.bits, tail: opts.tail, cloudCopy: cloud.checked });
      progress.hidden = false;
      setProgress(0);
      try {
        const ok = await runExport(app, { ...opts, stems, inserts, signal: controller.signal, cloudCopy: signedIn && cloud.checked, setProgress, setStatus: (t) => (status.textContent = t) });
        return ok;
      } catch (err) {
        if (controller.signal.aborted) return true;
        status.textContent = renderError(err);
        status.classList.add('error');
        return false;
      } finally {
        busy = false;
        if (exportBtn) exportBtn.disabled = false;
      }
    },
  });
  const result = await dialogDone;
  // Closed (Cancel, Escape, close button) while rendering: stop the render.
  if (result === null && controller && !controller.signal.aborted) controller.abort();
}

function renderError(err) {
  const msg = err?.message || String(err);
  if (/not available/i.test(msg)) return 'Audio export needs the audio engine, which is not available yet in this version. Try again after an update.';
  return `The export failed: ${msg}`;
}

async function runExport(app, { mode, rate, bits, tail, stems, inserts, signal, cloudCopy, setProgress, setStatus }) {
  const store = app.store;
  const p = store.project;
  const base = safeFileName(mode === 'pattern' ? `${p.name} - ${store.pattern.name}` : p.name);
  const render = (isolate, part, parts) =>
    app.engine.render({
      mode,
      patternId: store.view.pattern,
      rate,
      tail,
      isolate,
      signal,
      onProgress: (f) => setProgress((part + f) / parts),
    });
  let blob;
  let filename;
  if (!stems) {
    setStatus('Rendering...');
    const audio = await render(undefined, 0, 1);
    if (signal.aborted) return true;
    setStatus('Writing the file...');
    blob = new Blob([encodeWav(audio, { bits })], { type: 'audio/wav' });
    filename = `${base}.wav`;
  } else {
    const files = [];
    for (let i = 0; i < inserts.length; i++) {
      const ins = inserts[i];
      setStatus(`Rendering stem ${i + 1} of ${inserts.length}: ${ins.name}`);
      const audio = await render(ins.index, i, inserts.length);
      if (signal.aborted) return true;
      files.push({ name: `${String(ins.index).padStart(2, '0')} ${safeFileName(ins.name)}.wav`, data: new Uint8Array(encodeWav(audio, { bits })) });
    }
    setStatus('Writing the ZIP file...');
    blob = new Blob([zipBytes(files)], { type: 'application/zip' });
    filename = `${base} stems.zip`;
  }
  setProgress(1);
  downloadBlob(blob, filename);
  if (cloudCopy && puter.isSignedIn()) {
    setStatus('Saving a copy to Puter...');
    try {
      const item = await puter.writeNew(puter.joinPath(await puter.appSubdir('Exports'), filename), blob);
      app.notify(`Exported ${filename} (a copy is in Exports in your Puter cloud as ${item?.name || filename})`);
    } catch (err) {
      app.notify(`Downloaded ${filename}, but the Puter copy failed: ${puter.errorMessage(err)}`, { error: true });
    }
  } else {
    app.notify(`Exported ${filename}`);
  }
  return true;
}
