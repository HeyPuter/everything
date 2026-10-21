// @vitest-environment happy-dom
// Script compatibility harness (manual): runs every NN_*.py script of SCRIPTS_DIR in our Python
// (fresh empty scene each) and writes ours_out.json, to diff against the same scripts' output in
// the reference app.
import { it } from 'vitest';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp } from '../../src/app/app';
import { emptyDocument, startupDocument } from '../../src/data/defaults';
import { output } from '../../src/scripting/runner';
import { runPythonText } from '../../src/scripting/python';
import { pythonAvailable } from './support/python';

const DIR = process.env.SCRIPTS_DIR ?? '';

it.skipIf(!DIR)('runs the scripts', async () => {
  setApp(new App(startupDocument()));
  await import('./support/all_modules');
  if (!(await pythonAvailable())) throw new Error('Python unavailable');
  const out: Record<string, string> = {};
  for (const name of readdirSync(DIR).filter((f) => /^\d\d.*\.py$/.test(f)).sort()) {
    setApp(new App(emptyDocument()));
    output.clear();
    const r = runPythonText(readFileSync(join(DIR, name), 'utf8'), name);
    let text = output.lines
      .filter((l) => l.type === 'OUTPUT')
      .map((l) => l.text)
      .join('\n');
    if (!r.ok) text += `\nEXCEPTION ${r.error?.split('\n')[0]} (line ${r.line})`;
    out[name] = `${text}\n`;
  }
  writeFileSync(join(DIR, 'ours_out.json'), JSON.stringify(out, null, 1));
}, 300000);
