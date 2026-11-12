// Frame animation: the Timeline panel under the canvas, frame commands,
// playback, onion skins, tweening, animated exports (GIF, PNG, WebP), video
// rendering and importing video frames as layers.
import type { Editor } from '../../editor';
import { commands, contributeMenu, registerCommand, registerOverlay, registerPanel, type Command, type MenuItem } from '../../app/registry';
import { formDialog } from '../../ui/dialog';
import { allLayers } from '../../model/document';
import { newPixelLayer } from '../../model/pixel-layer';
import { gridFromImage } from '../../model/tiles';
import {
  adoptFrameLayers,
  createAnimation,
  defaultOnion,
  deleteFrames,
  delayLabel,
  duplicateFrames,
  frameDocument,
  framesFromLayers,
  loopLabel,
  matchLayersAcrossFrames,
  maxDelay,
  onionBlends,
  reverseFrames,
  setFrameDelay,
  syncAnimation,
  tweenFrames,
  type AnimationUnify,
} from '../../model/animation';
import { animationOf, hasAnimation, selectFrame, selectedFrames, setSelectedFrames } from './state';
import { isPlaying, onPlaybackChange, playbackUpdate, stop, togglePlay } from './playback';
import { compositeFrame, frameImage } from './render';
import { timelinePanel } from './panel';
import { lazy, lazyRun } from '../../app/lazy';
import { installVideo, videoCommands, videoFrames, videoPlaybackModule, videoTimelineMenu } from './video';
import { hasTimeline, isVideoPlaying, timelineOf } from './video-state';

// Exporters and the video importer load on first use.
const exporting = lazy(() => import('./export'));
const videoImport = lazy(() => import('./video-import'));

export const delayPresets = [0, 100, 200, 500, 1000, 2000, 5000, 10000];

const docOpen = (e: Editor) => e.hasDocument;
const frameCount = (e: Editor) => animationOf(e)?.frames.length ?? 0;

/** Open the Timeline panel. */
export function showTimeline(e: Editor) {
  if (!e.dock.isVisible('timeline')) e.dock.show('timeline');
}

function ensureAnimation(e: Editor) {
  if (!hasAnimation(e)) e.command('Create Frame Animation', (d) => (d.animation = createAnimation(d)));
}

async function tweenDialog(e: Editor) {
  const anim = animationOf(e)!;
  const sel = selectedFrames(e);
  const pair = sel.length === 2 && sel[1] === sel[0] + 1;
  const options: [string, string][] = [];
  if (pair) options.push(['selection', 'Selected frames']);
  else {
    if (anim.current > 0) options.push(['previous', 'Previous frame']);
    if (anim.current < anim.frames.length - 1) options.push(['next', 'Next frame']);
  }
  if (!options.length) {
    e.message('Select one frame next to another, or two neighboring frames, to tween.');
    return;
  }
  const v = await formDialog(
    'Tween',
    [
      { name: 'with', label: 'Tween with', type: 'select', value: options[0][0], options },
      { name: 'count', label: 'Frames to add', type: 'number', value: 5, min: 1, max: 200, step: 1 },
      { name: 'layers', label: 'Layers', type: 'select', value: 'all', options: [['all', 'All layers'], ['selected', 'Selected layers']] },
      { name: 'position', label: 'Position', type: 'checkbox', value: 'yes' },
      { name: 'opacity', label: 'Opacity', type: 'checkbox', value: 'yes' },
      { name: 'effects', label: 'Effects', type: 'checkbox', value: 'yes' },
    ],
    'Tween',
    'New frames interpolate the layers between two frames.',
  );
  if (!v) return;
  const count = Math.max(1, Math.min(200, Math.round(Number(v.count) || 1)));
  const from = v.with === 'selection' ? sel[0] : v.with === 'previous' ? anim.current - 1 : anim.current;
  const ids = new Set<string>();
  if (v.layers === 'selected') for (const l of allLayers(e.selectedLayers)) ids.add(l.id);
  e.command('Tween', (d) => {
    if (!tweenFrames(d, from, count, { position: v.position === 'yes', opacity: v.opacity === 'yes', effects: v.effects === 'yes', layers: v.layers === 'selected' ? ids : undefined }))
      throw new Error('Too many frames.');
  });
  setSelectedFrames(e, Array.from({ length: count + 2 }, (_, k) => from + k));
  e.update();
}

async function onionSettings(e: Editor) {
  const o = animationOf(e)!.onion ?? defaultOnion;
  const v = await formDialog(
    'Onion Skins',
    [
      // Shows the current state; checked before onion skins were ever set up.
      { name: 'enabled', label: 'Show onion skins', type: 'checkbox', value: animationOf(e)!.onion?.enabled === false ? 'no' : 'yes' },
      { name: 'before', label: 'Frames before', type: 'number', value: o.before, min: 0, max: 8, step: 1 },
      { name: 'after', label: 'Frames after', type: 'number', value: o.after, min: 0, max: 8, step: 1 },
      { name: 'opacity', label: 'Opacity (%)', type: 'number', value: Math.round(o.opacity * 100), min: 5, max: 100, step: 1 },
      { name: 'blend', label: 'Blend mode', type: 'select', value: o.blend ?? 'multiply', options: onionBlends.map((b) => [b, b[0].toUpperCase() + b.slice(1)]) },
    ],
    'OK',
    'Neighboring frames are drawn faintly over the canvas while the Timeline is open.',
  );
  if (!v) return;
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(n) ? n : lo)));
  e.command('Onion Skin Settings', (d) => {
    const blend = onionBlends.find((b) => b === v.blend) ?? 'multiply';
    d.animation!.onion = { enabled: v.enabled === 'yes', before: clamp(Number(v.before), 0, 8), after: clamp(Number(v.after), 0, 8), opacity: clamp(Number(v.opacity), 5, 100) / 100, ...(blend === 'multiply' ? {} : { blend }) };
  });
}

async function flattenFrames(e: Editor) {
  const doc = e.doc;
  const anim = doc.animation!;
  const images: ImageData[] = [];
  for (let i = 0; i < anim.frames.length; i++) {
    e.message(`Rendering frame ${i + 1} of ${anim.frames.length}…`);
    images.push(await compositeFrame(e, frameDocument(doc, i)));
  }
  const layers = images.map((img, i) => newPixelLayer(`Frame ${i + 1}`, doc, gridFromImage(e.assets.tiles, { width: img.width, height: img.height, data: img.data })));
  e.command('Flatten Frames Into Layers', (d) => {
    d.layers.push(...layers);
    adoptFrameLayers(d, d.layers.slice(-layers.length));
  });
  e.selected = layers[anim.current]?.id ?? e.selected;
  e.update();
  e.message(`Flattened ${layers.length} frames into layers.`);
}

async function customDelay(e: Editor) {
  const anim = animationOf(e)!;
  const v = await formDialog('Frame Delay', [{ name: 'seconds', label: 'Delay (seconds)', type: 'number', value: anim.frames[anim.current].delay / 1000, min: 0, max: maxDelay / 1000, step: 0.01 }], 'OK');
  if (!v) return;
  const ms = Number(v.seconds) * 1000;
  if (!Number.isFinite(ms)) return;
  const frames = selectedFrames(e);
  e.command('Frame Delay', (d) => setFrameDelay(d, frames, ms));
}

async function customLoop(e: Editor) {
  const anim = animationOf(e)!;
  const v = await formDialog('Looping', [{ name: 'plays', label: 'Play the animation (times)', type: 'number', value: anim.loop || 1, min: 1, max: 65535, step: 1 }], 'OK');
  if (!v) return;
  const n = Math.max(1, Math.min(65535, Math.round(Number(v.plays) || 1)));
  e.command('Looping', (d) => (d.animation!.loop = n));
}

function unifyCommand(key: keyof AnimationUnify, label: string): Command {
  return {
    id: `animation.unify-${key}`,
    label,
    menu: 'animation.unify',
    enabled: hasAnimation,
    checked: (e) => !!animationOf(e)?.unify?.[key],
    run: (e) =>
      e.command(label, (d) => {
        const u = { ...d.animation!.unify };
        if (u[key]) delete u[key];
        else u[key] = true;
        if (Object.keys(u).length) d.animation!.unify = u;
        else delete d.animation!.unify;
      }),
  };
}

/** Menu of the Timeline panel (frame animation or video timeline). */
export function timelineMenu(e?: Editor): MenuItem[] {
  if (e && hasTimeline(e)) return videoTimelineMenu();
  return [
    'animation.new-frame', 'animation.delete-frames', 'animation.delete', '-',
    'animation.select-all', 'animation.play', '-',
    'animation.tween', 'animation.reverse', '-',
    { label: 'Frame Delay', id: 'animation.delay', items: [] },
    { label: 'Looping', id: 'animation.loop', items: [] },
    '-',
    'animation.frames-from-layers', 'animation.flatten-frames', 'animation.match-layers',
    { label: 'Edits Apply to All Frames', id: 'animation.unify', items: [] },
    '-', 'animation.onion', 'animation.onion-settings', '-',
    'animation.create', 'timeline.create', 'timeline.convert-to-video', '-',
    'file.export-animation', 'file.render-video', 'file.import-video-frames',
  ];
}

export function installAnimation(e: Editor) {
  e.documentHooks.push((doc, before) => syncAnimation(doc, before));
  e.onUpdate(playbackUpdate);
  // Onion skins hide while playing.
  onPlaybackChange(() => e.overlay());
  installVideo(e);
  const animated = hasAnimation;
  const many = (e: Editor) => frameCount(e) > 1;
  // Playback, stepping and onion skins also drive the video timeline.
  const timed = (e: Editor) => animated(e) || hasTimeline(e);
  const step = (how: 'first' | 'previous' | 'next' | 'last', frames: (e: Editor) => void) => async (e: Editor) => {
    if (hasTimeline(e)) await (await videoCommands()).step(e, how);
    else frames(e);
  };
  registerCommand(
    {
      id: 'animation.create',
      label: 'Create Frame Animation',
      enabled: (e) => docOpen(e) && !hasAnimation(e) && !hasTimeline(e),
      description: 'Start a frame animation from the document as it is',
      run: (e) => {
        ensureAnimation(e);
        showTimeline(e);
      },
    },
    {
      id: 'animation.new-frame',
      label: 'New Frame',
      enabled: (e) => docOpen(e) && !hasTimeline(e),
      description: 'Duplicate the selected frames',
      run: (e) => {
        ensureAnimation(e);
        const frames = selectedFrames(e);
        e.command('New Frame', (d) => duplicateFrames(d, frames));
        const cur = animationOf(e)!.current;
        setSelectedFrames(e, Array.from({ length: frames.length }, (_, k) => cur + k), cur);
        showTimeline(e);
        e.update();
      },
    },
    {
      id: 'animation.delete-frames',
      label: 'Delete Frames',
      enabled: many,
      run: (e) => {
        const frames = selectedFrames(e);
        if (frames.length >= frameCount(e)) {
          e.message('An animation keeps at least one frame; use Delete Animation to remove it.');
          return;
        }
        stop(e, false);
        e.command(frames.length > 1 ? 'Delete Frames' : 'Delete Frame', (d) => deleteFrames(d, frames));
        setSelectedFrames(e, [animationOf(e)!.current]);
        e.update();
      },
    },
    {
      id: 'animation.delete',
      label: 'Delete Animation',
      enabled: animated,
      description: 'Remove the frames; the layers keep the current frame',
      run: (e) => {
        stop(e, false);
        e.command('Delete Animation', (d) => delete d.animation);
      },
    },
    {
      id: 'animation.select-all',
      label: 'Select All Frames',
      enabled: many,
      recordable: false,
      run: (e) => {
        setSelectedFrames(e, animationOf(e)!.frames.map((_, i) => i));
        e.update();
      },
    },
    {
      id: 'animation.select-frame',
      label: 'Select Frame',
      hidden: true,
      enabled: animated,
      run: (e, arg) => selectFrame(e, Math.round(Number(arg)) - 1),
    },
    { id: 'animation.first', label: 'First Frame', enabled: timed, recordable: false, run: step('first', (e) => selectFrame(e, 0)) },
    { id: 'animation.previous', label: 'Previous Frame', enabled: timed, recordable: false, run: step('previous', (e) => selectFrame(e, Math.max(0, animationOf(e)!.current - 1))) },
    {
      id: 'animation.next',
      label: 'Next Frame',
      enabled: timed,
      recordable: false,
      run: step('next', (e) => selectFrame(e, Math.min(frameCount(e) - 1, animationOf(e)!.current + 1))),
    },
    { id: 'animation.last', label: 'Last Frame', enabled: timed, recordable: false, run: step('last', (e) => selectFrame(e, frameCount(e) - 1)) },
    {
      id: 'animation.play',
      label: 'Play Animation',
      enabled: (e) => many(e) || (hasTimeline(e) && timelineOf(e)!.duration > 1),
      checked: (e) => isPlaying(e) || isVideoPlaying(e),
      recordable: false,
      run: async (e) => {
        if (hasTimeline(e)) (await videoPlaybackModule()).toggleVideo(e);
        else togglePlay(e);
      },
    },
    {
      id: 'animation.reverse',
      label: 'Reverse Frames',
      enabled: many,
      description: 'Reverse the order of the selected frames, or of all frames',
      run: (e) => {
        const frames = selectedFrames(e);
        e.command('Reverse Frames', (d) => reverseFrames(d, frames));
      },
    },
    { id: 'animation.tween', label: 'Tween…', enabled: many, description: 'Add frames that interpolate position, opacity and effects', run: (e) => tweenDialog(e) },
    {
      id: 'animation.frames-from-layers',
      label: 'Make Frames From Layers',
      enabled: (e) => docOpen(e) && e.doc.layers.length > 1 && !hasTimeline(e),
      description: 'One frame per top-level layer, bottom layer first',
      run: (e) => {
        stop(e, false);
        e.command('Make Frames From Layers', (d) => framesFromLayers(d));
        setSelectedFrames(e, [0]);
        showTimeline(e);
        e.update();
      },
    },
    { id: 'animation.flatten-frames', label: 'Flatten Frames Into Layers', enabled: animated, description: 'A new layer with the composite of each frame', run: (e) => flattenFrames(e) },
    {
      id: 'animation.match-layers',
      label: 'Apply Layer State to All Frames',
      enabled: (e) => many(e) && e.selectedIds.size > 0,
      description: "Copy the selected layers' position, visibility, opacity and style in this frame to every frame",
      run: (e) => {
        const ids = allLayers(e.selectedLayers).map((l) => l.id);
        e.command('Apply Layer State to All Frames', (d) => matchLayersAcrossFrames(d, ids));
      },
    },
    unifyCommand('position', 'Position'),
    unifyCommand('visibility', 'Visibility'),
    unifyCommand('style', 'Layer Style'),
    {
      id: 'animation.onion',
      label: 'Onion Skins',
      enabled: timed,
      checked: (e) => !!(animationOf(e)?.onion ?? timelineOf(e)?.onion)?.enabled,
      run: async (e) => {
        if (hasTimeline(e)) return (await videoCommands()).toggleVideoOnion(e);
        e.command('Onion Skins', (d) => (d.animation!.onion = { ...(d.animation!.onion ?? defaultOnion), enabled: !d.animation!.onion?.enabled }));
      },
    },
    { id: 'animation.onion-settings', label: 'Onion Skin Settings…', enabled: timed, run: async (e) => (hasTimeline(e) ? (await videoCommands()).videoOnionSettings(e) : onionSettings(e)) },
    ...delayPresets.map(
      (ms, i): Command => ({
        id: `animation.delay-${ms}`,
        label: delayLabel(ms),
        menu: 'animation.delay',
        order: i,
        enabled: animated,
        checked: (e) => selectedFrames(e).every((f) => animationOf(e)!.frames[f].delay === ms),
        run: (e) => {
          const frames = selectedFrames(e);
          e.command('Frame Delay', (d) => setFrameDelay(d, frames, ms));
        },
      }),
    ),
    { id: 'animation.delay-custom', label: 'Other…', menu: 'animation.delay', order: 99, enabled: animated, run: (e) => customDelay(e) },
    ...([1, 3, 0] as const).map(
      (n, i): Command => ({
        id: `animation.loop-${n === 0 ? 'forever' : n === 1 ? 'once' : n}`,
        label: loopLabel(n),
        menu: 'animation.loop',
        order: i,
        enabled: animated,
        checked: (e) => animationOf(e)?.loop === n,
        run: (e) => e.command('Looping', (d) => (d.animation!.loop = n)),
      }),
    ),
    { id: 'animation.loop-custom', label: 'Other…', menu: 'animation.loop', order: 99, enabled: animated, checked: (e) => ![0, 1, 3].includes(animationOf(e)?.loop ?? 0), run: (e) => customLoop(e) },
    { id: 'file.export-animation', label: 'Export Animation…', enabled: animated, recordable: false, description: 'Animated GIF, PNG or WebP from the Timeline frames', ...lazyRun(exporting, (m, e) => m.exportAnimation(e)) },
    { id: 'file.render-video', label: 'Render Video…', enabled: timed, recordable: false, description: 'Render the animation or video timeline to a WebM video or a PNG image sequence', ...lazyRun(exporting, (m, e) => m.renderVideo(e)) },
    { id: 'file.import-video-frames', label: 'Video Frames to Layers…', recordable: false, description: 'Open frames of a video as layers, optionally as a frame animation', ...lazyRun(videoImport, (m, e, arg) => m.importVideoFrames(e, arg)) },
  );
  // With an animation, Export GIF writes its frames.
  const gif = commands.get('file.export-gif');
  if (gif) registerCommand({ ...gif, run: async (e, arg) => (hasAnimation(e) ? (await exporting()).exportAnimation(e, 'gif') : gif.run(e, arg)) });
  registerPanel(timelinePanel(timelineMenu));
  contributeMenu('window', ['window.panel.timeline'], 'window.contextual-taskbar');
  registerOverlay('animation-onion', onionOverlay);
}

/** Neighboring frames drawn faintly over the canvas (farthest first). */
function onionOverlay(e: Editor) {
  if (hasTimeline(e)) return videoOnionOverlay(e);
  const anim = animationOf(e);
  const o = anim?.onion;
  if (!anim || !o?.enabled || isPlaying() || !e.dock?.isVisible('timeline') || e.displayDoc !== e.doc) return '';
  const parts: string[] = [];
  const add = (index: number, k: number, count: number) => {
    if (index < 0 || index >= anim.frames.length) return;
    const img = frameImage(e, e.doc, index);
    if (!img) return;
    const opacity = o.opacity * (1 - (k - 1) / Math.max(1, count));
    parts.push(`<image class="onion-skin" href="${img.onion}" x="0" y="0" width="${e.doc.width}" height="${e.doc.height}" preserveAspectRatio="none" opacity="${opacity.toFixed(3)}" style="mix-blend-mode:${o.blend ?? 'multiply'}"/>`);
  };
  for (let k = o.before; k >= 1; k--) add(anim.current - k, k, o.before);
  for (let k = o.after; k >= 1; k--) add(anim.current + k, k, o.after);
  return parts.length ? `<g class="onion-skins" pointer-events="none">${parts.join('')}</g>` : '';
}

/** Onion skins of the video timeline: the frames around the current time. */
function videoOnionOverlay(e: Editor) {
  const tl = timelineOf(e)!;
  const o = tl.onion;
  if (!o?.enabled || isVideoPlaying() || !e.dock?.isVisible('timeline') || e.displayDoc !== e.doc) return '';
  const frames = videoFrames.loaded;
  if (!frames) {
    // Draw again once the frame decoder has loaded.
    void videoFrames().then(() => e.overlay());
    return '';
  }
  const parts: string[] = [];
  const add = (t: number, k: number, count: number) => {
    if (t < 0 || t >= tl.duration) return;
    const img = frames.timeImage(e, e.doc, t);
    if (!img) return;
    const opacity = o.opacity * (1 - (k - 1) / Math.max(1, count));
    parts.push(`<image class="onion-skin" href="${img.onion}" x="0" y="0" width="${e.doc.width}" height="${e.doc.height}" preserveAspectRatio="none" opacity="${opacity.toFixed(3)}" style="mix-blend-mode:${o.blend ?? 'multiply'}"/>`);
  };
  for (let k = o.before; k >= 1; k--) add(tl.current - k, k, o.before);
  for (let k = o.after; k >= 1; k--) add(tl.current + k, k, o.after);
  return parts.length ? `<g class="onion-skins" pointer-events="none">${parts.join('')}</g>` : '';
}
