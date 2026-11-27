/// <reference lib="webworker" />
// Writes G-code away from the interface: a long finishing program takes a
// second or more, which froze the Post Process dialog on every change.

import { type PostJob, postProcess } from '../../cam/post';

declare const self: DedicatedWorkerGlobalScope;

/** The program, its line count and its first lines (for the preview). */
export type PostWorkerResponse = { code: string; lines: number; head: string } | { error: string };

const HEAD = 400;

self.onmessage = (ev: MessageEvent<PostJob>) => {
  try {
    const code = postProcess(ev.data);
    let lines = 0, end = -1;
    for (let i = code.indexOf('\n'); i >= 0; i = code.indexOf('\n', i + 1)) {
      lines++;
      if (lines === HEAD) end = i;
    }
    const more = lines + 1 - HEAD;
    const head = end < 0 ? code : `${code.slice(0, end)}\n... ${more} more lines`;
    self.postMessage({ code, lines, head } satisfies PostWorkerResponse);
  } catch (e) {
    self.postMessage({ error: (e as Error).message } satisfies PostWorkerResponse);
  }
};
