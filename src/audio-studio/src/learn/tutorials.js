// The Learn panel's tutorials (see engine.js for the step format). Each one makes its
// own practice audio when it starts, so it can be followed on any machine.

import { practiceFile, voiceSamples, clicksSamples, musicSamples, FIRST_CLICK } from './media.js';
import { displayOn } from '../spectral/state.js';
import { rmsDb, roughness, peakDb, integratedLoudness } from './measure.js';
import { MATCH_DEFAULTS } from '../analysis/loudness.js';

const audio = (app) => (app.active?.kind === 'audio' ? app.active : null);
const session = (app) => (app.active?.kind === 'session' ? app.active : null);
const seconds = (doc, frames) => frames / (doc?.sampleRate || 48000);
const panelOpen = (app, id) => Boolean(app.dock?.isVisible?.(id) ?? app.dock?.isOpen?.(id));
// The tutorial's own file while it is open, else the active one.
const fileOf = (app, ctx) => (ctx.doc && app.documents?.includes(ctx.doc) ? ctx.doc : audio(app));
const db = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : 'silence');
const rangeCount = (doc) => (doc?.state.markers || []).filter((m) => m.duration > 0).length;

const voiceFile = (app) => practiceFile(app, 'Practice Voice.wav', () => ({ rate: 48000, channels: [voiceSamples(48000, 16)] }));
const clicksFile = (app) => practiceFile(app, 'Practice Clicks.wav', () => ({ rate: 44100, channels: clicksSamples(44100, 8) }));
const musicFile = (app) => practiceFile(app, 'Practice Song.wav', () => ({ rate: 44100, channels: musicSamples(44100, 16) }));

/** The open Waveform editor's lanes. */
const lanes = () => document.querySelector('.editor-panel .wf-lanes');
const button = (scope, text) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent.trim() === text) || null;

export const TUTORIALS = [
  {
    id: 'voice-cleanup',
    title: 'Clean up a voice recording',
    summary: 'Take out steady background noise, even out the level and add a gentle fade.',
    minutes: 4,
    setup: (app, ctx) => {
      ctx.doc = voiceFile(app);
    },
    steps: [
      {
        id: 'listen',
        title: 'Listen first',
        text: 'This practice recording has hiss and hum under the voice. Press Play (or Space) and listen to the first two seconds, where nobody is speaking.',
        command: 'transport.play',
        done: { command: ['transport.play', 'transport.toggle'] },
      },
      {
        id: 'select-noise',
        title: 'Select some noise on its own',
        text: 'Drag across the quiet start of the file, before the voice begins (about the first second). That stretch tells the noise reducer what to remove.',
        target: () => lanes(),
        drag: { from: [0.004, 0.5], to: [0.06, 0.5] },
        done: { check: (app) => { const d = audio(app); return Boolean(d) && d.hasSelection && seconds(d, d.selection.end) <= 1.6 && seconds(d, d.selection.end - d.selection.start) >= 0.4; } },
      },
      {
        id: 'capture',
        title: 'Capture a noise print',
        text: 'Choose Effects > Noise Reduction / Restoration > Capture Noise Print, or press its shortcut.',
        command: 'fx.captureNoisePrint',
        menu: ['Effects', 'Noise Reduction / Restoration'],
        done: { command: 'fx.captureNoisePrint' },
      },
      {
        id: 'select-all',
        title: 'Select the whole file',
        text: 'Choose Edit > Select > Select All, or press its shortcut, so the whole recording is cleaned.',
        command: 'edit.selectAll',
        menu: ['Edit', 'Select'],
        done: { check: (app) => { const d = audio(app); return Boolean(d) && d.selection.start === 0 && d.selection.end >= d.length && d.length > 0; } },
      },
      {
        id: 'reduce',
        title: 'Reduce the noise',
        text: 'Open Effects > Noise Reduction / Restoration > Noise Reduction (process). Keep the settings, press the play button in the dialog to hear the result, then Apply.',
        command: 'fx.noiseReduction',
        menu: ['Effects', 'Noise Reduction / Restoration'],
        done: { edit: 'Noise Reduction' },
        enter: (app, ctx) => {
          const d = fileOf(app, ctx);
          ctx.noiseBefore = d ? rmsDb(d, 0.2, 1.2) : null;
        },
        // The room tone before the voice should end up clearly quieter.
        verify: (app, ctx) => {
          const d = fileOf(app, ctx);
          if (!d || ctx.noiseBefore == null) return null;
          const drop = ctx.noiseBefore - rmsDb(d, 0.2, 1.2);
          return drop >= 3 ? null : `The background noise only dropped ${Math.max(0, drop).toFixed(1)} dB. Undo, open Noise Reduction again, raise Noise Reduction and Reduce By, then apply.`;
        },
      },
      {
        id: 'normalize',
        title: 'Bring up the level',
        text: 'The voice is quiet. Open Effects > Amplitude and Compression > Normalize and apply it to raise the loudest peak close to full scale.',
        command: 'fx.normalize',
        menu: ['Effects', 'Amplitude and Compression'],
        done: { edit: 'Normalize' },
        verify: (app, ctx) => {
          const d = fileOf(app, ctx);
          const peak = d ? peakDb(d) : 0;
          return peak >= -3 ? null : `The loudest peak is at ${db(peak)}. Undo, set Normalize to -1 dB (or 0 dB) with the whole file selected, and apply again.`;
        },
      },
      {
        id: 'fade',
        title: 'Fade in',
        text: 'Drag the small square at the top-left corner of the waveform to the right. It draws a fade-in; dragging up or down bends its curve.',
        target: '.editor-panel .fade-handle.in',
        drag: { from: [0.5, 0.5], by: [90, 0] },
        done: { edit: 'Fade In' },
      },
      {
        id: 'save',
        title: 'Save your work',
        text: 'Choose File > Save As. WAV keeps full quality; pick MP3 for a smaller file to share.',
        command: 'file.saveAs',
        menu: ['File'],
        done: { command: ['file.saveAs', 'file.save'] },
      },
    ],
  },
  {
    id: 'heal-click',
    title: 'Remove a click with spectral healing',
    summary: 'Find a click in the spectral display and paint it away without touching the music around it.',
    minutes: 3,
    setup: (app, ctx) => {
      ctx.doc = clicksFile(app);
    },
    steps: [
      {
        id: 'spectral',
        title: 'Show the spectral display',
        text: 'Turn on the spectral frequency display with its toolbar button (or View > Show Spectral Frequency Display). Clicks show up as thin vertical lines.',
        command: 'view.spectral',
        target: '[data-cmd="view.spectral"]',
        done: { check: (app) => displayOn(app) },
      },
      {
        id: 'zoom',
        title: 'Zoom in on the first click',
        text: `The first click is at ${FIRST_CLICK.toFixed(1)} seconds. Drag a short selection around it and press Zoom to Selection, or scroll over the waveform, until less than half a second is in view.`,
        target: '[data-cmd="view.zoomSelection"]',
        done: { check: (app) => { const d = audio(app); if (!d) return false; const v = d.view; const at = FIRST_CLICK * d.sampleRate; return v.end - v.start < 0.5 * d.sampleRate && v.start <= at && v.end >= at; } },
      },
      {
        id: 'tool',
        title: 'Pick the Spot Healing Brush',
        text: 'Choose the Spot Healing Brush in the toolbar (the plaster icon).',
        command: 'tool.heal',
        target: '[data-tool="heal"]',
        done: { check: (app) => app.tool === 'heal' },
      },
      {
        id: 'heal',
        title: 'Heal the click',
        text: 'Hold Shift and click on the vertical line: the dashed column shows what will be repaired. Without Shift you can paint over just part of it.',
        target: () => document.querySelector('.editor-panel .spec-overlay') || lanes(),
        done: { edit: 'Spot Healing' },
        enter: (app, ctx) => {
          const d = fileOf(app, ctx);
          ctx.roughBefore = d ? roughness(d, FIRST_CLICK - 0.01, FIRST_CLICK + 0.01) : null;
        },
        // The click itself has to be gone, not just a nearby stretch repaired.
        verify: (app, ctx) => {
          const d = fileOf(app, ctx);
          if (!d || !ctx.roughBefore) return null;
          const left = roughness(d, FIRST_CLICK - 0.01, FIRST_CLICK + 0.01) / ctx.roughBefore;
          return left <= 0.35 ? null : `The click at ${FIRST_CLICK.toFixed(1)} s is still ${Math.round(left * 100)}% as sharp. Hold Shift and click right on its line to heal the full height, or make the brush bigger with ].`;
        },
      },
      {
        id: 'listen',
        title: 'Check by ear',
        text: 'Play the passage again. If you hear the click less but not gone, heal it once more with a slightly bigger brush (] makes it bigger). Press Next when you are happy.',
        command: 'transport.play',
        done: { manual: true },
      },
    ],
  },
  {
    id: 'podcast',
    title: 'Make a podcast in Multitrack',
    summary: 'Put a voice and a music bed on separate tracks, balance them and export the mix.',
    minutes: 5,
    setup: (app, ctx) => {
      ctx.music = musicFile(app);
      ctx.voice = voiceFile(app);
    },
    steps: [
      {
        id: 'insert-voice',
        title: 'Put the voice in a session',
        text: 'With the voice file open, choose Edit > Insert > Into Multitrack Session > New Multitrack Session, and accept the settings.',
        menu: ['Edit', 'Insert'],
        done: { check: (app) => (session(app)?.state.clips.length || 0) >= 1 },
      },
      {
        id: 'add-music',
        title: 'Add the music bed',
        text: 'Drag "Practice Song.wav" from the Files panel onto the second track, starting at the beginning.',
        target: '[data-panel="files"]',
        done: { check: (app) => (session(app)?.state.clips.length || 0) >= 2 },
      },
      {
        id: 'balance',
        title: 'Turn the music down',
        text: 'Lower the volume of the music track (its volume knob in the track header) by about 12 dB so the voice stays clear.',
        target: '.editor-panel .track-header',
        done: { check: (app) => { const s = session(app); if (!s) return false; const music = new Set(s.state.clips.filter((c) => /Song/.test(c.name || '')).map((c) => c.trackId)); return s.state.tracks.some((t) => (music.size ? music.has(t.id) : true) && t.volume <= -6); } },
      },
      {
        id: 'play',
        title: 'Listen to the mix',
        text: 'Press Play and listen. Adjust the music level again if the voice gets lost.',
        command: 'transport.play',
        done: { command: ['transport.play', 'transport.toggle'] },
      },
      {
        id: 'export',
        title: 'Export the mix',
        text: 'Choose File > Export > Multitrack Mixdown > Entire Session to write the finished podcast to one file.',
        command: 'export.mixdownSession',
        menu: ['File', 'Export', 'Multitrack Mixdown'],
        done: { command: 'export.mixdownSession' },
      },
    ],
  },
  {
    id: 'master',
    title: 'Master a song',
    summary: 'Shape the tone, tighten the dynamics, catch the peaks and hit a loudness target.',
    minutes: 5,
    setup: (app, ctx) => {
      ctx.doc = musicFile(app);
    },
    steps: [
      {
        id: 'eq',
        title: 'Shape the tone',
        text: 'Open Effects > Filter and EQ > Parametric Equalizer. Try a small low shelf boost and a gentle cut around 300 Hz, compare with the power button, then Apply.',
        command: 'fx.parametricEq',
        menu: ['Effects', 'Filter and EQ'],
        done: { edit: 'Parametric Equalizer' },
      },
      {
        id: 'multiband',
        title: 'Even out the bands',
        text: 'Open Effects > Amplitude and Compression > Multiband Compressor and apply it. It controls lows, mids and highs separately.',
        command: 'fx.multibandCompressor',
        menu: ['Effects', 'Amplitude and Compression'],
        done: { edit: 'Multiband Compressor' },
      },
      {
        id: 'limit',
        title: 'Catch the peaks',
        text: 'Open Effects > Amplitude and Compression > Hard Limiter, raise the input boost a few dB and apply. The limiter keeps the loudest peaks below the ceiling.',
        command: 'fx.hardLimiter',
        menu: ['Effects', 'Amplitude and Compression'],
        done: { edit: 'Hard Limiter' },
      },
      {
        id: 'loudness-panel',
        title: 'Open Match Loudness',
        text: 'Open Window > Match Loudness. It measures the file and can bring it to a target such as -14 LUFS for streaming.',
        command: 'window.loudness',
        menu: ['Window'],
        done: { check: (app) => panelOpen(app, 'loudness') },
      },
      {
        id: 'match',
        title: 'Hit the target',
        text: 'Choose "Streaming (-14 LUFS)" under Match To and press Run. Scan shows the measured loudness first if you want to check it.',
        target: () => button('[data-panel="loudness"]', 'Run'),
        done: { edit: 'Match Loudness' },
        // Within 1 LU of the target chosen in the panel.
        verify: async (app, ctx) => {
          const d = fileOf(app, ctx);
          if (!d) return null;
          const target = Number((app.prefs.get('matchLoudness') || {}).target ?? MATCH_DEFAULTS.target);
          const lufs = await integratedLoudness(d, ctx.measureLoudness);
          if (!Number.isFinite(lufs) || Math.abs(lufs - target) <= 1) return null;
          return `The song measures ${lufs.toFixed(1)} LUFS, more than 1 LU from the ${target} LUFS target. Turn on Use Limiting (or raise Max True Peak) so the gain is not held back, then press Run again.`;
        },
      },
    ],
  },
  {
    id: 'punch-in',
    title: 'Record with punch-in',
    summary: 'Replace one mistake in a take by recording over just that part.',
    minutes: 3,
    setup: (app, ctx) => {
      ctx.doc = voiceFile(app);
    },
    steps: [
      {
        id: 'select',
        title: 'Select the part to replace',
        text: 'Drag across the stretch you want to record again, for example one phrase in the middle.',
        target: () => lanes(),
        drag: { from: [0.3, 0.5], to: [0.45, 0.5] },
        done: { check: (app) => { const d = audio(app); return Boolean(d) && d.hasSelection && seconds(d, d.selection.end - d.selection.start) >= 0.3; } },
      },
      {
        id: 'options',
        title: 'Know your options',
        text: 'Right-click the Record button to choose between inserting at the playhead and recording over what is there. With a selection, recording always replaces just the selection. Press Next.',
        target: '.editor-panel [data-cmd="transport.record"]',
        done: { manual: true },
      },
      {
        id: 'record',
        title: 'Record',
        text: 'Press Record (or Shift+Space) and speak. Your browser asks for the microphone the first time. Recording stops by itself at the end of the selection.',
        command: 'transport.record',
        target: '.editor-panel [data-cmd="transport.record"]',
        done: { check: (app) => !app.recording && app.active?.history?.undoLabel === 'Record' },
      },
      {
        id: 'undo',
        title: 'Not happy? Try again',
        text: 'Undo (Edit > Undo) puts the old take back so you can record again. Press Next when the take is right.',
        command: 'edit.undo',
        done: { manual: true },
      },
    ],
  },
  {
    id: 'export-ranges',
    title: 'Split a file into takes',
    summary: 'Mark the parts you want with range markers and save each one as its own file.',
    minutes: 3,
    setup: (app, ctx) => {
      ctx.doc = voiceFile(app);
    },
    steps: [
      {
        id: 'first-range',
        title: 'Mark the first take',
        text: 'Drag across the first phrase, then choose Edit > Marker > Add Range Marker (or press its shortcut).',
        command: 'marker.addRange',
        menu: ['Edit', 'Marker'],
        done: { check: (app) => rangeCount(audio(app)) >= 1 },
      },
      {
        id: 'more-ranges',
        title: 'Mark two more',
        text: 'Do the same for two more phrases. Range markers count in their own sequence: Range 01, Range 02...',
        target: () => lanes(),
        drag: { from: [0.45, 0.5], to: [0.6, 0.5] },
        done: { check: (app) => rangeCount(audio(app)) >= 3 },
      },
      {
        id: 'markers-panel',
        title: 'Open the Markers panel',
        text: 'Open Window > Markers. Double-click a name to rename a take before exporting.',
        command: 'window.markers',
        menu: ['Window'],
        done: { check: (app) => panelOpen(app, 'markers') },
      },
      {
        id: 'export',
        title: 'Export each range',
        text: 'Press Export Audio within Range Markers in the Markers panel (or File > Export). Each checked range becomes its own file, named after its marker.',
        command: 'file.exportRanges',
        target: '[data-panel="markers"] [aria-label="Export Audio within Range Markers"]',
        done: { command: 'file.exportRanges' },
      },
    ],
  },
];
