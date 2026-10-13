import { expect, test, type Page } from '@playwright/test';
import { boot, downloadFrom, historyLabels, idle, openImage, run } from './helpers';
import { decodeWav, encodeWav } from '../../src/imaging/codecs/wav';
import { ebmlIds, readEbml, type EbmlNode } from '../../src/imaging/codecs/webm';
import { demuxWebm } from '../../src/imaging/codecs/webm-demux';

/** A 2 s, 440 Hz tone (amplitude 0.5) at 48 kHz as a WAV file, base64. */
function toneWav(seconds = 2, rate = 48000) {
  const ch = Float32Array.from({ length: seconds * rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return Buffer.from(encodeWav([ch], rate)).toString('base64');
}
const timeline = (page: Page) => page.evaluate(() => window.photoStudio.doc.timeline!);
/** Peak level of `ch` over seconds [a, b). */
const peak = (ch: Float32Array, rate: number, a: number, b: number) => {
  let m = 0;
  for (let i = Math.round(a * rate); i < Math.min(ch.length, Math.round(b * rate)); i++) m = Math.max(m, Math.abs(ch[i]));
  return m;
};
const uintOf = (d: Uint8Array) => d.reduce((v, x) => v * 256 + x, 0);
/** Tracks and audio block times of a WebM file. */
function webmAudio(bytes: Uint8Array) {
  const [, segment] = readEbml(bytes);
  const find = (nodes: EbmlNode[], id: number) => nodes.find((n) => n.id === id);
  const entries = find(segment.children!, ebmlIds.Tracks)!.children!.filter((n) => n.id === ebmlIds.TrackEntry);
  const tracks = entries.map((t) => ({ number: uintOf(find(t.children!, ebmlIds.TrackNumber)!.data), type: uintOf(find(t.children!, ebmlIds.TrackType)!.data), codec: new TextDecoder().decode(find(t.children!, ebmlIds.CodecID)!.data) }));
  const audio = tracks.find((t) => t.type === 2);
  const times = segment
    .children!.filter((n) => n.id === ebmlIds.Cluster)
    .flatMap((c) => {
      const t0 = uintOf(find(c.children!, ebmlIds.Timestamp)!.data);
      return c.children!.filter((b) => b.id === ebmlIds.SimpleBlock && (b.data[0] & 0x7f) === audio?.number).map((b) => t0 + new DataView(b.data.buffer, b.data.byteOffset + 1, 2).getInt16(0));
    });
  return { tracks, times };
}
/** Decode the sound of a media file in the page (48 kHz, first channel). */
async function decodeInPage(page: Page, bytes: Uint8Array) {
  const samples = await page.evaluate(async (b64) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buffer = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(data.buffer);
    return Array.from(buffer.getChannelData(0));
  }, Buffer.from(bytes).toString('base64'));
  return Float32Array.from(samples);
}
/** Drag from the middle of `box` by `dx` (and `dy`) pixels. */
async function drag(page: Page, box: { x: number; y: number; width: number; height: number }, dx: number, dy = 0) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
  await page.mouse.up();
  await idle(page);
}

/** Add a 1 s WebM (VP8 pictures, a 330 Hz Opus tone; written with the
 * app's own writer) as a video layer. */
async function addFootage(page: Page) {
  await page.evaluate(async () => {
    const { muxWebm } = await import('/src/imaging/codecs/webm.ts');
    const chunks: { data: Uint8Array; timestampMs: number; key: boolean }[] = [];
    const ve = new VideoEncoder({
      output: (c) => {
        const data = new Uint8Array(c.byteLength);
        c.copyTo(data);
        chunks.push({ data, timestampMs: c.timestamp / 1000, key: c.type === 'key' });
      },
      error: (err) => console.warn(err),
    });
    ve.configure({ codec: 'vp8', width: 32, height: 32, bitrate: 200_000, framerate: 10 });
    for (let k = 0; k < 10; k++) {
      const frame = new VideoFrame(new Uint8ClampedArray(32 * 32 * 4).fill(25 * k), { format: 'RGBA', codedWidth: 32, codedHeight: 32, timestamp: k * 100_000, duration: 100_000 });
      ve.encode(frame, { keyFrame: k === 0 });
      frame.close();
    }
    await ve.flush();
    const { encodeOpus } = await import('/src/features/animation/audio-export.ts');
    const tone = Float32Array.from({ length: 48000 }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 330 * i) / 48000));
    const audio = await encodeOpus(window.photoStudio, [tone, tone]);
    const bytes = muxWebm(chunks, { width: 32, height: 32, codec: 'V_VP8', frameRate: 10, audio });
    await window.photoStudio.runCommand('layer.video-new-file', new File([bytes], 'tone.webm', { type: 'video/webm' }));
  });
  await idle(page);
}

test.describe('audio tracks', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    await page.evaluate(() => localStorage.removeItem('photo-studio-bottom-dock'));
  });

  test('imports audio, edits clips, renders video with sound and WAV, and keeps audio in projects', async ({ page }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await openImage(page, 64, 48, '#ffffff', 'sound.png');
    await run(page, 'timeline.create');
    expect(await timeline(page)).toMatchObject({ fps: 30, duration: 150 });
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await window.photoStudio.runCommand('timeline.audio-add', new File([bytes], 'tone.wav', { type: 'audio/wav' }));
    }, toneWav());
    await idle(page);
    let tl = await timeline(page);
    expect(tl.audio).toHaveLength(1);
    expect(tl.audio![0].clips[0]).toMatchObject({ start: 0, in: 0, length: 2, source: { name: 'tone.wav', channels: 1, sampleRate: 48000, seconds: 2 } });
    const panel = page.locator('.panel-body[aria-label="Timeline"]');
    const clip = panel.locator('.vt-clip.audio');
    await expect(clip).toHaveCount(1);
    // The waveform is drawn once the sound is decoded.
    await expect(clip.locator('.vt-wave path')).toHaveCount(1);
    expect((await clip.locator('.vt-wave path').getAttribute('d'))!.length).toBeGreaterThan(100);
    await expect(page.locator('.vt-audio-props')).toBeVisible();
    const zoom = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.vt-grid')!).getPropertyValue('--zoom').replace('px', '')));

    // Move the clip 15 frames (0.5 s) to the right.
    await drag(page, (await clip.boundingBox())!, 15 * zoom);
    tl = await timeline(page);
    expect(tl.audio![0].clips[0].start).toBeCloseTo(0.5, 5);
    // Trim its end by 15 frames.
    await drag(page, (await clip.locator('[data-trim="end"]').boundingBox())!, -15 * zoom);
    tl = await timeline(page);
    expect(tl.audio![0].clips[0]).toMatchObject({ in: 0 });
    expect(tl.audio![0].clips[0].length).toBeCloseTo(1.5, 5);
    // A move that ends near the playhead snaps to it.
    await run(page, 'timeline.go-to', 20);
    await drag(page, (await clip.boundingBox())!, 4.3 * zoom);
    expect((await timeline(page)).audio![0].clips[0].start).toBeCloseTo(20 / 30, 5);
    await run(page, 'edit.undo');
    expect((await timeline(page)).audio![0].clips[0].start).toBeCloseTo(0.5, 5);

    // Split at 1 s.
    await run(page, 'timeline.go-to', 30);
    await run(page, 'timeline.split');
    tl = await timeline(page);
    const [a, b] = tl.audio![0].clips;
    expect(a).toMatchObject({ start: 0.5, in: 0 });
    expect(a.length).toBeCloseTo(0.5, 5);
    expect(b).toMatchObject({ start: 1, in: 0.5 });
    expect(b.length).toBeCloseTo(1, 5);
    await expect(clip).toHaveCount(2);
    // Gain and fade of the first part from the properties bar.
    await page.evaluate((id) => (async () => (await import('/src/features/animation/video-state.ts')).videoView(window.photoStudio).audioClips = [id])(), a.id);
    await page.evaluate(() => window.photoStudio.update());
    const gain = page.locator(`.vt-audio-props input[data-audio="gain"][data-clip="${a.id}"]`);
    await expect(gain).toHaveCount(1);
    await gain.evaluate((el: HTMLInputElement) => {
      el.value = '-6';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await idle(page);
    await page.locator('.vt-audio-props input[data-audio="fadeIn"]').fill('0.25');
    await page.locator('.vt-audio-props input[data-audio="fadeIn"]').dispatchEvent('change');
    await idle(page);
    tl = await timeline(page);
    expect(tl.audio![0].clips[0]).toMatchObject({ gain: -6, fadeIn: 0.25 });
    // Track volume, then undo it; mute and solo toggle the track.
    await run(page, 'timeline.audio-set', { track: tl.audio![0].id, volume: -3 });
    expect((await timeline(page)).audio![0].volume).toBe(-3);
    await run(page, 'edit.undo');
    expect((await timeline(page)).audio![0].volume).toBeUndefined();
    await run(page, 'timeline.audio-track-mute', tl.audio![0].id);
    expect((await timeline(page)).audio![0].muted).toBe(true);
    await expect(panel.locator('.vt-clip.audio.muted')).toHaveCount(2);
    await run(page, 'timeline.audio-track-mute', tl.audio![0].id);
    // A second track with a duplicate of the second part; solo plays only it.
    await page.evaluate((id) => (async () => (await import('/src/features/animation/video-state.ts')).videoView(window.photoStudio).audioClips = [id])(), b.id);
    await run(page, 'timeline.audio-duplicate');
    tl = await timeline(page);
    expect(tl.audio![0].clips).toHaveLength(3);
    expect(tl.audio![0].clips[2]).toMatchObject({ start: 2, in: 0.5 });
    await run(page, 'timeline.audio-delete');
    expect((await timeline(page)).audio![0].clips).toHaveLength(2);
    await run(page, 'timeline.audio-track-new');
    // Drag the second part down onto the new track, then undo.
    const second = panel.locator(`[data-audio-clip="${b.id}"]`);
    await panel.locator('.vt-body').evaluate((el) => (el.scrollTop = el.scrollHeight));
    const row2 = (await panel.locator(`[data-audio-row="${(await timeline(page)).audio![1].id}"]`).boundingBox())!;
    const from = (await second.boundingBox())!;
    await drag(page, from, 0, row2.y + row2.height / 2 - (from.y + from.height / 2));
    tl = await timeline(page);
    expect(tl.audio![0].clips.map((c) => c.id)).toEqual([a.id]);
    expect(tl.audio![1].clips).toEqual([expect.objectContaining({ id: b.id, start: 1 })]);
    await run(page, 'edit.undo');
    // The fade out handle of the second part drags to set its fade.
    const handle = (await second.locator('[data-afade="out"]').boundingBox())!;
    await drag(page, handle, -9 * zoom);
    expect((await timeline(page)).audio![0].clips[1].fadeOut).toBeCloseTo(0.3, 2);
    await run(page, 'edit.undo');
    expect((await timeline(page)).audio![0].clips[1].fadeOut).toBeUndefined();
    // Scrubbing with audio scrubbing on plays snippets without errors.
    await run(page, 'timeline.audio-scrub');
    const ruler = (await panel.locator('.vt-ruler').boundingBox())!;
    await page.mouse.move(ruler.x + 31 * zoom, ruler.y + ruler.height / 2);
    await page.mouse.down();
    await page.mouse.move(ruler.x + 40 * zoom, ruler.y + ruler.height / 2, { steps: 4 });
    await page.mouse.up();
    await idle(page);
    await run(page, 'timeline.audio-scrub');
    await run(page, 'timeline.audio-track-solo', (await timeline(page)).audio![1].id);
    expect((await timeline(page)).audio![1]).toMatchObject({ name: 'Audio 2', solo: true, clips: [] });
    await expect(panel.locator('.vt-clip.audio.muted')).toHaveCount(2);
    await run(page, 'timeline.audio-track-delete', (await timeline(page)).audio![1].id);
    expect((await timeline(page)).audio).toHaveLength(1);

    // Playback starts the sound with the pictures.
    await run(page, 'timeline.go-to', 0);
    await panel.locator('.timeline-play').click();
    await expect.poll(() => page.evaluate(async () => (await import('/src/features/animation/audio-playback.ts')).isAudioPlaying())).toBe(true);
    await panel.locator('.timeline-play').click();
    await idle(page);
    expect(await page.evaluate(async () => (await import('/src/features/animation/audio-playback.ts')).isAudioPlaying())).toBe(false);
    await run(page, 'timeline.go-to', 0);

    // Render Video: the WebM has an Opus track whose sound sits where the clips are.
    await page.evaluate(() => void window.photoStudio.runCommand('file.render-video'));
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toContainText('Render Video');
    await dialog.locator('select[name="output"]').selectOption('webm');
    await dialog.locator('select[name="range"]').selectOption('all');
    await dialog.locator('select[name="fps"]').selectOption('12');
    await expect(dialog.locator('input[name="audio"]')).toBeChecked();
    const webm = await downloadFrom(page, () => dialog.getByRole('button', { name: 'Render' }).click());
    await idle(page);
    const bytes = new Uint8Array(webm.bytes);
    expect(demuxWebm(bytes).frames).toHaveLength(60);
    const parsed = webmAudio(bytes);
    expect(parsed.tracks).toEqual([{ number: 1, type: 1, codec: 'V_VP9' }, { number: 2, type: 2, codec: 'A_OPUS' }]);
    expect(parsed.times.length).toBeGreaterThan(200);
    expect(parsed.times[0]).toBeLessThan(30);
    expect(parsed.times.at(-1)!).toBeGreaterThan(4900);
    const sound = await decodeInPage(page, bytes);
    expect(sound.length / 48000).toBeGreaterThan(4.9);
    expect(peak(sound, 48000, 0.05, 0.45)).toBeLessThan(0.02);
    expect(peak(sound, 48000, 0.8, 0.95)).toBeGreaterThan(0.15);
    expect(peak(sound, 48000, 0.8, 0.95)).toBeLessThan(0.35);
    expect(peak(sound, 48000, 1.2, 1.9)).toBeGreaterThan(0.4);
    expect(peak(sound, 48000, 2.2, 4.8)).toBeLessThan(0.02);

    // WAV audio only: the exact mix (gain -6 dB and the fade on the first part).
    await page.evaluate(() => void window.photoStudio.runCommand('file.render-video'));
    await expect(dialog).toContainText('Render Video');
    await dialog.locator('select[name="output"]').selectOption('wav');
    await dialog.locator('select[name="range"]').selectOption('all');
    const wav = await downloadFrom(page, () => dialog.getByRole('button', { name: 'Render' }).click());
    await idle(page);
    expect(wav.name).toMatch(/\.wav$/);
    const mix = decodeWav(new Uint8Array(wav.bytes));
    expect(mix.sampleRate).toBe(48000);
    expect(mix.channels).toHaveLength(2);
    expect(mix.channels[0].length).toBe(5 * 48000);
    const [l] = mix.channels;
    expect(peak(l, 48000, 0, 0.5)).toBe(0);
    // Half way through the fade in: 0.5 × 0.501 × 0.5.
    expect(peak(l, 48000, 0.62, 0.63)).toBeCloseTo(0.5 * 0.501 * 0.5, 1);
    expect(peak(l, 48000, 0.8, 0.99)).toBeCloseTo(0.5 * 0.501, 2);
    expect(peak(l, 48000, 1.0, 2.0)).toBeCloseTo(0.5, 2);
    expect(peak(l, 48000, 2.0, 5)).toBe(0);

    // The project keeps the clips and the sound; reopening draws the waveforms again.
    const project = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { serialize } = await import('/src/model/serialization.ts');
      const blob = await serialize(e.doc, e.assets);
      const { purgeAudioCache } = await import('/src/features/animation/audio-media.ts');
      purgeAudioCache();
      const { openFile } = await import('/src/features/files/open.ts');
      await openFile(e, new File([blob], 'sound.photo'), 'sound.photo');
      return e.doc.timeline!.audio;
    });
    await idle(page);
    expect(project).toEqual((await page.evaluate(() => window.photoStudio.sessions[0].doc.timeline!.audio)));
    expect(project![0].clips.map((c) => [c.start, c.length])).toEqual([[0.5, expect.closeTo(0.5, 5)], [1, expect.closeTo(1, 5)]]);
    await page.evaluate(() => window.photoStudio.dock.show('timeline'));
    await expect(panel.locator('.vt-clip.audio .vt-wave path')).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test('links the sound of video footage, follows its clip, mutes and unlinks', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await openImage(page, 64, 48, '#ffffff', 'footage.png');
    await addFootage(page);
    const layer = await page.evaluate(() => window.photoStudio.doc.layers.find((l) => l.video)!);
    expect(layer.video!.audio).toMatchObject({ asset: layer.video!.footage!.asset, channels: 2, sampleRate: 48000 });
    expect(layer.video!.audio!.seconds).toBeGreaterThan(0.9);
    let tl = await timeline(page);
    expect(tl.audio![0].clips).toEqual([expect.objectContaining({ link: layer.id })]);
    const panel = page.locator('.panel-body[aria-label="Timeline"]');
    const linked = panel.locator('.vt-clip.audio.linked');
    await expect(linked).toHaveCount(1);
    await expect(linked.locator('.vt-wave path')).toHaveCount(1);
    await expect(panel.locator(`[data-video-mute="${layer.id}"]`)).toBeVisible();

    // Dragging the linked sound moves the video clip (whole frames).
    await page.evaluate(() => window.photoStudio.command('Longer', (d) => (d.timeline!.duration = 40)));
    await idle(page);
    const zoom = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.vt-grid')!).getPropertyValue('--zoom').replace('px', '')));
    await drag(page, (await linked.boundingBox())!, 5 * zoom);
    tl = await timeline(page);
    expect(tl.clips[layer.id].start).toBe(5);
    const span = await page.evaluate(async () => {
      const { clipSpan } = await import('/src/model/audio-timeline.ts');
      const d = window.photoStudio.doc;
      return clipSpan(d, d.timeline!.audio![0].clips[0]);
    });
    expect(span).toMatchObject({ start: 0.5, in: 0, linked: true });

    // Mute the video layer's sound: the plan is silent; the button shows it.
    await run(page, 'layer.video-mute');
    expect((await page.evaluate(() => window.photoStudio.doc.layers.find((l) => l.video)!.video!.muted))).toBe(true);
    await expect(panel.locator(`[data-video-mute="${layer.id}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.locator('.vt-clip.audio.linked.muted')).toHaveCount(1);
    await run(page, 'layer.video-mute');

    // Unlink: the clip keeps its place and plays the footage sound on its own.
    await page.evaluate(() => (async () => {
      const e = window.photoStudio;
      (await import('/src/features/animation/video-state.ts')).videoView(e).audioClips = [e.doc.timeline!.audio![0].clips[0].id];
    })());
    await run(page, 'timeline.audio-unlink');
    tl = await timeline(page);
    expect(tl.audio![0].clips[0].link).toBeUndefined();
    expect(tl.audio![0].clips[0]).toMatchObject({ start: 0.5, in: 0, source: { asset: layer.video!.footage!.asset } });
    await expect(panel.locator('.vt-clip.audio.linked')).toHaveCount(0);
    await run(page, 'edit.undo');
    expect((await timeline(page)).audio![0].clips[0].link).toBe(layer.id);
    // Deleting the video layer removes its linked sound.
    await page.evaluate((id) => window.photoStudio.command('Delete', (d) => (d.layers = d.layers.filter((l) => l.id !== id))), layer.id);
    await idle(page);
    expect((await timeline(page)).audio![0].clips).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('playback schedules the same sound as the offline mix', async ({ page }) => {
    await openImage(page, 32, 32, '#ffffff', 'schedule.png');
    await run(page, 'timeline.create');
    await page.evaluate(async (b64) => {
      const e = window.photoStudio;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await e.runCommand('timeline.audio-add', new File([bytes], 'a.wav', { type: 'audio/wav' }));
      await e.runCommand('timeline.audio-track-new');
      await e.runCommand('timeline.go-to', 15);
      await e.runCommand('timeline.audio-add', new File([bytes], 'b.wav', { type: 'audio/wav' }));
      const [t1, t2] = e.doc.timeline!.audio!;
      await e.runCommand('timeline.audio-set', { clip: t1.clips[0].id, gain: -6, fadeIn: 0.25, fadeOut: 0.5 });
      await e.runCommand('timeline.audio-set', { track: t2.id, volume: -9.5 });
      // Overlapping fades on the 2 s clip: they meet where the ramps cross.
      await e.runCommand('timeline.audio-set', { clip: t2.clips[0].id, fadeIn: 1.4, fadeOut: 1.5 });
    }, toneWav());
    await idle(page);
    const diff = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { audioPlan } = await import('/src/model/audio-timeline.ts');
      const { mixPlan } = await import('/src/imaging/audio/mix.ts');
      const { audioPcm } = await import('/src/features/animation/audio-media.ts');
      const { scheduleSegment } = await import('/src/features/animation/audio-playback.ts');
      const plan = audioPlan(e.doc);
      const rate = 48000;
      const ctx = new OfflineAudioContext(2, rate * 3, rate);
      // Playback from 0.25 s: the segment [0.25, 3) starts at context time 0.
      scheduleSegment(ctx, ctx.destination, plan, 0.25, 3, 0);
      const live = await ctx.startRendering();
      const mix = mixPlan(plan, (p) => audioPcm(p.source), 0.25, 3.25, rate, 2);
      let worst = 0;
      let level = 0;
      for (let c = 0; c < 2; c++) {
        const a = live.getChannelData(c);
        for (let i = 0; i < Math.round(2.75 * rate); i++) {
          worst = Math.max(worst, Math.abs(a[i] - mix[c][i]));
          level = Math.max(level, Math.abs(mix[c][i]));
        }
      }
      return { worst, level, items: plan.length };
    });
    expect(diff.items).toBe(2);
    expect(diff.level).toBeGreaterThan(0.3);
    expect(diff.worst).toBeLessThan(2e-3);
  });
});

test.describe('audio edge cases', () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    await page.evaluate(() => localStorage.removeItem('photo-studio-bottom-dock'));
  });

  test('looping footage extended before its start plays, scrubs and schedules every clip', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await openImage(page, 32, 32, '#ffffff', 'loop.png');
    await addFootage(page);
    await page.evaluate(async (b64) => {
      const e = window.photoStudio;
      const id = e.doc.layers.find((l) => l.video)!.id;
      // Looping footage, its clip trimmed 0.5 s before the footage starts.
      e.command('Loop', (d) => {
        d.layers.find((l) => l.id === id)!.video!.loops = 0;
        d.timeline!.duration = 60;
        d.timeline!.clips[id] = { start: 3, in: 0, length: 10 };
      });
      const { trimClipStart, contentLength } = await import('/src/model/video-timeline-ops.ts');
      e.command('Trim', (d) => (d.timeline!.clips[id] = trimClipStart(d.timeline!.clips[id], -5, contentLength(d.layers.find((l) => l.id === id)!, d.timeline!.fps))));
      await e.runCommand('timeline.go-to', e.doc.timeline!.fps);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await e.runCommand('timeline.audio-add', new File([bytes], 'later.wav', { type: 'audio/wav' }));
    }, toneWav(1));
    await idle(page);
    const tl = await timeline(page);
    const id = (await page.evaluate(() => window.photoStudio.doc.layers.find((l) => l.video)!.id))!;
    expect(tl.clips[id]).toMatchObject({ start: 0, in: -3 });
    const result = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { audioPlan } = await import('/src/model/audio-timeline.ts');
      const { mixPlan } = await import('/src/imaging/audio/mix.ts');
      const { audioPcm, loadAll } = await import('/src/features/animation/audio-media.ts');
      const { scheduleSegment } = await import('/src/features/animation/audio-playback.ts');
      const plan = audioPlan(e.doc);
      await loadAll(e.session, plan.map((p) => p.source));
      const rate = 48000;
      const render = async (items: typeof plan) => {
        const ctx = new OfflineAudioContext(2, rate * 2, rate);
        const n = scheduleSegment(ctx, ctx.destination, items, 0, 2, 0).length;
        const live = await ctx.startRendering();
        const mix = mixPlan(items, (p) => audioPcm(p.source), 0, 2, rate, 2);
        let worst = 0;
        for (let c = 0; c < 2; c++) for (let i = 0; i < 2 * rate; i++) worst = Math.max(worst, Math.abs(live.getChannelData(c)[i] - mix[c][i]));
        return { n, worst };
      };
      // A hand-made item asking for sound before the source start is
      // scheduled from the source start and does not stop later clips.
      const early = { ...plan[0], at: 0, offset: -0.4, clip: 'early' };
      return { plan: plan.map((p) => [p.at, p.offset]), linked: await render(plan), early: await render([early, plan[1]]) };
    });
    expect(result.plan[0][0]).toBeCloseTo(3 / tl.fps, 5);
    expect(result.plan[0][1]).toBe(0);
    expect(result.linked.n).toBe(2);
    expect(result.linked.worst).toBeLessThan(2e-3);
    expect(result.early.n).toBe(2);
    expect(result.early.worst).toBeLessThan(2e-3);
    // Playback and scrubbing from the start run without errors.
    await run(page, 'timeline.go-to', 0);
    const panel = page.locator('.panel-body[aria-label="Timeline"]');
    await panel.locator('.timeline-play').click();
    await expect.poll(() => page.evaluate(async () => (await import('/src/features/animation/audio-playback.ts')).isAudioPlaying())).toBe(true);
    await page.waitForTimeout(400);
    await panel.locator('.timeline-play').click();
    await idle(page);
    await page.evaluate(async () => {
      const { scrubAudio } = await import('/src/features/animation/audio-playback.ts');
      for (const t of [0, 0.05, 0.1, 0.2]) scrubAudio(window.photoStudio.session, window.photoStudio.doc, t);
    });
    expect(errors).toEqual([]);
  });

  test('splitting and trimming plain and linked clips together is one step', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await openImage(page, 32, 32, '#ffffff', 'steps.png');
    await addFootage(page);
    await page.evaluate(async (b64) => {
      const e = window.photoStudio;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await e.runCommand('timeline.audio-add', new File([bytes], 'music.wav', { type: 'audio/wav' }));
      const view = (await import('/src/features/animation/video-state.ts')).videoView(e);
      view.audioClips = e.doc.timeline!.audio![0].clips.map((c) => c.id);
      await e.runCommand('timeline.go-to', Math.round(e.doc.timeline!.fps / 2));
    }, toneWav(1));
    await idle(page);
    const state = () =>
      page.evaluate(async () => {
        const { clipSpan } = await import('/src/model/audio-timeline.ts');
        const d = window.photoStudio.doc;
        return { layers: d.layers.length, clips: d.timeline!.audio![0].clips.map((c) => [c.link ? 'linked' : 'plain', Math.round(clipSpan(d, c)!.length * 1000)]) };
      });
    const before = await state();
    expect(before.clips.map((c) => c[0])).toEqual(['linked', 'plain']);
    const steps = (await historyLabels(page)).length;
    await run(page, 'timeline.split');
    const split = await state();
    expect(split.layers).toBe(before.layers + 1);
    expect(split.clips.map((c) => c[0]).sort()).toEqual(['linked', 'linked', 'plain', 'plain']);
    expect(await historyLabels(page)).toHaveLength(steps + 1);
    expect((await historyLabels(page)).at(-1)).toBe('Split at Playhead');
    // The second parts are selected.
    expect(await page.evaluate(async () => (await import('/src/features/animation/video-state.ts')).selectedAudioClips(window.photoStudio).length)).toBe(2);
    await run(page, 'edit.undo');
    expect(await state()).toEqual(before);

    await page.evaluate(async () => {
      const e = window.photoStudio;
      (await import('/src/features/animation/video-state.ts')).videoView(e).audioClips = e.doc.timeline!.audio![0].clips.map((c) => c.id);
    });
    await run(page, 'timeline.trim-end');
    const trimmed = await state();
    expect(trimmed.clips.every((c, i) => (c[1] as number) < (before.clips[i][1] as number))).toBe(true);
    expect(await historyLabels(page)).toHaveLength(steps + 1);
    await run(page, 'edit.undo');
    expect(await state()).toEqual(before);
    expect(errors).toEqual([]);
  });

  test('surround sound keeps its center and surround channels in playback and the mix', async ({ page }) => {
    await openImage(page, 32, 32, '#ffffff', 'surround.png');
    await run(page, 'timeline.create');
    // 5.1 WAV (L R C LFE SL SR): a tone on the center channel only.
    const rate = 48000;
    const tone = Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate));
    const silent = new Float32Array(rate);
    const wav = Buffer.from(encodeWav([silent, silent, tone, silent, silent, silent], rate)).toString('base64');
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await window.photoStudio.runCommand('timeline.audio-add', new File([bytes], 'center.wav', { type: 'audio/wav' }));
    }, wav);
    await idle(page);
    expect((await timeline(page)).audio![0].clips[0].source).toMatchObject({ channels: 6 });
    const r = await page.evaluate(async () => {
      const e = window.photoStudio;
      const { audioPlan } = await import('/src/model/audio-timeline.ts');
      const { mixPlan, peakLevel } = await import('/src/imaging/audio/mix.ts');
      const { audioPcm, loadAll } = await import('/src/features/animation/audio-media.ts');
      const { scheduleSegment } = await import('/src/features/animation/audio-playback.ts');
      const plan = audioPlan(e.doc);
      await loadAll(e.session, plan.map((p) => p.source));
      const ctx = new OfflineAudioContext(2, 48000, 48000);
      scheduleSegment(ctx, ctx.destination, plan, 0, 1, 0);
      const live = await ctx.startRendering();
      const mix = mixPlan(plan, (p) => audioPcm(p.source), 0, 1, 48000, 2);
      let worst = 0;
      for (let c = 0; c < 2; c++) for (let i = 0; i < 48000; i++) worst = Math.max(worst, Math.abs(live.getChannelData(c)[i] - mix[c][i]));
      return { worst, left: peakLevel([mix[0]]), right: peakLevel([mix[1]]) };
    });
    // The center reaches both sides at -3 dB.
    expect(r.left).toBeCloseTo(0.5 * Math.SQRT1_2, 2);
    expect(r.right).toBeCloseTo(0.5 * Math.SQRT1_2, 2);
    expect(r.worst).toBeLessThan(2e-3);
  });
});
