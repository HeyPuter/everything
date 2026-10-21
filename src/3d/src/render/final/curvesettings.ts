// Render ▸ Curves: how hair strands become render geometry in each engine.
import type { DocumentData, RenderSettings } from '../../data/types';
import { strandShapeHooks, type StrandShape } from '../../hair/render';

export interface CyclesCurves {
  shape: 'RIBBONS' | 'THICK' | 'THICK_LINEAR';
  subdivisions: number;
}

/** Strand shape for an engine (pure). */
export function strandShape(r: Pick<RenderSettings, 'hair_type' | 'hair_subdiv' | 'cycles_curves'>, mode: 'raster' | 'pathtrace'): StrandShape {
  if (mode === 'pathtrace') {
    const c = r.cycles_curves ?? { shape: 'THICK', subdivisions: 2 };
    const sides = c.shape === 'RIBBONS' ? 2 : c.shape === 'THICK_LINEAR' ? 4 : 5;
    // the default (2) keeps the evaluated points; every 2 more doubles them
    return { sides, subdivisions: c.shape === 'THICK_LINEAR' ? 0 : Math.max(0, Math.min(3, Math.round(c.subdivisions / 2) - 1)) };
  }
  // strips are flat ribbons along each strand (not turned towards the camera)
  const t = r.hair_type ?? 'STRAND';
  return { sides: t === 'STRIP' ? 2 : t === 'CYLINDER' ? 6 : 3, subdivisions: Math.max(0, Math.min(3, Math.round(r.hair_subdiv ?? 0))) };
}

strandShapeHooks.shape = (doc: DocumentData, mode) => strandShape(doc.scene.render, mode);
