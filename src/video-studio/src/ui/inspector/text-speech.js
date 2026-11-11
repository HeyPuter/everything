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
  let busy = false;
  let audio = null;

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
  const status = h('p.tts-status', { role: 'status' });
  const where = h('p.field-hint.text-hint');
  const quote = h('blockquote.speech-quote');
  const fit = toggle(view, { label: 'Fit text to speech', hint: 'Make the text clip as long as the speech', get: () => fitText, set: (v) => (fitText = v) });

  const text = () => (view.clip?.text || '').trim().slice(0, TTS_MAX);
  const update = () => {
    const c = view.clip;
    if (!c) return;
    const empty = !text();
    previewBtn.disabled = busy || empty;
    addBtn.disabled = busy || empty;
    quote.textContent = empty ? 'This clip has no text yet.' : text();
    where.textContent = `The audio starts with this text clip (${clock(c.start)}).`;
  };

  async function run(label, fn) {
    const had = document.activeElement;
    busy = true;
    update();
    status.replaceChildren(h('span.spinner'), label);
    try {
      await fn();
    } catch (err) {
      status.replaceChildren();
      toast(err?.message || "Couldn't create the speech.", { kind: 'error' });
    }
    busy = false;
    update();
    // Adding speech selects the new clip and then the text again, which rebuilds this panel.
    const name = had?.textContent;
    restoreFocus(had, () => [...document.querySelectorAll('.text-speech .tts-actions button')].find((b) => b.textContent === name));
  }

  const stopPreview = () => {
    if (!audio) return;
    audio.pause();
    URL.revokeObjectURL(audio.src);
    audio = null;
    previewBtn.replaceChildren(icon('play', 16), 'Preview');
  };

  previewBtn.addEventListener('click', () => {
    if (audio) {
      stopPreview();
      return;
    }
    run('Creating speech...', async () => {
      const blob = await synthesize(text(), voice);
      status.replaceChildren();
      audio = new Audio(URL.createObjectURL(blob));
      audio.addEventListener('ended', stopPreview);
      // Stop when the panel goes away (another clip or tab).
      audio.addEventListener('timeupdate', () => !el.isConnected && stopPreview());
      previewBtn.replaceChildren(icon('stop', 16), 'Stop');
      await audio.play().catch(() => stopPreview());
    });
  });

  addBtn.addEventListener('click', () => {
    stopPreview();
    const id = view.id;
    run('Creating speech...', async () => {
      const words = text();
      const blob = await synthesize(words, voice);
      status.replaceChildren(h('span.spinner'), 'Adding to timeline...');
      const start = findClip(store.project, id)?.clip.start ?? store.time;
      const made = await addSpeechToTimeline(ctx, blob, words, { start });
      if (!made) {
        status.textContent = '';
        return;
      }
      if (fitText && made.duration) {
        store.update('Fit text to speech', (p) => {
          const c = findClip(p, id)?.clip;
          if (!c || c.duration === made.duration) return false;
          c.duration = made.duration;
          for (const k of ['animIn', 'animOut']) if (c[k]) c[k].duration = Math.min(c[k].duration, Math.floor(c.duration / 2));
        });
      }
      // Stay on the text clip so the next edit continues here.
      store.select(id);
      status.textContent = 'Speech added as an audio clip.';
      announce('Speech added as an audio clip');
    });
  });

  view.bind(update);
  update();
  const el = h('div.text-speech',
    propSection('Text to read', [quote, where]),
    propSection('Voice', [voices.el]),
    propSection('Speech', [fit.el, h('div.tts-actions', previewBtn, addBtn), status]),
  );
  voices.el.setAttribute('aria-label', 'Voice');
  return el;
}
