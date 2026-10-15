// Proportional editing helpers shared by the curve and lattice edit modes.
import type { Vector3 } from 'three';
import { app } from '../app/app';

/** Falloff curve value: t = 0 at the selection, 1 at the proportional radius. */
export function falloff(type: string, t: number): number {
  const x = Math.max(0, Math.min(1, 1 - t));
  switch (type) {
    case 'SPHERE':
      return Math.sqrt(1 - (1 - x) * (1 - x));
    case 'ROOT':
      return Math.sqrt(x);
    case 'INVERSE_SQUARE':
      return x * (2 - x);
    case 'SHARP':
      return x * x;
    case 'LINEAR':
      return x;
    case 'CONSTANT':
      return x > 0 ? 1 : 0;
    case 'RANDOM':
      return x * (0.5 + 0.5 * Math.random());
    default:
      return x * x * (3 - 2 * x);
  }
}

/**
 * Proportional weights for points: selected points get 1, others by distance to the nearest
 * selected point (or, when `neighbours` is given and Connected is on, by distance along links).
 */
export function proportionalWeights(points: Vector3[], selected: boolean[], connected: boolean, neighbours?: (i: number) => number[]): { weight: Float32Array; dist: Float32Array } {
  const ts = app.doc.scene.tool_settings;
  const radius = ts.proportional_size;
  const n = points.length;
  const weight = new Float32Array(n);
  const dist = new Float32Array(n).fill(Infinity);
  for (let i = 0; i < n; i++)
    if (selected[i]) {
      weight[i] = 1;
      dist[i] = 0;
    }
  if (connected && neighbours) {
    const queue: number[] = [];
    for (let i = 0; i < n; i++) if (selected[i]) queue.push(i);
    while (queue.length) {
      const u = queue.shift()!;
      for (const w of neighbours(u)) {
        const d = dist[u] + points[u].distanceTo(points[w]);
        if (d < dist[w] && d < radius) {
          dist[w] = d;
          queue.push(w);
        }
      }
    }
  } else {
    const sel = points.filter((_, i) => selected[i]);
    for (let i = 0; i < n; i++) {
      if (selected[i]) continue;
      let best = Infinity;
      for (const q of sel) best = Math.min(best, points[i].distanceToSquared(q));
      dist[i] = Math.sqrt(best);
    }
  }
  for (let i = 0; i < n; i++) if (!selected[i] && dist[i] < radius) weight[i] = falloff(ts.proportional_edit_falloff, dist[i] / radius);
  return { weight, dist };
}
