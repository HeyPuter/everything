import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function distinctOutput(input, output) {
  const source = await realpath(input);
  const target = output instanceof URL ? fileURLToPath(output) : resolve(output);
  try {
    const resolved = await realpath(target);
    const [a, b] = await Promise.all([stat(source), stat(resolved)]);
    if (source === resolved || (a.dev === b.dev && a.ino === b.ino)) throw new Error('Output must not overwrite the reviewed input');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return pathToFileURL(target);
}
