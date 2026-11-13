/**
 * Speech tab for text clips: read the clip's text aloud with a chosen
 * voice, preview it, and add it as an audio clip that starts with the text
 * clip (optionally stretching the text clip to the speech's length).
 * Speech runs on Puter AI, so signed-out users see the same sign-in prompt
 * as the Audio panel.
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { clock } from '../../lib/time.js';
import { findClip } from '../../model/timeline.js';
import { TTS_VOICES, TTS_MAX, aiAvailable, synthesize, addSpeechToTimeline } from '../../media/tts.js';
import { segmented } from '../controls.js';
import { toast } from '../dialog.js';
import { prefs, setPref } from '../prefs.js';
import { emptyState } from '../panels/common.js';
import { propSection, toggle, restoreFocus } from './common.js';

function signInHint(ctx) {
  const btn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in to Puter') : null;
  return h('div.text-speech', emptyState('user', 'Sign in to use text to speech', 'Text to speech runs on Puter AI, so it needs a Puter account.', btn));
}

// Whether "Add as audio clip" also fits the text clip to the speech.
let fitText = true;

export function speechTab(view) {
  const { ctx, store } = view;
  if (!aiAvailable(ctx)) return signInHint(ctx);
  let voice = TTS_VOICES.some((v) => v.id === prefs().ttsVoice) ? prefs().ttsVoice : TTS_VOICES[0].id;
  let job = null, disposed = false;
  let audio = null, audioUrl = null;
  const context = () => JSON.stringify([store.project.id, store.project.timelineId, ...(store.nest || []).map((f) => f.id)]);

  const voices = segmented({
    label: 'Voice',
    className: 'voice-grid',
    options: TTS_VOICES.map((v) => ({ value: v.id, label: v.label })),
    value: voice,
    onChange: (v) => {
      voice = v;
      setPref('ttsVoice', v);
    },
  });
  const previewBtn = h('button.btn', { type: 'button' }, icon('play', 16), 'Preview');
  const addBtn = h('button.btn.primary', { type: 'button' }, icon('plus', 16), 'Add as audio clip');
  const cancelBtn = h('button.btn', { type: 'button', hidden: true }, 'Cancel speech');
  const status = h('p.tts-status', { role: 'status' });
  const where = h('p.field-hint.text-hint');
  const quote = h('blockquote.speech-quote');
  const fit = toggle(view, { label: 'Fit text to speech', hint: 'Make the text clip as long as the speech', get: () => fitText, set: (v) => (fitText = v) });

  const text = () => (view.clip?.text || '').trim().slice(0, TTS_MAX);
  const update = () => {
    const c = view.clip;
    if (!c) return;
    const empty = !text();
    previewBtn.disabled = !audio && (Boolean(job) || empty);
    addBtn.disabled = Boolean(job) || empty;
    cancelBtn.hidden = !job;
    quote.textContent = empty ? 'This clip has no text yet.' : text();
    where.textContent = `The audio starts with this text clip (${clock(c.start)}).`;
  };

  const current = (task) => !disposed && job === task && !task.controller.signal.aborted && context() === task.source;
  function finish(task) {
    if (job !== task) return;
    const hadFocus = document.activeElement === cancelBtn;
    job = null;
    update();
    if (!disposed) {
      if (hadFocus) (task.trigger.disabled ? fit.el.querySelector('button') : task.trigger)?.focus();
      else restoreFocus(task.focus);
    }
  }
  function stopAudio(expected = audio) {
    if (!expected || audio !== expected) return;
    expected.pause();
    URL.revokeObjectURL(audioUrl);
    audio = audioUrl = null;
    previewBtn.replaceChildren(icon('play', 16), 'Preview');
    update();
  }
  function cancelJob(message = '') {
    if (!job) return;
    const task = job;
    finish(task);
    task.controller.abort();
    if (task.kind === 'preview') stopAudio();
    status.textContent = message;
  }
  function stopPreview() {
    if (job?.kind === 'preview') cancelJob();
    stopAudio();
  }
  cancelBtn.addEventListener('click', () => cancelJob('Speech cancelled.'));

  async function run(kind) {
    if (disposed || job || !text() || view.found?.track.locked) return;
    const task = {
      controller: new AbortController(), source: context(), kind,
      words: text(), voice, start: view.clip.start, fit: fitText,
      focus: document.activeElement,
      trigger: kind === 'preview' ? previewBtn : addBtn,
    };
    job = task;
    update();
    status.replaceChildren(h('span.spinner'), 'Creating speech...');
    const { signal } = task.controller;
    try {
      const blob = await synthesize(task.words, task.voice, { signal });
      if (!current(task)) return;
      if (kind === 'preview') {
        status.replaceChildren();
        audioUrl = URL.createObjectURL(blob);
        const playing = new Audio(audioUrl);
        audio = playing;
        playing.addEventListener('ended', () => stopAudio(playing), { once: true });
        previewBtn.replaceChildren(icon('stop', 16), 'Stop');
        update();
        await playing.play().catch(() => stopAudio(playing));
      } else {
        status.replaceChildren(h('span.spinner'), 'Adding to timeline...');
        const made = await addSpeechToTimeline(ctx, blob, task.words, { start: task.start, signal, select: false });
        if (!current(task)) return;
        if (!made) {
          status.textContent = '';
          return;
        }
        if (task.fit && made.duration) {
          store.update('Fit text to speech', (p) => {
            const found = findClip(p, view.id), c = found?.clip;
            if (!c || found.track.locked || c.duration === made.duration) return false;
            c.duration = made.duration;
            for (const k of ['animIn', 'animOut']) if (c[k]) c[k].duration = Math.min(c[k].duration, Math.floor(c.duration / 2));
          });
        }
        status.textContent = 'Speech added as an audio clip.';
        announce('Speech added as an audio clip');
      }
    } catch (err) {
      if (current(task) && err?.name !== 'AbortError') {
        status.replaceChildren();
        toast(err?.message || "Couldn't create the speech.", { kind: 'error' });
      }
    } finally {
      finish(task);
    }
  }
  previewBtn.addEventListener('click', () => audio ? stopPreview() : run('preview'));
  addBtn.addEventListener('click', () => {
    if (disposed || job) return;
    stopAudio();
    run('add');
  });

  const source = context();
  view.bind(() => {
    if (!job && !audio) return;
    if (context() !== source || !view.clip || view.found?.track.locked) {
      cancelJob('Speech cancelled because its text clip changed.');
      stopAudio();
    }
  });
  const offPlay = ctx.player?.on('play', ({ playing }) => { if (playing) stopPreview(); });
  view.scope.onDispose(() => {
    disposed = true;
    cancelJob();
    stopAudio();
    offPlay?.();
  });

  view.bind(update);
  update();
  const el = h('div.text-speech',
    propSection('Text to read', [quote, where]),
    propSection('Voice', [voices.el]),
    propSection('Speech', [fit.el, h('div.tts-actions', previewBtn, addBtn, cancelBtn), status]),
  );
  voices.el.setAttribute('aria-label', 'Voice');
  return el;
}
