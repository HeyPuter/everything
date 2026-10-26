// Shared helpers for the perf scripts: timing, a results table and `--json` output.
export const args = new Set(process.argv.slice(2));

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
}

/** Runs `fn` `runs` times (after `warm` unmeasured runs) and returns the median wall time in ms. */
export async function timed(fn, { runs = 5, warm = 1, before } = {}) {
  const times = [];
  for (let i = 0; i < warm + runs; i++) {
    if (before) await before(i);
    const start = performance.now();
    await fn(i);
    if (i >= warm) times.push(performance.now() - start);
  }
  return median(times);
}

export const ms = (value) => `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
export const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/** Rows are `{area, metric, budget, value, ok?}`; `ok` undefined means no fixed budget. */
export function printTable(title, rows) {
  if (args.has('--json')) { console.log(JSON.stringify({ title, rows }, null, 2)); return; }
  console.log(`\n${title}\n`);
  console.log('| Area | Metric | Budget | Measured | |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const row of rows) console.log(`| ${row.area} | ${row.metric} | ${row.budget ?? '—'} | ${row.value} | ${row.ok === undefined ? '' : row.ok ? 'ok' : 'over'} |`);
}
