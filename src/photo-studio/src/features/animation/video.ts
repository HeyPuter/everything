// Video timeline and video layer commands. Registration is eager (menus,
// the Timeline panel and the command search see every command); decoding,
// dialogs, playback and the timeline view load on first use.
import type { Editor } from '../../editor';
import { registerCommand, type Command } from '../../app/registry';
import { lazy, lazyRun } from '../../app/lazy';
import { layerBadges, layerNotes } from '../panels/layers';
import { svg } from '../../app/icons';
import { allLayers } from '../../model/document';
import { clipStates, keyProperties, presentTimeline, syncTimeline, videoFrameAt, canAnimate, type KeyProperty } from '../../model/video-timeline';
import { registerPresentation } from '../../renderer/renderer';
import { hasAnimation } from './state';
import { hasTimeline, isVideoLayer, timelineOf, videoLayerOf, videoView, type VideoLayer } from './video-state';
import { audioCommands, audioMenu, audioSelected, installAudio } from './audio';

export const videoCommands = lazy(() => import('./video-commands'));
// The frame cache budget comes from Preferences → Performance.
let cacheMb = 512;
export const videoFrames = lazy(() =>
  import('./video-frames').then((m) => {
    m.setCacheLimit(cacheMb);
    return m;
  }),
);
export const videoPlaybackModule = lazy(() => import('./video-playback'));

const docOpen = (e: Editor) => e.hasDocument;
const single = (e: Editor) => hasTimeline(e) && e.selectedIds.size === 1 && !!e.layer;
const someSelected = (e: Editor) => hasTimeline(e) && e.selectedIds.size > 0;
const clipTargets = (e: Editor) => someSelected(e) || audioSelected(e);
/** Layer frame of the selected video layer at the current time. */
function currentFrame(e: Editor, l: VideoLayer) {
  const tl = timelineOf(e)!;
  return videoFrameAt(tl, l, clipStates(e.doc, tl.current).get(l.id)?.content ?? tl.current);
}
const altered = (e: Editor) => {
  const l = videoLayerOf(e);
  return !!l && !!l.video.altered?.[currentFrame(e, l)];
};
const selectedKeyCount = (e: Editor) => {
  const tl = timelineOf(e);
  return tl ? videoView(e).keys.filter((k) => tl.clips[k.id]?.keys?.[k.prop]?.some((x) => x.t === k.t)).length : 0;
};
const keyHold = (e: Editor) => {
  const tl = timelineOf(e)!;
  const keys = videoView(e).keys.flatMap((k) => tl.clips[k.id]?.keys?.[k.prop]?.filter((x) => x.t === k.t) ?? []);
  return keys.length > 0 && keys.every((k) => k.hold);
};
const propLabels: Record<KeyProperty, string> = { position: 'Position', opacity: 'Opacity', style: 'Style' };

/** Panel menu in video timeline mode. */
export function videoTimelineMenu() {
  return [
    'animation.play', 'timeline.loop', '-',
    'timeline.split', 'timeline.trim-start', 'timeline.trim-end', 'timeline.transitions', '-',
    'timeline.animate-position', 'timeline.animate-opacity', 'timeline.animate-style', 'timeline.previous-key', 'timeline.next-key',
    'timeline.key-linear', 'timeline.key-hold', 'timeline.delete-keys', '-',
    'timeline.work-start', 'timeline.work-end', 'timeline.work-clear', '-',
    ...audioMenu(), '-',
    'layer.video-new-file', 'layer.video-new-blank', 'layer.video-mute', '-',
    'animation.onion', 'animation.onion-settings', '-',
    'timeline.settings', 'timeline.convert-to-frames', 'timeline.delete', '-',
    'file.render-video',
  ];
}

export function installVideo(e: Editor) {
  registerPresentation(presentTimeline);
  e.documentHooks.push((doc, before) => syncTimeline(doc, before));
  e.onUpdate((e) => videoPlaybackModule.loaded?.videoPlaybackUpdate(e));
  cacheMb = e.preferences.videoCacheSize;
  e.preferenceHooks.push((e) => {
    cacheMb = e.preferences.videoCacheSize;
    videoFrames.loaded?.setCacheLimit(cacheMb);
  });
  const cmd = videoCommands;
  installAudio();
  // Clip commands act on the selected audio clips while any is selected.
  const clipRun = (video: (m: typeof import('./video-commands'), e: Editor) => unknown, audio: (m: typeof import('./audio-commands'), e: Editor) => unknown): Pick<Command, 'run' | 'prefetch'> => ({
    run: async (e) => void (audioSelected(e) ? await audio(await audioCommands(), e) : await video(await cmd(), e)),
    prefetch: cmd.prefetch,
  });
  const stopwatch = (prop: KeyProperty): Command => ({
    id: `timeline.animate-${prop}`,
    label: `Animate ${propLabels[prop]}`,
    enabled: (e) => single(e) && canAnimate(e.layer!, prop),
    checked: (e) => !!timelineOf(e)?.clips[e.selected]?.keys?.[prop],
    description: `Keyframe the layer's ${prop === 'style' ? 'layer style' : prop}: edits at the playhead add keyframes`,
    ...lazyRun(cmd, (m, e, arg) => m.toggleStopwatchCommand(e, prop, arg)),
  });
  registerCommand(
    // Timelines
    { id: 'timeline.create', label: 'Create Video Timeline', enabled: (e) => docOpen(e) && !hasTimeline(e) && !hasAnimation(e), description: 'Animate layers over time with clips, keyframes and video layers', ...lazyRun(cmd, (m, e) => m.createVideoTimeline(e)) },
    { id: 'timeline.convert-to-video', label: 'Convert to Video Timeline', enabled: hasAnimation, description: 'Frames become clip ranges and hold keyframes', ...lazyRun(cmd, (m, e) => m.convertToVideo(e)) },
    { id: 'timeline.convert-to-frames', label: 'Convert to Frame Animation…', enabled: hasTimeline, description: 'Sample the timeline into frames', ...lazyRun(cmd, (m, e) => m.convertToFrames(e)) },
    { id: 'timeline.delete', label: 'Delete Video Timeline', enabled: hasTimeline, description: 'Remove clips and keyframes; layers keep the current time', ...lazyRun(cmd, (m, e) => m.deleteTimeline(e)) },
    { id: 'timeline.settings', label: 'Timeline Settings…', enabled: hasTimeline, description: 'Duration and frame rate', ...lazyRun(cmd, (m, e) => m.timelineSettings(e)) },
    { id: 'timeline.frame-rate', label: 'Timeline Frame Rate', hidden: true, enabled: hasTimeline, ...lazyRun(cmd, (m, e, arg) => m.setFrameRate(e, Number(arg))) },
    { id: 'timeline.go-to', label: 'Go to Time', hidden: true, recordable: false, enabled: hasTimeline, ...lazyRun(cmd, (m, e, arg) => m.goTo(e, Number(arg))) },
    {
      id: 'timeline.loop',
      label: 'Loop Playback',
      enabled: hasTimeline,
      recordable: false,
      checked: (e) => hasTimeline(e) && videoView(e).loop,
      run: (e) => {
        videoView(e).loop = !videoView(e).loop;
        e.update();
      },
    },
    // Clips
    { id: 'timeline.split', label: 'Split at Playhead', enabled: clipTargets, description: 'Cut the selected clips in two at the current time', ...clipRun((m, e) => m.splitAtPlayhead(e), (m, e) => m.splitAudio(e)) },
    { id: 'timeline.trim-start', label: 'Trim Start to Playhead', enabled: clipTargets, ...clipRun((m, e) => m.trimToPlayhead(e, 'start'), (m, e) => m.trimAudio(e, 'start')) },
    { id: 'timeline.trim-end', label: 'Trim End to Playhead', enabled: clipTargets, ...clipRun((m, e) => m.trimToPlayhead(e, 'end'), (m, e) => m.trimAudio(e, 'end')) },
    { id: 'timeline.transitions', label: 'Transitions…', enabled: single, description: 'Fades, fades with color and cross fades at the clip ends', ...lazyRun(cmd, (m, e) => m.transitionsDialog(e)) },
    { id: 'timeline.work-start', label: 'Set Start of Work Area', enabled: hasTimeline, ...lazyRun(cmd, (m, e) => m.setWorkArea(e, 'start')) },
    { id: 'timeline.work-end', label: 'Set End of Work Area', enabled: hasTimeline, ...lazyRun(cmd, (m, e) => m.setWorkArea(e, 'end')) },
    { id: 'timeline.work-clear', label: 'Clear Work Area', enabled: (e) => !!timelineOf(e)?.work, ...lazyRun(cmd, (m, e) => m.setWorkArea(e, 'clear')) },
    // Keyframes
    ...keyProperties.map(stopwatch),
    { id: 'timeline.toggle-key', label: 'Add or Remove Keyframe', hidden: true, enabled: hasTimeline, ...lazyRun(cmd, (m, e, arg) => m.toggleKeyCommand(e, arg)) },
    { id: 'timeline.previous-key', label: 'Previous Keyframe', enabled: someSelected, recordable: false, ...lazyRun(cmd, (m, e) => m.gotoKey(e, -1)) },
    { id: 'timeline.next-key', label: 'Next Keyframe', enabled: someSelected, recordable: false, ...lazyRun(cmd, (m, e) => m.gotoKey(e, 1)) },
    { id: 'timeline.key-linear', label: 'Linear Interpolation', enabled: (e) => selectedKeyCount(e) > 0, checked: (e) => selectedKeyCount(e) > 0 && !keyHold(e), ...lazyRun(cmd, (m, e) => m.setKeyInterpolation(e, false)) },
    { id: 'timeline.key-hold', label: 'Hold Interpolation', enabled: (e) => selectedKeyCount(e) > 0, checked: (e) => selectedKeyCount(e) > 0 && keyHold(e), ...lazyRun(cmd, (m, e) => m.setKeyInterpolation(e, true)) },
    { id: 'timeline.delete-keys', label: 'Delete Keyframes', enabled: (e) => selectedKeyCount(e) > 0, ...lazyRun(cmd, (m, e) => m.deleteSelectedKeys(e)) },
    // Video layers
    { id: 'layer.video-new-file', label: 'New Video Layer from File…', recordable: false, enabled: (e) => !e.hasDocument || !e.doc.layers.some((l) => l.artboard), description: 'Add a video file as a layer on the video timeline', ...lazyRun(cmd, (m, e, arg) => m.newVideoLayerFromFile(e, arg)) },
    { id: 'layer.video-new-blank', label: 'New Blank Video Layer', enabled: (e) => docOpen(e) && !e.doc.layers.some((l) => l.artboard), description: 'A layer with a blank frame for every frame of the timeline, painted frame by frame', ...lazyRun(cmd, (m, e) => m.newBlankVideoLayer(e)) },
    { id: 'layer.video-insert-frame', label: 'Insert Blank Frame', enabled: (e) => !!videoLayerOf(e), ...lazyRun(cmd, (m, e) => m.insertFrame(e)) },
    { id: 'layer.video-duplicate-frame', label: 'Duplicate Frame', enabled: (e) => !!videoLayerOf(e), ...lazyRun(cmd, (m, e) => m.duplicateVideoFrame(e)) },
    { id: 'layer.video-delete-frame', label: 'Delete Frame', enabled: (e) => (videoLayerOf(e)?.video.frames ?? 0) > 1, ...lazyRun(cmd, (m, e) => m.deleteVideoFrame(e)) },
    { id: 'layer.video-replace', label: 'Replace Footage…', recordable: false, enabled: (e) => !!videoLayerOf(e), ...lazyRun(cmd, (m, e, arg) => m.replaceFootage(e, arg)) },
    { id: 'layer.video-interpret', label: 'Interpret Footage…', enabled: (e) => !!videoLayerOf(e), description: 'Frame rate, alpha channel and looping of a video layer', ...lazyRun(cmd, (m, e) => m.interpretFootage(e)) },
    { id: 'layer.video-show-altered', label: 'Show Altered Video', enabled: hasTimeline, checked: (e) => hasTimeline(e) && !timelineOf(e)!.hideAltered, description: 'Show painted frames (off shows the original footage)', ...lazyRun(cmd, (m, e) => m.toggleShowAltered(e)) },
    { id: 'layer.video-restore-frame', label: 'Restore Frame', enabled: altered, description: 'Discard the changes to the current frame', ...lazyRun(cmd, (m, e) => m.restoreFrame(e)) },
    { id: 'layer.video-restore-all', label: 'Restore All Frames', enabled: (e) => !!videoLayerOf(e)?.video.altered, ...lazyRun(cmd, (m, e) => m.restoreAllFrames(e)) },
    { id: 'layer.video-reload-frame', label: 'Reload Frame', enabled: (e) => !!videoLayerOf(e)?.video.footage, description: 'Decode the current frame from the footage again', ...lazyRun(cmd, (m, e) => m.reloadFrame(e)) },
    { id: 'layer.video-rasterize', label: 'Rasterize', enabled: (e) => hasTimeline(e) && allLayers(e.selectedLayers).some(isVideoLayer), description: 'Keep the current frame as an ordinary pixel layer', ...lazyRun(cmd, (m, e) => m.rasterizeVideo(e)) },
    { id: 'layer.rasterize-video', label: 'Video', enabled: (e) => hasTimeline(e) && allLayers(e.selectedLayers).some(isVideoLayer), description: 'Keep the current frame of a video layer as pixels', ...lazyRun(cmd, (m, e) => m.rasterizeVideo(e)) },
    { id: 'edit.purge-video-cache', label: 'Video Cache', recordable: false, description: 'Free the decoded video frames kept in memory', ...lazyRun(cmd, (m, e) => m.purgeCache(e)) },
  );
  // Layers panel: a film badge and the frame shown.
  layerBadges.push((e, l) => (isVideoLayer(l) && hasTimeline(e) ? `<span class="video-badge" title="Video layer" aria-label="Video layer">${svg('film', 11)}</span>` : ''));
  layerNotes.push((e, l) => {
    if (!isVideoLayer(l) || !hasTimeline(e)) return undefined;
    const k = currentFrame(e, l);
    return `video · frame ${k + 1} of ${l.video.frames}${l.video.altered?.[k] ? ' · altered' : ''}`;
  });
}
