/**
 * Script to video dialog: write or paste a script (or have Puter AI write
 * one), check the scenes and their picture descriptions, then generate a
 * narrated video with pictures, captions and music. From the home screen it
 * becomes a new project; in the editor it is added at the playhead as one
 * undo step.
 *
 * Every AI call goes through `services` (see puterServices) so tests and
 * browser checks can pass fakes.
 */
import { h, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { clock } from '../lib/time.js';
import { RATIOS, normalizeProject, makeClip } from '../model/project.js';
import { allClips } from '../model/timeline.js';
import { openDialog, toast } from './dialog.js';
import { segmented } from './controls.js';
import { prefs, setPref } from './prefs.js';
import { aiAvailable, TTS_VOICES, synthesize } from '../media/tts.js';
import { IMAGE_STYLES, aspectForSize, generateImage } from '../media/imagegen.js';
import { STT_RATE, mixdown, transcribePiece, errorMessage } from '../media/transcribe.js';
import { MUSIC, MUSIC_BY_ID } from '../media/music.js';
import { drawBackdrop } from '../media/backdrops.js';
import {
  SCRIPT_TONES, SCRIPT_LENGTHS, SCRIPT_RATIOS, SCRIPT_CAPTION_STYLES, SCRIPT_MAX, SCENES_MAX, FALLBACK_BACKDROPS,
  scriptPrompt, cleanScript, chatText, splitScenes, picturesPrompt, parsePictures, projectName, estimateSpeech,
  sceneTimes, generateScenes, scriptProject, insertScenes, problemSummary,
} from '../media/script-video.js';
import '../styles/ai-create.css';

/**
 * Puter AI can be used: signed in to Puter, or (development builds only) a
 * stand-in installed as globalThis.__vsAiStub for browser checks.
 */
export function aiReady(env) {
  return aiAvailable(env) || Boolean(import.meta.env.DEV && globalThis.__vsAiStub);
}

/** Explain that a tool needs a Puter account, with a sign-in button when possible. */
export function needAiDialog(account, what) {
  const close = h('button.btn', { type: 'button' }, 'Close');
  const signIn = account?.onSignIn ? h('button.btn.primary', { type: 'button' }, icon('cloud', 16), 'Sign in to Puter') : null;
  const d = openDialog({
    title: 'Sign in to use AI',
    body: h('p.dialog-text', `${what} uses Puter AI, so it needs a Puter account. Sign in, then try again.`),
    actions: [close, signIn].filter(Boolean),
    className: 'small',
    labelledBody: true,
  });
  close.addEventListener('click', () => d.close());
  signIn?.addEventListener('click', () => {
    d.close();
    account.onSignIn();
  });
  return d;
}

/** A picture to stand in for one that could not be made: a gradient backdrop at the frame size. */
async function backdropFile(index, width, height) {
  const id = FALLBACK_BACKDROPS[index % FALLBACK_BACKDROPS.length];
  const c = document.createElement('canvas');
  c.width = Math.min(width, 1920);
  c.height = Math.max(2, Math.round((c.width * height) / width));
  const g = c.getContext('2d');
  if (!g) throw new Error("This browser can't draw pictures.");
  drawBackdrop(g, id, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error("This browser can't draw pictures.");
  return new File([blob], `Scene ${index + 1} backdrop.png`, { type: 'image/png' });
}

/** Timed words heard in a voice asset (seconds), through Puter speech to text. */
async function heardWords(library, asset, { signal } = {}) {
  const clip = makeClip('audio', { assetId: asset.id, duration: asset.duration });
  const mini = { settings: { width: 16, height: 9, fps: 30 }, assets: { [asset.id]: asset }, tracks: [{ id: 'voice', kind: 'audio', locked: false, hidden: false, muted: false, clips: [clip] }] };
  const mix = await mixdown(mini, library, { scope: 'all', signal });
  return transcribePiece(mix, STT_RATE, { signal });
}

/** The real services: Puter AI for words, speech and pictures; media stored in the library. */
export function puterServices(library) {
  return {
    chat: (p) => puter.ai.chat(p),
    speech: (text, voice) => synthesize(text, voice),
    image: async (prompt, { aspect, style }) => (await generateImage(prompt, { aspect, style })).blob,
    words: (asset, blob, opts) => heardWords(library, asset, opts),
    backdrop: backdropFile,
    music: async (id) => (await import('../media/music-render.js')).musicBlob(id),
    addMedia: (file, origin) => library.importFile(file, { origin }),
  };
}

const DEFAULTS = { tone: 'Friendly', length: 'medium', ratio: '16:9', voice: 'openai-nova', style: 'cinematic', captions: 'clean-caption', music: 'still-water' };

function savedOpts() {
  const s = { ...DEFAULTS, ...(prefs().scriptVideo || {}) };
  if (!TTS_VOICES.some((v) => v.id === s.voice)) s.voice = TTS_VOICES[0].id;
  if (!IMAGE_STYLES.some((x) => x.id === s.style)) s.style = 'none';
  if (s.music && !MUSIC_BY_ID.has(s.music)) s.music = MUSIC[0]?.id || '';
  if (!SCRIPT_CAPTION_STYLES.some((c) => c.id === s.captions)) s.captions = DEFAULTS.captions;
  return s;
}

const select = (label, options, value, onChange) => {
  const el = h('select.select', { 'aria-label': label }, options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  el.addEventListener('change', () => onChange(el.value));
  return el;
};

const field = (label, control, hint) => h('label.aic-field', h('span.aic-label', label), control, hint ? h('span.aic-hint', hint) : null);

/**
 * Open the dialog.
 *  env       { library, account, store? }  store present = add to the open project
 *  services  defaults to puterServices(env.library)
 *  onProject (projectId) called after a new project is saved (home screen)
 */
export function openScriptDialog(env, { services = puterServices(env.library), onProject } = {}) {
  const { library, store } = env;
  const opts = savedOpts();
  const save = () => setPref('scriptVideo', { tone: opts.tone, length: opts.length, ratio: opts.ratio, voice: opts.voice, style: opts.style, captions: opts.captions, music: opts.music });
  // In the editor the frame shape is the project's, unless the timeline is still empty.
  const fixedShape = store && allClips(store.project).length > 0 ? store.project.settings : null;
  let scenes = [];
  let busy = false;
  let abort = null;

  // ---- Step 1: script and options ----------------------------------------------
  const script = h('textarea.textarea.aic-script', { rows: 8, maxLength: SCRIPT_MAX, placeholder: 'Paste your script here. Each paragraph becomes a scene.\n\nOr describe a topic, for example "why cats sleep so much", and use Write the script for me.', 'aria-label': 'Topic or script' });
  script.value = env.initialText || '';
  const tone = select('Tone', SCRIPT_TONES.map((t) => ({ value: t, label: t })), opts.tone, (v) => { opts.tone = v; save(); });
  const length = select('Length', SCRIPT_LENGTHS.map((l) => ({ value: l.id, label: l.label })), opts.length, (v) => { opts.length = v; save(); });
  const writeBtn = h('button.btn', { type: 'button' }, icon('magic', 16), 'Write the script for me');
  const writeStatus = h('span.aic-hint', { role: 'status' });
  const ratio = segmented({
    label: 'Frame shape',
    options: SCRIPT_RATIOS.map((id) => ({ value: id, label: `${id} ${RATIOS.find((r) => r.id === id).hint}` })),
    value: fixedShape ? null : opts.ratio,
    onChange: (v) => { opts.ratio = v; save(); },
  });
  const ratioField = fixedShape
    ? field('Frame shape', h('span.aic-fixed', `${fixedShape.width} x ${fixedShape.height}`), 'Pictures are made to fit this project.')
    : h('div.aic-field', h('span.aic-label', 'Frame shape'), ratio.el);
  const voice = select('Voice', TTS_VOICES.map((v) => ({ value: v.id, label: `${v.label} (${v.hint})` })), opts.voice, (v) => { opts.voice = v; save(); });
  const style = select('Picture style', IMAGE_STYLES.filter((s) => s.id !== 'backdrop').map((s) => ({ value: s.id, label: s.label })), opts.style, (v) => { opts.style = v; save(); });
  const captions = select('Captions', SCRIPT_CAPTION_STYLES.map((c) => ({ value: c.id, label: c.label })), opts.captions, (v) => { opts.captions = v; save(); });
  const music = select('Music', [{ value: '', label: 'No music' }, ...MUSIC.map((m) => ({ value: m.id, label: `${m.title} (${m.mood})` }))], opts.music, (v) => { opts.music = v; save(); });

  writeBtn.addEventListener('click', async () => {
    const topic = script.value.trim();
    if (!topic) {
      writeStatus.textContent = 'Describe the topic first.';
      script.focus();
      return;
    }
    busy = true;
    writeBtn.disabled = true;
    writeStatus.textContent = 'Writing...';
    try {
      const text = cleanScript(chatText(await services.chat(scriptPrompt({ topic, tone: opts.tone, length: opts.length }))));
      if (!text) throw new Error('The AI did not write anything. Try again.');
      env.topic = topic;
      script.value = text;
      writeStatus.textContent = `Done: ${splitScenes(text).length} scenes. Edit anything you like.`;
      announce('Script written');
    } catch (err) {
      console.error(err);
      writeStatus.textContent = errorMessage(err, 'Could not write the script.');
    } finally {
      busy = false;
      writeBtn.disabled = false;
    }
  });

  const step1 = h('div.aic-step',
    field('Topic or script', script),
    h('div.aic-row', tone, length, writeBtn),
    writeStatus,
    h('div.aic-grid', ratioField, field('Voice', voice), field('Picture style', style), field('Captions', captions), field('Music', music, 'Turned down while the voice speaks.')),
  );

  // ---- Step 2: scenes -------------------------------------------------------------
  const list = h('ol.aic-scenes', { 'aria-label': 'Scenes' });
  const summary = h('p.aic-hint', { role: 'status' });
  const suggestBtn = h('button.btn.small', { type: 'button' }, icon('magic', 14), 'Suggest pictures');
  const addBtn = h('button.btn.small', { type: 'button' }, icon('plus', 14), 'Add scene');
  const sceneStatus = h('span.aic-hint', { role: 'status' });

  function renderScenes() {
    list.replaceChildren(...scenes.map((s, i) => {
      const narration = h('textarea.textarea.aic-narration', { rows: 2, maxLength: 1200, 'aria-label': `Scene ${i + 1} narration` });
      narration.value = s.narration;
      narration.addEventListener('input', () => {
        s.narration = narration.value;
        updateSummary();
      });
      const picture = h('textarea.textarea.aic-picture', { rows: 2, maxLength: 600, placeholder: 'What the picture shows (leave empty to use the narration)', 'aria-label': `Scene ${i + 1} picture description` });
      picture.value = s.picture;
      picture.addEventListener('input', () => (s.picture = picture.value));
      const remove = h('button.icon-btn.small', { type: 'button', 'aria-label': `Remove scene ${i + 1}`, 'data-tip': 'Remove scene', disabled: scenes.length < 2 }, icon('trash', 14));
      remove.addEventListener('click', () => {
        scenes.splice(i, 1);
        renderScenes();
      });
      return h('li.aic-scene',
        h('div.aic-scene-head', h('span.aic-scene-num', `Scene ${i + 1}`), remove),
        h('span.aic-label', 'Narration'), narration,
        h('span.aic-label', h('span', icon('image', 12), ' Picture')), picture);
    }));
    updateSummary();
  }

  function updateSummary() {
    const total = sceneTimes(scenes.map((s) => estimateSpeech(s.narration))).reduce((a, t) => a + t.duration, 0);
    summary.textContent = `${scenes.length} scene${scenes.length === 1 ? '' : 's'}, about ${clock(total)} long.`;
  }

  addBtn.addEventListener('click', () => {
    if (scenes.length >= SCENES_MAX) return;
    scenes.push({ narration: '', picture: '' });
    renderScenes();
    list.lastElementChild?.querySelector('textarea')?.focus();
  });
  suggestBtn.addEventListener('click', async () => {
    const filled = scenes.filter((s) => s.narration.trim());
    if (!filled.length) return;
    busy = true;
    suggestBtn.disabled = true;
    sceneStatus.textContent = 'Thinking of pictures...';
    try {
      const styleLabel = IMAGE_STYLES.find((s) => s.id === opts.style)?.phrase || '';
      const pics = parsePictures(await services.chat(picturesPrompt({ scenes: filled, topic: env.topic || '', style: styleLabel })), filled.length);
      let n = 0;
      filled.forEach((s, i) => {
        if (pics[i]) {
          s.picture = pics[i];
          n++;
        }
      });
      renderScenes();
      sceneStatus.textContent = n ? `Suggested ${n} picture${n === 1 ? '' : 's'}.` : 'No suggestions came back. Try again.';
    } catch (err) {
      console.error(err);
      sceneStatus.textContent = errorMessage(err, 'Could not suggest pictures.');
    } finally {
      busy = false;
      suggestBtn.disabled = false;
    }
  });

  const step2 = h('div.aic-step',
    h('p.dialog-text', 'Check each scene. The narration is read aloud and shown as captions; the picture is drawn by AI and moves slowly while it plays.'),
    h('div.aic-row', suggestBtn, addBtn, sceneStatus),
    list,
    summary,
  );

  // ---- Step 3: progress -------------------------------------------------------------
  const bar = h('span');
  const progressText = h('p.dialog-text', { role: 'status' }, 'Starting...');
  const step3 = h('div.aic-step', progressText, h('div.progress', { role: 'progressbar', 'aria-label': 'Progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar), h('p.aic-hint', 'Pictures and voices are made one scene at a time. This can take a minute or two.'));

  // ---- Dialog shell -------------------------------------------------------------------
  const body = h('div.aic-body', step1);
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  const back = h('button.btn', { type: 'button', hidden: true }, icon('chevronLeft', 16), 'Back');
  const next = h('button.btn.primary', { type: 'button' }, 'Next: scenes', icon('chevronRight', 16));
  const create = h('button.btn.primary', { type: 'button', hidden: true }, icon('film', 16), store ? 'Create and add' : 'Create video');
  const d = openDialog({
    title: 'Script to video',
    body,
    actions: [cancel, h('span.spacer'), back, next, create],
    className: 'aic-dialog',
    wide: true,
    closeOnBackdrop: false,
    onClose: () => abort?.abort(),
  });
  d.el.dataset.step = 'script';
  const show = (step) => {
    d.el.dataset.step = step;
    body.replaceChildren(step === 'script' ? step1 : step === 'scenes' ? step2 : step3);
    back.hidden = step !== 'scenes';
    next.hidden = step !== 'script';
    create.hidden = step !== 'scenes';
    cancel.textContent = step === 'progress' ? 'Stop' : 'Cancel';
  };
  cancel.addEventListener('click', () => (abort ? abort.abort() : d.close()));
  back.addEventListener('click', () => show('script'));
  next.addEventListener('click', () => {
    if (busy) return;
    const found = splitScenes(script.value);
    if (!found.length) {
      writeStatus.textContent = 'Write or paste a script first.';
      script.focus();
      return;
    }
    // Keep picture descriptions the user already wrote for unchanged scenes.
    const old = new Map(scenes.map((s) => [s.narration.trim(), s.picture]));
    scenes = found.map((s) => ({ ...s, picture: old.get(s.narration) || '' }));
    if (!env.topic) env.topic = projectName(script.value);
    renderScenes();
    show('scenes');
    list.querySelector('textarea')?.focus();
  });
  create.addEventListener('click', () => run());

  // Pictures and voices made in this dialog: Create after Stop or a failure takes them again rather than paying twice.
  const made = new Map();

  async function run() {
    if (busy || abort) return;
    const todo = scenes.filter((s) => s.narration.trim());
    if (!todo.length) {
      sceneStatus.textContent = 'Write at least one scene.';
      return;
    }
    const ratioId = fixedShape ? null : opts.ratio;
    const frame = fixedShape || RATIOS.find((r) => r.id === ratioId);
    const width = fixedShape ? fixedShape.width : frame.w;
    const height = fixedShape ? fixedShape.height : frame.h;
    abort = new AbortController();
    show('progress');
    const set = ({ done, total, label }) => {
      const pct = Math.round((done / Math.max(1, total)) * 100);
      bar.style.width = `${pct}%`;
      bar.parentElement.setAttribute('aria-valuenow', String(pct));
      if (label) progressText.textContent = label;
    };
    try {
      const res = await generateScenes(todo, {
        voice: opts.voice,
        style: opts.style,
        aspect: aspectForSize(width, height).id,
        width,
        height,
        captions: opts.captions,
        music: opts.music,
        musicName: MUSIC_BY_ID.get(opts.music)?.title,
      }, services, { signal: abort.signal, onProgress: set, reuse: made });
      progressText.textContent = 'Putting it together...';
      const name = projectName(env.topic || script.value);
      const note = problemSummary(res.problems);
      if (store) {
        let ids = [];
        store.update('Script to video', (p) => {
          if (!fixedShape) Object.assign(p.settings, { width, height, ratio: ratioId });
          ids = insertScenes(p, res.layout, res.assets, store.time);
        });
        const pictures = new Set(res.layout.pictures.map((c) => c.id));
        store.select(ids.filter((id) => pictures.has(id)));
      } else {
        const project = normalizeProject(scriptProject(res.layout, res.assets, { name, ratio: ratioId }));
        await library.saveProject(project);
        onProject?.(project.id);
      }
      d.close('done');
      announce(`Video created with ${res.layout.pictures.length} scenes`);
      toast(note || `Made ${res.layout.pictures.length} scenes, ${clock(res.layout.duration)} long.`, { kind: note ? 'info' : 'success', duration: note ? 9000 : 4000 });
      return res;
    } catch (err) {
      abort = null;
      if (err?.name === 'AbortError') {
        if (d.el.isConnected) show('scenes');
        announce('Stopped');
        return null;
      }
      console.error(err);
      show('scenes');
      sceneStatus.textContent = errorMessage(err, 'Could not make the video.');
      return null;
    } finally {
      abort = null;
    }
  }

  return { ...d, run, get scenes() { return scenes; }, show };
}

/** Open the dialog from the editor, or explain that it needs a Puter account. */
export function openScriptVideo(ctx, extra = {}) {
  if (!aiReady(ctx)) return needAiDialog(ctx.account, 'Script to video');
  return openScriptDialog({ library: ctx.library, account: ctx.account, store: ctx.store }, extra);
}
