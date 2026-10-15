// Timeline: bars along the bottom showing which frames of each simulation are cached or baked,
// with View ▸ Cache toggles per simulation kind.
import { app } from '../app/app';
import { timelineOverlays, timelineViewMenuHooks, type Timeline } from '../editors/timeline';
import { caches } from './common';
import { cacheOwners } from './ops';
import { RB_CACHE } from './rigidbody';

type Kind = 'SOFTBODY' | 'PARTICLES' | 'CLOTH' | 'SMOKE' | 'DYNAMICPAINT' | 'RIGIDBODY';

/** What the timeline shows (session setting). */
export const cacheDisplay: Record<'show' | Kind, boolean> = { show: true, SOFTBODY: true, PARTICLES: true, CLOTH: true, SMOKE: true, DYNAMICPAINT: true, RIGIDBODY: true };

const COLORS: Record<Kind, string> = {
  SOFTBODY: '#d8b04a',
  PARTICLES: '#d85a5a',
  CLOTH: '#5a8fd8',
  SMOKE: '#a46ad8',
  DYNAMICPAINT: '#e08a3c',
  RIGIDBODY: '#62b85c',
};

/** Simulation kind of a cache key (keys start with the modifier/system type). */
export function cacheKind(key: string): Kind | null {
  if (key === RB_CACHE) return 'RIGIDBODY';
  if (key.startsWith('SOFT_BODY')) return 'SOFTBODY';
  if (key.startsWith('CLOTH')) return 'CLOTH';
  if (key.startsWith('FLUID')) return 'SMOKE';
  if (key.startsWith('PARTICLES') || key.startsWith('PSYS')) return 'PARTICLES';
  if (key.startsWith('DPAINT')) return 'DYNAMICPAINT';
  return null;
}

function draw(g: CanvasRenderingContext2D, tl: Timeline, W: number) {
  if (!cacheDisplay.show) return;
  const owners = cacheOwners(app.doc).filter((o) => {
    const k = cacheKind(o.key);
    return !!k && cacheDisplay[k];
  });
  if (!owners.length) return;
  const bottom = tl.contentBottom();
  const bh = 4;
  owners.forEach((o, i) => {
    const kind = cacheKind(o.key)!;
    const y = bottom - (i + 1) * (bh + 1);
    const x0 = tl.view.fx(o.pc.frame_start - 0.5),
      x1 = tl.view.fx(o.pc.frame_end + 0.5);
    if (x1 < 0 || x0 > W) return;
    // the frame range, then the cached frames on top
    g.globalAlpha = 0.18;
    g.fillStyle = COLORS[kind];
    g.fillRect(x0, y, x1 - x0, bh);
    const c = caches.get(o.key);
    if (c?.frames.size) {
      g.globalAlpha = o.pc.is_baked ? 1 : 0.6;
      const frames = [...c.frames.keys()].sort((a, b) => a - b);
      let runStart = frames[0],
        prev = frames[0];
      const flush = () => g.fillRect(tl.view.fx(runStart - 0.5), y, tl.view.fx(prev + 0.5) - tl.view.fx(runStart - 0.5), bh);
      for (let k = 1; k < frames.length; k++) {
        if (frames[k] !== prev + 1) {
          flush();
          runStart = frames[k];
        }
        prev = frames[k];
      }
      flush();
    }
    g.globalAlpha = 1;
  });
}

timelineOverlays.push(draw);
timelineViewMenuHooks.push((tl) => [
  {
    label: 'Cache',
    submenu: () => {
      const t = (k: keyof typeof cacheDisplay, label: string) => ({
        label,
        checked: cacheDisplay[k],
        disabled: k !== 'show' && !cacheDisplay.show,
        action: () => {
          cacheDisplay[k] = !cacheDisplay[k];
          tl.refresh();
        },
      });
      return [t('show', 'Show Cache'), { separator: true }, t('SOFTBODY', 'Soft Body'), t('PARTICLES', 'Particles'), t('CLOTH', 'Cloth'), t('SMOKE', 'Smoke'), t('DYNAMICPAINT', 'Dynamic Paint'), t('RIGIDBODY', 'Rigid Body')];
    },
  },
]);
