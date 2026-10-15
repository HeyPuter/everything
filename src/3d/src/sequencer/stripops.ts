// Strip operators: colour tags, changing effect type / source files, reload, swapping data,
// render size, subtitles export, multicam cuts and copying modifiers.
import { app, registerOperators, type Operator } from '../app/app';
import type { ColorTag, Strip, StripType } from './types';
import * as S from './strips';
import { seqList, selectedStrips, activeStrip, hasEditor, afterEdit, sceneFps, isLocked, hoverSeq, seqEditor } from './context';
import { restartPlayback } from './audio';
import { clearMovieCaches, getMovie, loadImage, loadSound, mimeFor } from './media';
import { pickFiles, ACCEPT, fileBytes, fitScale } from './add';
import { download } from '../io/native';
import { subtitlesSrt } from './subtitles';
import { effectTypesFor, changeEffectType, swapData } from './stripdata';
export { effectTypesFor };
import { addFade, clearFade, crossfadeSounds, type FadeType } from './fades';

const anySelected = () => hasEditor() && seqList().some((s) => s.select);
const act = () => (hasEditor() ? activeStrip() : null);

export const COLOR_TAGS: [ColorTag, string][] = [
  ['NONE', 'None'],
  ['COLOR_01', 'Color 01'],
  ['COLOR_02', 'Color 02'],
  ['COLOR_03', 'Color 03'],
  ['COLOR_04', 'Color 04'],
  ['COLOR_05', 'Color 05'],
  ['COLOR_06', 'Color 06'],
  ['COLOR_07', 'Color 07'],
  ['COLOR_08', 'Color 08'],
  ['COLOR_09', 'Color 09'],
];

/** Length in frames of a strip's media (null when it has none or it cannot be read). */
async function mediaLength(s: Strip): Promise<number | null> {
  const fps = sceneFps();
  if (s.type === 'MOVIE' && s.media) {
    const info = await getMovie(s.media.bytes, s.media.mime).info.catch(() => null);
    return info ? Math.max(1, Math.round(info.duration * fps)) : null;
  }
  if (s.type === 'SOUND' && s.media) {
    const buf = await loadSound(s.media.bytes);
    return buf ? Math.max(1, Math.round(buf.duration * fps) - Math.round((s.sound_offset ?? 0) * fps)) : null;
  }
  if (s.type === 'IMAGE' && (s.elements?.length ?? 0) > 1) return s.elements!.length;
  return null;
}

/** Content length changed (new media / reload): keep the start, clamp trims into the content. */
function setContentLength(s: Strip, len: number) {
  s.frame_duration = Math.max(1, len);
  s.animation_offset_start = s.animation_offset_end = 0;
  S.clampOffsets(s);
}

async function replaceSource(s: Strip, files: File[]) {
  const r = app.doc.scene.render;
  if (s.type === 'IMAGE') {
    const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    s.elements = await Promise.all(sorted.map(async (f) => ({ filename: f.name, mime: mimeFor(f.name, f.type), bytes: new Uint8Array(await f.arrayBuffer()) })));
    const bmp = await loadImage(s.elements[0].bytes, s.elements[0].mime);
    s.orig_width = bmp.width;
    s.orig_height = bmp.height;
    if (s.elements.length > 1) setContentLength(s, s.elements.length);
  } else {
    s.media = await fileBytes(files[0]);
    if (s.type === 'MOVIE') {
      const info = await getMovie(s.media.bytes, s.media.mime).info;
      s.orig_width = info.width;
      s.orig_height = info.height;
      s.fps = info.fps || sceneFps();
    }
    const len = await mediaLength(s);
    if (len) setContentLength(s, len);
  }
  if (s.orig_width) {
    const [sx, sy] = fitScale(s.orig_width, s.orig_height ?? 0, r.resolution_x, r.resolution_y);
    s.transform.scale_x = sx;
    s.transform.scale_y = sy;
  }
}

/** Selected multicam strip under the playhead (or any at the playhead). */
function multicamAt(frame: number): Strip | null {
  const list = seqList().filter((s) => s.type === 'MULTICAM' && S.activeAt(s, frame) && !isLocked(s));
  return list.find((s) => s.select) ?? list.find((s) => s === activeStrip()) ?? list[0] ?? null;
}

const ops: Operator[] = [
  {
    idname: 'sequencer.fades_add',
    label: 'Add Fades',
    description: 'Fade the opacity (or volume of sound strips) of the selected strips in and/or out',
    props: [
      { id: 'duration_seconds', label: 'Fade Duration', type: 'float', default: 1, min: 0.01, max: 3600, precision: 2 },
      {
        id: 'type',
        label: 'Fade Type',
        type: 'enum',
        default: 'IN_OUT',
        items: [
          ['IN_OUT', 'Fade In and Out'],
          ['IN', 'Fade In'],
          ['OUT', 'Fade Out'],
          ['CURSOR_FROM', 'From Current Frame'],
          ['CURSOR_TO', 'To Current Frame'],
        ],
      },
    ],
    poll: anySelected,
    exec: (c, p) => {
      const frames = Math.max(1, Math.round((p.duration_seconds as number) * sceneFps()));
      let n = 0;
      for (const s of selectedStrips()) if (!isLocked(s) && addFade(s, p.type as FadeType, frames, c.doc.scene.frame_current)) n++;
      if (!n) {
        app.report('WARNING', 'No fade added (effect strips, or the current frame is outside the strips)');
        return 'CANCELLED';
      }
      restartPlayback();
    },
  },
  {
    idname: 'sequencer.fades_clear',
    label: 'Clear Fades',
    description: 'Remove fade animation from the selected strips',
    poll: () => anySelected() && selectedStrips().some((s) => !!s.keys),
    exec: () => {
      let n = 0;
      for (const s of selectedStrips()) if (clearFade(s)) n++;
      if (!n) return 'CANCELLED';
      restartPlayback();
    },
  },
  {
    idname: 'sequencer.crossfade_sounds',
    label: 'Crossfade Sounds',
    description: 'Fade the volume of two overlapping selected sound strips across each other',
    poll: () => selectedStrips().filter((s) => s.type === 'SOUND').length === 2,
    exec: () => {
      const [a, b] = selectedStrips().filter((s) => s.type === 'SOUND');
      if (!crossfadeSounds(a, b)) {
        app.report('ERROR', 'The sound strips need to overlap');
        return 'CANCELLED';
      }
      restartPlayback();
    },
  },
  {
    idname: 'sequencer.strip_color_tag_set',
    label: 'Set Color Tag',
    description: 'Set a color tag for the selected strips',
    props: [{ id: 'color', label: 'Color Tag', type: 'enum', default: 'NONE', items: COLOR_TAGS }],
    poll: anySelected,
    exec: (_c, p) => {
      for (const s of selectedStrips()) s.color_tag = p.color as ColorTag;
    },
  },
  {
    idname: 'sequencer.change_effect_type',
    label: 'Change Effect Type',
    description: 'Turn the active effect strip into another effect of the same kind',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'CROSS', items: (Object.keys(S.STRIP_LABELS) as StripType[]).filter((t) => effectTypesFor(t).length).map((t) => [t, S.STRIP_LABELS[t]]) }],
    poll: () => !!act() && effectTypesFor(act()!.type).length > 0,
    exec: (_c, p) => {
      const s = act()!;
      const t = p.type as StripType;
      if (!effectTypesFor(s.type).includes(t)) {
        app.report('ERROR', `Cannot change a ${S.STRIP_LABELS[s.type]} strip into ${S.STRIP_LABELS[t]}`);
        return 'CANCELLED';
      }
      changeEffectType(s, t);
      afterEdit();
    },
  },
  {
    idname: 'sequencer.change_path',
    label: 'Change Data/Files',
    description: 'Replace the media of the active strip with other files',
    poll: () => !!act() && ['MOVIE', 'SOUND', 'IMAGE'].includes(act()!.type),
    undo: false,
    invoke: () => {
      const s = act()!;
      const accept = s.type === 'MOVIE' ? ACCEPT.movie : s.type === 'SOUND' ? ACCEPT.sound : ACCEPT.image;
      void pickFiles(accept, s.type === 'IMAGE').then(async (files) => {
        if (!files.length) return;
        try {
          await replaceSource(s, files);
          clearMovieCaches();
          afterEdit();
          app.pushUndo('Change Data/Files');
          app.changed('doc');
          restartPlayback();
        } catch (e) {
          app.report('ERROR', `Cannot use the file: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
      return 'CANCELLED';
    },
  },
  {
    idname: 'sequencer.reload',
    label: 'Reload Strips',
    description: 'Decode the media of the selected strips again, optionally fitting their length to the media',
    props: [{ id: 'adjust_length', label: 'Adjust Length', type: 'bool', default: false }],
    poll: anySelected,
    undo: false,
    exec: (_c, p) => {
      clearMovieCaches();
      app.changed('doc');
      if (!p.adjust_length) return 'CANCELLED';
      const strips = selectedStrips().filter((s) => !isLocked(s));
      void Promise.all(strips.map(async (s) => [s, await mediaLength(s)] as const)).then((res) => {
        let n = 0;
        for (const [s, len] of res)
          if (len && len !== s.frame_duration) {
            setContentLength(s, len);
            n++;
          }
        if (!n) return;
        S.resolveOverlap(seqList(), strips, 'SHUFFLE');
        afterEdit();
        app.pushUndo('Reload Strips and Adjust Length');
        app.changed('doc');
        restartPlayback();
      });
      return 'CANCELLED';
    },
  },
  {
    idname: 'sequencer.swap_data',
    label: 'Sequencer Swap Data',
    description: 'Swap the content of two selected strips, keeping where they are',
    poll: () => selectedStrips().length === 2,
    exec: () => {
      const [a, b] = selectedStrips();
      const err = swapData(a, b);
      if (err) {
        app.report('ERROR', err);
        return 'CANCELLED';
      }
      afterEdit();
      restartPlayback();
    },
  },
  {
    idname: 'sequencer.rendersize',
    label: 'Set Render Size',
    description: 'Set the render resolution to the size of the active strip’s image',
    poll: () => !!act()?.orig_width,
    exec: (c) => {
      const s = act()!;
      const r = c.doc.scene.render;
      r.resolution_x = s.orig_width!;
      r.resolution_y = s.orig_height!;
      r.resolution_percentage = 100;
      s.transform.scale_x = s.transform.scale_y = 1;
      s.transform.offset_x = s.transform.offset_y = 0;
    },
  },
  {
    idname: 'sequencer.export_subtitles',
    label: 'Export Subtitles',
    description: 'Save the text strips as a SubRip (.srt) subtitle file',
    undo: false,
    poll: () => hasEditor() && S.allStrips(seqEditor().strips).some((s) => s.type === 'TEXT'),
    exec: (c) => {
      const srt = subtitlesSrt(seqEditor().strips, sceneFps(), c.doc.scene.frame_start);
      if (!srt) {
        app.report('ERROR', 'No text strips to export');
        return 'CANCELLED';
      }
      download(srt, `${(app.filename || 'untitled').replace(/\.[^.]*$/, '')}.srt`, 'text/plain');
      app.report('INFO', 'Subtitles exported');
    },
  },
  {
    idname: 'sequencer.split_multicam',
    label: 'Split Multicam',
    description: 'Cut the multicam strip at the current frame and switch to another camera channel',
    props: [{ id: 'camera', label: 'Camera', type: 'int', default: 1, min: 1, max: 32 }],
    poll: () => hasEditor() && !!multicamAt(app.doc.scene.frame_current) && hoverSeq()?.hover !== 'preview',
    exec: (c, p) => {
      const f = c.doc.scene.frame_current;
      const m = multicamAt(f);
      if (!m) return 'CANCELLED';
      const cam = p.camera as number;
      if (cam >= m.channel) {
        app.report('ERROR', 'The camera channel must be below the multicam strip');
        return 'CANCELLED';
      }
      let target = m;
      if (S.finalStart(m) < f) {
        const right = S.splitStrips(seqEditor(), seqList(), [m], f, 'SOFT');
        target = right.find((r) => r.type === 'MULTICAM') ?? m;
        m.select = false;
      }
      target.multicam_source = cam;
      target.select = true;
      seqEditor().active_strip = target.name;
      afterEdit();
    },
  },
  {
    idname: 'sequencer.strip_modifier_copy',
    label: 'Copy to Selected Strips',
    description: 'Copy the active strip’s modifiers to the selected strips',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'REPLACE',
        items: [
          ['REPLACE', 'Replace'],
          ['APPEND', 'Append'],
        ],
      },
    ],
    poll: () => !!act()?.modifiers.length && selectedStrips().some((s) => s !== act() && s.type !== 'SOUND'),
    exec: (_c, p) => {
      const src = act()!;
      for (const s of selectedStrips()) {
        if (s === src || s.type === 'SOUND') continue;
        const copies = src.modifiers.map((m) => structuredClone(m));
        if (p.type === 'REPLACE') s.modifiers = copies;
        else
          for (const m of copies) {
            let name = m.name;
            for (let i = 1; s.modifiers.some((x) => x.name === name); i++) name = `${m.name}.${String(i).padStart(3, '0')}`;
            m.name = name;
            s.modifiers.push(m);
          }
      }
    },
  },
];

registerOperators(ops);
