/**
 * Avatar tab for avatar clips: change the presenter, framing, background
 * and position, speak a new script (or another voice) through text to
 * speech, or lip-sync to another audio clip on the timeline.
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { clock } from '../../lib/time.js';
import { segmented } from '../controls.js';
import { toast } from '../dialog.js';
import { TTS_VOICES, aiAvailable } from '../../media/tts.js';
import { AVATAR_POSITIONS, AVATAR_SCRIPT_MAX, positionOf } from '../../model/avatar.js';
import { avatarCharacter } from '../../engine/avatars.js';
import { revoiceAvatar, syncAvatarTo, relipAvatar, voiceChoices } from '../avatar-actions.js';
import { characterGrid, framingControl, backgroundControl, positionControl } from '../avatar-ui.js';
import { propSection, row, note } from './common.js';
import { transformSection, blendSection } from './transform.js';

function lookSections(view) {
  const a = () => view.clip?.avatar;
  const chars = characterGrid({ value: a()?.character, onPick: (id) => view.edit('Change presenter', (c) => {
    // A default name follows the presenter.
    if (c.name === `${avatarCharacter(c.avatar.character).label} avatar`) c.name = `${avatarCharacter(id).label} avatar`;
    c.avatar.character = id;
  }) });
  const framing = framingControl({ value: a()?.framing, onChange: (v) => view.edit('Avatar framing', (c) => {
    c.avatar.framing = v;
  }) });
  const bg = backgroundControl({
    value: a()?.background,
    color: a()?.bgColor,
    onChange: (v) => view.edit('Avatar background', (c) => {
      c.avatar.background = v;
    }),
    onColor: (v, final) => view.edit('Avatar background color', (c) => {
      c.avatar.bgColor = v;
    }, { key: 'avatar-bg', final }),
  });
  const pos = positionControl({ value: positionOf(view.clip?.transform), onChange: (id) => view.edit('Avatar position', (c) => {
    const p = AVATAR_POSITIONS.find((x) => x.id === id);
    Object.assign(c.transform, p.transform);
    // Presets replace position and scale keyframes.
    for (const k of ['x', 'y', 'scale']) delete c.keyframes[k];
  }) });
  view.bind(() => {
    const c = view.clip;
    if (!c) return;
    chars.set(c.avatar.character);
    framing.set(c.avatar.framing);
    bg.set(c.avatar.background, c.avatar.bgColor);
    pos.set(positionOf(c.transform));
  });
  return [
    propSection('Presenter', [chars.el]),
    propSection('Look', [row('Framing', framing.el), h('div.field', h('span.field-label', 'Background'), bg.el), row('Position', pos.el)]),
  ];
}

function voiceSection(view) {
  const { ctx, store } = view;
  const status = h('p.tts-status', { role: 'status' });
  let busy = false;
  const run = async (fn) => {
    if (busy) return;
    busy = true;
    sync();
    try {
      await fn((label) => status.replaceChildren(h('span.spinner'), label));
      status.textContent = '';
    } catch (err) {
      status.replaceChildren();
      toast(err?.message || "Couldn't change the voice.", { kind: 'error' });
    }
    busy = false;
    sync();
  };

  const script = h('textarea.textarea.insp-textarea.avatar-script', { maxLength: AVATAR_SCRIPT_MAX, rows: 4, 'aria-label': 'Script', placeholder: 'What the presenter says' });
  script.value = view.clip?.avatar.script || '';
  // The clip's script as last shown: a changed one (undo, a new voice) replaces the box, typing does not.
  let shown = script.value;
  let voice = TTS_VOICES.some((v) => v.id === view.clip?.avatar.voice) ? view.clip.avatar.voice : TTS_VOICES[0].id;
  const voices = segmented({ label: 'Voice', className: 'voice-grid', options: TTS_VOICES.map((v) => ({ value: v.id, label: v.label })), value: voice, onChange: (v) => {
    voice = v;
    sync();
  } });
  const speakBtn = h('button.btn.primary', { type: 'button' }, icon('speech', 16), 'Speak again');
  speakBtn.addEventListener('click', () => run((onStep) => revoiceAvatar(ctx, view.id, { script: script.value, voice }, { onStep }).then((ok) => ok && announce('New voice added'))));
  script.addEventListener('input', () => sync());

  const clipSel = h('select.select', { 'aria-label': 'Audio clip for the voice' });
  const useBtn = h('button.btn', { type: 'button' }, icon('waveform', 16), 'Use clip');
  useBtn.addEventListener('click', () => run((onStep) => syncAvatarTo(ctx, view.id, clipSel.value, { onStep }).then((ok) => ok && announce('Lips matched to the clip'))));
  const relipBtn = h('button.btn', { type: 'button' }, icon('refresh', 16), 'Match lips again');
  relipBtn.addEventListener('click', () => run((onStep) => relipAvatar(ctx, view.id, { onStep })));
  const voiceState = h('p.field-hint');

  const tts = aiAvailable(ctx);
  const signIn = ctx.account?.onSignIn ? h('button.btn.small', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 14), 'Sign in to Puter') : null;
  const ttsBlock = tts
    ? [script, h('div.field', h('span.field-label', 'Voice'), voices.el), h('div.avatar-voice-actions', speakBtn)]
    : [note('Speaking a new script uses text to speech on Puter AI. Sign in to use it.', 'user'), signIn];

  let clipsSig = '';
  function sync() {
    const c = view.clip;
    if (!c) return;
    const a = c.avatar;
    if (a.script !== shown) {
      shown = a.script;
      script.value = a.script;
    }
    const list = voiceChoices(store.project);
    const sig = list.map((x) => `${x.id}:${x.label}:${x.start}`).join('|');
    if (sig !== clipsSig) {
      clipsSig = sig;
      const keep = clipSel.value;
      clipSel.replaceChildren(...(list.length ? list.map((x) => h('option', { value: x.id }, `${x.label} (${clock(x.start)})`)) : [h('option', { value: '' }, 'No audio clips')]));
      if (list.some((x) => x.id === keep)) clipSel.value = keep;
    }
    const asset = a.voiceAsset && store.project.assets[a.voiceAsset];
    voiceState.textContent = !asset ? 'No voice yet: speak a script or pick an audio clip.' : a.lips ? `Lips follow "${asset.name}".` : `"${asset.name}" has not been matched yet.`;
    relipBtn.hidden = !asset || Boolean(a.lips);
    speakBtn.disabled = busy || !script.value.trim();
    useBtn.disabled = busy || !list.length;
    relipBtn.disabled = busy;
  }
  view.bind(sync);
  sync();
  return propSection('Voice', [voiceState, ...ttsBlock, h('div.field', h('span.field-label', 'Lip-sync to an audio clip'), h('div.avatar-voice-actions', clipSel, useBtn)), relipBtn, status]);
}

export function avatarTab(view) {
  return h('div', ...lookSections(view), voiceSection(view), blendSection(view), transformSection(view));
}
