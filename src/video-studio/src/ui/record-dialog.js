/**
 * Record dialog: capture the camera (with a microphone, a mirrored preview
 * and a 3-2-1 count-in) or a screen, window or tab (with its sound and/or a
 * microphone), with an optional teleprompter over the preview. The take is
 * imported into the media bin and can go straight onto the timeline at the
 * playhead.
 */
import { h, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { US } from '../lib/time.js';
import { openDialog, toast } from './dialog.js';
import { switchField, segmented } from './controls.js';
import { prefs, setPref } from './prefs.js';
import { createTeleprompter } from './teleprompter.js';
import {
  RESOLUTIONS, cameraSupported, screenSupported, listDevices, openCamera, openMic, openScreen, stopStream, mixStreams,
  captureErrorMessage, VideoRecorder, extForVideoMime,
} from '../media/capture.js';
import '../styles/audio.css';
import '../styles/panels.css';

let open = null;

const fmt = (s) => {
  const m = Math.floor(s / 60);
  const r = Math.floor(s - m * 60);
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
};

const DEFAULTS = { mode: 'camera', cameraId: '', micId: '', resolution: '720', mirror: true, countdown: true, addToTimeline: false, systemAudio: true, screenMic: false };

/** Open (or focus) the Record dialog. opts: { mode, folder } */
export function openRecordDialog(ctx, { mode, folder = null } = {}) {
  if (open) return open;
  const { store, actions } = ctx;
  const opts = { ...DEFAULTS, ...(prefs().record || {}) };
  if (mode) opts.mode = mode;
  const save = () => setPref('record', { ...opts });

  let preview = null; // camera stream, or the shared screen
  let micStream = null; // separate microphone for screen recording
  let mixed = null;
  let state = 'idle'; // idle | countdown | recording | paused | saving
  let countdownTimer = 0;
  let tick = 0;
  let opening = 0;
  const recorder = new VideoRecorder();

  const message = h('div.vo-message', { role: 'alert', hidden: true });
  const video = h('video.rec-preview', { muted: true, playsInline: true, autoplay: true, 'aria-label': 'Recording preview' });
  video.muted = true;
  const placeholder = h('div.rec-placeholder');
  const prompter = createTeleprompter({ overlay: true });
  const stageView = h('div.rec-view', video, placeholder, prompter.view);

  const modeCtl = segmented({
    label: 'What to record',
    options: [
      { value: 'camera', label: 'Camera', icon: 'camera' },
      { value: 'screen', label: 'Screen', icon: 'screen' },
    ],
    value: opts.mode,
    onChange: (v) => {
      if (state !== 'idle') return;
      opts.mode = v;
      save();
      // The camera and a shared screen never carry over between modes.
      closeStreams();
      sync();
      reopen();
    },
  });

  const camSelect = h('select#rec-cam.select');
  const micSelect = h('select#rec-mic.select');
  const resSelect = h('select#rec-res.select', RESOLUTIONS.map((r) => h('option', { value: r.id, selected: r.id === opts.resolution }, r.label)));
  camSelect.addEventListener('change', () => { opts.cameraId = camSelect.value; save(); reopen(); });
  micSelect.addEventListener('change', () => { opts.micId = micSelect.value; save(); reopen(); });
  resSelect.addEventListener('change', () => { opts.resolution = resSelect.value; save(); reopen(); });

  const mirror = switchField({ label: 'Mirror preview', hint: 'The recording itself is not flipped', checked: opts.mirror, onChange: (v) => { opts.mirror = v; save(); sync(); } });
  const sysAudio = switchField({ label: 'Include sound from the screen', hint: 'Where the browser allows it', checked: opts.systemAudio, onChange: (v) => { opts.systemAudio = v; save(); } });
  const screenMic = switchField({ label: 'Include microphone', checked: opts.screenMic, onChange: (v) => { opts.screenMic = v; save(); sync(); reopen(); } });
  const countdownSw = switchField({ label: 'Count in 3, 2, 1', checked: opts.countdown, onChange: (v) => { opts.countdown = v; save(); } });
  const addSw = switchField({ label: 'Add to the timeline at the playhead', checked: opts.addToTimeline, onChange: (v) => { opts.addToTimeline = v; save(); } });

  const cameraFields = h('div.rec-fields',
    h('div.field', h('label.field-label', { for: 'rec-cam' }, 'Camera'), camSelect),
    h('div.field', h('label.field-label', { for: 'rec-mic' }, 'Microphone'), micSelect),
    h('div.field', h('label.field-label', { for: 'rec-res' }, 'Quality'), resSelect),
    mirror.el,
  );
  const pickScreen = h('button.btn', { type: 'button' }, icon('screen', 16), 'Choose what to share');
  pickScreen.addEventListener('click', () => shareScreen());
  const screenMicField = h('div.field', h('label.field-label', { for: 'rec-mic' }, 'Microphone'));
  const screenFields = h('div.rec-fields', pickScreen, sysAudio.el, screenMic.el, screenMicField);

  const countdown = h('div.vo-countdown.rec-countdown', { 'aria-hidden': 'true' });
  const recBtn = h('button.vo-record', { type: 'button', 'aria-label': 'Start recording' }, h('span.vo-record-dot'));
  const pauseBtn = h('button.icon-btn.rec-pause', { type: 'button', 'aria-label': 'Pause recording', hidden: true }, icon('pause', 18));
  const elapsed = h('div.vo-elapsed', { 'aria-live': 'off' }, '00:00');
  const status = h('p.vo-status', { role: 'status' });

  recBtn.addEventListener('click', () => {
    if (state === 'idle') begin();
    else if (state === 'countdown') cancelCountdown();
    else if (state === 'recording' || state === 'paused') stopRecording();
  });
  pauseBtn.addEventListener('click', () => {
    if (state === 'recording') {
      recorder.pause();
      setState('paused');
      announce('Paused');
    } else if (state === 'paused') {
      recorder.resume();
      setState('recording');
      announce('Recording');
    }
  });

  const body = h('div.rec-body',
    modeCtl.el,
    message,
    h('div.rec-layout',
      h('div.rec-left', stageView, h('div.vo-stage.rec-stage', countdown, h('div.rec-controls', recBtn, pauseBtn), elapsed)),
      h('div.rec-right', cameraFields, screenFields, countdownSw.el, addSw.el, prompter.controls),
    ),
    status,
  );

  const d = openDialog({ title: 'Record', body, className: 'record-dialog', wide: true, closeOnBackdrop: false, onClose: () => cleanup() });
  open = d;

  function sync() {
    const cam = opts.mode === 'camera';
    cameraFields.hidden = !cam;
    screenFields.hidden = cam;
    video.classList.toggle('mirror', cam && opts.mirror);
    // One microphone picker, moved to whichever mode shows.
    (cam ? cameraFields.children[1] : screenMicField).append(micSelect);
    screenMicField.hidden = !opts.screenMic;
    placeholder.replaceChildren(
      icon(cam ? 'camera' : 'screen', 28),
      h('span', cam ? 'Waiting for the camera...' : 'Choose a screen, window or tab to share.'),
    );
  }

  function showError(text) {
    placeholder.replaceChildren(icon('alert', 28), h('span', opts.mode === 'camera' ? 'The camera is not available.' : 'Nothing is being shared.'));
    message.replaceChildren(icon('alert', 16), h('span', text), h('button.btn.small', { type: 'button', onclick: () => reopen(true) }, 'Try again'));
    message.hidden = false;
  }

  function clearError() {
    message.replaceChildren();
    message.hidden = true;
  }

  async function fillDevices() {
    const { cameras, mics } = await listDevices();
    const camNow = preview?.getVideoTracks()[0]?.getSettings?.().deviceId || opts.cameraId;
    const micNow = (opts.mode === 'camera' ? preview : micStream)?.getAudioTracks()[0]?.getSettings?.().deviceId || opts.micId;
    camSelect.replaceChildren(...(cameras.length ? cameras : [{ deviceId: '', label: 'Default camera' }]).map((c) => h('option', { value: c.deviceId, selected: c.deviceId === camNow }, c.label)));
    micSelect.replaceChildren(
      h('option', { value: 'none', selected: opts.micId === 'none' }, 'No microphone'),
      ...(mics.length ? mics : [{ deviceId: '', label: 'Default microphone' }]).map((m) => h('option', { value: m.deviceId, selected: opts.micId !== 'none' && m.deviceId === micNow }, m.label)),
    );
  }

  function closeStreams() {
    mixed?.close();
    mixed = null;
    stopStream(preview);
    stopStream(micStream);
    preview = null;
    micStream = null;
    video.srcObject = null;
    stageView.classList.remove('live');
  }

  function attach(stream) {
    video.srcObject = stream;
    stageView.classList.add('live');
    video.play?.().catch(() => {});
  }

  /** (Re)open the camera, or the microphone for an already shared screen. */
  async function reopen(retry = false) {
    if (state !== 'idle') return;
    const my = ++opening;
    clearError();
    if (opts.mode === 'camera') {
      closeStreams();
      if (!cameraSupported()) {
        showError(globalThis.isSecureContext === false ? 'Recording needs a secure (https) connection.' : 'This browser cannot record from a camera.');
        setState('idle');
        return;
      }
      status.textContent = 'Waiting for camera access...';
      let stream;
      try {
        stream = await openCamera({ cameraId: opts.cameraId, micId: opts.micId === 'none' ? '' : opts.micId, audio: opts.micId !== 'none', resolution: opts.resolution });
      } catch (err) {
        if (my !== opening) return;
        // A remembered device that is gone falls back to the default one.
        if ((opts.cameraId || (opts.micId && opts.micId !== 'none')) && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
          opts.cameraId = '';
          if (opts.micId !== 'none') opts.micId = '';
          save();
          return reopen();
        }
        status.textContent = '';
        showError(captureErrorMessage(err, 'camera'));
        setState('idle');
        return;
      }
      if (!open || my !== opening) {
        stopStream(stream);
        return;
      }
      preview = stream;
      status.textContent = '';
      attach(stream);
      await fillDevices();
    } else {
      // The screen stays shared; only the microphone changes.
      stopStream(micStream);
      micStream = null;
      if (!screenSupported()) {
        showError('This browser cannot record the screen.');
        setState('idle');
        return;
      }
      if (opts.screenMic && opts.micId !== 'none') {
        try {
          const mic = await openMic(opts.micId);
          if (!open || my !== opening) {
            stopStream(mic);
            return;
          }
          micStream = mic;
        } catch (err) {
          if (my !== opening) return;
          showError(captureErrorMessage(err, 'camera').replace(/camera/gi, 'microphone'));
        }
      }
      if (!preview && retry) await shareScreen();
      await fillDevices();
    }
    setState('idle');
  }

  /** Ask the browser for a screen, window or tab (needs a click). */
  async function shareScreen() {
    if (state !== 'idle') return false;
    clearError();
    stopStream(preview);
    preview = null;
    try {
      preview = await openScreen({ systemAudio: opts.systemAudio });
    } catch (err) {
      showError(captureErrorMessage(err, 'screen'));
      setState('idle');
      return false;
    }
    if (!open) {
      closeStreams();
      return false;
    }
    attach(preview);
    // Stopping the share from the browser's own bar ends the take.
    preview.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (state === 'recording' || state === 'paused') stopRecording();
      else if (state === 'countdown') cancelCountdown();
      if (state === 'idle') {
        closeStreams();
        setState('idle');
      }
    });
    setState('idle');
    return true;
  }

  function setState(next) {
    state = next;
    body.dataset.state = next;
    prompter.follow(next);
    const busy = next !== 'idle';
    const label = next === 'recording' || next === 'paused' ? 'Stop recording' : next === 'countdown' ? 'Cancel countdown' : 'Start recording';
    recBtn.setAttribute('aria-label', label);
    recBtn.setAttribute('aria-pressed', String(next === 'recording' || next === 'paused'));
    // Screen mode can start without a stream: the click asks what to share.
    recBtn.disabled = next === 'saving' || (opts.mode === 'camera' && !preview);
    pauseBtn.hidden = !(next === 'recording' || next === 'paused');
    pauseBtn.setAttribute('aria-label', next === 'paused' ? 'Resume recording' : 'Pause recording');
    pauseBtn.replaceChildren(icon(next === 'paused' ? 'play' : 'pause', 18));
    for (const el of body.querySelectorAll('.rec-right select, .rec-right .switch, .rec-right .btn')) el.disabled = busy;
    for (const b of modeCtl.el.querySelectorAll('button')) b.disabled = busy;
  }

  async function begin() {
    if (opts.mode === 'screen' && !preview && !(await shareScreen())) return;
    if (!preview) return;
    if (!opts.countdown) {
      startRecording();
      return;
    }
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
    if (!preview) {
      setState('idle');
      return;
    }
    try {
      const audio = opts.mode === 'camera' ? [preview] : [opts.systemAudio ? preview : null, micStream];
      mixed?.close();
      mixed = mixStreams(preview, audio);
      recorder.start(mixed.stream);
    } catch (err) {
      setState('idle');
      showError(err?.message || "Couldn't start recording.");
      return;
    }
    status.textContent = '';
    setState('recording');
    announce('Recording');
    elapsed.textContent = '00:00';
    tick = setInterval(() => {
      elapsed.textContent = fmt(recorder.elapsed);
    }, 250);
  }

  async function stopRecording() {
    if (state !== 'recording' && state !== 'paused') return;
    clearInterval(tick);
    setState('saving');
    const seconds = recorder.elapsed;
    const blob = await recorder.stop();
    elapsed.textContent = fmt(seconds);
    if (!blob || !blob.size) {
      setState('idle');
      showError('Nothing was recorded. Check the camera or screen and try again.');
      return;
    }
    status.replaceChildren(h('span.spinner'), 'Saving the recording...');
    const base = opts.mode === 'camera' ? 'Camera' : 'Screen';
    const n = Object.values(store.project.assets).filter((a) => new RegExp(`^${base} recording \\d+`).test(a.name)).length + 1;
    const file = new File([blob], `${base} recording ${n}.${extForVideoMime(blob.type)}`, { type: blob.type });
    const at = store.time;
    try {
      const [asset] = await actions.importFiles([file], { folder, origin: 'record' });
      if (asset) {
        // Recorders often write no duration into the file; fall back to the measured length.
        if (!asset.duration) asset.duration = Math.round(seconds * US);
        if (opts.addToTimeline) actions.addAsset(asset, { start: at });
        const msg = opts.addToTimeline ? `Added ${asset.name} to the timeline.` : `Saved ${asset.name} to your media.`;
        status.textContent = msg;
        announce(msg);
      } else status.textContent = '';
    } catch (err) {
      status.textContent = '';
      toast(err?.message || "Couldn't save the recording.", { kind: 'error' });
    }
    if (!open) return;
    // A screen whose sharing ended needs to be chosen again.
    if (preview && !preview.getVideoTracks().some((t) => t.readyState === 'live')) closeStreams();
    setState('idle');
  }

  function cleanup() {
    open = null;
    prompter.dispose();
    opening++;
    clearTimeout(countdownTimer);
    clearInterval(tick);
    if (state === 'recording' || state === 'paused') {
      recorder.cancel();
      toast('Recording discarded.');
    }
    closeStreams();
  }

  sync();
  setState('idle');
  if (opts.mode === 'camera') reopen();
  else fillDevices().then(() => setState(state));
  return d;
}
