// Top functions by self time from a V8 .cpuprofile (node --cpu-prof, or browser.mjs --profile), and with
// `--callers=<name>` the call stacks that spend the most time in functions of that name.
// Run: node tools/perf/profile-summary.mjs <file.cpuprofile> [count] [--callers=<name>]
import { readFileSync } from 'node:fs';

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const callers = process.argv.find((arg) => arg.startsWith('--callers='))?.slice(10);
const [file, count = '25'] = positional;
const profile = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const label = (node) => `${node.callFrame.functionName || '(anonymous)'} ${node.callFrame.url.split('/').slice(-2).join('/')}:${node.callFrame.lineNumber + 1}`;
const self = new Map();
const stacks = new Map();
let total = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const delta = profile.timeDeltas[i] ?? 0;
  total += delta;
  const node = byId.get(profile.samples[i]);
  self.set(label(node), (self.get(label(node)) ?? 0) + delta);
  if (!callers) continue;
  let current = node;
  while (current && current.callFrame.functionName !== callers) current = byId.get(parent.get(current.id));
  if (!current) continue;
  const chain = [];
  for (let up = byId.get(parent.get(current.id)); up && chain.length < 6; up = byId.get(parent.get(up.id))) chain.push(label(up));
  const key = chain.join(' ← ');
  stacks.set(key, (stacks.get(key) ?? 0) + delta);
}
const show = (map) => {
  for (const [key, micros] of [...map].sort((a, b) => b[1] - a[1]).slice(0, Number(count))) {
    console.log(`${(micros / 1000).toFixed(1).padStart(8)} ms ${((micros / total) * 100).toFixed(1).padStart(5)}%  ${key}`);
  }
};
if (callers) show(stacks); else show(self);
