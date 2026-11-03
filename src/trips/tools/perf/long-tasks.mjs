// For each main-thread task over 50 ms in a browser.mjs --profile trace, the functions (with callers) that took the
// most time, from the CPU profile recorded alongside it.
// Run: node tools/perf/long-tasks.mjs <trips-<tab>.trace.json> <trips-<tab>.cpuprofile>
import { readFileSync } from 'node:fs';

const [traceFile, profileFile] = process.argv.slice(2);
const trace = JSON.parse(readFileSync(traceFile, 'utf8')).traceEvents;
const profile = JSON.parse(readFileSync(profileFile, 'utf8'));
const main = trace.find((event) => event.name === 'thread_name' && event.args?.name === 'CrRendererMain' && trace.some((other) => other.pid === event.pid && other.name === 'FunctionCall'));
const tasks = trace.filter((event) => event.pid === main.pid && event.tid === main.tid && event.ph === 'X' && event.name === 'RunTask' && event.dur > 50_000).sort((a, b) => a.ts - b.ts);
const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const label = (node) => `${node.callFrame.functionName || '(anonymous)'}:${node.callFrame.lineNumber + 1}`;
const times = [];
let at = profile.startTime;
for (let i = 0; i < profile.samples.length; i++) { at += profile.timeDeltas[i]; times.push(at); }
for (const task of tasks) {
  const stacks = new Map();
  for (let i = 0; i < times.length; i++) {
    if (times[i] < task.ts || times[i] > task.ts + task.dur) continue;
    const chain = [];
    for (let node = byId.get(profile.samples[i]); node && chain.length < 5; node = byId.get(parent.get(node.id))) if (node.callFrame.functionName !== '(root)') chain.push(label(node));
    const key = chain.slice(0, 5).join(' ← ') || '(native)';
    stacks.set(key, (stacks.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
  console.log(`\nTask at +${((task.ts - tasks[0].ts) / 1000).toFixed(0)} ms, ${(task.dur / 1000).toFixed(0)} ms`);
  for (const [key, micros] of [...stacks].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`  ${(micros / 1000).toFixed(1).padStart(6)} ms  ${key}`);
}
