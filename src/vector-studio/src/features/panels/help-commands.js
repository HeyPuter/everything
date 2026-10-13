/**
 * Help menu commands: Welcome (the start screen), What's New (a summary of
 * this release's additions) and System Info (browser, graphics, storage
 * and feature support, with Copy for bug reports).
 */
import { h } from '../../lib/dom.js';
import { formatBytes } from '../files/naming.js';

export const WHATS_NEW = [
  { title: 'History panel', text: 'Step back to any earlier state with one click, and keep named snapshots of the whole document.' },
  { title: 'Actions', text: 'Record commands, dialog settings, paint changes and transformations, then replay them on any selection or on every open document. Assign shortcuts and show actions as buttons.' },
  { title: 'Color Guide', text: 'Build harmonies from the current color, explore tints, shades, warm, cool, vivid and muted variations, and save them as color groups.' },
  { title: 'Asset Export', text: 'Collect artwork as assets and export each one at several scales and formats in one step.' },
  { title: 'Links and Attributes', text: 'Inspect and replace placed images, set overprint, fill rule, a link URL and notes on any object.' },
  { title: 'Document Info and Magic Wand panels', text: 'See what a document or selection contains at a glance, and tune the Magic Wand without opening a dialog.' },
  { title: 'More commands', text: 'Ungroup All, Lock and Hide Artwork Above, Trim Marks, Smooth, Global Edit, saved selections, Convert to CMYK, Overprint Black, File Info, Package, Version History and My Settings.' },
];

async function whatsNew(app) {
  return app.dialogs.open({
    title: "What's New in Vector Studio",
    className: 'whats-new',
    body: h('div.whats-new-body', h('ul.whats-new-list', WHATS_NEW.map((f) => h('li', h('strong', f.title), h('span', f.text))))),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

/** The browser's WebGL renderer name, when it shares it. */
function gpuInfo() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl || typeof gl.getParameter !== 'function') return { webgl: false };
    const ext = gl.getExtension?.('WEBGL_debug_renderer_info');
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    return { webgl: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? 'WebGL 2' : 'WebGL 1', renderer, vendor, maxTex };
  } catch {
    return { webgl: false };
  }
}

/** System information as [section, [[label, value]]] (pure apart from reading the environment). */
export async function systemInfo(app) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const scr = typeof screen !== 'undefined' ? screen : {};
  const yes = (v) => (v ? 'Yes' : 'No');
  let storage = 'Unknown';
  try {
    const est = await nav.storage?.estimate?.();
    if (est) storage = `${formatBytes(est.usage || 0)} used of ${formatBytes(est.quota || 0)} available`;
  } catch {
    // Not available in this context.
  }
  let persisted = 'Unknown';
  try {
    if (nav.storage?.persisted) persisted = yes(await nav.storage.persisted());
  } catch {
    // Ignore.
  }
  const gpu = gpuInfo();
  const sections = [
    [
      'Application',
      [
        ['Environment', app.env === 'app' ? 'Puter desktop' : 'Web browser'],
        ['Signed in', app.user ? `Yes (${app.user.username})` : 'No'],
        ['Open documents', String(app.editors.length)],
        ['Theme', app.prefs.get('theme')],
      ],
    ],
    [
      'Browser',
      [
        ['User agent', nav.userAgent || 'Unknown'],
        ['Platform', nav.userAgentData?.platform || nav.platform || 'Unknown'],
        ['Languages', (nav.languages || [nav.language]).filter(Boolean).join(', ') || 'Unknown'],
        ['Online', yes(nav.onLine !== false)],
      ],
    ],
    [
      'Display',
      [
        ['Screen', scr.width ? `${scr.width} x ${scr.height} px, ${scr.colorDepth || '?'}-bit color` : 'Unknown'],
        ['Window', typeof window !== 'undefined' ? `${window.innerWidth} x ${window.innerHeight} px` : 'Unknown'],
        ['Pixel ratio', String(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)],
        ['Wide color (P3)', yes(typeof matchMedia !== 'undefined' && matchMedia('(color-gamut: p3)').matches)],
      ],
    ],
    [
      'Graphics',
      [
        ['WebGL', gpu.webgl || 'Not available'],
        ['GPU', gpu.renderer ? `${gpu.renderer}${gpu.vendor ? ` (${gpu.vendor})` : ''}` : 'Not shared by the browser'],
        ['Max texture size', gpu.maxTex ? `${gpu.maxTex} px` : 'Unknown'],
        ['WebGPU', yes(Boolean(nav.gpu))],
        ['OffscreenCanvas', yes(typeof OffscreenCanvas !== 'undefined')],
        ['WebAssembly', yes(typeof WebAssembly !== 'undefined')],
      ],
    ],
    [
      'Hardware',
      [
        ['CPU threads', nav.hardwareConcurrency ? String(nav.hardwareConcurrency) : 'Unknown'],
        ['Memory', nav.deviceMemory ? `About ${nav.deviceMemory} GB` : 'Not shared by the browser'],
        ['Touch points', String(nav.maxTouchPoints ?? 0)],
      ],
    ],
    [
      'Storage',
      [
        ['Site storage', storage],
        ['Persistent storage', persisted],
        ['Private file system', yes(Boolean(nav.storage?.getDirectory))],
        ['Save to files in place', yes(typeof window !== 'undefined' && 'showSaveFilePicker' in window)],
        ['Clipboard images', yes(typeof ClipboardItem !== 'undefined')],
        ['Local fonts', yes(typeof window !== 'undefined' && 'queryLocalFonts' in window)],
      ],
    ],
  ];
  return sections;
}

export function systemInfoText(sections) {
  return sections.map(([title, rows]) => [`${title}`, ...rows.map(([k, v]) => `  ${k}: ${v}`)].join('\n')).join('\n\n');
}

async function systemInfoDialog(app) {
  const sections = await systemInfo(app);
  const text = systemInfoText(sections);
  const body = h(
    'div.sysinfo',
    // Scrolls when long: focusable so the keyboard can scroll it.
    { role: 'region', 'aria-label': 'System information', tabindex: '0' },
    sections.map(([title, rows]) => h('section.sysinfo-sec', h('h3.form-heading', title), h('dl.files-info-list', rows.flatMap(([k, v]) => [h('dt', k), h('dd', v)])))),
  );
  const copy = h('button.btn', {
    type: 'button',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
        app.notify('Copied system info.', { polite: true });
      } catch {
        app.notify('Could not copy to the clipboard.');
      }
    },
  }, 'Copy');
  return app.dialogs.open({
    title: 'System Info',
    className: 'wide sysinfo-dialog',
    body,
    onOpen: ({ footer }) => footer.prepend(copy),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

export function registerHelpCommands(app) {
  app.commands.register([
    { id: 'help.welcome', label: 'Welcome Screen', run: (a) => a.showHome() },
    { id: 'help.whatsNew', label: "What's New...", run: (a) => whatsNew(a) },
    { id: 'help.systemInfo', label: 'System Info...', run: (a) => systemInfoDialog(a) },
  ]);
}
