/**
 * Export dialog: a still of the current frame beside the settings (file
 * name, destination, video file and audio file sections, size estimate), then a progress
 * view with a live thumbnail, then a result view with Download and Save to
 * Puter. Settings are remembered per device.
 */
import '../styles/export.css';
import { h, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { US, clock } from '../lib/time.js';
import { projectDuration } from '../model/timeline.js';
import { audibleClips } from '../engine/scene.js';
import {
  RESOLUTIONS, FRAME_RATES, BITRATE_LEVELS, VIDEO_CODECS, CONTAINERS, AUDIO_FORMATS, DEFAULT_SETTINGS,
  outputSize, videoBitrate, estimateSize, reconcile, detectCapabilities, exportProject, renderStill,
  describeError, formatBytes, safeFileName, renderFrames,
} from '../engine/exporter.js';
import { sliceProject, exportSpan } from '../model/slice.js';
import { GifWriter } from '../media/gif.js';
import { captionCues, toSrt } from '../media/transcribe.js';
import { openDialog, toast } from './dialog.js';
import { prefs, setPref } from './prefs.js';

let seq = 0;

const signedIn = (ctx) => ctx.library?.backend?.kind === 'puter' && typeof puter !== 'undefined';

/** Settings worth remembering on this device (not the per-project name). */
function remember(s) {
  const { name, ...rest } = s;
  void name;
  setPref('exportSettings', rest);
}

function secondsLabel(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  return clock(Math.max(0, sec) * US);
}

/** A labeled native select with stable id. */
function select(label, options, value, onChange) {
  const id = `exp-${++seq}`;
  const el = h('select.select', { id }, options.map((o) => h('option', { value: String(o.value) }, o.label)));
  el.value = String(value);
  el.addEventListener('change', () => onChange(el.value));
  const row = h('div.export-row', h('label.export-label', { for: id }, label), el);
  return {
    row,
    el,
    setOptions(opts, v) {
      el.replaceChildren(...opts.map((o) => h('option', { value: String(o.value) }, o.label)));
      el.value = String(v);
    },
    set(v) {
      el.value = String(v);
    },
  };
}

/** Section with a checkbox heading (Video, Audio) that turns that output on or off. */
function checkSection(title, checked, onChange, body) {
  const id = `exp-${++seq}`;
  const box = h('input.export-check', { type: 'checkbox', id, checked });
  const content = h('div.export-section-body', { id: `${id}-body` }, body);
  box.setAttribute('aria-controls', `${id}-body`);
  box.addEventListener('change', () => {
    content.classList.toggle('off', !box.checked);
    content.inert = !box.checked;
    onChange(box.checked);
  });
  content.classList.toggle('off', !checked);
  content.inert = !checked;
  const el = h('section.export-section', h('div.export-section-head', box, h('label.export-section-title', { for: id }, title)), content);
  return { el, box };
}

const GIF_WIDTHS = [240, 320, 480, 640, 800, 1080];
const GIF_FPS = [8, 10, 12, 15, 20, 25];
const EXTRA_DEFAULTS = { scope: 'all', gif: false, gifWidth: 480, gifFps: 12, gifLoop: true, captions: false };

/** Encode [project] as an animated GIF. */
async function exportGif(project, library, s, { signal, onProgress }) {
  const { width: pw, height: ph } = project.settings;
  const width = Math.min(s.gifWidth, pw);
  const height = Math.max(2, Math.round((ph * width) / pw / 2) * 2);
  const gif = new GifWriter(width, height, { loop: s.gifLoop ? 0 : null });
  const scratch = document.createElement('canvas');
  scratch.width = width;
  scratch.height = height;
  const g = scratch.getContext('2d', { willReadFrequently: true });
  const started = performance.now();
  const duration = projectDuration(project);
  let n = 0;
  for await (const f of renderFrames(project, library, { width, height, fps: s.gifFps, signal })) {
    g.drawImage(f.canvas, 0, 0, width, height);
    gif.addFrame(g.getImageData(0, 0, width, height).data, 1000 / s.gifFps);
    n = f.index + 1;
    const elapsed = (performance.now() - started) / 1000;
    onProgress?.({ fraction: n / f.total, done: n, total: f.total, elapsed, remaining: (elapsed / n) * (f.total - n), fps: n / Math.max(0.001, elapsed), preview: n % 10 === 1 ? await createImageBitmap(scratch) : null });
  }
  const blob = new Blob([gif.finish()], { type: 'image/gif' });
  return { kind: 'gif', blob, fileName: `${safeFileName(s.name || project.name)}.gif`, width, height, duration, elapsed: (performance.now() - started) / 1000 };
}

export function openExportDialog(ctx) {
  const { store, library } = ctx;
  const full = store.project;
  const projW = full.settings.width;
  const projH = full.settings.height;
  const selection = store.selectedIds || [];
  const saved = prefs().exportSettings || {};
  let caps = null;
  // With several timelines the file is named after the project and the timeline.
  const multi = (ctx.timelines?.list().length || 0) > 1;
  let s = { ...DEFAULT_SETTINGS, ...EXTRA_DEFAULTS, ...saved, name: multi ? `${full.name} - ${ctx.timelines.active().name}` : full.name };
  // The in/out range is the natural default whenever one is set.
  if (full.range) s.scope = 'range';
  else if (s.scope === 'range' || (s.scope === 'selection' && !selection.length)) s.scope = 'all';
  /** The project to export: all of it, or a slice for the range or selection. */
  const source = () => {
    if (s.scope === 'all') return full;
    const span = exportSpan(full, s.scope, selection);
    return sliceProject(full, span.start, span.end, s.scope === 'selection' ? { keep: new Set(selection) } : {});
  };
  let project = source();
  let duration = projectDuration(project);
  const hasSound = audibleClips(full).length > 0;
  const hasCaptions = captionCues(full).length > 0;
  if (!BITRATE_LEVELS.some((l) => l.value === s.bitrate)) s.bitrate = DEFAULT_SETTINGS.bitrate;
  if (!signedIn(ctx)) s.destination = 'device';
  if (!s.video && !s.audio) s.video = true;

  let controller = null;
  let results = [];
  let state = 'settings';
  const urls = [];

  /* Still frame ---------------------------------------------------------- */
  const stillCanvas = h('canvas.export-still-canvas', { 'aria-hidden': 'true' });
  const stillWrap = h('div.export-still', { style: { aspectRatio: `${projW} / ${projH}` } }, stillCanvas, h('div.spinner.export-still-spinner', { 'aria-hidden': 'true' }));
  const stillMeta = h('p.export-still-meta');
  const drawBitmap = (bmp) => {
    if (!bmp) return;
    stillCanvas.width = bmp.width;
    stillCanvas.height = bmp.height;
    stillCanvas.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    stillWrap.classList.add('ready');
  };
  const stillTime = Math.max(0, Math.min(store.time, projectDuration(full) - 1));
  if (duration > 0) {
    renderStill(full, library, stillTime, { maxWidth: 640 }).then(drawBitmap).catch(() => stillWrap.classList.add('ready'));
  } else stillWrap.classList.add('ready');
  const aside = h('div.export-aside', stillWrap, stillMeta);

  /* Settings form ---------------------------------------------------------- */
  const nameId = `exp-${++seq}`;
  const nameInput = h('input.input', { id: nameId, type: 'text', value: s.name, maxLength: 120, spellcheck: false, autocomplete: 'off' });
  nameInput.addEventListener('input', () => {
    s.name = nameInput.value;
  });
  const nameRow = h('div.export-row', h('label.export-label', { for: nameId }, 'File name'), nameInput);

  const destOptions = [{ value: 'device', label: 'This device', icon: 'saveLocal' }];
  if (signedIn(ctx)) destOptions.push({ value: 'puter', label: 'Puter', icon: 'cloud' });
  const destGroup = h('div.segmented.export-dest', { role: 'radiogroup', 'aria-labelledby': `${nameId}-dest` });
  const destButtons = destOptions.map((o) => {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(s.destination === o.value), tabindex: s.destination === o.value ? '0' : '-1' }, icon(o.icon, 15), o.label);
    b.addEventListener('click', () => {
      s.destination = o.value;
      destButtons.forEach((x, i) => {
        const on = destOptions[i].value === o.value;
        x.setAttribute('aria-checked', String(on));
        x.tabIndex = on ? 0 : -1;
      });
      update();
    });
    return b;
  });
  destGroup.addEventListener('keydown', (e) => {
    const i = destButtons.indexOf(document.activeElement);
    if (i < 0 || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const j = (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + destButtons.length) % destButtons.length;
    destButtons[j].focus();
    destButtons[j].click();
  });
  destGroup.append(...destButtons);
  const destHint = h('p.export-hint');
  const destRow = h('div.export-row', h('span.export-label', { id: `${nameId}-dest` }, 'Save to'), h('div.export-dest-wrap', destGroup, destHint));

  const scopeOptions = [{ value: 'all', label: 'Whole timeline' }];
  if (full.range) scopeOptions.push({ value: 'range', label: 'In to out points' });
  if (selection.length) scopeOptions.push({ value: 'selection', label: selection.length === 1 ? 'Selected clip' : `Selected clips (${selection.length})` });
  const scope = select('Export', scopeOptions, s.scope, (v) => {
    s.scope = v;
    project = source();
    duration = projectDuration(project);
    update();
  });
  scope.row.hidden = scopeOptions.length < 2;

  // Projects with several timelines export the open one; picking another opens it.
  const timelines = ctx.timelines?.list() || [];
  const timelineSel = select('Timeline', timelines.map((t) => ({ value: t.id, label: t.name })), timelines.find((t) => t.active)?.id, (id) => {
    dlg.close();
    ctx.timelines.open(id);
    ctx.openExport();
  });
  timelineSel.row.hidden = timelines.length < 2;

  const res = select('Resolution', RESOLUTIONS, s.resolution, (v) => {
    s.resolution = Number(v);
    refreshCaps();
  });
  const bitrate = select('Quality', BITRATE_LEVELS, s.bitrate, (v) => {
    s.bitrate = v;
    update();
  });
  const customId = `exp-${++seq}`;
  const customInput = h('input', { type: 'range', id: customId, min: 1, max: 150, step: 1, value: s.customMbps });
  const customNum = h('output.export-custom-value', { for: customId });
  const setCustomPct = () => customInput.style.setProperty('--pct', `${((customInput.value - 1) / 149) * 100}%`);
  customInput.addEventListener('input', () => {
    s.customMbps = Number(customInput.value);
    setCustomPct();
    update();
  });
  setCustomPct();
  const customRow = h('div.export-row.export-custom', h('label.export-label', { for: customId }, 'Custom bitrate'), h('div.export-custom-ctl', customInput, customNum));
  const codec = select('Codec', VIDEO_CODECS, s.codec, (v) => {
    s.codec = v;
    s = reconcile(s, caps, 'codec');
    update();
  });
  const format = select('Format', Object.entries(CONTAINERS).map(([k, c]) => ({ value: k, label: c.label })), s.format, (v) => {
    s.format = v;
    s = reconcile(s, caps, 'format');
    update();
  });
  const fps = select('Frame rate', FRAME_RATES.map((f) => ({ value: f, label: `${f} fps` })), s.fps, (v) => {
    s.fps = Number(v);
    update();
  });
  const audioSwitchId = `exp-${++seq}`;
  const audioSwitch = h('button.switch', { type: 'button', role: 'switch', id: audioSwitchId, 'aria-checked': String(s.includeAudio), 'aria-labelledby': `${audioSwitchId}-l` });
  audioSwitch.addEventListener('click', () => {
    s.includeAudio = !s.includeAudio;
    audioSwitch.setAttribute('aria-checked', String(s.includeAudio));
    update();
  });
  const audioRow = h('div.export-row', h('span.export-label', { id: `${audioSwitchId}-l` }, 'Export audio'), h('div.export-switch-wrap', audioSwitch));
  const codecNote = h('p.export-hint.export-codec-note', { role: 'status' });
  const videoSection = checkSection('Video file', s.video, (v) => {
    s.video = v;
    update();
  }, [format.row, codec.row, res.row, fps.row, bitrate.row, customRow, audioRow, codecNote]);

  const audioFormat = select('Format', Object.entries(AUDIO_FORMATS).map(([k, f]) => ({ value: k, label: f.label })), s.audioFormat, (v) => {
    s.audioFormat = v;
    update();
  });
  const audioHint = h('p.export-hint');
  const audioSection = checkSection('Audio file', s.audio, (v) => {
    s.audio = v;
    update();
  }, [audioFormat.row, audioHint]);

  const gifWidth = select('Width', GIF_WIDTHS.map((w) => ({ value: w, label: `${w} px` })), s.gifWidth, (v) => {
    s.gifWidth = Number(v);
    update();
  });
  const gifFps = select('Frame rate', GIF_FPS.map((f) => ({ value: f, label: `${f} fps` })), s.gifFps, (v) => {
    s.gifFps = Number(v);
    update();
  });
  const gifLoop = select('Playback', [{ value: 'loop', label: 'Loop forever' }, { value: 'once', label: 'Play once' }], s.gifLoop ? 'loop' : 'once', (v) => {
    s.gifLoop = v === 'loop';
  });
  const gifHint = h('p.export-hint');
  const gifSection = checkSection('Animated GIF', s.gif, (v) => {
    s.gif = v;
    update();
  }, [gifWidth.row, gifFps.row, gifLoop.row, gifHint]);
  const capSection = checkSection('Captions file (.srt)', s.captions && hasCaptions, (v) => {
    s.captions = v;
    update();
  }, [h('p.export-hint', 'Saves the captions as a subtitle file next to the video.')]);
  capSection.el.hidden = !hasCaptions;

  const form = h('form.export-form', { novalidate: true }, nameRow, destRow, timelineSel.row, scope.row, videoSection.el, audioSection.el, gifSection.el, capSection.el);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    start();
  });
  const settingsView = h('div.export-layout', aside, form);

  /* Footer ------------------------------------------------------------------ */
  const footerInfo = h('div.export-footer-info');
  const footerButtons = h('div.export-footer-buttons');
  const footer = h('div.export-footer', footerInfo, footerButtons);
  const body = h('div.export-body', settingsView);

  const dlg = openDialog({
    title: 'Export',
    body,
    actions: [footer],
    className: 'export-dialog',
    closeOnBackdrop: false,
    onClose: () => {
      controller?.abort();
      setTimeout(() => {
        for (const u of urls) URL.revokeObjectURL(u);
        for (const r of results) r.release?.();
      }, 60_000);
    },
  });
  const titleEl = dlg.el.querySelector('.dialog-title');

  const exportBtn = h('button.btn.primary', { type: 'button' }, icon('export', 16), 'Export');
  exportBtn.addEventListener('click', () => start());
  const cancelBtn = h('button.btn', { type: 'button' }, 'Cancel');
  cancelBtn.addEventListener('click', () => dlg.close());

  function showSettingsFooter() {
    footerButtons.replaceChildren(cancelBtn, exportBtn);
  }

  /* Live state ---------------------------------------------------------------- */
  function update() {
    if (state !== 'settings') return;
    const size = outputSize(projW, projH, s.resolution);
    // Options the browser cannot encode are not offered at all.
    const codecList = VIDEO_CODECS.filter((c) => !caps || caps.video.includes(c.value));
    const formatList = Object.entries(CONTAINERS).filter(([, c]) => !caps || c.video.some((v) => caps.video.includes(v))).map(([k, c]) => ({ value: k, label: c.label }));
    const audioList = Object.entries(AUDIO_FORMATS).filter(([k]) => !caps || caps.audioFormats.includes(k)).map(([k, f]) => ({ value: k, label: f.label }));
    if (caps) s = reconcile(s, caps);
    codec.setOptions(codecList.length ? codecList : VIDEO_CODECS, s.codec);
    format.setOptions(formatList, s.format);
    audioFormat.setOptions(audioList, s.audioFormat);
    res.set(s.resolution);
    fps.set(s.fps);
    bitrate.set(s.bitrate);
    customRow.hidden = s.bitrate !== 'custom';
    const bps = videoBitrate({ ...size, fps: s.fps, codec: s.codec, level: s.bitrate, customMbps: s.customMbps });
    customNum.textContent = `${s.customMbps} Mbps`;
    bitrate.el.title = `${(bps / 1e6).toFixed(1)} Mbps`;
    const codecLabel = VIDEO_CODECS.find((c) => c.value === s.codec)?.label;
    if (caps && !caps.video.length) codecNote.textContent = 'This browser cannot encode video. Audio export still works.';
    else codecNote.textContent = `${size.width} x ${size.height}, ${codecLabel}, about ${(bps / 1e6).toFixed(1)} Mbps`;
    audioSwitch.disabled = !hasSound;
    audioRow.classList.toggle('disabled', !hasSound);
    if (!hasSound) audioHint.textContent = 'This project has no sound yet.';
    else audioHint.textContent = s.video ? 'Also saves the sound as a separate file.' : 'Audio only: exports just the sound.';
    destHint.textContent = s.destination === 'puter' ? 'Saved to the Videos folder in your Puter account.' : 'Downloaded by your browser.';
    const gifW = Math.min(s.gifWidth, projW);
    const gifFrames = Math.ceil((duration / US) * s.gifFps);
    // GIFs land around half a byte per pixel per frame for video content.
    const gifBytes = s.gif ? gifFrames * gifW * Math.round((projH * gifW) / projW) * 0.45 : 0;
    gifHint.textContent = `${gifW} x ${Math.round((projH * gifW) / projW)}, ${gifFrames} frames. GIFs are large; keep them short.`;
    const bytes = (s.video || s.audio ? estimateSize(s, duration, { projW, projH }) : 0) + gifBytes;
    const nothing = !s.video && !s.audio && !s.gif && !(s.captions && hasCaptions);
    const noVideo = s.video && caps && !caps.video.length;
    exportBtn.disabled = duration <= 0 || nothing || noVideo;
    scope.set(s.scope);
    footerInfo.replaceChildren(
      h('span', icon('clock', 14), `Length ${clock(duration)}`),
      h('span', icon('drive', 14), duration > 0 && !nothing ? `Estimated size ${formatBytes(bytes)}` : 'Nothing to export'),
    );
    stillMeta.textContent = `${size.width} x ${size.height}  ${s.fps} fps`;
  }

  let capsReq = 0;
  async function refreshCaps() {
    const id = ++capsReq;
    update();
    const size = outputSize(projW, projH, s.resolution);
    const c = await detectCapabilities({ ...size, fps: s.fps }).catch(() => null);
    if (id !== capsReq) return;
    caps = c || { video: ['avc'], audio: ['aac'], audioFormats: ['wav'] };
    update();
  }

  /* Export run --------------------------------------------------------------- */
  const progressCanvas = h('canvas.export-still-canvas', { 'aria-hidden': 'true' });
  const pct = h('div.export-pct', '0%');
  const bar = h('div.export-bar-fill');
  const barEl = h('div.export-bar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': 'Export progress' }, bar);
  const phaseEl = h('h3.export-phase');
  const stat = (label) => {
    const dd = h('dd', '--');
    return { dd, el: [h('dt', label), dd] };
  };
  const stFrames = stat('Frames');
  const stElapsed = stat('Elapsed');
  const stRemain = stat('Remaining');
  const stSpeed = stat('Speed');
  const progressView = h('div.export-layout.export-running',
    h('div.export-aside', h('div.export-still.ready', { style: { aspectRatio: `${projW} / ${projH}` } }, progressCanvas)),
    h('div.export-progress', phaseEl, pct, barEl, h('dl.export-stats', stFrames.el, stElapsed.el, stRemain.el, stSpeed.el)));

  async function start() {
    if (state === 'running' || exportBtn.disabled) return;
    s.name = safeFileName(nameInput.value || project.name);
    remember(s);
    state = 'running';
    controller = new AbortController();
    const jobs = [];
    if (s.video) jobs.push('video');
    if (s.audio) jobs.push('audio');
    if (s.gif) jobs.push('gif');
    if (s.captions && hasCaptions) jobs.push('captions');
    body.replaceChildren(progressView);
    if (stillCanvas.width) {
      progressCanvas.width = stillCanvas.width;
      progressCanvas.height = stillCanvas.height;
      progressCanvas.getContext('2d').drawImage(stillCanvas, 0, 0);
    }
    const stopBtn = h('button.btn', { type: 'button' }, 'Cancel');
    stopBtn.addEventListener('click', () => controller.abort());
    footerInfo.replaceChildren(h('span', `Exporting ${s.name}`));
    footerButtons.replaceChildren(stopBtn);
    stopBtn.focus();
    titleEl.textContent = 'Exporting';
    announce('Export started');
    results = [];
    let lastAnnounced = 0;
    try {
      for (let j = 0; j < jobs.length; j++) {
        const kind = jobs[j];
        const jobLabel = { video: 'Video', audio: 'Audio', gif: 'GIF', captions: 'Captions' }[kind];
        phaseEl.textContent = jobs.length > 1 ? `${jobLabel} (${j + 1} of ${jobs.length})` : { video: 'Rendering video', audio: 'Mixing audio', gif: 'Rendering GIF', captions: 'Writing captions' }[kind];
        stFrames.dd.textContent = '--';
        stSpeed.dd.textContent = '--';
        if (kind === 'captions') {
          const blob = new Blob([toSrt(captionCues(project))], { type: 'application/x-subrip' });
          results.push({ kind, blob, fileName: `${s.name}.srt`, duration, elapsed: 0 });
          continue;
        }
        const run = kind === 'gif' ? (o) => exportGif(project, library, s, o) : (o) => exportProject(project, library, s, { kind, ...o });
        const r = await run({
          signal: controller.signal,
          onProgress: (p) => {
            if (p.preview) {
              progressCanvas.width = p.preview.width;
              progressCanvas.height = p.preview.height;
              progressCanvas.getContext('2d').drawImage(p.preview, 0, 0);
              p.preview.close();
            }
            const overall = (j + p.fraction) / jobs.length;
            const n = Math.min(100, Math.floor(overall * 100));
            pct.textContent = p.phase === 'finalizing' && j === jobs.length - 1 ? 'Finishing...' : `${n}%`;
            bar.style.width = `${overall * 100}%`;
            barEl.setAttribute('aria-valuenow', String(n));
            if (kind === 'video' || kind === 'gif') {
              stFrames.dd.textContent = `${p.done} / ${p.total}`;
              if (p.fps) stSpeed.dd.textContent = `${p.fps.toFixed(0)} fps`;
            } else {
              stFrames.dd.textContent = 'Audio';
            }
            stElapsed.dd.textContent = secondsLabel(p.elapsed);
            stRemain.dd.textContent = p.done > 0 ? secondsLabel(p.remaining) : '--:--';
            if (n >= lastAnnounced + 25) {
              lastAnnounced = n - (n % 25);
              announce(`Export ${lastAnnounced}% done`);
            }
          },
        });
        results.push(r);
      }
      finish();
    } catch (err) {
      if (err?.name === 'AbortError') {
        if (!dlg.el.isConnected) return;
        announce('Export canceled');
        backToSettings();
        return;
      }
      console.error(err);
      fail(err);
    }
  }

  function backToSettings() {
    state = 'settings';
    titleEl.textContent = 'Export';
    body.replaceChildren(settingsView);
    showSettingsFooter();
    update();
    exportBtn.focus();
  }

  function fail(err) {
    state = 'error';
    titleEl.textContent = 'Export failed';
    const msg = describeError(err, s);
    body.replaceChildren(h('div.export-message', { role: 'alert' }, icon('alert', 28), h('p', msg)));
    const back = h('button.btn', { type: 'button' }, 'Back to settings');
    back.addEventListener('click', backToSettings);
    const close = h('button.btn.primary', { type: 'button' }, 'Close');
    close.addEventListener('click', () => dlg.close());
    footerInfo.replaceChildren();
    footerButtons.replaceChildren(back, close);
    back.focus();
  }

  function download(r) {
    const url = URL.createObjectURL(r.blob);
    urls.push(url);
    const a = h('a', { href: url, download: r.fileName, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function saveToVideos(r, statusEl) {
    statusEl.textContent = 'Saving to Puter...';
    try {
      const user = ctx.account?.user || (await puter.auth.getUser());
      const item = await puter.fs.write(`/${user.username}/Videos/${r.fileName}`, r.blob, { dedupeName: true, createMissingParents: true, overwrite: false });
      statusEl.textContent = `Saved to ${item?.path || `Videos/${r.fileName}`}`;
      announce(`Saved ${r.fileName} to Puter`);
    } catch (err) {
      statusEl.textContent = 'Could not save to Puter.';
      toast(`Could not save to Puter: ${err?.message || err}`, { kind: 'error' });
    }
  }

  async function saveWithPicker(r, statusEl) {
    if (!puter.ui?.showSaveFilePicker) return saveToVideos(r, statusEl);
    statusEl.textContent = 'Choose where to save it in Puter.';
    try {
      // The picker never resolves when dismissed, so the status just stays as a prompt.
      const item = await puter.ui.showSaveFilePicker(r.blob, r.fileName);
      statusEl.textContent = `Saved to ${item?.path || item?.name || 'Puter'}`;
      announce(`Saved ${r.fileName} to Puter`);
    } catch (err) {
      statusEl.textContent = 'Could not save to Puter.';
      toast(`Could not save to Puter: ${err?.message || err}`, { kind: 'error' });
    }
  }

  function finish() {
    state = 'done';
    titleEl.textContent = 'Export complete';
    const cloud = signedIn(ctx);
    const rows = results.map((r) => {
      const status = h('p.export-file-status', { role: 'status' });
      const dl = h('button.btn', { type: 'button' }, icon('download', 16), 'Download');
      dl.addEventListener('click', () => download(r));
      const save = cloud ? h('button.btn', { type: 'button' }, icon('cloud', 16), 'Save to Puter') : null;
      save?.addEventListener('click', () => saveWithPicker(r, status));
      const meta = r.kind === 'video' || r.kind === 'gif'
        ? `${r.width} x ${r.height}, ${clock(r.duration)}, ${formatBytes(r.blob.size)}`
        : r.kind === 'captions' ? formatBytes(r.blob.size) : `${clock(r.duration)}, ${formatBytes(r.blob.size)}`;
      const row = h('li.export-file', h('span.export-file-icon', icon({ video: 'fileVideo', audio: 'fileAudio', gif: 'fileImage', captions: 'subtitles' }[r.kind] || 'fileVideo', 20)),
        h('div.export-file-text', h('span.export-file-name', r.fileName), h('span.export-file-meta', meta), status),
        h('div.export-file-actions', dl, save));
      if (s.destination === 'puter' && cloud) saveToVideos(r, status);
      return row;
    });
    const took = results.reduce((a, r) => a + r.elapsed, 0);
    const doneView = h('div.export-layout.export-done',
      h('div.export-aside', h('div.export-still.ready', { style: { aspectRatio: `${projW} / ${projH}` } }, progressCanvas)),
      h('div.export-progress',
        h('div.export-done-head', h('span.export-done-icon', icon('check', 18)), h('h3.export-phase', 'Your export is ready')),
        h('p.export-hint', `Finished in ${secondsLabel(took)}.`),
        h('ul.export-files', rows)));
    body.replaceChildren(doneView);
    const doneBtn = h('button.btn.primary', { type: 'button' }, 'Done');
    doneBtn.addEventListener('click', () => dlg.close());
    footerInfo.replaceChildren();
    footerButtons.replaceChildren(doneBtn);
    doneBtn.focus();
    announce('Export complete');
    if (s.destination !== 'puter' || !cloud) for (const r of results) download(r);
  }

  showSettingsFooter();
  refreshCaps();
  nameInput.focus();
  nameInput.select();
  return dlg;
}
