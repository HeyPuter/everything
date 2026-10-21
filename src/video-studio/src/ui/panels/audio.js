/**
 * Audio tab: original music beds and sound effects (both synthesized on
 * this device, with favorites), the project's audio files, audio from
 * videos, voiceover recording and text to speech.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { clock, US } from '../../lib/time.js';
import { tabLayout, tileGrid, tile, emptyState, emptyFavorites, favoriteButton } from './common.js';
import { favoriteIds } from './favorites.js';
import { SFX, SFX_BY_ID, SFX_GROUPS, renderSfx } from '../../media/sfx.js';
import { MUSIC, MUSIC_BY_ID, musicDuration } from '../../media/music.js';
import { musicSamples, musicBlob } from '../../media/music-render.js';
import { encodeWav } from '../../media/wav.js';
import { TTS_VOICES, TTS_MAX, aiAvailable, synthesize, addSpeechToTimeline } from '../../media/tts.js';
import { segmented } from '../controls.js';
import { toast } from '../dialog.js';
import { prefs, setPref } from '../prefs.js';
import { openVoiceoverDialog } from '../voiceover-dialog.js';
import '../../styles/audio.css';

const SFX_RATE = 44100;
const FAV_TAB = 'audio';
const MOODS = [...new Set(MUSIC.map((m) => m.mood))];

/* Rendered sound effects, shared by every editor in the page. */
const samples = new Map(); // id -> Float32Array
const blobs = new Map(); // id -> Blob (WAV)

function sfxSamples(id) {
  let s = samples.get(id);
  if (!s) {
    s = renderSfx(id, SFX_RATE);
    samples.set(id, s);
  }
  return s;
}

function sfxBlob(id) {
  let b = blobs.get(id);
  if (!b) {
    b = encodeWav([sfxSamples(id)], SFX_RATE);
    blobs.set(id, b);
  }
  return b;
}

/* One preview at a time through a shared AudioContext. */
const preview = {
  ctx: null,
  node: null,
  id: null,
  onEnd: null,
  startedAt: 0,
  duration: 0,
  /** Play mono or stereo channels; key identifies what is playing. */
  playChannels(key, channels, rate, onEnd) {
    this.stop();
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    this.ctx ||= new AC();
    this.ctx.resume?.();
    const buf = this.ctx.createBuffer(channels.length, channels[0].length, rate);
    channels.forEach((c, i) => buf.copyToChannel(c, i));
    const node = this.ctx.createBufferSource();
    node.buffer = buf;
    node.connect(this.ctx.destination);
    node.onended = () => {
      if (this.node !== node) return;
      this.node = null;
      this.id = null;
      const cb = this.onEnd;
      this.onEnd = null;
      cb?.();
    };
    node.start();
    this.node = node;
    this.id = key;
    this.onEnd = onEnd;
    this.startedAt = this.ctx.currentTime;
    this.duration = buf.duration;
    return true;
  },
  play(id, onEnd) {
    return this.playChannels(id, [sfxSamples(id)], SFX_RATE, onEnd);
  },
  /** 0..1 through the current preview. */
  progress() {
    if (!this.node || !this.ctx || !this.duration) return 0;
    return Math.min(1, (this.ctx.currentTime - this.startedAt) / this.duration);
  },
  stop() {
    const node = this.node;
    if (!node) return;
    this.node = null;
    this.id = null;
    try {
      node.stop();
    } catch {
      /* already stopped */
    }
    const cb = this.onEnd;
    this.onEnd = null;
    cb?.();
  },
};

/** Tiny static waveform of a rendered effect for its row. */
function drawWave(canvas, data) {
  const g = canvas.getContext('2d');
  if (!g) return;
  const w = canvas.width;
  const hgt = canvas.height;
  g.clearRect(0, 0, w, hgt);
  g.fillStyle = getComputedStyle(canvas).color || '#888';
  const step = data.length / w;
  for (let x = 0; x < w; x++) {
    let peak = 0;
    for (let i = Math.floor(x * step), e = Math.floor((x + 1) * step); i < e; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
    const bh = Math.max(1, peak * hgt);
    g.fillRect(x, (hgt - bh) / 2, 1, bh);
  }
}

const idle = (fn) => (globalThis.requestIdleCallback ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 16));

/** Import a generated sound once per project (matched by name and size), then add it at the playhead. */
async function addGenerated(ctx, name, blob, origin) {
  const { store, actions } = ctx;
  let asset = Object.values(store.project.assets).find((a) => a.kind === 'audio' && a.name === name && a.size === blob.size);
  if (!asset) [asset] = await actions.importFiles([new File([blob], name, { type: 'audio/wav' })], { origin });
  if (asset) actions.addAsset(asset);
  return asset;
}

function sfxPanel(ctx) {
  const rows = new Map(); // id -> { el, wave, drawn }
  const pending = new Set();

  async function add(s, btn) {
    if (pending.has(s.id)) return;
    pending.add(s.id);
    btn.disabled = true;
    try {
      await addGenerated(ctx, `${s.label}.wav`, sfxBlob(s.id), 'sfx');
    } catch (err) {
      console.error(err);
      toast(`Couldn't add ${s.label}.`, { kind: 'error' });
    } finally {
      pending.delete(s.id);
      btn.disabled = false;
    }
  }

  function row(s) {
    const playBtn = h('button.icon-btn.sfx-play', { type: 'button', 'aria-label': `Preview ${s.label}`, 'aria-pressed': 'false' }, icon('play', 16));
    const setPlaying = (on) => {
      playBtn.setAttribute('aria-pressed', String(on));
      playBtn.setAttribute('aria-label', on ? `Stop ${s.label} preview` : `Preview ${s.label}`);
      playBtn.replaceChildren(icon(on ? 'stop' : 'play', 16));
      el.classList.toggle('playing', on);
    };
    playBtn.addEventListener('click', () => {
      if (preview.id === s.id) {
        preview.stop();
        return;
      }
      if (preview.play(s.id, () => setPlaying(false))) setPlaying(true);
    });
    const wave = h('canvas.sfx-wave', { width: 120, height: 24, 'aria-hidden': 'true' });
    const addBtn = h('button.icon-btn.sfx-add', { type: 'button', 'aria-label': `Add ${s.label} to timeline`, 'data-tip': 'Add to timeline' }, icon('plus', 16));
    addBtn.addEventListener('click', () => add(s, addBtn));
    const el = h('div.sfx-row', { role: 'listitem' },
      playBtn,
      h('div.sfx-info', h('span.sfx-name', s.label), h('span.sfx-dur', `${s.dur.toFixed(1)}s`)),
      wave,
      favoriteButton(FAV_TAB, `sfx:${s.id}`, s.label, { className: 'row-fav' }),
      addBtn,
    );
    el.addEventListener('dblclick', (e) => {
      if (!e.target.closest('button')) add(s, addBtn);
    });
    rows.set(s.id, { el, wave, drawn: false });
    return el;
  }

  // Waveforms render in idle time so opening the tab stays instant.
  function drawPending() {
    const next = [...rows.entries()].find(([, r]) => !r.drawn && r.el.isConnected);
    if (!next) return;
    next[1].drawn = true;
    drawWave(next[1].wave, sfxSamples(next[0]));
    idle(drawPending);
  }

  return {
    /** Rows for these effects, in groups unless flat. */
    render(list, { flat = false, hint = true } = {}) {
      if (!list.length) return emptyState('search', 'No sound effects found', 'Try another word.');
      // Rows are rebuilt each time so their favorite stars are current.
      const groups = flat
        ? [h('div.sfx-list', { role: 'list', 'aria-label': 'Sound effects' }, list.map(row))]
        : SFX_GROUPS.map((g) => {
          const items = list.filter((s) => s.group === g.id);
          if (!items.length) return null;
          return h('section.sfx-group', { 'aria-labelledby': `sfx-g-${g.id}` },
            h('h3.sfx-group-title', { id: `sfx-g-${g.id}` }, g.label),
            h('div.sfx-list', { role: 'list', 'aria-label': g.label }, items.map(row)),
          );
        });
      idle(drawPending);
      return h('div.sfx-panel', hint ? h('p.asset-hint', 'Original sounds made on your device. Preview, then add one at the playhead.') : null, groups);
    },
  };
}

/** Music beds: original loops rendered on demand, previewed and added as WAV. */
function musicPanel(ctx) {
  const pending = new Set();
  let raf = 0;
  let current = null; // { id, bar }

  const tickProgress = () => {
    if (!current || preview.id !== `music:${current.id}`) {
      raf = 0;
      return;
    }
    current.bar.style.setProperty('--p', String(preview.progress()));
    raf = requestAnimationFrame(tickProgress);
  };

  async function add(m, btn) {
    if (pending.has(m.id)) return;
    pending.add(m.id);
    btn.disabled = true;
    btn.replaceChildren(h('span.spinner.small'));
    try {
      const blob = await musicBlob(m.id);
      await addGenerated(ctx, `${m.title} (${m.mood}).wav`, blob, 'music');
    } catch (err) {
      console.error(err);
      toast(`Couldn't add ${m.title}.`, { kind: 'error' });
    } finally {
      pending.delete(m.id);
      btn.disabled = false;
      btn.replaceChildren(icon('plus', 16));
    }
  }

  function row(m) {
    const key = `music:${m.id}`;
    const playBtn = h('button.icon-btn.sfx-play', { type: 'button', 'aria-label': `Preview ${m.title}`, 'aria-pressed': 'false' }, icon('play', 16));
    const bar = h('span.music-progress', { 'aria-hidden': 'true' });
    const setPlaying = (on) => {
      playBtn.setAttribute('aria-pressed', String(on));
      playBtn.setAttribute('aria-label', on ? `Stop ${m.title} preview` : `Preview ${m.title}`);
      playBtn.replaceChildren(icon(on ? 'stop' : 'play', 16));
      el.classList.toggle('playing', on);
      if (!on) bar.style.setProperty('--p', '0');
    };
    let loading = false;
    playBtn.addEventListener('click', async () => {
      if (preview.id === key) {
        preview.stop();
        return;
      }
      if (loading) return;
      loading = true;
      playBtn.replaceChildren(h('span.spinner.small'));
      playBtn.setAttribute('aria-label', `Preparing ${m.title}`);
      try {
        const s = await musicSamples(m.id);
        if (!el.isConnected) return;
        if (preview.playChannels(key, [s.left, s.right], s.sampleRate, () => setPlaying(false))) {
          setPlaying(true);
          current = { id: m.id, bar };
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(tickProgress);
        } else setPlaying(false);
      } catch (err) {
        setPlaying(false);
        toast(err?.message || `Couldn't play ${m.title}.`, { kind: 'error' });
      } finally {
        loading = false;
      }
    });
    const addBtn = h('button.icon-btn.sfx-add', { type: 'button', 'aria-label': `Add ${m.title} to timeline`, 'data-tip': 'Add to timeline' }, icon('plus', 16));
    addBtn.addEventListener('click', () => add(m, addBtn));
    const el = h('div.sfx-row.music-row', { role: 'listitem' },
      playBtn,
      h('div.sfx-info',
        h('span.sfx-name', m.title),
        h('span.sfx-dur', `${m.mood} · ${clock(Math.round(musicDuration(m) * US))} · ${m.bpm} BPM`),
        bar,
      ),
      favoriteButton(FAV_TAB, key, m.title, { className: 'row-fav' }),
      addBtn,
    );
    if (preview.id === key) {
      el.classList.add('playing');
      playBtn.replaceChildren(icon('stop', 16));
      playBtn.setAttribute('aria-pressed', 'true');
      preview.onEnd = () => setPlaying(false);
      current = { id: m.id, bar };
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tickProgress);
    }
    el.addEventListener('dblclick', (e) => {
      if (!e.target.closest('button')) add(m, addBtn);
    });
    return el;
  }

  return {
    render(list, { hint = true } = {}) {
      if (!list.length) return emptyState('search', 'No music found', 'Try another word or mood.');
      return h('div.sfx-panel.music-panel',
        hint ? h('p.asset-hint', 'Original loops composed on your device. Each one repeats seamlessly, so you can extend the clip.') : null,
        h('div.sfx-list', { role: 'list', 'aria-label': 'Music' }, list.map(row)),
      );
    },
    dispose() {
      cancelAnimationFrame(raf);
    },
  };
}

function voiceoverPanel(ctx) {
  const btn = h('button.btn.primary', { type: 'button' }, icon('mic', 16), 'Record');
  btn.addEventListener('click', () => ctx.openVoiceover());
  return h('div.audio-feature', emptyState('mic', 'Record a voiceover', 'Talk over your video while it plays. The recording is added to an audio track at the playhead.', btn));
}

function signInHint(ctx, what) {
  const btn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button', onclick: () => ctx.account.onSignIn() }, icon('cloud', 16), 'Sign in to Puter') : null;
  return emptyState('user', `Sign in to use ${what}`, `${what[0].toUpperCase()}${what.slice(1)} runs on Puter AI, so it needs a Puter account.`, btn);
}

/**
 * Text to speech form. Also reads a selected text clip aloud and puts the
 * speech where that clip starts.
 */
function ttsPanel(ctx) {
  const { store } = ctx;
  if (!aiAvailable(ctx)) return { el: signInHint(ctx, 'text to speech') };
  let voice = TTS_VOICES.some((v) => v.id === prefs().ttsVoice) ? prefs().ttsVoice : TTS_VOICES[0].id;
  let fromClip = null; // { id, start } when the text came from a clip
  let busy = false;
  let audio = null;

  const text = h('textarea#tts-text.textarea.tts-text', { maxLength: TTS_MAX, rows: 5, placeholder: 'Type or paste what should be read aloud', 'aria-describedby': 'tts-count' });
  const count = h('span#tts-count.tts-count', `0 / ${TTS_MAX}`);
  const useClip = h('button.btn.small.ghost', { type: 'button' }, icon('text', 14), 'Use selected text');
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
  const addBtn = h('button.btn.primary', { type: 'button' }, icon('plus', 16), 'Add to timeline');
  const status = h('p.tts-status', { role: 'status' });
  const where = h('p.field-hint.tts-where');

  const update = () => {
    count.textContent = `${text.value.length} / ${TTS_MAX}`;
    const empty = !text.value.trim();
    previewBtn.disabled = busy || empty;
    addBtn.disabled = busy || empty;
    const sel = store.selected?.clip;
    useClip.disabled = !(sel && sel.type === 'text');
    where.textContent = fromClip ? `Speech will start where the selected text starts (${clock(fromClip.start)}).` : 'Speech is added at the playhead.';
  };
  text.addEventListener('input', update);
  useClip.addEventListener('click', () => {
    const sel = store.selected?.clip;
    if (!sel || sel.type !== 'text') return;
    text.value = sel.text.slice(0, TTS_MAX);
    fromClip = { id: sel.id, start: sel.start };
    update();
    text.focus();
  });

  async function run(label, fn) {
    busy = true;
    update();
    status.replaceChildren(h('span.spinner'), label);
    try {
      await fn();
    } catch (err) {
      status.replaceChildren();
      toast(err?.message || "Couldn't create the speech.", { kind: 'error' });
      busy = false;
      update();
      return;
    }
    busy = false;
    update();
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
      const blob = await synthesize(text.value, voice);
      status.replaceChildren();
      audio = new Audio(URL.createObjectURL(blob));
      audio.addEventListener('ended', stopPreview);
      previewBtn.replaceChildren(icon('stop', 16), 'Stop');
      await audio.play().catch(() => stopPreview());
    });
  });

  addBtn.addEventListener('click', () => {
    stopPreview();
    run('Creating speech...', async () => {
      const blob = await synthesize(text.value, voice);
      status.replaceChildren(h('span.spinner'), 'Adding to timeline...');
      const start = fromClip && store.project && findStart(store.project, fromClip.id);
      const clip = await addSpeechToTimeline(ctx, blob, text.value, { start: start ?? undefined });
      status.textContent = clip ? 'Speech added to the timeline.' : '';
    });
  });

  const offSel = store.on('select', update);
  update();
  const el = h('div.tts-panel',
    h('div.field',
      h('div.tts-label-row', h('label.field-label', { for: 'tts-text' }, 'Text'), useClip),
      text,
      count,
    ),
    h('div.field', h('span.field-label', { id: 'tts-voice-label' }, 'Voice'), voices.el),
    h('div.tts-actions', previewBtn, addBtn),
    where,
    status,
  );
  voices.el.setAttribute('aria-labelledby', 'tts-voice-label');
  return { el, stop: stopPreview, dispose: () => { offSel(); stopPreview(); } };
}

function findStart(project, clipId) {
  for (const t of project.tracks) for (const c of t.clips) if (c.id === clipId) return c.start;
  return null;
}

export function audioTab(ctx) {
  const { store, actions } = ctx;
  // The timeline toolbar's microphone button opens the same dialog.
  ctx.openVoiceover ||= () => openVoiceoverDialog(ctx);
  const sfx = sfxPanel(ctx);
  const music = musicPanel(ctx);
  let tts = null;
  let vo = null;
  const moodPref = () => (MOODS.includes(prefs().musicMood) ? prefs().musicMood : null);
  const matches = (text, q) => !q || text.toLowerCase().includes(q);

  function renderFavorites(q) {
    const ids = favoriteIds(FAV_TAB);
    const tracks = ids.filter((k) => k.startsWith('music:')).map((k) => MUSIC_BY_ID.get(k.slice(6))).filter((m) => m && matches(`${m.title} ${m.mood}`, q));
    const sounds = ids.filter((k) => k.startsWith('sfx:')).map((k) => SFX_BY_ID.get(k.slice(4))).filter((s) => s && matches(s.label, q));
    if (!tracks.length && !sounds.length) return q ? emptyState('search', 'No favorites match', 'Try another word.') : emptyFavorites('music or a sound effect');
    return h('div',
      tracks.length ? h('section.sfx-group', h('h3.sfx-group-title', 'Music'), music.render(tracks, { hint: false })) : null,
      sounds.length ? h('section.sfx-group', h('h3.sfx-group-title', 'Sound effects'), sfx.render(sounds, { flat: true, hint: false })) : null,
    );
  }

  let layout = null;
  layout = tabLayout({
    title: 'Audio',
    favorites: FAV_TAB,
    categories: [
      { id: 'music', label: 'Music' },
      {
        id: 'sfx-group',
        label: 'Sound effects',
        children: [{ id: 'sfx', label: 'All sounds' }, ...SFX_GROUPS.map((g) => ({ id: `sfx:${g.id}`, label: g.label }))],
      },
      {
        id: 'yours-group',
        label: 'Your audio',
        children: [{ id: 'yours', label: 'Imported' }, { id: 'extracted', label: 'From videos' }],
      },
      {
        id: 'create-group',
        label: 'Create',
        children: [{ id: 'voiceover', label: 'Voiceover' }, { id: 'tts', label: 'Text to speech' }],
      },
    ],
    menu: () => {
      const mood = moodPref();
      const set = (v) => {
        setPref('musicMood', v);
        layout.refresh();
      };
      return [
        { heading: 'Mood' },
        { label: 'All moods', checked: !mood, radio: true, onSelect: () => set(null) },
        ...MOODS.map((m) => ({ label: m, checked: mood === m, radio: true, onSelect: () => set(m) })),
      ];
    },
    menuLabel: 'Filter by mood',
    menuActive: () => Boolean(moodPref()),
    render(cat, q) {
      const menuBtn = layout?.el.querySelector('.asset-menu-btn');
      if (menuBtn) menuBtn.hidden = cat !== 'music';
      if (cat === 'favorites') return renderFavorites(q);
      if (cat === 'music') {
        const mood = moodPref();
        return music.render(MUSIC.filter((m) => (!mood || m.mood === mood) && matches(`${m.title} ${m.mood}`, q)));
      }
      if (cat === 'sfx' || cat.startsWith('sfx:')) {
        const group = cat === 'sfx' ? null : cat.slice(4);
        return sfx.render(SFX.filter((s) => (!group || s.group === group) && matches(s.label, q)), { hint: !group });
      }
      if (cat === 'voiceover') return (vo ||= voiceoverPanel(ctx));
      if (cat === 'tts') return (tts ||= ttsPanel(ctx)).el;
      const assets = Object.values(store.project.assets)
        .filter((a) => (cat === 'yours' ? a.kind === 'audio' : a.kind === 'video' && a.hasAudio))
        .filter((a) => !q || a.name.toLowerCase().includes(q));
      if (!assets.length) {
        const btn = h('button.btn', { type: 'button' }, icon('import', 16), 'Import audio');
        btn.addEventListener('click', () => ctx.assets.openImport());
        return emptyState('music', cat === 'yours' ? 'No audio yet' : 'No videos with sound', cat === 'yours' ? 'Import music or sound files to use them here.' : 'Import a video with sound to use its audio separately.', cat === 'yours' ? btn : null);
      }
      return tileGrid(assets.map((a) => tile({
        label: a.name,
        preview: h('span.tile-audio', icon('waveform', 26)),
        badge: clock(a.duration),
        onAdd: () => actions.addAsset({ ...a, kind: 'audio' }),
        drag: { kind: 'asset', assetId: a.id, audioOnly: true },
        addLabel: `Add ${a.name} audio to timeline`,
      })), { label: 'Audio' });
    },
  });
  layout.el.classList.add('wrap-cats');
  const menuBtn = layout.el.querySelector('.asset-menu-btn');
  if (menuBtn) menuBtn.hidden = layout.category !== 'music';
  // Only the asset lists depend on the project; the other categories keep their state.
  const off = store.on('change', () => {
    if (layout.category === 'yours' || layout.category === 'extracted') layout.refresh();
  });
  // Previews don't play on over the timeline or from a tab that is gone.
  const stopPreviews = () => {
    preview.stop();
    tts?.stop?.();
  };
  const offPlay = ctx.player?.on?.('play', (e) => e?.playing && stopPreviews());
  return {
    el: layout.el,
    hidden: stopPreviews,
    dispose() {
      off();
      offPlay?.();
      preview.stop();
      music.dispose();
      layout.dispose();
      tts?.dispose?.();
    },
  };
}
