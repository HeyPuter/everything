// Frames: Alt + mouse wheel steps the current frame by one from any editor (wheel down = next
// frame), except inside text inputs and the text-based editors.
import { app, onAppReady } from '../app/app';

const TEXT_EDITORS = new Set(['TEXT', 'CONSOLE', 'INFO', 'PREFERENCES', 'FILE_BROWSER']);
let acc = 0;

onAppReady(() => {
  addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || app.modal) return;
      const t = e.target as HTMLElement | null;
      if (!t || t.closest('input, textarea, [contenteditable="true"], .popup-layer')) return;
      const area = t.closest('.area') as HTMLElement | null;
      if (!area || TEXT_EDITORS.has(area.dataset.editor ?? '')) return;
      e.preventDefault();
      e.stopPropagation();
      // trackpads send many small deltas: step once per notch-sized amount
      acc += e.deltaY;
      const step = Math.abs(acc) >= 40 || e.deltaMode !== 0 ? Math.sign(acc) : 0;
      if (!step) return;
      acc = 0;
      app.run('screen.frame_offset', { delta: step }, { invoke: false });
    },
    { capture: true, passive: false },
  );
});
