import type { UnitSystem } from './types';

export interface UnitInfo {
  id: UnitSystem;
  label: string;
  length: string;
  /** millimetres per display length unit */
  scale: number;
  mass: string;
  /** kilograms per display mass unit */
  massScale: number;
}

export const UNIT_SYSTEMS: Record<UnitSystem, UnitInfo> = {
  MMGS: { id: 'MMGS', label: 'MMGS (millimeter, gram, second)', length: 'mm', scale: 1, mass: 'g', massScale: 0.001 },
  CGS: { id: 'CGS', label: 'CGS (centimeter, gram, second)', length: 'cm', scale: 10, mass: 'g', massScale: 0.001 },
  MKS: { id: 'MKS', label: 'MKS (meter, kilogram, second)', length: 'm', scale: 1000, mass: 'kg', massScale: 1 },
  IPS: { id: 'IPS', label: 'IPS (inch, pound, second)', length: 'in', scale: 25.4, mass: 'lb', massScale: 0.45359237 },
};

/** Length unit suffixes accepted in typed values, in millimetres. */
export const LENGTH_SUFFIX: Record<string, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  '"': 25.4,
  ft: 304.8,
  "'": 304.8,
  um: 0.001,
};

export const ANGLE_SUFFIX: Record<string, number> = {
  deg: 1,
  '°': 1,
  rad: 180 / Math.PI,
};

export function formatNumber(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return '?';
  const s = v.toFixed(Math.max(0, Math.min(8, decimals)));
  // Avoid "-0.00" for tiny negative values.
  return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
}

/** Shortest round-trippable text for an editable value (no forced decimals). */
export function formatEditable(v: number): string {
  if (!Number.isFinite(v)) return '0';
  return v.toString();
}

export function formatLength(mm: number, units: UnitSystem, decimals: number, withUnit = false): string {
  const u = UNIT_SYSTEMS[units];
  const s = formatNumber(mm / u.scale, decimals);
  return withUnit ? `${s} ${u.length}` : s;
}

export function formatAngle(deg: number, decimals = 2): string {
  return `${formatNumber(deg, decimals)}°`;
}

export const toDisplay = (mm: number, units: UnitSystem) => mm / UNIT_SYSTEMS[units].scale;
export const fromDisplay = (v: number, units: UnitSystem) => v * UNIT_SYSTEMS[units].scale;
