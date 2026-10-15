// Python scripting in unit tests: loads the Pyodide package installed as a dev
// dependency (no network). `pythonAvailable()` is false when it cannot load, so
// Python suites can skip instead of failing in environments without it.
import { loadPython, setPyodideSource, runPythonText } from '../../../src/scripting/python';
import { output } from '../../../src/scripting/runner';

let ok: boolean | null = null;

export async function pythonAvailable(): Promise<boolean> {
  if (ok !== null) return ok;
  try {
    setPyodideSource(() => import('pyodide') as never);
    await loadPython();
    ok = true;
  } catch (e) {
    console.warn(`Python tests skipped: ${(e as Error).message}`);
    ok = false;
  }
  return ok;
}

/** Runs Python source as a script and returns what it printed; throws with the error and line on failure. */
export function runPy(code: string): string {
  output.clear();
  const src = code.replace(/^\n/, '');
  const indent = /^[ \t]*/.exec(src)![0].length;
  const dedented = src
    .split('\n')
    .map((l) => l.slice(Math.min(indent, /^[ \t]*/.exec(l)![0].length)))
    .join('\n');
  const r = runPythonText(dedented, 'test.py');
  const printed = output.lines
    .filter((l) => l.type === 'OUTPUT')
    .map((l) => l.text)
    .join('\n');
  if (!r.ok) throw new Error(`${r.error} (line ${r.line})\n${r.traceback ?? ''}\n${printed}`);
  return printed;
}
