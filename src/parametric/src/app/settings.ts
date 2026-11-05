export interface Settings {
  showPlanes: boolean;
  showOrigin: boolean;
  showSketches: boolean;
  showRelations: boolean;
  showDimensions: boolean;
  invertZoom: boolean;
  quality: number;
  autoNormalTo: boolean;
  defaultUnits: 'MMGS' | 'CGS' | 'MKS' | 'IPS';
}

export const DEFAULT_SETTINGS: Settings = {
  showPlanes: false,
  showOrigin: false,
  showSketches: true,
  showRelations: true,
  showDimensions: true,
  invertZoom: false,
  quality: 1,
  autoNormalTo: true,
  defaultUnits: 'MMGS',
};

/** Treat browser and account preferences as untrusted persisted data. */
export function normalizeSettings(value: unknown, fallback: Settings = DEFAULT_SETTINGS): Settings {
  const result = { ...fallback };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const raw = value as Record<string, unknown>;
  for (const key of ['showPlanes', 'showOrigin', 'showSketches', 'showRelations', 'showDimensions', 'invertZoom', 'autoNormalTo'] as const) {
    if (Object.hasOwn(raw, key) && typeof raw[key] === 'boolean') result[key] = raw[key];
  }
  if (Object.hasOwn(raw, 'quality') && (raw.quality === 0 || raw.quality === 1 || raw.quality === 2)) result.quality = raw.quality;
  if (Object.hasOwn(raw, 'defaultUnits') && (raw.defaultUnits === 'MMGS' || raw.defaultUnits === 'CGS' || raw.defaultUnits === 'MKS' || raw.defaultUnits === 'IPS')) {
    result.defaultUnits = raw.defaultUnits;
  }
  return result;
}
