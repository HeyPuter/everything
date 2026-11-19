// Video feature: video files open with their picture remembered, inserting
// them into a session fills its video track, the Video panel (Window >
// Video) follows the playhead, View > Video Display sets its scaling, the
// video clip commands and the Properties section for the session's video.

import '../styles/video.css';
import { h } from '../lib/dom.js';
import { resolveItems } from '../ui/menubar.js';
import { OPEN_HOOKS } from '../storage/files.js';
import { INSERT_HOOKS } from '../multitrack/insert.js';
import { rememberVideo, insertVideoHook } from '../video/media.js';
import { videoPanel, VIDEO_ZOOMS, VIDEO_RESOLUTIONS, videoZoom } from '../video/video-panel.js';
import { releaseThumbnails } from '../video/video-lane.js';
import { videoClip, videoPool, setVideoClip, updateVideoClip, videoSourceOf } from '../model/session-video.js';

const ZOOM_IDS = { fit: 'view.videoFit', 25: 'view.video25', 50: 'view.video50', 100: 'view.video100', 200: 'view.video200' };
const RES_IDS = { full: 'view.videoResFull', 2: 'view.videoRes2', 4: 'view.videoRes4', 8: 'view.videoRes8' };
const RES_LABELS = { full: 'Full Resolution', 2: '1/2 Resolution', 4: '1/4 Resolution', 8: '1/8 Resolution' };
export const VIDEO_DISPLAY_MENU = [...VIDEO_ZOOMS.map((z) => ZOOM_IDS[z.id]), '-', ...VIDEO_RESOLUTIONS.map((r) => RES_IDS[r.id]), '-', 'view.videoFullOnStop', '-', 'view.videoTimecode'];

export function installVideo(app) {
  OPEN_HOOKS.push(rememberVideo);
  INSERT_HOOKS.push(insertVideoHook);

  const session = () => (app.active?.kind === 'session' ? app.active : null);
  const withVideo = () => Boolean(videoClip(session()?.state));
  const edit = (label, fn) => {
    const doc = session();
    if (doc && videoClip(doc.state)) doc.apply(label, fn(doc.state, doc));
  };

  app.registerPanel({ id: 'video', title: 'Video', create: videoPanel, near: ['properties', 'assistant', 'effects'], menu: (a) => resolveItems(a, VIDEO_DISPLAY_MENU) });

  app.commands.register([
    {
      id: 'window.video',
      label: 'Video',
      enabled: (a) => a.panels.has('video'),
      checked: (a) => Boolean(a.dock?.isOpen('video')),
      run: () => (app.dock.isVisible('video') ? app.dock.closePanel('video') : app.dock.openPanel('video')),
    },
    ...VIDEO_ZOOMS.map((z) => ({
      id: ZOOM_IDS[z.id],
      label: z.label,
      checked: (a) => videoZoom(a) === z.id,
      run: () => {
        app.prefs.set('videoZoom', z.id);
        if (!app.dock?.isOpen('video')) app.dock?.openPanel('video');
      },
    })),
    ...VIDEO_RESOLUTIONS.map((r) => ({
      id: RES_IDS[r.id],
      label: RES_LABELS[r.id],
      checked: (a) => String(a.prefs.get('videoResolution') || 'full') === r.id,
      run: () => app.prefs.set('videoResolution', r.id),
    })),
    { id: 'view.videoFullOnStop', label: 'Full Resolution on Stop', enabled: (a) => String(a.prefs.get('videoResolution') || 'full') !== 'full', checked: (a) => a.prefs.get('videoFullOnStop') !== false, run: () => app.prefs.set('videoFullOnStop', app.prefs.get('videoFullOnStop') === false) },
    { id: 'video.showPanel', label: 'Show Video Panel', enabled: (a) => a.panels.has('video'), run: () => app.dock?.openPanel('video') },
    { id: 'view.videoTimecode', label: 'Show Timecode on Video', checked: (a) => Boolean(a.prefs.get('videoTimecode')), run: () => app.prefs.toggle('videoTimecode') },
    { id: 'video.remove', label: 'Remove Video', enabled: withVideo, run: () => edit('Remove Video', (st) => setVideoClip(st, null)) },
    { id: 'video.toPlayhead', label: 'Move Video Start to Playhead', enabled: () => withVideo() && !videoClip(session().state).locked, run: () => edit('Move Video Clip', (st, doc) => updateVideoClip(st, { start: Math.max(0, Math.round(doc.cursor)) })) },
    { id: 'video.toStart', label: 'Move Video to Session Start', enabled: () => withVideo() && !videoClip(session().state).locked, run: () => edit('Move Video Clip', (st) => updateVideoClip(st, { start: 0 })) },
    { id: 'video.lock', label: 'Lock Video in Time', enabled: withVideo, checked: () => Boolean(videoClip(session()?.state)?.locked), run: () => edit('Lock Video in Time', (st) => updateVideoClip(st, (v) => ({ locked: !v.locked }))) },
  ]);

  app.propertySections = app.propertySections || [];
  app.propertySections.push(videoPropertySection);

  // Closing a session frees the offscreen videos that drew its thumbnails.
  const open = new Set();
  app.on('documents', () => {
    const now = new Set(app.documents.filter((d) => d.kind === 'session'));
    for (const s of open) if (!now.has(s)) for (const src of videoPool(s).values()) releaseThumbnails(src);
    open.clear();
    for (const s of now) open.add(s);
  });
}

/** Properties panel section: the session's video (file, picture size, frame rate, timing). */
export function videoPropertySection(app, doc) {
  if (doc.kind !== 'session') return null;
  const v = videoClip(doc.state);
  if (!v) return null;
  const src = videoSourceOf(doc);
  const fmt = (f) => app.formatTime(f, doc.sampleRate);
  const row = (label, value) => h('div.prop-row', h('span.prop-label', label), h('span.prop-value', { title: value }, value));
  const where = !src?.blob ? 'Offline' : src.path || 'This device';
  return h(
    'section.prop-section',
    h('h3.prop-heading', 'Video'),
    row('Name', v.name),
    row('Location', where),
    row('Resolution', src?.width && src?.height ? `${src.width} × ${src.height}` : 'Unknown'),
    row('Frame Rate', src?.fps ? `${src.fps} fps` : 'Unknown'),
    row('Media Duration', src?.duration ? fmt(Math.round(src.duration * doc.sampleRate)) : 'Unknown'),
    row('Clip Start', fmt(v.start)),
    row('Clip Duration', fmt(v.length)),
    v.offset ? row('Media Offset', fmt(v.offset)) : null,
    v.locked ? row('Locked', 'Yes') : null,
  );
}
