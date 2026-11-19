// Workspace panels: Time, Zoom, Transport, Tools, Tracks, Track Panner,
// Playlist and Events, the Track Visibility commands behind the Tracks panel,
// and the event log the Events panel shows (fed by wrapping app.notify and
// app.setStatus and by engine dropout and error reports).

import '../styles/panels-extra.css';
import { registerIcons } from '../ui/icons.js';
import { resolveItems } from '../ui/menubar.js';
import { EventLog } from '../lib/event-log.js';
import { visibilityCommands } from '../multitrack/visibility.js';
import { timePanel } from '../panels/time.js';
import { zoomPanel } from '../panels/zoom.js';
import { transportPanel } from '../panels/transport.js';
import { toolsPanel } from '../panels/tools.js';
import { tracksPanel, tracksMenu } from '../panels/tracks.js';
import { trackPannerPanel } from '../panels/track-panner.js';
import { playlistPanel } from '../panels/playlist.js';
import { eventsPanel } from '../panels/events.js';

// Frequency zoom: the magnifier with a spectrum scale on the left.
const ICONS = {
  'zoom-in-freq': [['circle', { cx: '14', cy: '11', r: '5' }], ['path', { d: 'm17.5 14.5 4 4M12 11h4M14 9v4' }], ['path', { d: 'M4 4v16M4 6h3M4 10h2M4 14h3M4 18h2' }]],
  'zoom-out-freq': [['circle', { cx: '14', cy: '11', r: '5' }], ['path', { d: 'm17.5 14.5 4 4M12 11h4' }], ['path', { d: 'M4 4v16M4 6h3M4 10h2M4 14h3M4 18h2' }]],
};

export function installPanelsExtra(app) {
  registerIcons(ICONS);
  installEventLog(app);
  app.commands.register(visibilityCommands(app));

  const instance = (id) => app.dock?.instances.get(id);
  app.registerPanel({ id: 'time', title: 'Time', create: timePanel, near: ['selection', 'levels'], menu: (a) => a.timeFormatMenuItems?.() || [] });
  app.registerPanel({
    id: 'zoom',
    title: 'Zoom',
    create: zoomPanel,
    near: ['selection', 'levels'],
    menu: (a) => resolveItems(a, ['view.zoomPreset1', 'view.zoomPreset2', 'view.zoomPreset3', '-', 'view.saveZoom1', 'view.saveZoom2', 'view.saveZoom3']),
  });
  app.registerPanel({ id: 'transport', title: 'Transport', create: transportPanel, near: ['levels', 'selection'], menu: (a) => resolveItems(a, ['transport.loop', 'transport.skipSelection']) });
  app.registerPanel({ id: 'tools', title: 'Tools', create: toolsPanel, near: ['properties', 'history'] });
  app.registerPanel({ id: 'tracks', title: 'Tracks', create: tracksPanel, near: ['files', 'media'], menu: tracksMenu });
  app.registerPanel({ id: 'trackPanner', title: 'Track Panner', create: trackPannerPanel, near: ['properties', 'assistant', 'effects'] });
  app.registerPanel({ id: 'playlist', title: 'Playlist', create: playlistPanel, near: ['history', 'markers'], menu: () => instance('playlist')?.menu?.() || [] });
  app.registerPanel({
    id: 'events',
    title: 'Events',
    create: eventsPanel,
    near: ['history', 'markers'],
    menu: (a) =>
      instance('events')?.menu?.() || [{ type: 'cmd', label: 'Clear All', enabled: a.eventLog.entries.length > 0, run: () => a.eventLog.clear() }],
  });
}

/** Feeds app.eventLog from notifications, status messages, the engine and uncaught errors. */
export function installEventLog(app) {
  const log = new EventLog();
  app.eventLog = log;
  const source = () => app.active?.name || 'Audio Studio';

  // Wrap rather than replace: toasts and the status bar work as before.
  const notify = app.notify.bind(app);
  app.notify = (message, opts = {}) => {
    log.add({ type: opts.error ? 'error' : opts.warning ? 'warning' : 'info', name: source(), message });
    return notify(message, opts);
  };
  const setStatus = app.setStatus.bind(app);
  app.setStatus = (message) => {
    if (message && message !== app.statusMessage) log.add({ type: 'info', name: source(), message });
    return setStatus(message);
  };

  app.engine.on?.('underrun', ({ frame }) => {
    const at = app.active ? ` at ${app.formatTime(Math.max(0, Math.round(frame)))}` : '';
    log.add({ type: 'warning', name: source(), message: `Playback dropout${at}: audio data did not arrive in time.` });
  });
  app.engine.on?.('engine-error', (message) => log.add({ type: 'error', name: 'Audio engine', message: `Audio engine error: ${message}` }));

  if (typeof window !== 'undefined') {
    window.addEventListener('error', (e) => {
      if (e?.message) log.add({ type: 'error', name: 'Audio Studio', message: e.message });
    });
    window.addEventListener('unhandledrejection', (e) => {
      const r = e?.reason;
      if (r?.name === 'AbortError') return; // a cancelled operation, not a failure
      log.add({ type: 'error', name: 'Audio Studio', message: r?.message || String(r ?? 'Unknown error') });
    });
  }
  return log;
}
