// Preference sections built from simple rows (Interface, Viewport, Editing, Animation, Input,
// Navigation, System, Save & Load, File Paths). Themes, Lights, Add-ons and Keymap have their
// own modules.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { panel } from '../ui/widgets';
import { prefs } from '../app/prefs';
import { renderContext } from '../render/context';
import { python, PYODIDE_INDEX_URL, PYODIDE_VERSION } from '../scripting/python';
import { registerPrefSection } from './editor';
import { pBool, pNum, pEnum, pText, note, infoRow } from './ui';

// ---------------------------------------------------------------------------
// Interface

registerPrefSection({
  id: 'INTERFACE',
  label: 'Interface',
  group: 0,
  draw: () => [
    panel('pf-display', 'Display', () => [
      pNum('resolution_scale', 'Resolution Scale', { min: 0.25, max: 4, softMin: 0.5, softMax: 2, step: 0.05, precision: 2, slider: true, tip: 'Size of the whole interface' }),
      pNum('font_size', 'Font Size', { min: 8, max: 24, int: true, unit: 'pixel' }),
      pBool('show_splash', 'Splash Screen', 'Show the splash screen with recent files when the application starts fresh'),
      pBool('show_tooltips', 'Tooltips', 'Show a description when the pointer rests on a control'),
    ]),
    panel('pf-statusbar', 'Status Bar', () => [pBool('show_statusbar_stats', 'Scene Statistics', 'Object, vertex and face counts of the scene')]),
    panel('pf-text', 'Text Rendering', () => [
      pBool('use_text_antialiasing', 'Anti-Aliasing', 'Smooth the edges of interface text'),
      pText('font_ui', 'Interface Font', 'Inter (built in)'),
      pText('font_ui_mono', 'Monospaced Font', 'JetBrains Mono (built in)'),
      note('Enter the name of a font installed on this computer, e.g. "Helvetica Neue". Leave empty for the built-in fonts.'),
    ]),
  ],
});

// ---------------------------------------------------------------------------
// Viewport

registerPrefSection({
  id: 'VIEWPORT',
  label: 'Viewport',
  group: 0,
  draw: () => [panel('pf-vp-display', 'Display', () => [pNum('view_lens', 'Default Focal Length', { min: 1, max: 250, int: true, tip: 'Lens of newly opened 3D Viewports, in millimeters' })])],
});

// ---------------------------------------------------------------------------
// Input & Navigation

registerPrefSection({
  id: 'INPUT',
  label: 'Input',
  group: 2,
  draw: () => [
    panel('pf-kb', 'Keyboard', () => [pBool('emulate_numpad', 'Emulate Numpad', 'The 1 to 0 keys of the main keyboard act as the numpad ones in the 3D Viewport (useful for laptops)')]),
    panel('pf-mouse', 'Mouse', () => [pBool('emulate_3_button_mouse', 'Emulate 3 Button Mouse', 'Alt with the left mouse button acts as the middle button')]),
    panel('pf-touchpad', 'Touchpad', () => [pBool('trackpad_orbit', 'Two-Finger Scroll Orbits', 'Two-finger scrolling orbits the view (off: it zooms)')]),
  ],
});

registerPrefSection({
  id: 'NAVIGATION',
  label: 'Navigation',
  group: 2,
  draw: () => [
    panel('pf-orbit', 'Orbit & Pan', () => [
      pEnum('orbit_method', 'Orbit Method', [
        { value: 'TURNTABLE', label: 'Turntable', description: 'Orbit around the vertical axis and keep the horizon level' },
        { value: 'TRACKBALL', label: 'Trackball', description: 'Orbit freely in every direction' },
      ], { expand: true }),
      pBool('use_rotate_around_active', 'Orbit Around Selection', 'Orbit around the center of the selection instead of the view center'),
      pBool('use_auto_perspective', 'Auto Perspective', 'Switch to orthographic for axis-aligned views and back to perspective when orbiting'),
    ]),
    panel('pf-zoom', 'Zoom', () => [
      pBool('use_zoom_to_mouse', 'Zoom to Mouse Position', 'Zoom toward the pointer instead of the view center'),
      pBool('invert_zoom_wheel', 'Invert Wheel Zoom Direction', 'Scroll the wheel the other way to zoom in'),
    ]),
    panel('pf-fly', 'Fly & Walk', () => [
      pEnum('navigation_mode', 'View Navigation', [
        { value: 'WALK', label: 'Walk', description: 'Shift ` walks through the scene' },
        { value: 'FLY', label: 'Fly', description: 'Shift ` flies through the scene' },
      ], { expand: true }),
    ]),
  ],
});

// ---------------------------------------------------------------------------
// Keymap

registerPrefSection({ id: 'KEYMAP', label: 'Keymap', group: 2, draw: (c) => c.editor.keymapView.body() });

// ---------------------------------------------------------------------------
// System

let glInfo: [string, string][] | null = null;
function systemRows(): Child {
  if (!glInfo) {
    glInfo = [];
    try {
      const r = renderContext?.engine.renderer;
      const gl = (r?.getContext() as WebGL2RenderingContext | undefined) ?? document.createElement('canvas').getContext('webgl2');
      if (!gl) glInfo.push(['WebGL', 'Not available']);
      else {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        glInfo.push(['Vendor', String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR))]);
        glInfo.push(['Renderer', String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))]);
        glInfo.push(['Version', String(gl.getParameter(gl.VERSION))]);
        glInfo.push(['Shading Language', String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION))]);
        glInfo.push(['Max Texture Size', String(gl.getParameter(gl.MAX_TEXTURE_SIZE))]);
        glInfo.push(['Max Samples', String(gl.getParameter(gl.MAX_SAMPLES))]);
        glInfo.push(['Extensions', String(gl.getSupportedExtensions()?.length ?? 0)]);
      }
      glInfo.push(['WebGPU', typeof navigator !== 'undefined' && 'gpu' in navigator ? 'Available' : 'Not available']);
    } catch (e) {
      glInfo.push(['WebGL', `Unavailable (${(e as Error).message})`]);
    }
  }
  return glInfo.map(([a, b]) => infoRow(a, b));
}

function pythonRows(): Child {
  const st = python.state;
  return [
    infoRow('Status', st === 'ready' ? `Loaded (Python ${python.version})` : st === 'loading' ? 'Loading…' : st === 'error' ? 'Failed to load' : 'Not loaded (loads on first use)'),
    infoRow('Runtime', `Pyodide ${PYODIDE_VERSION} (MPL-2.0)`),
    infoRow('Source', PYODIDE_INDEX_URL),
    st === 'error' ? h('div', { class: 'prefs-note err' }, python.error) : null,
  ];
}

function deviceRows(): Child {
  const n = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string } };
  return [
    infoRow('Device Pixel Ratio', String(devicePixelRatio)),
    infoRow('CPU Threads', String(n.hardwareConcurrency ?? '?')),
    infoRow('Memory', n.deviceMemory ? `${n.deviceMemory} GB (approx.)` : 'Unknown'),
    infoRow('Platform', n.userAgentData?.platform ?? n.platform ?? ''),
    infoRow('Browser', n.userAgent),
    infoRow('Storage', typeof indexedDB !== 'undefined' ? 'IndexedDB available (session recovery)' : 'IndexedDB unavailable'),
  ];
}

registerPrefSection({
  id: 'SYSTEM',
  label: 'System',
  group: 3,
  draw: () => [
    panel('pf-gpu', 'Display Graphics', () => systemRows()),
    panel('pf-memory', 'Memory & Limits', () => [
      pNum('undo_steps', 'Undo Steps', { min: 0, max: 512, int: true, tip: 'How many steps Undo can go back' }),
      note(`${app.undo.history.length} step(s) in the current history.`),
    ]),
    panel('pf-py', 'Python', () => pythonRows()),
    panel('pf-dev', 'Device', () => deviceRows(), { closed: true }),
  ],
});

// ---------------------------------------------------------------------------
// Save & Load

registerPrefSection({
  id: 'SAVE_LOAD',
  label: 'Save & Load',
  group: 3,
  draw: () => [
    panel('pf-autosave', 'Auto Save', () => [
      pBool('use_auto_save_temporary_files', 'Auto Save', 'Keep a recovery copy of the project at regular intervals (in addition to saving after edits)'),
      pNum('autosave_interval', 'Timer (Minutes)', { min: 1, max: 60, int: true, disabled: !prefs.use_auto_save_temporary_files }),
      h('div', { class: 'prefs-btn-row' }, h('button', { class: 'btn', onclick: () => app.run('wm.recover_last_session') }, 'Recover Last Session'), h('button', { class: 'btn', onclick: () => app.run('wm.recover_auto_save') }, 'Recover Auto Save…')),
    ]),
  ],
});
