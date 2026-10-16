// Clip proxies: reduced-size JPEG copies of every frame (25 / 50 / 75 / 100 %) built in the
// background, so playback and scrubbing in the clip editor decode small images instead of the
// full footage. Proxies are a cache of this session: they are rebuilt, not saved with the file.
import { app, registerOperators } from '../app/app';
import { FrameSource, readySource, clipSource } from './source';
import { contextClip, contextEditor } from './ops';
import { runJob, setProgress } from './jobs';
import type { MovieClipData } from './types';

export type ProxySize = 25 | 50 | 75 | 100;
export type ProxyRenderSize = 'PROXY_25' | 'PROXY_50' | 'PROXY_75' | 'PROXY_100' | 'FULL';

export interface MovieClipProxy {
  build_25: boolean;
  build_50: boolean;
  build_75: boolean;
  build_100: boolean;
  /** JPEG quality, percent */
  quality: number;
}

declare module './types' {
  interface MovieClipData {
    use_proxy?: boolean;
    proxy?: MovieClipProxy;
  }
}

export function proxySettings(c: MovieClipData): MovieClipProxy {
  return (c.proxy ??= { build_25: true, build_50: false, build_75: false, build_100: false, quality: 50 });
}

class ProxySource extends FrameSource {
  constructor(
    private frames: (Uint8Array | null)[],
    w: number,
    h: number,
  ) {
    super();
    this.kind = 'images';
    this.width = w;
    this.height = h;
    this.frameCount = frames.length;
  }
  protected async decode(index: number) {
    const b = this.frames[index];
    if (!b) return null;
    const bmp = await createImageBitmap(new Blob([b as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
    this.store(index, bmp);
    return bmp;
  }
}

/** Built proxies per clip id and size. */
const store = new Map<string, Map<ProxySize, ProxySource>>();

export function proxySource(c: MovieClipData, size: ProxyRenderSize): FrameSource | null {
  if (!c.use_proxy || size === 'FULL') return null;
  return store.get(c.id)?.get(Number(size.slice(6)) as ProxySize) ?? null;
}

export function builtProxySizes(c: MovieClipData): ProxySize[] {
  return [...(store.get(c.id)?.keys() ?? [])].sort((a, b) => a - b);
}

async function encodeScaled(bmp: ImageBitmap, w: number, h: number, quality: number): Promise<Uint8Array> {
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = cv.getContext('2d') as CanvasRenderingContext2D;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  const blob: Blob =
    cv instanceof HTMLCanvasElement ? await new Promise((res) => cv.toBlob((b) => res(b!), 'image/jpeg', quality / 100)) : await (cv as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
  return new Uint8Array(await blob.arrayBuffer());
}

async function buildProxies(clipId: string) {
  const c0 = app.doc.movieclips?.[clipId];
  if (!c0) return;
  const set = proxySettings(c0);
  const sizes = ([25, 50, 75, 100] as ProxySize[]).filter((s) => set[`build_${s}`]);
  if (!sizes.length) return app.report('ERROR', 'Choose at least one proxy size to build');
  await runJob(
    'Building Proxy',
    async (job) => {
      const src = await clipSource(c0);
      if (!src) return;
      const frames = sizes.map(() => new Array<Uint8Array | null>(src.frameCount).fill(null));
      for (let i = 0; i < src.frameCount; i++) {
        if (job.cancelled) return 'Proxy building stopped';
        const bmp = await src.get(i);
        if (bmp)
          for (let k = 0; k < sizes.length; k++) {
            const w = Math.max(2, Math.round((src.width * sizes[k]) / 100)),
              h = Math.max(2, Math.round((src.height * sizes[k]) / 100));
            frames[k][i] = await encodeScaled(bmp, w, h, set.quality);
          }
        job.detail = `frame ${i + 1} of ${src.frameCount}`;
        setProgress(job, (i + 1) / src.frameCount);
      }
      const m = store.get(clipId) ?? new Map<ProxySize, ProxySource>();
      sizes.forEach((s, k) => {
        m.get(s)?.dispose();
        m.set(s, new ProxySource(frames[k], Math.round((src.width * s) / 100), Math.round((src.height * s) / 100)));
      });
      store.set(clipId, m);
      const bytes = frames.flat().reduce((n, b) => n + (b?.length ?? 0), 0);
      return `Built ${sizes.map((s) => `${s}%`).join(', ')} proxies (${(bytes / 1024 / 1024).toFixed(1)} MB)`;
    },
    { undo: false },
  );
}

registerOperators([
  {
    idname: 'clip.rebuild_proxy',
    label: 'Rebuild Proxy',
    description: 'Build reduced-size copies of the footage for faster playback in the clip editor',
    undo: false,
    poll: (ctx) => {
      const c = contextClip(ctx);
      return !!c && !!c.use_proxy && !!readySource(c);
    },
    exec: (ctx) => {
      void buildProxies(contextClip(ctx)!.id);
    },
  },
  {
    idname: 'clip.delete_proxy',
    label: 'Delete Proxy',
    description: 'Discard the proxies built for the clip',
    undo: false,
    poll: (ctx) => {
      const c = contextClip(ctx);
      return !!c && !!store.get(c.id)?.size;
    },
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      for (const s of store.get(c.id)?.values() ?? []) s.dispose();
      store.delete(c.id);
      contextEditor(ctx)?.draw();
      app.report('INFO', `Deleted the proxies of "${c.name}"`);
    },
  },
]);
