const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'];

// File lists format hundreds of sizes; locale lookups and formatters are kept.
let localeMemo = { key: null, value: undefined };
function browserLocale(nav = globalThis.navigator) {
  const tags = [...(nav?.languages ?? []), nav?.language];
  const key = tags.join('\u0000');
  if (localeMemo.key === key) return localeMemo.value;
  let value;
  for (const tag of tags) {
    try { const [supported] = Intl.NumberFormat.supportedLocalesOf(tag ?? []); if (supported) { value = supported; break; } } catch { /* invalid tag */ }
  }
  localeMemo = { key, value };
  return value;
}
const formats = new Map();
function numberFormat(locale, options) {
  const key = `${locale}|${options.unit}|${options.unitDisplay}|${options.maximumFractionDigits}`;
  if (!formats.has(key)) {
    if (formats.size >= 64) formats.delete(formats.keys().next().value);
    formats.set(key, new Intl.NumberFormat(locale, options));
  }
  return formats.get(key);
}

/** Bytes in decimal units (1 kB = 1000 B), as operating systems show file sizes. */
export function formatBytes(bytes, { locale = browserLocale() } = {}) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) { value /= 1000; unit += 1; }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return numberFormat(locale, { style: 'unit', unit: UNITS[unit], unitDisplay: unit === 0 ? 'long' : 'short', maximumFractionDigits: digits }).format(value);
}
