// Extra top-level script modules (bmesh, …). Each one is a JavaScript global of
// that name for JavaScript scripts, and `import <name>` in Python through a thin
// Python file that forwards to the same JavaScript object (see python.ts:
// `_p3d_bridge.module(name)`), so both languages share one implementation.

export const scriptModules: Record<string, unknown> = {};

/** Python sources written next to bpy.py when the runtime loads: file name → source. */
export const pyModuleFiles: Record<string, string> = {};

/** Registers a module for scripts; `pySource` is the Python file that makes `import name` work. */
export function registerScriptModule(name: string, jsValue: unknown, pySource?: string) {
  scriptModules[name] = jsValue;
  if (pySource !== undefined) pyModuleFiles[`${name}.py`] = pySource;
}
