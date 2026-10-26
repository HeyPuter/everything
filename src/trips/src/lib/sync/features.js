import { appConfig } from '../deploy.js';

const ON = Object.freeze({ pathA: true, directFiles: true });

/**
 * Path A (KV share handles) and direct file mode wait on the live checks (docs/live-checks.md) in production, where
 * `config.json` `pathA` and `directFiles` turn them on. Dev, tests and the mock build always run both.
 */
export async function loadFeatures({ env = import.meta.env, loadConfig = appConfig } = {}) {
  if (!env?.PROD || env.MODE === 'mock') return ON;
  let config = {};
  try { config = (await loadConfig()) ?? {}; } catch { /* treated as off */ }
  return featureSet(config);
}

/** Missing or non-true flags are off. */
export const featureSet = (value) => Object.freeze({ pathA: value?.pathA === true, directFiles: value?.directFiles === true });
