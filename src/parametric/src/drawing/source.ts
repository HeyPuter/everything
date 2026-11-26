// Where a drawing view's geometry comes from. Every view names a source (absent: 'part', the
// open part's body). An assembly document will register its own source: the combined
// transformed solid to project, its named edges (component path + '/' + edge name, so
// dimensions and balloons can refer to them) and its bill of materials.

import type { EdgeInfo, ProjectionRequest, ProjectionResult } from '../kernel/protocol';
import type { Vec3 } from '../math/vec';

export interface BomRow {
  item: number;
  /** Part number or name. */
  name: string;
  description?: string;
  material?: string;
  qty: number;
  /** Edge names of this component start with this prefix (a balloon's reference finds its row by it). */
  prefix: string;
}

export interface DrawingSource {
  /** Changes whenever the geometry changes (projections are cached until it does). */
  version(): number;
  /** Bounding box of the geometry, null while there is none. */
  bbox(): { min: Vec3; max: Vec3 } | null;
  /** Hidden-line projections (each request's id comes back on its result). */
  project(requests: ProjectionRequest[]): Promise<ProjectionResult[]>;
  /** Named model edges, in the same coordinates as the projections. */
  edges(): EdgeInfo[];
  /** Bill of materials rows (assemblies). */
  bom?(): BomRow[];
}
