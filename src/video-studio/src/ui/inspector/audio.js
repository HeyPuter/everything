/**
 * Audio tab for audio clips and video clips with sound: volume in dB
 * (keyframable), fades, mute, the sound sections (inspector/audio-fx.js)
 * and extract audio. Video clips get Basic and Voice sub-tabs here; audio
 * clips show Voice as a top tab (index.js).
 */
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { US } from '../../lib/time.js';
import { slider, toggle, propSection, note, tabSet } from './common.js';
import { soundSections } from './audio-fx.js';
import { voiceTab } from './voice.js';

/** The slider's bottom stop means silence. */
export const DB_MIN = -60;
export const DB_MAX = 20;

export function gainToDb(v) {
  if (!(v > 0)) return DB_MIN;
  return Math.max(DB_MIN, Math.min(DB_MAX, Math.round(20 * Math.log10(v) * 10) / 10));
}

export function dbToGain(db) {
  if (db <= DB_MIN) return 0;
  return Math.min(10, 10 ** (db / 20));
}

export function volumeSlider(view) {
  return slider(view, {
    label: 'Volume',
    min: DB_MIN,
    max: DB_MAX,
    step: 0.1,
    unit: 'dB',
    prop: 'volume',
    get: () => gainToDb(view.valueOf('volume')),
    set: (v, final) => view.animate('volume', dbToGain(v), { label: 'Volume', final }),
  });
}

function fadeSlider(view, which) {
  const key = which === 'in' ? 'fadeIn' : 'fadeOut';
  const field = slider(view, {
    label: which === 'in' ? 'Fade in' : 'Fade out',
    min: 0,
    max: 10,
    step: 0.1,
    unit: 's',
    get: (c) => Math.round((c[key] / US) * 10) / 10,
    set: (v, final) => view.edit(which === 'in' ? 'Fade in' : 'Fade out', (c) => {
      const other = which === 'in' ? c.fadeOut : c.fadeIn;
      c[key] = Math.max(0, Math.min(Math.round(v * US), c.duration - other));
    }, { key, final }),
  });
  // Fades can't run longer than the clip. The slider covers up to 10 s; the
  // number box takes up to the clip's length.
  const fit = () => {
    const c = view.clip;
    if (!c) return;
    const len = Math.max(0.1, Math.floor((c.duration / US) * 10) / 10);
    field.input.max = String(Math.min(10, len));
    field.setLimits(0, len);
  };
  fit();
  view.bind(fit);
  return field;
}

const SUBS = [
  { id: 'basic', label: 'Basic', make: basicAudioTab },
  { id: 'voice', label: 'Voice', make: voiceTab },
];

export function audioTab(view, state = {}) {
  if (view.clip.type !== 'video') return basicAudioTab(view, state);
  const subs = tabSet({
    label: 'Audio settings',
    className: 'subtabs',
    items: SUBS,
    value: state.audioSub || 'basic',
    onChange: (id) => {
      state.audioSub = id;
      show(id);
    },
  });
  const show = (id) => {
    view.resetScope();
    subs.panel.replaceChildren(SUBS.find((s) => s.id === id).make(view, state));
  };
  show(subs.current);
  return h('div.audio-tab', subs.list, subs.panel);
}

export function basicAudioTab(view, state = {}) {
  const c = view.clip;
  const asset = c.assetId ? view.project.assets[c.assetId] : null;
  const vol = volumeSlider(view);
  const mute = toggle(view, {
    label: 'Mute clip',
    get: (x) => Boolean(x.muted),
    set: (v) => {
      view.edit(v ? 'Mute clip' : 'Unmute clip', (x) => {
        x.muted = v;
      });
      announce(v ? 'Clip muted' : 'Clip unmuted');
    },
  });
  const basics = propSection('Basic', [vol.el, fadeSlider(view, 'in').el, fadeSlider(view, 'out').el, mute.el], {
    onReset: () => view.edit('Reset audio', (x) => {
      x.volume = 1;
      x.fadeIn = 0;
      x.fadeOut = 0;
      delete x.keyframes?.volume;
    }),
  });
  const sound = soundSections(view, state);
  if (c.type !== 'video') return h('div', basics, sound);
  const extract = h('button.btn.small.block', { type: 'button' }, icon('detachAudio', 14), 'Detach audio');
  extract.addEventListener('click', () => view.actions.detachAudio());
  const detachedNote = note('The sound plays from its own audio clip. Edit it there.');
  detachedNote.tabIndex = -1;
  const render = () => {
    const x = view.clip;
    if (!x) return;
    const detached = Boolean(x.audioDetached);
    const hadFocus = document.activeElement === extract;
    extract.disabled = detached || !asset?.hasAudio;
    detachedNote.hidden = !detached;
    // A button disabled under the keyboard would drop focus to the page.
    if (hadFocus && extract.disabled) detachedNote.focus();
  };
  render();
  view.bind(render);
  return h('div', detachedNote, basics, sound, propSection('Extract', [h('p.insp-empty', 'Move the sound to its own track so you can edit it separately.'), extract]));
}
