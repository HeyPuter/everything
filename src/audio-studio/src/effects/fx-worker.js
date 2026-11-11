// Worker that runs one offline effect process (see offline-fx.js).
// in:  { id, task?, channels, rate, values, extra, mask?, module } (task: a def.tasks helper)
// out: { type: 'progress', value } | { type: 'done', result } | { type: 'error', message }

import { setDspModule, dsp } from '../audio/dsp.js';
import { getEffect } from './registry.js';
import './catalog.js';

self.onmessage = async (e) => {
  const { id, task, channels, rate, values, extra, mask = null, module } = e.data;
  try {
    setDspModule(module);
    const def = getEffect(id);
    const fn = task ? def?.tasks?.[task] : def?.run;
    if (!fn) throw new Error(task ? `No task ${task} for ${id}` : `No offline process for ${id}`);
    let last = 0;
    const onProgress = (v) => {
      const now = Date.now();
      if (now - last > 50 || v >= 1) {
        last = now;
        self.postMessage({ type: 'progress', value: v });
      }
    };
    const result = await fn({ channels, rate, values, extra, dsp: await dsp(), onProgress, mask });
    const list = Array.isArray(result) ? result : result?.channels;
    self.postMessage({ type: 'done', result }, Array.isArray(list) ? list.map((c) => c.buffer) : []);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
