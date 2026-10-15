// File ▸ Import / Export ▸ Subtitles: text strips from / to SubRip (.srt) and WebVTT (.vtt) files.
import { app } from '../app/app';
import { registerFormat } from '../io/files';
import { seqEditor, sceneFps, afterEdit } from './context';
import { newStrip, uniqueName, allStrips, isFree } from './strips';
import { parseSubtitles, subtitlesSrt } from './subtitles';
import { MAX_CHANNELS } from './types';

registerFormat({
  id: 'subtitles',
  label: 'Subtitles (.srt, .vtt)',
  extensions: ['.srt', '.vtt'],
  description: 'Text strips of the sequencer, one per subtitle',
  import: async (file) => {
    const cues = parseSubtitles(await file.text());
    if (!cues.length) throw new Error('No subtitles found in the file');
    const ed = seqEditor();
    const list = ed.strips;
    const fps = sceneFps();
    const f0 = app.doc.scene.frame_start;
    const ranges = cues.map((c) => [f0 + Math.round(c.start * fps), Math.max(f0 + Math.round(c.start * fps) + 1, f0 + Math.round(c.end * fps))] as const);
    // one channel that is free for all of the subtitles
    let channel = 1;
    while (channel < MAX_CHANNELS && !ranges.every(([a, b]) => isFree(list, channel, a, b))) channel++;
    const taken = new Set(allStrips(list).map((s) => s.name));
    for (const s of list) s.select = false;
    cues.forEach((c, i) => {
      const [a, b] = ranges[i];
      const name = uniqueName(ed, 'Subtitle', taken);
      taken.add(name);
      const s = newStrip('TEXT', name, channel, a, b - a);
      s.text = c.text;
      // lower third, a size that reads well at the render height
      s.location = [0.5, 0.1];
      s.anchor_y = 'BOTTOM';
      s.font_size = Math.round(app.doc.scene.render.resolution_y / 18);
      s.use_shadow = true;
      list.push(s);
    });
    afterEdit();
    app.pushUndo('Import Subtitles');
    app.changed('doc');
    app.report('INFO', `Imported ${cues.length} subtitle${cues.length === 1 ? '' : 's'} into channel ${channel}`);
  },
  export: async () => {
    const ed = app.doc.scene.sequence_editor;
    const srt = ed ? subtitlesSrt(ed.strips, sceneFps(), app.doc.scene.frame_start) : '';
    if (!srt) throw new Error('No text strips to export');
    return { bytes: srt, mime: 'text/plain', ext: '.srt' };
  },
});
