export const CONFIG_KEY = 'geo:config';
export const PROVIDERS = Object.freeze(['nominatim', 'osrm', 'valhalla']);
const DEFAULT_LIMITS = Object.freeze({ nominatim: 1, osrm: 1, valhalla: 1 });

/** `geo:config` in the worker's KV: `{regions, disabled, killed, limits}`, written by the operator. */
export function sanitizeRemoteConfig(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const limits = { ...DEFAULT_LIMITS };
  if (input.limits && typeof input.limits === 'object') for (const name of PROVIDERS) if (Number.isFinite(input.limits[name]) && input.limits[name] > 0 && input.limits[name] <= 10) limits[name] = input.limits[name];
  return {
    regions: Number.isInteger(input.regions) && input.regions >= 1 && input.regions <= 16 ? input.regions : null,
    disabled: Array.isArray(input.disabled) ? input.disabled.filter(name => PROVIDERS.includes(name)) : [],
    killed: input.killed === true,
    limits,
  };
}
/** Re-reads the kill switch at most every `ttl` ms; a failed read keeps the last value (initially: no regions, so upstream stays off). */
export function createRemoteConfig({ kv, now = Date.now, ttl = 30_000 }) {
  let current = sanitizeRemoteConfig(null); let expires = 0;
  return async () => {
    if (expires > now()) return current;
    try { current = sanitizeRemoteConfig(await kv.get(CONFIG_KEY)); } catch { /* Keep the last known switch. */ }
    expires = now() + ttl;
    return current;
  };
}
