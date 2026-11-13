/**
 * Avatars tab: pick an original presenter, write or paste a script, choose
 * a voice, the framing, background and position, and add a talking avatar
 * clip with its voice. The voice comes from text to speech (Puter AI, so
 * signed-out users see the sign-in prompt) or from an audio clip already on
 * the timeline, which works on the device alone.
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { segmented } from '../controls.js';
import { toast } from '../dialog.js';
import { prefs, setPref } from '../prefs.js';
import { TTS_VOICES, aiAvailable, synthesize } from '../../media/tts.js';
import { AVATAR_SCRIPT_MAX, normalizeAvatar, AVATAR_POSITIONS } from '../../model/avatar.js';
import { avatarCharacter } from '../../engine/avatars.js';
import { clock } from '../../lib/time.js';
import { findClip } from '../../model/timeline.js';
import { restoreFocus } from '../inspector/common.js';
import { createAvatar, voiceChoices } from '../avatar-actions.js';
import { characterGrid, framingControl, backgroundControl, positionControl, avatarPreview } from '../avatar-ui.js';
import { tabLayout, emptyState } from './common.js';

function signInHint(ctx) {
  const btn = ctx.account?.onSignIn ? h('button.btn.small.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 14), 'Sign in to Puter') : null;
  return h('div.avatar-signin', emptyState('user', 'Sign in for spoken scripts', 'Text to speech runs on Puter AI, so it needs a Puter account. You can still give an avatar the voice of an audio clip on the timeline.', btn));
}

export function avatarsTab(ctx) {
  const { store } = ctx;
  const saved = prefs().avatar || {};
  const look = normalizeAvatar({ ...saved, seed: 7 });
  let position = AVATAR_POSITIONS.some((p) => p.id === saved.position) ? saved.position : 'full';
  let voice = TTS_VOICES.some((v) => v.id === saved.voice) ? saved.voice : TTS_VOICES[0].id;
  let source = saved.source === 'clip' ? 'clip' : 'script';
  let job = null, disposed = false;
  let audio = null, audioUrl = null, listeningSource = null;
  const context = () => JSON.stringify([store.project.id, store.project.timelineId, ...(store.nest || []).map((f) => f.id)]);
  const save = () => setPref('avatar', { character: look.character, framing: look.framing, background: look.background, bgColor: look.bgColor, position, voice, source });

  const preview = avatarPreview(() => look, { aspect: store.project.settings.width / store.project.settings.height });
  const changed = () => {
    save();
    preview.refresh();
    update();
  };
  const chars = characterGrid({ value: look.character, onPick: (id) => {
    look.character = id;
    changed();
  } });
  const framing = framingControl({ value: look.framing, onChange: (v) => {
    look.framing = v;
    changed();
  } });
  const bg = backgroundControl({ value: look.background, color: look.bgColor, onChange: (v) => {
    look.background = v;
    changed();
  }, onColor: (v) => {
    look.bgColor = v;
    changed();
  } });
  const pos = positionControl({ value: position, onChange: (v) => {
    position = v;
    changed();
  } });

  // Voice: a script read by text to speech, or an audio clip on the timeline.
  const sourceSeg = segmented({
    label: 'Voice from',
    options: [{ value: 'script', label: 'Script' }, { value: 'clip', label: 'Audio clip' }],
    value: source,
    onChange: (v) => {
      source = v;
      stopListening();
      save();
      renderSource();
      update();
    },
  });
  const script = h('textarea#avatar-script.textarea.avatar-script', { maxLength: AVATAR_SCRIPT_MAX, rows: 5, placeholder: 'Type or paste what the presenter says', 'aria-describedby': 'avatar-count' });
  const count = h('span#avatar-count.tts-count', `0 / ${AVATAR_SCRIPT_MAX}`);
  const voices = segmented({
    label: 'Voice',
    className: 'voice-grid',
    options: TTS_VOICES.map((v) => ({ value: v.id, label: v.label })),
    value: voice,
    onChange: (v) => {
      voice = v;
      save();
    },
  });
  const listenBtn = h('button.btn', { type: 'button' }, icon('play', 16), 'Listen');
  const clipSel = h('select#avatar-clip.select');
  const clipHint = h('p.field-hint', 'The avatar starts and ends with this clip and moves its lips to it.');
  const sourceBody = h('div.avatar-source');
  const addBtn = h('button.btn.primary.avatar-add', { type: 'button' }, icon('plus', 16), 'Add avatar');
  const cancelBtn = h('button.btn.avatar-cancel', { type: 'button', hidden: true }, 'Cancel');
  const status = h('p.tts-status', { role: 'status' });
  // Next to the button: why it is off, else where the avatar goes.
  const where = h('p#avatar-add-hint.field-hint');
  addBtn.setAttribute('aria-describedby', 'avatar-add-hint');

  function renderClips() {
    const list = voiceChoices(store.project);
    const keep = clipSel.value;
    clipSel.replaceChildren(...(list.length
      ? list.map((c) => h('option', { value: c.id }, `${c.label} (${clock(c.start)})`))
      : [h('option', { value: '' }, 'No audio clips on the timeline')]));
    if (list.some((c) => c.id === keep)) clipSel.value = keep;
    clipSel.disabled = !list.length;
  }

  function renderSource() {
    if (source === 'clip') {
      renderClips();
      sourceBody.replaceChildren(h('div.field', h('label.field-label', { for: 'avatar-clip' }, 'Audio clip'), clipSel, clipHint));
    } else if (!aiAvailable(ctx)) {
      sourceBody.replaceChildren(signInHint(ctx));
    } else {
      sourceBody.replaceChildren(
        h('div.field', h('label.field-label', { for: 'avatar-script' }, 'Script'), script, count),
        h('div.field', h('span.field-label', { id: 'avatar-voice-label' }, 'Voice'), voices.el, h('div.tts-actions.avatar-listen', listenBtn)),
      );
      voices.el.setAttribute('aria-labelledby', 'avatar-voice-label');
    }
  }

  const ready = () => (source === 'clip' ? Boolean(clipSel.value) : aiAvailable(ctx) && Boolean(script.value.trim()));
  /** Why the avatar cannot be added yet ('' when it can). */
  const blocker = () => {
    if (source === 'clip') return clipSel.value ? '' : 'Add an audio clip to the timeline first, or take the voice from a script.';
    if (!aiAvailable(ctx)) return 'Sign in to Puter to speak a script, or take the voice from an audio clip.';
    return script.value.trim() ? '' : 'Write a script under Voice first.';
  };
  const paintWhere = () => {
    const why = job ? '' : blocker();
    const creating = job?.kind === 'add';
    const fromClip = creating ? Boolean(job.voiceId) : source === 'clip';
    where.textContent = why || (fromClip ? '' : `The avatar and its voice are added at the playhead (${clock(creating ? job.start : store.time)}).`);
  };
  function update() {
    count.textContent = `${script.value.length} / ${AVATAR_SCRIPT_MAX}`;
    addBtn.disabled = Boolean(job) || !ready();
    listenBtn.disabled = !audio && (Boolean(job) || !script.value.trim());
    cancelBtn.hidden = !job;
    const name = avatarCharacter(look.character).label;
    addBtn.replaceChildren(icon('plus', 16), `Add ${name}`);
    paintWhere();
  }
  script.addEventListener('input', update);
  clipSel.addEventListener('change', update);

  const current = (task) => !disposed && job === task && !task.controller.signal.aborted && context() === task.source;
  function finish(task) {
    if (job !== task) return;
    const hadFocus = document.activeElement === cancelBtn;
    job = null;
    update();
    if (!disposed) {
      if (hadFocus) {
        const fallback = source === 'script' ? script : clipSel.disabled ? sourceSeg.el.querySelector('[aria-checked="true"]') : clipSel;
        const target = task.trigger.isConnected && !task.trigger.disabled ? task.trigger : fallback;
        target.focus();
      } else restoreFocus(task.focus);
    }
  }
  function stopAudio(expected = audio) {
    if (!expected || audio !== expected) return;
    expected.pause();
    URL.revokeObjectURL(audioUrl);
    audio = audioUrl = listeningSource = null;
    listenBtn.replaceChildren(icon('play', 16), 'Listen');
    update();
  }
  function cancelJob(message = '') {
    if (!job) return;
    const task = job;
    finish(task);
    task.controller.abort();
    if (task.kind === 'listen') stopAudio();
    status.textContent = message;
  }
  function stopListening() {
    if (job?.kind === 'listen') cancelJob();
    stopAudio();
  }
  cancelBtn.addEventListener('click', () => cancelJob('Cancelled.'));
  async function run(kind) {
    if (disposed || job || (kind === 'add' ? !ready() : !script.value.trim())) return;
    const task = {
      controller: new AbortController(), kind, source: context(), focus: document.activeElement,
      trigger: kind === 'add' ? addBtn : listenBtn,
      voiceId: kind === 'add' && source === 'clip' ? clipSel.value : null,
      start: store.time,
    };
    task.voiceAsset = task.voiceId ? findClip(store.project, task.voiceId)?.clip.assetId : null;
    job = task;
    update();
    const { signal } = task.controller;
    try {
      if (kind === 'listen') {
        status.replaceChildren(h('span.spinner'), 'Creating the voice...');
        const blob = await (ctx.avatarServices?.synthesize || synthesize)(script.value, voice, { signal });
        if (!current(task)) return;
        status.replaceChildren();
        audioUrl = URL.createObjectURL(blob);
        const playing = new Audio(audioUrl);
        audio = playing;
        listeningSource = task.source;
        playing.addEventListener('ended', () => stopAudio(playing), { once: true });
        listenBtn.replaceChildren(icon('stop', 16), 'Stop');
        update();
        await playing.play().catch(() => stopAudio(playing));
      } else {
        const opts = { ...look, seed: undefined, position, start: task.start, ...(source === 'clip' ? { voiceClipId: clipSel.value } : { script: script.value, voice }) };
        const clip = await createAvatar(ctx, opts, { signal, onStep: (label) => {
          if (current(task)) status.replaceChildren(h('span.spinner'), label);
        } });
        if (!current(task)) return;
        status.textContent = clip ? 'Avatar added. Edit it any time in Details.' : '';
        if (clip) announce('Avatar added');
      }
    } catch (err) {
      if (current(task)) {
        status.replaceChildren();
        if (err?.name !== 'AbortError') toast(err?.message || (kind === 'listen' ? "Couldn't create the voice." : "Couldn't add the avatar."), { kind: 'error' });
      }
    } finally {
      finish(task);
    }
  }
  listenBtn.addEventListener('click', () => audio ? stopListening() : run('listen'));
  addBtn.addEventListener('click', () => {
    if (disposed || job || addBtn.disabled) return;
    stopAudio();
    run('add');
  });

  renderSource();
  update();
  const body = h('div.avatar-panel',
    h('div.avatar-stage', preview.el),
    h('section.avatar-block', h('h3.asset-group-title', 'Presenter'), chars.el),
    h('section.avatar-block', h('h3.asset-group-title', 'Voice'), sourceSeg.el, sourceBody),
    h('section.avatar-block', h('h3.asset-group-title', 'Look'),
      h('div.field', h('span.field-label', 'Framing'), framing.el),
      h('div.field', h('span.field-label', 'Background'), bg.el),
      h('div.field', h('span.field-label', 'Position'), pos.el)),
    h('div.avatar-actions', addBtn, cancelBtn, where, status),
  );
  const layout = tabLayout({ title: 'Avatars', id: 'avatars', search: false, render: () => body });
  layout.el.classList.add('avatars-tab');
  const offs = [store.on('change', () => {
    if (source === 'clip') renderClips();
    if (job || audio) {
      const now = context();
      if (job && job.source !== now) cancelJob('Cancelled because the open timeline changed.');
      if (job?.voiceId && findClip(store.project, job.voiceId)?.clip.assetId !== job.voiceAsset) cancelJob('Cancelled because the source audio changed.');
      if (audio && listeningSource !== now) stopAudio();
    }
    update();
  }), store.on('time', paintWhere)];
  const offPlay = ctx.player?.on?.('play', ({ playing }) => { if (playing) stopListening(); });
  return {
    el: layout.el,
    hidden: stopListening,
    shown() {
      renderSource();
      update();
      preview.refresh();
    },
    dispose() {
      disposed = true;
      cancelJob();
      offPlay?.();
      offs.forEach((f) => f());
      stopListening();
      preview.stop();
      layout.dispose();
    },
  };
}
