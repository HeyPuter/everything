// Sound Assistant panel: assign an audio type (Dialogue, Music, SFX,
// Ambience) to the selected clips of a session or to the active audio file,
// then turn on task sections with simple sliders. Each task maps to real
// effects from the registry (see model.js); sessions store the result on the
// clips and play it back in realtime, the Waveform editor previews it and
// applies it as one undo step (see ops.js).

import { h, announce } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { select } from '../ui/controls.js';
import { promptDialog, confirmDialog } from '../ui/dialog.js';
import { withProgress } from '../effects/progress.js';
import { isAbort } from '../effects/apply.js';
import { formatTime } from '../lib/time.js';
import { TYPES, TYPE_IDS, TASKS, LOUDNESS_TARGETS, taskItems, defaultSettings, normalizeSettings, setPath, getPath, presetsFor, applyPreset, saveUserPreset, deleteUserPreset, loudnessGain, assistantChain } from './model.js';
import * as ops from './ops.js';

const PRESETS_KEY = 'soundAssistantPresets';
const COLLAPSED_KEY = 'soundAssistantCollapsed';

const fmtDb = (v) => `${v > 0 ? '+' : ''}${(Math.round(v * 10) / 10).toFixed(1)} dB`;
const fmtAmount = (v) => (Math.round(v * 10) / 10).toFixed(1);

/** What the panel edits right now. */
function target(app) {
  const doc = app.active;
  if (!doc) return { mode: 'none' };
  if (doc.kind === 'session') {
    const clips = doc.clipSelection;
    if (!clips.length) return { mode: 'session-empty', doc };
    const types = new Set(clips.map((c) => c.soundAssistant?.type || null));
    const type = types.size === 1 ? [...types][0] : undefined;
    const lead = clips.find((c) => c.soundAssistant?.type === type) || clips[0];
    return { mode: 'session', doc, clips, ids: clips.map((c) => c.id), type, mixed: types.size > 1, settings: type ? ops.clipSettings(lead) : null, lead };
  }
  if (doc.kind === 'audio') {
    const settings = ops.getFileSettings(doc);
    return { mode: 'file', doc, type: settings?.type || null, settings };
  }
  return { mode: 'none' };
}

export function soundAssistantPanel(app) {
  const el = h('div.sa-panel');
  let built = null; // { key, refresh }
  let preview = null; // slot specs we put on app.previewFx
  let busy = false;

  // ------------------------------------------------------------- editing

  const edit = (path, value, { gesture = false } = {}) => {
    const t = target(app);
    if (t.mode === 'session' && t.type) {
      const label = `Sound Assistant: ${TASKS[path[0]]?.label || 'Settings'}`;
      t.doc.apply(label, ops.editClips(t.doc.state, t.ids, t.type, path, value), gesture ? { coalesce: `sa:${path.join('.')}` } : {});
      if (!gesture) t.doc.endGesture?.();
    } else if (t.mode === 'file' && t.settings) {
      let next = setPath(t.settings, path, value);
      if (path[0] !== 'volume') next = { ...next, preset: '' };
      ops.setFileSettings(t.doc, next);
      syncPreview();
      refresh();
    }
  };
  const endGesture = () => app.active?.endGesture?.();

  const setAll = (fn, label) => {
    const t = target(app);
    if (t.mode === 'session') t.doc.apply(label, ops.setClipSettings(t.doc.state, t.ids, fn));
    else if (t.mode === 'file' && t.settings) {
      ops.setFileSettings(t.doc, fn(t.settings));
      syncPreview();
      refresh(true);
    }
  };

  const assign = (type) => {
    const t = target(app);
    if (t.mode === 'session') {
      t.doc.apply(`Assign ${TYPES[type].label} Type`, ops.assignType(t.doc.state, t.ids, type));
    } else if (t.mode === 'file') {
      ops.setFileSettings(t.doc, defaultSettings(type));
      refresh(true);
    }
    announce(`Audio type set to ${TYPES[type].label}`);
    requestAnimationFrame(() => el.querySelector('.sa-section-toggle input, .sa-preset select')?.focus());
  };

  const clearType = () => {
    const t = target(app);
    if (t.mode === 'session') t.doc.apply('Clear Audio Type', ops.clearType(t.doc.state, t.ids));
    else if (t.mode === 'file') {
      ops.setFileSettings(t.doc, null);
      setPreview(false);
      refresh(true);
    }
    announce('Audio type cleared');
    requestAnimationFrame(() => el.querySelector('.sa-type-btn')?.focus());
  };

  // ------------------------------------------------------------ preview

  function setPreview(on) {
    const t = target(app);
    if (on && t.mode === 'file' && t.settings) {
      preview = ops.filePreviewSpecs(t.settings, t.doc.sampleRate);
      app.previewFx = preview;
    } else {
      if (preview && app.previewFx === preview) app.previewFx = null;
      preview = null;
    }
    app.syncGraph();
    refresh();
  }

  function syncPreview() {
    if (!preview) return;
    const t = target(app);
    if (app.previewFx !== preview || t.mode !== 'file' || !t.settings) {
      preview = null;
      return;
    }
    preview = ops.filePreviewSpecs(t.settings, t.doc.sampleRate);
    app.previewFx = preview;
    app.syncGraph();
  }

  // ------------------------------------------------------------ actions

  async function run(title, task) {
    if (busy) return;
    busy = true;
    refresh();
    try {
      return await withProgress(app, title, task);
    } catch (err) {
      if (!isAbort(err)) {
        console.error(err);
        app.notify(err?.message || `${title} failed.`, { error: true });
      }
      return undefined;
    } finally {
      busy = false;
      refresh();
    }
  }

  /**
   * Work that disables the buttons (and Apply, which rebuilds them) drops keyboard focus to the
   * page: put it back on `selector`, or the nearest control that can take it.
   */
  async function keepFocus(selector, work) {
    const had = el.contains(document.activeElement);
    try {
      return await work();
    } finally {
      const at = document.activeElement;
      if (had && (!at || at === document.body)) {
        const next = [selector, '.sa-preview', 'button'].map((q) => el.querySelector(q));
        next.find((b) => b && !b.disabled)?.focus();
      }
    }
  }

  async function autoMatch() {
    const t = target(app);
    if (t.mode === 'session') {
      const r = await run('Matching Loudness', (signal, onProgress) => ops.autoMatchClips(t.doc, t.ids, { signal, onProgress }));
      if (!r) return;
      t.doc.apply('Auto-Match Loudness', r.state);
      const quiet = r.results.filter((x) => x.lufs == null).length;
      const msg = quiet ? `${quiet} clip${quiet > 1 ? 's were' : ' was'} too quiet or short to measure.` : `Loudness matched for ${r.results.length} clip${r.results.length === 1 ? '' : 's'}.`;
      app.notify(msg);
      announce(msg);
    } else if (t.mode === 'file') {
      const [start, end] = t.doc.editRange();
      const lufs = await run('Measuring Loudness', (signal, onProgress) => ops.measureFile(t.settings, t.doc.state, start, end, { signal, onProgress }));
      if (lufs === undefined) return;
      const quiet = lufs == null;
      if (quiet) app.notify('The audio is too quiet or too short to measure.', { error: true });
      ops.setFileSettings(t.doc, setPath(setPath(ops.getFileSettings(t.doc), ['loudness', 'measured'], lufs), ['loudness', 'on'], true));
      syncPreview();
      refresh();
      announce(quiet ? 'The audio is too quiet or too short to measure' : 'Loudness measured');
    }
  }

  async function applyDuration() {
    const t = target(app);
    if (t.mode !== 'session') return;
    const state = await run('Changing Duration', (signal, onProgress) => ops.applyDurationClips(t.doc, t.ids, { signal, onProgress }));
    if (state) t.doc.apply('Sound Assistant: Duration', state);
  }

  function generateKeyframes() {
    const t = target(app);
    if (t.mode !== 'session') return;
    const state = ops.regenerateDucking(t.doc.state);
    if (state === t.doc.state) app.notify('The ducking keyframes are already up to date.');
    else t.doc.apply('Generate Ducking Keyframes', state);
  }

  async function applyFile() {
    const t = target(app);
    if (t.mode !== 'file' || !t.settings) return;
    const doc = t.doc;
    const [start, end] = doc.editRange();
    if (end <= start) return app.notify('There is no audio to process.', { error: true });
    const before = doc.state;
    const hadSelection = doc.hasSelection;
    const r = await run('Applying Sound Assistant', (signal, onProgress) => ops.renderFile({ settings: t.settings, state: before, start, end, mask: doc.channelMask, signal, onProgress }));
    if (!r) return;
    if (doc.state !== before) return app.notify('Sound Assistant was not applied because the file changed while it was processing.', { error: true });
    if (preview) setPreview(false);
    doc.apply(`Sound Assistant: ${TYPES[t.settings.type].label}`, r.state, hadSelection ? { selection: { start, end: start + r.length } } : {});
    // The audio now carries the processing; keep the type but switch tasks off so Apply is not repeated by accident.
    ops.setFileSettings(doc, { ...defaultSettings(t.settings.type) });
    app.setStatus('Sound Assistant applied');
    announce('Sound Assistant applied');
    refresh(true);
  }

  // ------------------------------------------------------------- presets

  const userPresets = () => app.prefs.get(PRESETS_KEY) || {};

  async function savePreset() {
    const t = target(app);
    if (!t.settings) return;
    const name = await promptDialog({
      title: 'Save Sound Assistant Preset',
      label: 'Preset name:',
      value: t.settings.preset || '',
      confirm: 'Save',
      validate: (v) => {
        try {
          saveUserPreset({}, v, t.settings);
          return '';
        } catch (err) {
          return err.message;
        }
      },
    });
    if (name == null) return;
    app.prefs.set(PRESETS_KEY, saveUserPreset(userPresets(), name, t.settings));
    setAll((s) => ({ ...s, preset: name.trim() }), 'Sound Assistant: Preset');
    app.notify(`Preset "${name.trim()}" saved.`);
  }

  async function deletePreset() {
    const t = target(app);
    const name = t.settings?.preset;
    const p = presetsFor(t.type, userPresets()).find((x) => x.name === name);
    if (!p?.user) return;
    const ok = await confirmDialog({ title: 'Delete Preset?', message: `Delete the preset "${name}"?`, confirm: 'Delete', danger: true });
    if (!ok) return;
    app.prefs.set(PRESETS_KEY, deleteUserPreset(userPresets(), t.type, name));
    setAll((s) => ({ ...s, preset: '' }), 'Sound Assistant: Preset');
  }

  // --------------------------------------------------------------- build

  const collapsed = () => app.prefs.get(COLLAPSED_KEY) || {};
  const toggleCollapsed = (key) => app.prefs.set(COLLAPSED_KEY, { ...collapsed(), [key]: !collapsed()[key] });

  function message(text, extra) {
    return h('div.sa-empty', h('p', text), extra || null);
  }

  function assignView(t) {
    const what = t.mode === 'file' ? 'this audio file' : t.clips.length > 1 ? `the ${t.clips.length} selected clips` : 'the selected clip';
    const heading = t.mixed ? `The selected clips have different audio types. Choose one type for all of them:` : `Choose an audio type for ${what}:`;
    return h(
      'div.sa-assign',
      h('p.sa-assign-text', heading),
      h(
        'div.sa-types',
        { role: 'group', 'aria-label': 'Audio type' },
        TYPE_IDS.map((id) => h('button.sa-type-btn', { type: 'button', 'data-type': id, onclick: () => assign(id) }, icon(TYPES[id].icon, 20), h('span', TYPES[id].label))),
      ),
      t.mixed ? h('button.btn.sa-clear-mixed', { type: 'button', onclick: clearType }, 'Clear Audio Types') : null,
      h('p.sa-hint.faint', t.mode === 'file' ? 'Tasks you turn on can be previewed during playback and applied to the selection or the whole file.' : 'Settings are stored on the clips and play back in real time. Mixdowns and exports include them.'),
    );
  }

  function editorView(t) {
    const type = t.type;
    const refreshers = [];
    const s0 = () => target(app).settings;
    const sessionMode = t.mode === 'session';

    // Header: type and Clear.
    const head = h(
      'div.sa-head',
      h('span.sa-type-icon', icon(TYPES[type].icon, 16)),
      h('h3.sa-type-name', TYPES[type].label),
      h('span.sa-count.faint', sessionMode && t.clips.length > 1 ? `${t.clips.length} clips` : ''),
      h('div.spacer'),
      h('button.btn.sa-clear', { type: 'button', onclick: clearType, title: 'Remove the audio type and its processing' }, 'Clear Audio Type'),
    );

    // Presets.
    const presetSel = h('select.select', { 'aria-label': 'Preset' });
    const delBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Delete preset', title: 'Delete preset', onclick: deletePreset }, icon('trash-2', 14));
    const saveBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Save settings as a preset', title: 'Save as preset', onclick: savePreset }, icon('bookmark-plus', 14));
    presetSel.addEventListener('change', () => {
      const p = presetsFor(type, userPresets()).find((x) => x.name === presetSel.value);
      if (!p) return;
      setAll((cur) => applyPreset(cur, p), `Sound Assistant Preset: ${p.name}`);
      announce(`Preset ${p.name}`);
    });
    const renderPresets = (s) => {
      const list = presetsFor(type, userPresets());
      const cur = s?.preset || '';
      presetSel.replaceChildren(h('option', { value: '', disabled: true }, '(Custom)'), ...list.map((p) => h('option', { value: p.name }, p.user ? `${p.name} (mine)` : p.name)));
      presetSel.value = list.some((p) => p.name === cur) ? cur : '';
      delBtn.disabled = !list.find((p) => p.name === cur)?.user;
    };
    refreshers.push(renderPresets);
    const presetRow = h('div.sa-preset', h('label.sa-label', 'Preset'), presetSel, saveBtn, delBtn);

    // Controls.
    let uid = 0;
    const nextId = () => `sa-${++uid}`;
    const slider = ({ path, label, min, max, step, format, disabled, hideLabel = false }) => {
      const id = nextId();
      const out = h('output.sa-value.tabular', { for: id });
      const input = h('input.slider.sa-slider', { type: 'range', id, min, max, step, 'aria-label': label });
      input.addEventListener('input', () => edit(path, Number(input.value), { gesture: true }));
      input.addEventListener('change', endGesture);
      input.addEventListener('keydown', (e) => e.stopPropagation());
      refreshers.push((s) => {
        const v = Number(getPath(s, path) ?? 0);
        if (document.activeElement !== input || !input.matches(':active')) input.value = String(v);
        out.textContent = format(v);
        input.setAttribute('aria-valuetext', format(v));
        input.disabled = Boolean(disabled?.(s));
      });
      // Item sliders sit under their checkbox, which names them; the label stays for screen readers.
      return h('div.sa-slider-row', h(`label.sa-label${hideLabel ? '.sr-only' : ''}`, { for: id }, label), input, out);
    };
    const checkbox = (path, label) => {
      const box = h('input', { type: 'checkbox', onchange: () => edit(path, box.checked) });
      refreshers.push((s) => (box.checked = Boolean(getPath(s, path))));
      return h('label.check.sa-check', box, label);
    };
    const choice = (path, label, options, { number = false } = {}) => {
      const sel = select({ value: '', options, label, onChange: (v) => edit(path, number ? Number(v) : v) });
      refreshers.push((s) => (sel.value = String(getPath(s, path))));
      return sel;
    };

    const section = (task, body) => {
      const def = TASKS[task];
      const key = `${type}.${task}`;
      const bodyId = nextId();
      const isCollapsed = Boolean(collapsed()[key]);
      const chevron = h('button.icon-btn.sa-collapse', { type: 'button', 'aria-expanded': String(!isCollapsed), 'aria-controls': bodyId, 'aria-label': `${isCollapsed ? 'Expand' : 'Collapse'} ${def.label}` }, icon(isCollapsed ? 'chevron-right' : 'chevron-down', 14));
      const content = h('div.sa-section-body', { id: bodyId, hidden: isCollapsed }, body);
      chevron.addEventListener('click', () => {
        toggleCollapsed(key);
        const now = Boolean(collapsed()[key]);
        content.hidden = now;
        chevron.setAttribute('aria-expanded', String(!now));
        chevron.setAttribute('aria-label', `${now ? 'Expand' : 'Collapse'} ${def.label}`);
        chevron.replaceChildren(icon(now ? 'chevron-right' : 'chevron-down', 14));
      });
      let header;
      if (def.toggle) {
        const box = h('input', { type: 'checkbox', onchange: () => edit([task, 'on'], box.checked) });
        refreshers.push((s) => {
          const on = Boolean(s?.[task]?.on);
          box.checked = on;
          content.classList.toggle('off', !on);
        });
        header = h('div.sa-section-head', chevron, h('label.check.sa-section-toggle', box, h('span.sa-section-title', def.label)));
      } else {
        header = h('div.sa-section-head', chevron, h('span.sa-section-title', def.label));
      }
      return h(`section.sa-section.sa-${task}`, { 'aria-label': def.label }, header, content);
    };

    const itemsBody = (task) =>
      taskItems(type, task).map((it) => {
        const parts = [checkbox([task, 'items', it.id, 'on'], it.label)];
        if (it.choice) parts.push(choice([task, 'items', it.id, it.choice.id], it.choice.label, it.choice.options, { number: typeof it.choice.options[0].value === 'number' }));
        const row = h('div.sa-item-head', parts);
        const rows = [row];
        if (it.id === 'width') rows.push(slider({ path: [task, 'items', it.id, 'amount'], label: `${it.label} amount`, min: it.min, max: it.max, step: it.step, format: (v) => `${Math.round(v)}%`, hideLabel: true }));
        else if (!it.noAmount) rows.push(slider({ path: [task, 'items', it.id, 'amount'], label: `${it.label} amount`, min: 0, max: 10, step: 0.1, format: fmtAmount, hideLabel: true }));
        return h('div.sa-item', rows);
      });

    const bodies = {
      loudness: () => {
        const readout = h('div.sa-readout.faint', { 'aria-live': 'polite' });
        const match = () => keepFocus('.sa-loudness .sa-action', autoMatch);
        const matchBtn = h('button.btn.sa-action', { type: 'button', onclick: match }, 'Auto-Match');
        refreshers.push((s) => {
          const m = s?.loudness?.measured;
          const g = loudnessGain(s);
          readout.textContent = Number.isFinite(m) ? `Measured ${m.toFixed(1)} LUFS, gain ${fmtDb(g)}${sessionMode && t.clips.length > 1 ? ' (first clip)' : ''}` : 'Not measured yet. Auto-Match measures the audio and sets the gain.';
          matchBtn.disabled = busy;
        });
        return [h('div.sa-field', h('label.sa-label', 'Target'), choice(['loudness', 'target'], 'Loudness target', LOUDNESS_TARGETS, { number: true })), h('div.sa-actions', matchBtn), readout];
      },
      repair: () => itemsBody('repair'),
      clarity: () => itemsBody('clarity'),
      creative: () => itemsBody('creative'),
      duration: () => {
        const id = nextId();
        const input = h('input.input.num.sa-seconds', { type: 'number', id, min: 0.1, max: 36000, step: 0.1, 'aria-label': 'Target duration in seconds' });
        input.addEventListener('change', () => {
          const v = Number(input.value);
          if (v > 0) edit(['duration', 'seconds'], Math.round(v * 10) / 10);
        });
        input.addEventListener('keydown', (e) => e.stopPropagation());
        const info = h('div.sa-readout.faint');
        const stretch = () => keepFocus('.sa-duration .sa-action', applyDuration);
        const btn = sessionMode ? h('button.btn.sa-action', { type: 'button', onclick: stretch }, 'Apply Duration') : null;
        refreshers.push((s) => {
          if (document.activeElement !== input) input.value = String(s?.duration?.seconds ?? 30);
          const cur = target(app);
          if (cur.mode === 'session') {
            const c = cur.lead;
            const orig = s?.duration?.orig;
            const len = orig ? orig.length : c.length;
            info.textContent = `Original ${formatTime(len, cur.doc.sampleRate, 'decimal')}${orig ? `, now ${formatTime(c.length, cur.doc.sampleRate, 'decimal')}` : ''}. The music is stretched without changing its pitch.`;
          } else if (cur.mode === 'file') {
            const [a, b] = cur.doc.editRange();
            info.textContent = `${cur.doc.hasSelection ? 'Selection' : 'File'} is ${formatTime(b - a, cur.doc.sampleRate, 'decimal')}. Apply stretches it without changing its pitch.`;
          }
          if (btn) btn.disabled = busy;
        });
        return [h('div.sa-field', h('label.sa-label', { for: id }, 'Target (s)'), input), btn ? h('div.sa-actions', btn) : null, info];
      },
      ducking: () => {
        if (!sessionMode) return [h('p.sa-readout.faint', 'Ducking lowers this audio under other clips, so it works on clips in a multitrack session.')];
        const against = h(
          'div.sa-against',
          { role: 'group', 'aria-label': 'Duck against' },
          TYPE_IDS.map((id) => {
            const box = h('input', {
              type: 'checkbox',
              onchange: () => {
                const cur = new Set(target(app).settings?.ducking?.against || []);
                if (box.checked) cur.add(id);
                else cur.delete(id);
                edit(['ducking', 'against'], TYPE_IDS.filter((x) => cur.has(x)));
              },
            });
            refreshers.push((s) => (box.checked = (s?.ducking?.against || []).includes(id)));
            return h('label.check', box, TYPES[id].label);
          }),
        );
        const gen = h('button.btn.sa-action', { type: 'button', onclick: generateKeyframes }, 'Generate Keyframes');
        return [
          h('div.sa-field.sa-field-top', h('span.sa-label', 'Duck against'), against),
          slider({ path: ['ducking', 'sensitivity'], label: 'Sensitivity', min: 1, max: 10, step: 0.1, format: fmtAmount }),
          slider({ path: ['ducking', 'reduce'], label: 'Reduce by', min: -40, max: 0, step: 0.5, format: (v) => `${v.toFixed(1)} dB` }),
          slider({ path: ['ducking', 'fade'], label: 'Fades', min: 0, max: 3000, step: 10, format: (v) => `${Math.round(v)} ms` }),
          h('div.sa-actions', gen),
          h('p.sa-readout.faint', 'Keyframes are written to the clip volume envelope and follow the clips of the chosen types.'),
        ];
      },
      pan: () => [slider({ path: ['pan', 'value'], label: 'Pan', min: -100, max: 100, step: 1, format: (v) => (v === 0 ? 'Center' : v < 0 ? `L ${-v}` : `R ${v}`) })],
      volume: () => {
        const rows = [slider({ path: ['volume', 'level'], label: 'Level', min: -30, max: 15, step: 0.1, format: fmtDb })];
        if (sessionMode) rows.push(checkbox(['volume', 'mute'], 'Mute'));
        return rows;
      },
    };

    const sections = TYPES[type].tasks.map((task) => section(task, bodies[task]()));

    // Footer.
    let foot = null;
    if (!sessionMode) {
      const previewBtn = h('button.btn.sa-preview', { type: 'button', 'aria-pressed': 'false', onclick: () => setPreview(!preview) }, icon('headphones', 14), h('span', 'Preview'));
      const apply = () => keepFocus('.sa-apply', applyFile);
      const applyBtn = h('button.btn.primary.sa-apply', { type: 'button', onclick: apply }, 'Apply');
      const note = h('span.sa-foot-note.faint');
      refreshers.push((s) => {
        previewBtn.setAttribute('aria-pressed', String(Boolean(preview)));
        previewBtn.classList.toggle('on', Boolean(preview));
        const chain = assistantChain(s, { loudness: false, volume: false });
        const active = chain.length || s?.loudness?.on || s?.volume?.level || s?.duration?.on;
        applyBtn.disabled = busy || !active;
        const cur = target(app);
        note.textContent = cur.doc?.hasSelection ? 'Selection' : 'Entire file';
      });
      foot = h('div.sa-foot', previewBtn, h('div.spacer'), note, applyBtn);
    }

    const root = h('div.sa-editor', head, presetRow, h('div.sa-scroll', sections), foot);
    const refreshAll = () => {
      const s = s0();
      if (!s) return;
      for (const f of refreshers) f(s);
    };
    return { el: root, refresh: refreshAll };
  }

  function keyOf(t) {
    if (t.mode === 'session') return `s:${t.doc.id}:${t.ids.join(',')}:${t.type ?? 'mixed'}`;
    if (t.mode === 'file') return `f:${t.doc.id}:${t.type}`;
    return t.mode + (t.doc?.id || '');
  }

  function refresh(force = false) {
    const t = target(app);
    const key = keyOf(t);
    if (!force && built && built.key === key) {
      built.refresh?.();
      return;
    }
    let view;
    if (t.mode === 'none') view = { el: message('Open an audio file or a multitrack session, then assign an audio type here.') };
    else if (t.mode === 'session-empty') view = { el: message('Select one or more clips to assign an audio type and adjust their sound.') };
    else if (!t.type) view = { el: assignView(t) };
    else view = editorView(t);
    const scroll = el.querySelector('.sa-scroll')?.scrollTop || 0;
    el.replaceChildren(view.el);
    built = { key, refresh: view.refresh };
    view.refresh?.();
    if (built.key === key) {
      const sc = el.querySelector('.sa-scroll');
      if (sc && !force) sc.scrollTop = scroll;
    }
  }

  app.on('active', () => {
    preview = null; // app.activate clears previewFx
    refresh();
  });
  app.on('doc-change', (doc, e) => {
    if (doc !== app.active) return;
    if (e.kind === 'clip-selection' || e.kind === 'edit' || e.kind === 'history' || e.kind === 'selection') refresh();
  });
  app.on('documents', () => refresh());
  app.prefs.on('change', (key) => key === PRESETS_KEY && built?.refresh?.());
  refresh();

  return {
    el,
    show: () => refresh(),
    focus: () => el.querySelector('button, input, select')?.focus(),
  };
}

/** Normalized settings for tests and other features. */
export { normalizeSettings };
