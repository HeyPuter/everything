// Proxies: reduced-size copies of movie strip frames, built ahead of time so the preview can scrub
// and play without decoding the full-size movie. Built frames are kept as compressed JPEG images
// in memory for the session (rebuild them after reopening a file); the preview uses them when its
// size is set to a proxy size the strip has proxies for.
import { h } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators } from '../app/app';
import { statusWidgets } from '../ui/shell';
import type { Strip, StripProxy } from './types';
import { selectedStrips, hasEditor, seqList } from './context';
import { getMovie } from './media';
import { allStrips } from './strips';

export const PROXY_SIZES = [25, 50, 75, 100] as const;
export type ProxySize = (typeof PROXY_SIZES)[number];

export function defaultProxy(): StripProxy {
  return { build_25: true, build_50: false, build_75: false, build_100: false, quality: 50, use_overwrite: false };
}

/** Sizes a strip is set to build. */
export const wantedSizes = (p: StripProxy): ProxySize[] => PROXY_SIZES.filter((k) => p[`build_${k}` as const]);

/** Content frames of a movie strip (hard trims excluded). */
export function contentFrames(s: Strip): number {
  return Math.max(0, Math.round(s.frame_duration + s.animation_offset_start + s.animation_offset_end));
}

interface ProxySet {
  frames: (Blob | undefined)[];
  /** all frames built */
  complete: boolean;
}

/** Built proxies by movie data and size. */
const store = new WeakMap<Uint8Array, Map<ProxySize, ProxySet>>();

function setsOf(s: Strip): Map<ProxySize, ProxySet> | undefined {
  return s.media ? store.get(s.media.bytes) : undefined;
}

/** Proxy sizes completely built for a strip's movie. */
export function builtSizes(s: Strip): ProxySize[] {
  const m = setsOf(s);
  return m ? PROXY_SIZES.filter((k) => m.get(k)?.complete) : [];
}

const decoded = new Map<Blob, ImageBitmap>();

/** A proxy frame (content frame index), when built. */
export async function proxyFrame(s: Strip, size: ProxySize, frame: number): Promise<ImageBitmap | null> {
  if (!s.use_proxy) return null;
  const set = setsOf(s)?.get(size);
  const blob = set?.frames[Math.max(0, Math.min(set.frames.length - 1, Math.round(frame)))];
  if (!blob) return null;
  const hit = decoded.get(blob);
  if (hit) return hit;
  const bmp = await createImageBitmap(blob);
  decoded.set(blob, bmp);
  if (decoded.size > 48) {
    const [k, v] = decoded.entries().next().value!;
    v.close();
    decoded.delete(k);
  }
  return bmp;
}

// ---------------------------------------------------------------------------
// building (chunked, with progress in the status bar; Esc cancels)

interface BuildJob {
  done: number;
  total: number;
  cancelled: boolean;
  label: string;
}
let job: BuildJob | null = null;

statusWidgets.push(() =>
  job
    ? h(
        'span',
        { key: 'proxy-job', class: 'sb-job', 'data-tip': `${job.label}: ${job.done} / ${job.total} frames` },
        h('span', { class: 'sb-job-label' }, 'Building Proxies'),
        h('span', { class: 'sb-job-bar' }, h('span', { class: 'sb-job-fill', style: { width: `${((job.done / Math.max(1, job.total)) * 100).toFixed(1)}%` } })),
        h('button', { class: 'sb-job-cancel', 'data-tip': 'Stop building (Esc)', onclick: () => job && (job.cancelled = true) }, icon('x')),
      )
    : null,
);

export const isBuilding = () => !!job;

/** Build the proxies of movie strips (each movie once, missing sizes only unless overwriting). */
export async function buildProxies(strips: Strip[]): Promise<number> {
  if (job) return 0;
  const work: { s: Strip; size: ProxySize }[] = [];
  const seen = new Set<string>();
  for (const s of strips) {
    if (s.type !== 'MOVIE' || !s.media || !s.use_proxy) continue;
    const p = (s.proxy ??= defaultProxy());
    for (const size of wantedSizes(p)) {
      const set = setsOf(s)?.get(size);
      if (set?.complete && !p.use_overwrite) continue;
      const id = `${s.media.filepath}:${s.media.bytes.byteLength}:${size}`;
      if (seen.has(id)) continue;
      seen.add(id);
      work.push({ s, size });
    }
  }
  if (!work.length) return 0;
  const fps = app.doc.scene.render.fps / (app.doc.scene.render.fps_base || 1);
  const me: BuildJob = { done: 0, total: work.reduce((n, w) => n + contentFrames(w.s), 0), cancelled: false, label: work.map((w) => `${w.s.name} ${w.size}%`).join(', ') };
  job = me;
  const esc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') me.cancelled = true;
  };
  addEventListener('keydown', esc, true);
  app.changed('ui');
  let built = 0;
  try {
    for (const { s, size } of work) {
      const movie = getMovie(s.media!.bytes, s.media!.mime);
      const info = await movie.info.catch(() => null);
      if (!info) continue;
      const width = Math.max(1, Math.round((info.width * size) / 100));
      // every frame of the movie file (trims and retiming can reach any of them)
      const n = info.duration > 0 ? Math.max(1, Math.round(info.duration * fps)) : contentFrames(s);
      me.total += n - contentFrames(s);
      const set: ProxySet = { frames: new Array(n), complete: false };
      let m = store.get(s.media!.bytes);
      if (!m) store.set(s.media!.bytes, (m = new Map()));
      const canvas = new OffscreenCanvas(width, Math.max(1, Math.round((info.height * size) / 100)));
      const g = canvas.getContext('2d')!;
      const quality = Math.max(0.05, Math.min(1, (s.proxy?.quality ?? 50) / 100));
      for (let f = 0; f < n; f++) {
        if (me.cancelled) break;
        const bmp = await movie.frame((f + 0.5) / Math.max(1, fps), width);
        if (bmp) {
          g.clearRect(0, 0, canvas.width, canvas.height);
          g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
          set.frames[f] = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        }
        me.done++;
        if (f % 4 === 0) app.changed('ui');
      }
      if (me.cancelled) break;
      set.complete = true;
      m.set(size, set);
      built++;
    }
  } finally {
    removeEventListener('keydown', esc, true);
    job = null;
    app.changed('ui');
  }
  if (me.cancelled) app.report('INFO', 'Proxy building stopped');
  else if (built) app.report('INFO', `Built ${built} prox${built === 1 ? 'y' : 'ies'}`);
  return built;
}

/** Forget the built proxies of strips. */
export function clearProxies(strips: Strip[]) {
  for (const s of strips) if (s.media) store.delete(s.media.bytes);
}

const movieStrips = (list: Strip[]) => list.filter((s) => s.type === 'MOVIE' && s.media);

registerOperators([
  {
    idname: 'sequencer.enable_proxies',
    label: 'Set Selected Strip Proxies',
    description: 'Turn proxies on for the selected movie strips and choose which sizes to build',
    props: [
      { id: 'proxy_25', label: '25%', type: 'bool', default: true },
      { id: 'proxy_50', label: '50%', type: 'bool', default: false },
      { id: 'proxy_75', label: '75%', type: 'bool', default: false },
      { id: 'proxy_100', label: '100%', type: 'bool', default: false },
      { id: 'overwrite', label: 'Overwrite', type: 'bool', default: false },
    ],
    poll: () => hasEditor() && movieStrips(selectedStrips()).length > 0,
    exec: (_c, p) => {
      for (const s of movieStrips(selectedStrips())) {
        s.use_proxy = true;
        const px = (s.proxy ??= defaultProxy());
        px.build_25 = !!p.proxy_25;
        px.build_50 = !!p.proxy_50;
        px.build_75 = !!p.proxy_75;
        px.build_100 = !!p.proxy_100;
        px.use_overwrite = !!p.overwrite;
      }
      app.changed('doc');
    },
  },
  {
    idname: 'sequencer.rebuild_proxy',
    label: 'Rebuild Proxy',
    description: 'Build the proxies of the selected movie strips (all movie strips with proxies when none is selected)',
    undo: false,
    poll: () => hasEditor() && !job && movieStrips(allStrips(seqList())).some((s) => s.use_proxy),
    exec: () => {
      const sel = movieStrips(selectedStrips()).filter((s) => s.use_proxy);
      const list = sel.length ? sel : movieStrips(allStrips(seqList())).filter((s) => s.use_proxy);
      void buildProxies(list).then(() => app.changed('doc'));
      return 'FINISHED';
    },
  },
]);
