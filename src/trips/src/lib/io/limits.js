import { LIMITS } from '../../shared/limits.js';

export const IO_LIMITS = Object.freeze({
  geoFileBytes: 25 * 1024 * 1024,
  kmlBytes: 50 * 1024 * 1024,
  jsonBytes: 50 * 1024 * 1024,
  features: 2_000,
  trackPoints: 20_000,
  trackBytes: 16 * 1024 * 1024,
  tracks: 500,
  xmlNodes: 4_000_000,
  xmlDepth: 256,
  batch: LIMITS.commitWrites,
  dataFileBytes: 500 * 1024 * 1024,
});
