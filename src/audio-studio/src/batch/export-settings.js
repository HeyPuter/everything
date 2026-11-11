// Export settings shared by Batch Process and Match Loudness: format, sample
// type, file name prefix/suffix and location (a Puter folder, or downloads
// zipped when there are several files), plus the writer that stores outputs.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { openDialog } from '../ui/dialog.js';
import { FORMATS, getFormat, COMMON_RATES, usesDither } from '../export/formats.js';
import { DITHER_MODES } from '../audio/quantize.js';
import { zipStore, zipProblem } from '../lib/zip.js';
import { downloadBlob } from '../storage/files.js';
import * as puter from '../storage/puter.js';
import { uniqueName } from './queue.js';

/** Where outputs go, as text for summaries. */
export function locationText(s) {
  if (s.location === 'puter') return `to ${s.dir || `~/${puter.APP_DIR}`}`;
  return 'downloaded (several files as one ZIP)';
}

/** Asks for export settings starting from `s`; resolves the new settings fields, or null. */
export async function exportSettingsDialog(app, s, { title = 'Batch Export Settings', example: exampleName = 'Interview' } = {}) {
  const sdk = Boolean(puter.sdk());
  const fmtSel = h('select.select', { 'aria-label': 'Format' }, FORMATS.map((f) => h('option', { value: f.id }, f.label)));
  fmtSel.value = s.format;
  const rateSel = h('select.select', { 'aria-label': 'Sample rate' });
  const chSel = h('select.select', { 'aria-label': 'Channels' }, h('option', { value: 'source' }, 'Same as source'), h('option', { value: '1' }, 'Mono'), h('option', { value: '2' }, 'Stereo'));
  chSel.value = String(s.channels);
  const bitSel = h('select.select', { 'aria-label': 'Bit depth' });
  const ditherSel = h('select.select', { 'aria-label': 'Dither' }, DITHER_MODES.map((d) => h('option', { value: d.id }, d.label)));
  ditherSel.value = s.dither;
  const settingsHost = h('div.batch-format-settings');
  const prefix = h('input.input', { type: 'text', value: s.prefix, 'aria-label': 'File name prefix', spellcheck: 'false' });
  const suffix = h('input.input', { type: 'text', value: s.suffix, 'aria-label': 'File name suffix', spellcheck: 'false' });
  const locSel = h('select.select', { 'aria-label': 'Location' }, h('option', { value: 'puter', disabled: !sdk }, sdk ? 'Puter folder' : 'Puter folder (not available)'), h('option', { value: 'download' }, 'Download (ZIP for several files)'));
  locSel.value = sdk ? s.location : 'download';
  let dir = s.dir;
  const dirText = h('span.batch-dir');
  const browse = h('button.btn', { type: 'button' }, 'Browse...');
  const dirRow = h('div.batch-dir-row', icon('folder', 14), dirText, browse);
  const collSel = h('select.select', { 'aria-label': 'When a file exists' }, h('option', { value: 'rename' }, 'Add a number to the name'), h('option', { value: 'overwrite' }, 'Replace the existing file'));
  collSel.value = s.collision;
  const collRow = [h('label', 'If a file exists:'), collSel];
  const bitRow = [h('label', 'Bit Depth:'), bitSel];
  const ditherRow = [h('label', 'Dither:'), ditherSel];
  const example = h('div.faint.batch-example');
  const formatSettings = { ...s.settings };

  const sync = () => {
    const f = getFormat(fmtSel.value);
    const rates = f.rates || COMMON_RATES;
    const curRate = rateSel.value || String(s.sampleRate);
    rateSel.replaceChildren(...(f.rates ? [] : [h('option', { value: 'source' }, 'Same as source')]), ...rates.map((r) => h('option', { value: String(r) }, `${r} Hz`)));
    rateSel.value = [...rateSel.options].some((o) => o.value === curRate) ? curRate : rateSel.options[0].value;
    bitRow.forEach((x) => (x.hidden = !f.bitDepths));
    if (f.bitDepths) {
      const cur = Number(bitSel.value || s.bitDepth);
      bitSel.replaceChildren(...f.bitDepths.map((b) => h('option', { value: String(b) }, b === 32 ? '32-bit (float)' : `${b}-bit`)));
      bitSel.value = String(f.bitDepths.includes(cur) ? cur : f.bitDepths.includes(24) ? 24 : f.bitDepths[f.bitDepths.length - 1]);
    }
    ditherRow.forEach((x) => (x.hidden = !usesDither({ format: f.id, bitDepth: f.bitDepths ? Number(bitSel.value) : undefined })));
    settingsHost.replaceChildren(
      ...f.settings.map((st) => {
        const opts = typeof st.options === 'function' ? st.options({ sampleRate: rateSel.value === 'source' ? 48000 : Number(rateSel.value) }) : st.options;
        const sel = h('select.select', { 'aria-label': st.label }, opts.map((o) => h('option', { value: String(o.value) }, o.label)));
        const cur = formatSettings[st.id] ?? st.default;
        sel.value = String(opts.some((o) => o.value === cur) ? cur : st.default);
        formatSettings[st.id] = Number(sel.value);
        sel.addEventListener('change', () => (formatSettings[st.id] = Number(sel.value)));
        return h('label.batch-setting', h('span.muted', `${st.label}:`), sel);
      }),
    );
    const puterLoc = locSel.value === 'puter';
    dirRow.hidden = !puterLoc;
    collRow.forEach((x) => (x.hidden = !puterLoc));
    dirText.textContent = dir || `~/${puter.APP_DIR}`;
    example.textContent = `Example: ${prefix.value}${exampleName}${suffix.value}.${f.ext}`;
  };
  fmtSel.addEventListener('change', sync);
  bitSel.addEventListener('change', sync);
  rateSel.addEventListener('change', sync);
  locSel.addEventListener('change', sync);
  prefix.addEventListener('input', sync);
  suffix.addEventListener('input', sync);
  browse.addEventListener('click', async () => {
    try {
      if (!puter.isSignedIn() && !(await puter.signIn())) return;
      const item = await puter.pickDirectory();
      if (item?.path) {
        dir = item.path;
        sync();
      }
    } catch (err) {
      app.notify(err?.message || 'The folder could not be chosen.', { error: true });
    }
  });
  sync();
  const body = h(
    'div.batch-settings',
    h(
      'div.form-grid',
      h('label', 'Format:'),
      fmtSel,
      h('label', 'Sample Rate:'),
      rateSel,
      h('label', 'Channels:'),
      chSel,
      ...bitRow,
      ...ditherRow,
      h('label', 'Format Settings:'),
      settingsHost,
      h('label', 'Name Prefix:'),
      prefix,
      h('label', 'Name Suffix:'),
      suffix,
      h('label', 'Location:'),
      h('div.batch-loc', locSel, dirRow),
      ...collRow,
    ),
    example,
  );
  const r = await openDialog({ title, body, className: 'batch-settings-dialog', buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', primary: true }] });
  if (r !== 'ok') return null;
  const f = getFormat(fmtSel.value);
  return {
    format: f.id,
    sampleRate: rateSel.value === 'source' ? 'source' : Number(rateSel.value),
    channels: chSel.value === 'source' ? 'source' : Number(chSel.value),
    bitDepth: f.bitDepths ? Number(bitSel.value) : s.bitDepth,
    dither: ditherSel.value,
    settings: { ...s.settings, ...formatSettings },
    prefix: prefix.value,
    suffix: suffix.value,
    location: locSel.value,
    dir,
    collision: collSel.value,
  };
}

/**
 * Output writer for export settings `s`. Resolves null when Puter output is
 * chosen but unavailable. write(name, blob) stores one file and resolves its
 * final name; finish(zipName) downloads what was collected (a ZIP for several).
 */
export async function outputWriter(app, s) {
  let dir = null;
  if (s.location === 'puter') {
    if (!puter.sdk()) {
      app.notify('Puter is not available. Choose Download in Export Settings.', { error: true });
      return null;
    }
    if (!puter.isSignedIn() && !(await puter.signIn().catch(() => false))) return null;
    dir = s.dir || (await puter.appDir());
  }
  const zip = [];
  const taken = new Set();
  return {
    dir,
    async write(name, blob) {
      if (dir) {
        let final = name;
        if (s.collision === 'rename') {
          const used = new Set();
          while (await puter.exists(puter.joinPath(dir, final))) {
            used.add(final.toLowerCase());
            final = uniqueName(name, used);
          }
        }
        await puter.writeFile(puter.joinPath(dir, final), blob);
        return final;
      }
      const final = uniqueName(name, taken);
      zip.push({ name: final, blob });
      return final;
    },
    async finish(zipName) {
      if (zip.length === 1) downloadBlob(zip[0].blob, zip[0].name);
      else if (zip.length > 1 && zipProblem(zip.map((z) => ({ name: z.name, size: z.blob.size })))) {
        // Too much for one ZIP: hand the files over one by one rather than lose them.
        app.notify(`${zipProblem(zip.map((z) => ({ name: z.name, size: z.blob.size })))} The ${zip.length} files are downloaded separately.`);
        for (const z of zip) downloadBlob(z.blob, z.name);
      } else if (zip.length > 1) {
        const files = [];
        for (const z of zip) files.push({ name: z.name, data: new Uint8Array(await z.blob.arrayBuffer()) });
        downloadBlob(zipStore(files), zipName);
      }
    },
  };
}
