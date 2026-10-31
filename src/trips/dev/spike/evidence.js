export const KV_PERMIT = 'RUN SYNTHETIC F0 KV PROBES';
export const IDENTITY_PERMIT = 'CREATE TEMPORARY F0 IDENTITY';
export const WORKER_PERMIT = 'CALL MY F0 SPIKE WORKER';
export const CLEANUP_PERMIT = 'DELETE MY F0 SPIKE FIXTURES';
export const RUN_PATTERN = /^f0-[a-f0-9]{16}$/;

const probes = new Set([
  'kv.batch', 'kv.updateMissing', 'kv.updatePaths', 'kv.incr', 'kv.add',
  'kv.listObject', 'kv.listStringConfig', 'kv.ttl', 'kv.size', 'kv.conditional',
  'worker.health', 'worker.auth', 'worker.compression', 'cleanup.kv', 'cleanup.identity',
]);
const outcomes = new Set(['pass', 'fail', 'error', 'unavailable', 'pending']);
const metrics = new Set(['calls', 'writes', 'attempted', 'failed', 'count', 'bytes', 'elapsedMs', 'prepareMs', 'status', 'accepted', 'rejected', 'restricted', 'owner', 'authenticated', 'streamed', 'entities', 'gzipBytes', 'jsonBytes', 'cleanupRequired', 'originalAccountRequired']);
export function requirePermit(actual, expected) {
  if (actual !== expected) throw new Error('spike_explicit_permission_required');
}
export function requireRunId(value) {
  if (typeof value !== 'string' || !RUN_PATTERN.test(value)) throw new Error('spike_invalid_run');
  return value;
}
export function newRunId(crypto = globalThis.crypto) {
  return `f0-${[...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
export function errorStatus(error) {
  const status = error?.status ?? error?.statusCode;
  return Number.isInteger(status) && status >= 0 && status <= 599 ? status : 0;
}

/** Evidence never accepts API bodies, error messages, keys, paths or credentials. */
export function createEvidence({ runId, environment }) {
  requireRunId(runId);
  if (!['fake', 'live'].includes(environment)) throw new Error('spike_environment_required');
  const results = [];
  return {
    record(probe, outcome, measurements = {}) {
      if (!probes.has(probe) || !outcomes.has(outcome)) throw new Error('spike_invalid_evidence');
      const safe = {};
      for (const [key, value] of Object.entries(measurements)) {
        if (!metrics.has(key) || !(typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value) && value >= 0))) {
          throw new Error('spike_invalid_measurement');
        }
        safe[key] = value;
      }
      results.push({ probe, outcome, measurements: safe });
    },
    report() { return { schema: 'trips-f0-evidence-v1', environment, runId, results: structuredClone(results) }; },
  };
}
