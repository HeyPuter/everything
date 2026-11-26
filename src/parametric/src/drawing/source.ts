// Where a drawing view's geometry comes from. Every view names a source (absent: 'part', the
// open part's body). An open assembly registers 'assembly' and 'assembly:exploded': the
// combined placed solids to project, their named edges (component id + '#' + the part's edge
// name, as the assembly's graphics area names them, so dimensions and balloons can refer to
// them) and the bill of materials. A sheet metal part registers 'flat', its flat pattern.

import type { EdgeInfo, ProjectionRequest, ProjectionResult } from '../kernel/protocol';
import type { Vec3 } from '../math/vec';

export interface BomRow {
  item: number;
  /** Part number or name. */
  name: string;
  description?: string;
  material?: string;
  qty: number;
  /** Edge names of this row's components start with one of these (a balloon's reference finds its row by them). */
  prefixes: string[];
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
