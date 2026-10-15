// Runtime effects of interface-wide preferences: scale, fonts, tooltips, undo limit,
// auto save, key timing. Feature-specific preferences apply in their own modules.
import { app } from '../app/app';
import { keyTiming } from '../app/keymap';
import { autosave } from '../io/files';
import { shell } from '../ui/shell';
import { onPrefsApply } from './store';

let autosaveTimer = 0;

type ViewLike = { nav: { autoPersp: boolean } };
export function forEachView3D(fn: (v: ViewLike) => void) {
  for (const a of shell?.screen.areas ?? []) {
    const ed = a.editor as unknown as Partial<ViewLike>;
    if (ed?.nav && typeof ed.nav === 'object' && 'autoPersp' in ed.nav) fn(ed as ViewLike);
  }
}

onPrefsApply((p) => {
  const root = document.documentElement;
  const scale = Math.max(0.25, Math.min(4, p.resolution_scale || 1));
  root.style.setProperty('--fs', `${Math.round(p.font_size * scale * 10) / 10}px`);
  root.style.setProperty('--row', `${Math.round(20 * scale)}px`);
  root.style.setProperty('--ui-scale', String(scale));
  if (p.font_ui.trim()) root.style.setProperty('--font', `${cssFamily(p.font_ui)}, 'Inter', system-ui, sans-serif`);
  else root.style.removeProperty('--font');
  if (p.font_ui_mono.trim()) root.style.setProperty('--mono', `${cssFamily(p.font_ui_mono)}, 'JetBrains Mono', ui-monospace, monospace`);
  else root.style.removeProperty('--mono');
  document.body.classList.toggle('no-tooltips', !p.show_tooltips);
  document.body.classList.toggle('no-text-aa', !p.use_text_antialiasing);
  document.body.classList.toggle('reduce-motion', p.use_reduce_motion);
  document.body.classList.toggle('no-corner-split', !p.show_corner_split);
  document.body.classList.toggle('no-edge-resize', !p.show_edge_resize);
  document.body.classList.toggle('no-region-toggles', !p.show_regions_visibility_toggle);
  app.undo.limit = Math.max(0, Math.min(512, Math.round(p.undo_steps)));
  keyTiming.doubleClick = Math.max(50, Math.min(1000, p.mouse_double_click_time));
  clearInterval(autosaveTimer);
  if (p.use_auto_save_temporary_files) {
    const minutes = Math.max(1, Math.min(60, Math.round(p.autosave_interval || 2)));
    autosaveTimer = window.setInterval(() => void autosave(), minutes * 60000);
  }
  // existing viewports pick up navigation settings immediately
  forEachView3D((v) => (v.nav.autoPersp = p.use_auto_perspective));
});

/** Quote a font family list entry unless it is a generic family or already quoted. */
function cssFamily(name: string) {
  const n = name.trim();
  if (/^['"]/.test(n) || /^(serif|sans-serif|monospace|system-ui|cursive|fantasy|ui-[a-z-]+)$/.test(n)) return n;
  return `'${n.replace(/'/g, '')}'`;
}
