/**
 * Voiceover recording dialog: choose a microphone, watch the input level,
 * count in 3-2-1, then record while the project plays from the playhead,
 * optionally reading from a scrolling teleprompter.
 * The take lands on an audio track where recording started.
 */
import { h, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { US, timecode } from '../lib/time.js';
import { openDialog, toast } from './dialog.js';
import { switchField } from './controls.js';
import { prefs, setPref } from './prefs.js';
import { createTeleprompter } from './teleprompter.js';
import {
  recordingSupported, listMicrophones, openMicrophone, stopStream, micErrorMessage, LevelMeter, VoiceRecorder, extForMime,
} from '../media/voiceover.js';
import '../styles/audio.css';

let open = null;

const fmt = (s) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
};

export function openVoiceoverDialog(ctx) {
  if (open) return open;
  const { store, player, actions } = ctx;
  const opts = { noiseSuppression: true, echoCancellation: true, deviceId: '', ...(prefs().voiceover || {}) };
  const save = () => setPref('voiceover', { ...opts });

  let stream = null;
  let meter = null;
  let raf = 0;
  let state = 'idle'; // idle | countdown | recording | saving
  let countdownTimer = 0;
  let tick = 0;
  let startAt = 0;
  let opening = 0; // newest microphone request; older ones are stopped when they arrive
  let closed = false;
  const recorder = new VoiceRecorder();

  const message = h('div.vo-message', { role: 'alert' });
  const micSelect = h('select#vo-mic.select', { 'aria-describedby': 'vo-mic-hint' }, h('option', { value: '' }, 'Default microphone'));
  const meterCanvas = h('canvas.vo-meter', { width: 300, height: 10, 'aria-hidden': 'true' });
  const levelText = h('span.sr-only', 'Input level');
  const ns = switchField({ label: 'Noise suppression', checked: opts.noiseSuppression, onChange: (v) => { opts.noiseSuppression = v; save(); reopen(); } });
  const ec = switchField({ label: 'Echo cancellation', checked: opts.echoCancellation, hint: 'Keeps the project sound out of the recording', onChange: (v) => { opts.echoCancellation = v; save(); reopen(); } });
  const countdown = h('div.vo-countdown', { 'aria-hidden': 'true' });
  const recBtn = h('button.vo-record', { type: 'button', 'aria-label': 'Start recording' }, h('span.vo-record-dot'));
  const elapsed = h('div.vo-elapsed', { 'aria-live': 'off' }, '00:00.0');
  const where = h('p.vo-where');
  const status = h('p.vo-status', { role: 'status' });

  micSelect.addEventListener('change', () => {
    opts.deviceId = micSelect.value;
    save();
    reopen();
  });
  recBtn.addEventListener('click', () => {
    if (state === 'idle') startCountdown();
    else if (state === 'countdown') cancelCountdown();
    else if (state === 'recording') stopRecording();
  });

  const prompter = createTeleprompter();
  const body = h('div.vo-body',
    message,
    prompter.view,
    h('div.field',
      h('label.field-label', { for: 'vo-mic' }, 'Microphone'),
      micSelect,
      h('span#vo-mic-hint.field-hint', 'Use headphones so the project sound is not recorded too.'),
    ),
    h('div.field', h('span.field-label', 'Input level'), h('div.vo-meter-wrap', meterCanvas, levelText)),
    ns.el,
    ec.el,
    prompter.controls,
    h('div.vo-stage', countdown, recBtn, elapsed),
    where,
    status,
  );

  const d = openDialog({
    title: 'Record voiceover',
    body,
    className: 'voiceover-dialog',
    closeOnBackdrop: false,
    onClose: () => cleanup(),
  });
  open = d;

  function setWhere() {
    where.textContent = `Recording starts at ${timecode(store.time, store.fps)} and plays your project so you can talk over it.`;
  }
  setWhere();
  const offTime = store.on('time', () => {
    if (state === 'idle') setWhere();
  });

  function showError(text, retry = true) {
    message.replaceChildren(icon('alert', 16), h('span', text), retry ? h('button.btn.small', { type: 'button', onclick: () => reopen() }, 'Try again') : null);
    message.hidden = false;
    recBtn.disabled = true;
  }

  function clearError() {
    message.replaceChildren();
    message.hidden = true;
    recBtn.disabled = false;
  }

  async function reopen() {
    if (state !== 'idle') return;
    const my = ++opening;
    const stale = () => closed || my !== opening;
    closeStream();
    if (!recordingSupported()) {
      showError(globalThis.isSecureContext === false ? 'Recording needs a secure (https) connection.' : 'Your browser cannot record audio.', false);
      return;
    }
    status.textContent = 'Waiting for microphone access...';
    let mic;
    try {
      mic = await openMicrophone(opts);
    } catch (err) {
      if (stale()) return;
      // A remembered device that is gone falls back to the default one.
      if (opts.deviceId && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
        opts.deviceId = '';
        save();
        return reopen();
      }
      status.textContent = '';
      showError(micErrorMessage(err));
      return;
    }
    if (stale()) {
      stopStream(mic);
      return;
    }
    stream = mic;
    clearError();
    status.textContent = '';
    const mics = await listMicrophones();
    // Closing or a newer request has already stopped this stream.
    if (stale()) return;
    const current = stream.getAudioTracks()[0]?.getSettings?.().deviceId || opts.deviceId;
    micSelect.replaceChildren(...(mics.length ? mics : [{ deviceId: '', label: 'Default microphone' }]).map((m) => h('option', { value: m.deviceId, selected: m.deviceId === current }, m.label)));
    try {
      meter = new LevelMeter(stream);
    } catch {
      meter = null;
    }
    drawLoop();
  }

  function closeStream() {
    cancelAnimationFrame(raf);
    raf = 0;
    meter?.close();
    meter = null;
    stopStream(stream);
    stream = null;
  }

  const cssVar = (name) => getComputedStyle(meterCanvas).getPropertyValue(name).trim();
  let colors = null;
  function drawLoop() {
    cancelAnimationFrame(raf);
    const g = meterCanvas.getContext('2d');
    if (!g || !meter) return;
    colors = { bg: cssVar('--bg-input') || '#111', fill: cssVar('--success') || '#3fbf7f', hot: cssVar('--danger') || '#f04d4d', warn: cssVar('--warning') || '#f2a93b' };
    const frame = () => {
      if (!meter) return;
      const w = meterCanvas.width;
      const hgt = meterCanvas.height;
      const lv = meter.level();
      // Map to a dB-like scale so normal speech fills about two thirds.
      const x = Math.max(0, Math.min(1, 1 + Math.log10(Math.max(lv, 1e-4)) / 2.5));
      g.fillStyle = colors.bg;
      g.fillRect(0, 0, w, hgt);
      g.fillStyle = lv > 0.95 ? colors.hot : x > 0.85 ? colors.warn : colors.fill;
      g.fillRect(0, 0, Math.round(w * x), hgt);
      raf = requestAnimationFrame(frame);
    };
    frame();
  }

  function setState(next) {
    state = next;
    body.dataset.state = next;
    prompter.follow(next);
    const label = next === 'recording' ? 'Stop recording' : next === 'countdown' ? 'Cancel countdown' : 'Start recording';
    recBtn.setAttribute('aria-label', label);
    recBtn.setAttribute('aria-pressed', String(next === 'recording'));
    recBtn.disabled = next === 'saving' || !stream;
    micSelect.disabled = next !== 'idle';
    for (const sw of body.querySelectorAll('.switch')) sw.disabled = next !== 'idle';
  }

  function startCountdown() {
    if (!stream) return;
    let n = 3;
    setState('countdown');
    const step = () => {
      if (n === 0) {
        countdown.textContent = '';
        startRecording();
        return;
      }
      countdown.textContent = String(n);
      announce(String(n));
      n--;
      countdownTimer = setTimeout(step, 1000);
    };
    step();
  }

  function cancelCountdown() {
    clearTimeout(countdownTimer);
    countdown.textContent = '';
    setState('idle');
    announce('Countdown cancelled');
  }

  function startRecording() {
    try {
      recorder.start(stream);
    } catch (err) {
      setState('idle');
      showError(err?.message || "Couldn't start recording.");
      return;
    }
    startAt = store.time;
    status.textContent = '';
    setState('recording');
    announce('Recording');
    // Play along from the playhead unless it is already at the end.
    if (store.time < store.duration - 1000) player.play();
    tick = setInterval(() => {
      elapsed.textContent = fmt(recorder.elapsed);
    }, 100);
  }

  async function stopRecording() {
    clearInterval(tick);
    setState('saving');
    player.pause();
    const seconds = recorder.elapsed;
    const blob = await recorder.stop();
    elapsed.textContent = fmt(seconds);
    if (!blob || !blob.size) {
      setState('idle');
      showError('Nothing was recorded. Check the microphone and try again.');
      return;
    }
    status.textContent = 'Adding recording...';
    const n = Object.values(store.project.assets).filter((a) => /^Voiceover \d+/.test(a.name)).length + 1;
    const file = new File([blob], `Voiceover ${n}.${extForMime(blob.type)}`, { type: blob.type });
    try {
      const [asset] = await actions.importFiles([file]);
      if (asset) {
        // Some recorders write no duration into the file; fall back to the measured length.
        if (!asset.duration) asset.duration = Math.round(seconds * US);
        actions.addAsset(asset, { start: startAt });
        status.textContent = `Added ${asset.name} to the timeline.`;
        announce(`Added ${asset.name} to the timeline`);
      } else status.textContent = '';
    } catch (err) {
      status.textContent = '';
      toast(err?.message || "Couldn't add the recording.", { kind: 'error' });
    }
    if (open) setState('idle');
    setWhere();
  }

  function cleanup() {
    prompter.dispose();
    open = null;
    closed = true;
    clearTimeout(countdownTimer);
    clearInterval(tick);
    offTime();
    if (state === 'recording') {
      recorder.cancel();
      player.pause();
      toast('Recording discarded.');
    }
    closeStream();
  }

  setState('idle');
  message.hidden = true;
  reopen();
  return d;
}
