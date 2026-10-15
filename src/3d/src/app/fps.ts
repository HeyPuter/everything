// Playback frame rate measured from frame changes while the animation plays (shown in the
// 3D Viewport when Preferences ▸ Viewport ▸ Playback Frame Rate is on).
import { app, onAppReady } from './app';

const times: number[] = [];

onAppReady((a) =>
  a.subscribe((kinds) => {
    if (!a.playing) {
      times.length = 0;
      return;
    }
    if (!kinds.has('frame')) return;
    times.push(performance.now());
    if (times.length > 16) times.shift();
  }),
);

/** "fps: 23.9" while playing; a leading "!" marks a rate below the scene's. */
export function playbackFpsLabel(): string {
  if (times.length < 3) return '';
  const fps = ((times.length - 1) * 1000) / (times[times.length - 1] - times[0]);
  const r = app.doc.scene.render;
  const target = (r?.fps ?? 24) / (r?.fps_base || 1);
  return `${fps < target * 0.95 ? '!' : ''}fps: ${fps.toFixed(1)}`;
}
