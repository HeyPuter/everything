// Material presets: density (kg/m^3) for mass properties, and the elastic
// properties a static stress analysis needs: elastic modulus and yield and
// tensile strength in MPa, Poisson's ratio. Values are typical published
// figures for the grade named (room temperature); real parts vary with
// temper, heat treatment and, for plastics, with moisture and print settings.

import type { MaterialRef } from './types';

export const MATERIALS: MaterialRef[] = [
  { name: 'Plain Carbon Steel', density: 7800, E: 200000, nu: 0.29, yield: 250, uts: 400 },
  { name: 'Stainless Steel (304)', density: 8000, E: 193000, nu: 0.29, yield: 215, uts: 505 },
  { name: 'Alloy Steel', density: 7700, E: 205000, nu: 0.29, yield: 415, uts: 655 },
  { name: 'Cast Iron', density: 7200, E: 110000, nu: 0.26, yield: 200, uts: 200 },
  { name: 'Aluminum 6061', density: 2700, E: 68900, nu: 0.33, yield: 276, uts: 310 },
  { name: 'Aluminum 7075', density: 2810, E: 71700, nu: 0.33, yield: 503, uts: 572 },
  { name: 'Brass', density: 8500, E: 100000, nu: 0.33, yield: 240, uts: 370 },
  { name: 'Copper', density: 8900, E: 117000, nu: 0.34, yield: 70, uts: 220 },
  { name: 'Titanium (Ti-6Al-4V)', density: 4430, E: 113800, nu: 0.34, yield: 880, uts: 950 },
  { name: 'ABS', density: 1040, E: 2200, nu: 0.35, yield: 40, uts: 44 },
  { name: 'PLA', density: 1240, E: 3500, nu: 0.36, yield: 50, uts: 60 },
  { name: 'PETG', density: 1270, E: 2100, nu: 0.38, yield: 50, uts: 53 },
  { name: 'Nylon 6/6', density: 1140, E: 2800, nu: 0.39, yield: 70, uts: 80 },
  { name: 'Acrylic (PMMA)', density: 1190, E: 3200, nu: 0.37, yield: 70, uts: 70 },
  { name: 'Polycarbonate', density: 1200, E: 2400, nu: 0.37, yield: 62, uts: 66 },
  // Wood is anisotropic (stiffer and stronger along the grain several times over):
  // an isotropic analysis would mislead, so it has no elastic properties.
  { name: 'Oak', density: 750 },
  { name: 'Pine', density: 510 },
  { name: 'Glass', density: 2500, E: 70000, nu: 0.22, yield: 40, uts: 40 },
];

/** Notes shown with a preset's analysis properties. */
export const MATERIAL_NOTES: Record<string, string> = {
  'Cast Iron': 'Brittle (gray iron): no yield point, so its tensile strength stands in for yield.',
  ABS: 'Typical values: plastics vary with grade, temperature and moisture.',
  PLA: 'Typical values for molded plastic: 3D printed parts are weaker and stiffer along the layers than across them.',
  PETG: 'Typical values for molded plastic: 3D printed parts are weaker and stiffer along the layers than across them.',
  'Nylon 6/6': 'Typical dry values: nylon absorbs moisture and becomes softer and weaker.',
  'Acrylic (PMMA)': 'Brittle: its tensile strength stands in for yield. Typical values.',
  Polycarbonate: 'Typical values: plastics vary with grade, temperature and moisture.',
  Oak: 'Wood is anisotropic: it cannot be analyzed as an isotropic material.',
  Pine: 'Wood is anisotropic: it cannot be analyzed as an isotropic material.',
  Glass: 'Brittle: its design tensile strength stands in for yield.',
};

/** Elastic properties of a material in MPa (E, yield, ultimate) and Poisson's ratio. */
export interface ElasticProps {
  E: number;
  nu: number;
  yield: number;
  uts: number;
}

/** Whether a value is a usable elastic property set (Poisson's ratio below 0.5: incompressible solids cannot be analyzed this way). */
export function validElastic(m: Partial<ElasticProps>): m is ElasticProps {
  const pos = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  return pos(m.E) && typeof m.nu === 'number' && Number.isFinite(m.nu) && m.nu >= 0 && m.nu < 0.5 && pos(m.yield) && pos(m.uts);
}

/**
 * The elastic properties of the part's material: its own, else those of the
 * preset of that name and density (parts saved before materials had them).
 * Null when it has none (wood, a custom material without them, no material).
 */
export function elasticOf(m: MaterialRef | null | undefined): ElasticProps | null {
  if (!m) return null;
  if (validElastic(m)) return { E: m.E, nu: m.nu, yield: m.yield, uts: m.uts };
  if (m.E !== undefined) return null;
  const preset = MATERIALS.find((p) => p.name === m.name && p.density === m.density);
  return preset && validElastic(preset) ? { E: preset.E, nu: preset.nu, yield: preset.yield, uts: preset.uts } : null;
}

/** A material read from a file: the elastic properties are kept only as a complete, valid set. */
export function normalizeMaterial(m: MaterialRef): MaterialRef {
  const { E, nu, yield: sy, uts, ...rest } = m;
  return validElastic({ E, nu, yield: sy, uts }) ? { ...rest, E, nu, yield: sy, uts } : rest;
}
