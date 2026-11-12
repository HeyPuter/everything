// Multitrack feature: the Session document kind (view, playback graph and
// command overrides), the Mixer panel, session files, Properties sections
// and the glue that keeps sessions in step with their source files.

import '../styles/multitrack.css';
import { registerIcons } from '../ui/icons.js';
import { MULTITRACK_ICONS } from '../multitrack/icons.js';
import { MultitrackView } from '../editor/multitrack-view.js';
import { buildSessionGraph, metronomeBar } from '../model/session-graph.js';
import { Channel } from '../audio/channel.js';
import { installMultitrackCommands } from '../multitrack/commands.js';
import { installSessionStorage } from '../multitrack/storage.js';
import { insertDocs, insertFiles, syncLinkedSources } from '../multitrack/insert.js';
import { TrackControls } from '../multitrack/track-controls.js';
import { SessionRecorder } from '../multitrack/recorder.js';
import { sessionPropertySection } from '../multitrack/properties.js';
import { mixerPanel } from '../panels/mixer.js';
import { followDucking } from '../multitrack/ducking.js';
import { remixerFor } from '../multitrack/remix.js';

export const SESSION_TOOLS = ['move', 'razor', 'slip', 'time'];

function controlsFor(app, doc) {
  if (!doc.controls) doc.controls = new TrackControls(app, doc);
  return doc.controls;
}

export function installMultitrack(app) {
  registerIcons(MULTITRACK_ICONS);
  installSessionStorage();
  const recorder = new SessionRecorder(app);
  app.multitrack = {
    insertDocs: (session, docs, o) => insertDocs(app, session, docs, o),
    insertFiles: (session, files, o) => insertFiles(app, session, files, o),
    toggleRecording: (session) => recorder.toggle(session),
  };
  const overrides = installMultitrackCommands(app);

  let click = null;
  const clickFor = (state) => {
    // A session keeps the sound picked for it; otherwise the last one picked anywhere.
    const sound = state.metronomeSound || app.prefs.get('metronomeSound') || undefined;
    const key = `${state.sampleRate}:${state.tempo}:${state.beatsPerBar}:${sound}`;
    if (!click || click.key !== key) click = { key, channels: metronomeBar(Channel, { ...state, sound }) };
    return click.channels;
  };
  app.registerDocumentKind('session', {
    view: (a, doc) => {
      controlsFor(app, doc);
      return new MultitrackView(app, doc);
    },
    graph: (a, doc) => {
      controlsFor(app, doc);
      const state = doc.state;
      return buildSessionGraph(state, doc.pool, {
        overrides: doc.overrides || {},
        metronome: state.metronome ? clickFor(state) : null,
        metronomeEnd: Math.max(doc.length, doc.extent),
        panLaw: { mode: app.prefs.get('panLaw'), centerDb: app.prefs.get('panLawDb') },
      });
    },
    commands: overrides,
    tools: SESSION_TOOLS,
  });

  app.registerPanel({ id: 'mixer', title: 'Mixer', create: mixerPanel, near: ['editor'] });
  app.propertySections = app.propertySections || [];
  app.propertySections.push(sessionPropertySection);

  app.on('documents', () => {
    for (const d of app.documents) {
      if (d.kind !== 'session') continue;
      controlsFor(app, d);
      // An opened session with remixed clips analyses their music again (and remakes missing remixed media).
      if (!d.remixer && d.state.clips.some((c) => c.remix)) {
        const r = remixerFor(app, d);
        r.sync();
        r.prepare();
      }
    }
  });

  // Edits to a source file in the Waveform editor flow into its clips.
  app.on('doc-change', (doc, e) => {
    if (doc.kind === 'audio' && (e.kind === 'edit' || e.kind === 'history')) syncLinkedSources(app, doc);
    if (doc.kind === 'session' && doc === app.active && e.kind === 'clip-selection') app.emit('properties');
    // Undo, redo and source edits can bring back stretched clips whose audio still needs rendering.
    if (doc.kind === 'session' && doc.stretcher && (e.kind === 'edit' || e.kind === 'history' || e.kind === 'graph')) doc.stretcher.sync();
    // Likewise remixed clips.
    if (doc.kind === 'session' && doc.remixer && (e.kind === 'edit' || e.kind === 'history' || e.kind === 'graph')) doc.remixer.sync();
    // Clip edits that move what a ducked clip reacts to regenerate its keyframes (same undo step).
    if (doc.kind === 'session' && e.kind === 'edit' && doc.history.index > 0) {
      const next = followDucking(doc.history.entries[doc.history.index - 1].state, doc.state);
      if (next !== doc.state) doc.history.amend(next);
    }
  });

  // Automation passes start with playback (or recording, which plays the session) and commit when it stops.
  let playingSession = null;
  // They follow the playhead through loop jumps (meters arrive steadily during playback).
  app.engine.on?.('meters', () => {
    if (playingSession && app.engine.playing && app.active === playingSession) playingSession.controls?.follow(Math.round(app.playhead));
  });
  app.on('transport', (s) => {
    const doc = app.active?.kind === 'session' ? app.active : null;
    if ((s === 'playing' || s === 'recording') && doc && playingSession !== doc) {
      playingSession = doc;
      controlsFor(app, doc).begin();
    } else if (s !== 'playing' && s !== 'recording' && playingSession && !app.engine.playing) {
      const d = playingSession;
      playingSession = null;
      d.controls?.commit(app.engine.lastPos?.frame ?? d.cursor);
    }
  });

  // Each editor keeps its own tool: Move in sessions, Time Selection in waveforms.
  const lastTool = { session: 'move', audio: 'time' };
  app.on('tool', (id) => {
    const k = app.active?.kind;
    if (k) lastTool[k] = id;
  });
  app.on('active', (doc) => {
    const k = doc?.kind;
    if (!k) return;
    const want = lastTool[k];
    if (want && app.tool !== want && app.toolAvailable?.(want) !== false) app.setTool?.(want);
    else if (app.toolAvailable && !app.toolAvailable(app.tool)) app.setTool?.(k === 'session' ? 'move' : 'time');
  });
}
