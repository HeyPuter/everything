// Ports of the Playwright suites and tools/perf/browser.mjs. Set TRIPS_E2E_PORT_BASE so parallel runs use separate ranges (default 5300).
const base = process.env.TRIPS_E2E_PORT_BASE === undefined || process.env.TRIPS_E2E_PORT_BASE === '' ? 5300 : Number(process.env.TRIPS_E2E_PORT_BASE);
if (!Number.isInteger(base) || base < 1024 || base > 65_000) throw new Error('TRIPS_E2E_PORT_BASE must be an integer from 1024 to 65000');

export const E2E_PORTS = Object.freeze({ client: base + 3, mock: base + 4, map: base + 5, perf: base + 6 });
export const e2eOrigin = (name) => `http://127.0.0.1:${E2E_PORTS[name]}`;
