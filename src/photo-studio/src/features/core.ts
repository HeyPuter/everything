import type { Editor } from '../editor';
import { registerCommand, commands, type Command } from '../app/registry';
import { performAction } from '../ui/actions';
import { formDialog, information } from '../ui/dialog';
import { findLayer, containerOf, allLayers, layer, replaceDocument, type Layer, type PhotoDocument, cropDocument } from '../model/document';
import { newPixelLayer, setLayerPixels } from '../model/pixel-layer';
import { gridFromImage, readRGBA, readMask, writeRect, emptyGrid } from '../model/tiles';
import { canvasRect, selectionGrid, selectionBounds, applySelection } from '../model/selection';
import { serialize } from '../model/serialization';
import { escapeXML } from '../model/assets';
import { formatShortcut, isMac } from '../app/shortcuts';
import { appIcon } from '../app/shell';
import { compositeRGBA, hexRgb, layerRGBA, nextLayerName, pixelTarget, rasterizeLayer, commitTarget } from './pixels';
import { assertEditable, selectedRoots, groupLayers } from '../model/layers';
import { hasMask } from '../model/masks';
import { transformBounds } from '../model/transform';
import { insertAboveSelection } from './layers/insert';
import type { RGBA8 } from '../imaging/types';
import { layerLock } from '../model/locks';
import { fillWithPattern } from './effects/commands';

const hasDoc = (e: Editor) => e.hasDocument;
const hasLayer = (e: Editor) => !!e.layer;
function cmd(id: string, label: string, run: Command['run'], extra: Partial<Command> = {}) {
  registerCommand({ id, label, run, ...extra });
}
// Internal clipboard keeps exact pixels and position; the system clipboard
// receives a PNG copy for other applications.
let clipboard: { image: RGBA8; x: number; y: number } | undefined;
/** The internal clipboard (Paste Special, Purge). */
export const internalClipboard = () => clipboard;
export function purgeClipboard() {
  clipboard = undefined;
}
/** Pixels last copied in the workspace (Perspective Planes pastes them). */
export const copiedImage = (): RGBA8 | undefined => clipboard?.image;

export function installCore(e: Editor) {
  // ----- File -----
  cmd('file.open', 'Open…', () => {
    // Load the decoders while the file picker is open.
    import('./files/open').catch(() => {});
    const input = e.el<HTMLInputElement>('#file-input');
    input.dataset.place = '';
    input.click();
  }, { shortcut: 'Mod+O', recordable: false });
  cmd('file.place-embedded', 'Place Embedded…', () => pickFiles(e, true), { enabled: hasDoc, recordable: false });
  cmd('file.close', 'Close', () => void e.closeSession(e.session), { shortcut: 'Mod+W', recordable: false });
  cmd('file.close-all', 'Close All', async () => {
    for (const s of [...e.sessions]) if (!(await e.closeSession(s))) break;
  }, { shortcut: 'Mod+Alt+W', recordable: false });
  cmd('file.close-others', 'Close Others', async () => {
    for (const s of e.sessions.filter((x) => x !== e.session)) await e.closeSession(s);
  }, { shortcut: 'Mod+Alt+P', enabled: (e) => e.sessions.length > 1, recordable: false });
  cmd('file.revert', 'Revert', () => {
    if (!e.saved) return;
    const saved = e.saved;
    e.command('Revert', (d) => replaceDocument(d, saved));
  }, { shortcut: 'F12', enabled: (e) => !!e.saved && e.doc !== e.saved });
  cmd('file.export-original-psd', 'Download Original PSD', () => performAction(e, 'save-original-psd'), { enabled: (e) => !!e.doc.psdOriginal, recordable: false });
  cmd('app.account', 'Puter Account', () => performAction(e, 'account'), { hidden: true, recordable: false });

  // ----- Edit -----
  cmd('edit.undo', 'Undo', () => performAction(e, 'undo'), { shortcut: 'Mod+Z', enabled: (e) => e.history.canUndo || e.transform.active, recordable: false });
  cmd('edit.redo', 'Redo', () => performAction(e, 'redo'), { shortcut: 'Mod+Shift+Z', enabled: (e) => e.history.canRedo, recordable: false });
  // Toggle Last State flips between the latest state and the one before it:
  // it redoes only the step it undid itself.
  let toggledTo: PhotoDocument | undefined;
  cmd('edit.toggle-last-state', 'Toggle Last State', async () => {
    const back = toggledTo === e.doc && e.history.canRedo;
    if (back || !e.history.canUndo) {
      await performAction(e, 'redo');
      toggledTo = undefined;
    } else {
      await performAction(e, 'undo');
      toggledTo = e.doc;
    }
  }, { shortcut: 'Mod+Alt+Z', recordable: false });
  cmd('edit.free-transform', 'Free Transform', () => {
    e.setTool('move');
    e.transform.begin();
  }, { shortcut: 'Mod+T', enabled: hasLayer });
  cmd('edit.transform-commit', 'Commit Transform', () => e.transform.apply(), { hidden: true });
  cmd('edit.transform-cancel', 'Cancel Transform', () => e.transform.cancel(), { hidden: true });
  cmd('edit.copy', 'Copy', () => copySelection(e, false, false), { shortcut: 'Mod+C', enabled: hasDoc, recordable: false });
  cmd('edit.copy-merged', 'Copy Merged', () => copySelection(e, false, true), { shortcut: 'Mod+Shift+C', enabled: hasDoc, recordable: false });
  cmd('edit.cut', 'Cut', () => copySelection(e, true, false), { shortcut: 'Mod+X', enabled: hasDoc });
  cmd('edit.paste', 'Paste', () => paste(e, false), { shortcut: 'Mod+V' });
  cmd('edit.paste-in-place', 'Paste in Place', () => paste(e, true), { shortcut: 'Mod+Shift+V', enabled: () => !!clipboard });
  cmd('edit.clear', 'Clear', () => clearSelection(e), { shortcut: ['Backspace', 'Delete'], enabled: hasDoc });
  cmd('edit.fill', 'Fill…', () => fillDialog(e), { shortcut: ['Shift+F5', 'Shift+Backspace'], enabled: hasDoc });
  cmd('edit.fill-foreground', 'Fill with Foreground Color', () => fillWith(e, hexRgb(e.color), 1, false), { shortcut: 'Alt+Backspace', hidden: true });
  cmd('edit.fill-background', 'Fill with Background Color', () => fillWith(e, hexRgb(e.background), 1, false), { shortcut: 'Mod+Backspace', hidden: true });
  cmd('edit.fill-foreground-preserve', 'Fill with Foreground Color, Preserving Transparency', () => fillWith(e, hexRgb(e.color), 1, true), { shortcut: 'Alt+Shift+Backspace', hidden: true });
  cmd('edit.fill-background-preserve', 'Fill with Background Color, Preserving Transparency', () => fillWith(e, hexRgb(e.background), 1, true), { shortcut: 'Mod+Shift+Backspace', hidden: true });
  cmd('edit.purge-history', 'Histories', () => {
    e.history.reset(e.doc);
    e.session.collectTiles();
    e.update();
    e.message('History purged.');
  }, { recordable: false });

  // ----- Image -----
  cmd('image.crop', 'Crop', () => {
    const b = selectionBounds(e.doc, selectionGrid(e.doc, e.assets.tiles));
    if (!b) return;
    e.command('Crop', (d) => {
      cropDocument(d, b);
      d.selection = null;
      d.selectionMask = null;
    });
    e.fit();
  }, { enabled: (e) => !!e.doc.selection });
  cmd('image.trim', 'Trim Transparent Pixels', () => trim(e), { enabled: hasDoc });
  cmd('image.reveal-all', 'Reveal All', () => revealAll(e), { enabled: hasDoc });
  cmd('image.duplicate', 'Duplicate…', async () => {
    const v = await formDialog('Duplicate Image', [{ name: 'name', label: 'As', value: `${e.doc.name} copy` }], 'Duplicate');
    if (!v) return;
    const blob = await serialize(e.doc, e.assets);
    const { deserialize } = await import('../model/serialization');
    const loaded = await deserialize(blob);
    // The copy is the read document itself (not a spread of it), so the
    // project's sidecars (its provenance record) stay attached to it.
    const doc = Object.assign(loaded.document, { id: crypto.randomUUID(), name: v.name });
    const s = e.newSession(doc);
    s.assets = loaded.assets;
    s.history.reset(doc);
    s.hasDocument = true;
    e.session = s;
    e.fit();
    e.update();
  }, { enabled: hasDoc, recordable: false });

  // ----- Layer -----
  cmd('layer.new', 'Layer…', async () => {
    const v = await formDialog('New Layer', [{ name: 'name', label: 'Name', value: nextLayerName(e.doc) }], 'OK');
    if (!v) return;
    const l = newPixelLayer(v.name || nextLayerName(e.doc), e.doc);
    insertAboveSelection(e, l, 'New Layer');
  }, { shortcut: 'Mod+Shift+N', enabled: hasDoc });
  cmd('layer.new-quick', 'New Layer', () => insertAboveSelection(e, newPixelLayer(nextLayerName(e.doc), e.doc), 'New Layer'), { shortcut: 'Mod+Alt+Shift+N', hidden: true });
  cmd('layer.new-group', 'Group', () => {
    const g = layer('group', `Group ${allLayers(e.doc.layers).filter((l) => l.kind === 'group').length + 1}`, e.doc.width, e.doc.height);
    insertAboveSelection(e, g, 'New Group');
  }, { enabled: hasDoc });
  cmd('layer.group', 'Group Layers', () => performAction(e, 'group'), { shortcut: 'Mod+G', enabled: (e) => e.selectedIds.size > 0 });
  cmd('layer.group-from-layers', 'Group from Layers', () => performAction(e, 'group'), { enabled: (e) => e.selectedIds.size > 0 });
  cmd('layer.ungroup', 'Ungroup Layers', () => performAction(e, 'ungroup'), { shortcut: 'Mod+Shift+G', enabled: (e) => e.selectedLayers.some((l) => l.kind === 'group') });
  cmd('layer.duplicate', 'Duplicate Layer', () => performAction(e, 'duplicate'), { enabled: hasLayer });
  cmd('layer.delete', 'Delete Layer', () => performAction(e, 'delete'), { enabled: hasLayer });
  cmd('layer.via-copy', 'Layer via Copy', () => layerVia(e, false), { shortcut: 'Mod+J', enabled: hasLayer });
  cmd('layer.via-cut', 'Layer via Cut', () => layerVia(e, true), { shortcut: 'Mod+Shift+J', enabled: (e) => !!e.doc.selection && !!e.layer });
  cmd('layer.properties', 'Layer Properties…', async () => {
    const l = e.layer;
    if (!l) return;
    const v = await formDialog('Layer Properties', [{ name: 'name', label: 'Name', value: l.name }], 'OK');
    if (v) e.editLayer('Rename Layer', (x) => (x.name = v.name));
    // Menus offer Rename Layer (in place); this stays for recorded actions.
  }, { enabled: hasLayer, hidden: true });
  cmd('layer.fill-solid', 'Solid Color', () => {
    const l = layer('solid', 'Color Fill', e.doc.width, e.doc.height);
    l.color = e.color;
    if (e.doc.selection) l.maskGrid = selectionGrid(e.doc, e.assets.tiles) ?? undefined;
    insertAboveSelection(e, l, 'New Fill Layer');
  }, { enabled: hasDoc });
  cmd('layer.rasterize', 'Layer', async () => {
    const l = e.layer;
    if (l) await rasterizeLayer(e, l.id);
  }, { enabled: (e) => !!e.layer && !['pixel', 'group', 'adjustment'].includes(e.layer.kind) });
  cmd('layer.rasterize-type', 'Type', async () => {
    if (e.layer?.kind === 'text') await rasterizeLayer(e, e.layer.id, 'Rasterize Type');
  }, { enabled: (e) => e.layer?.kind === 'text' });
  cmd('layer.rasterize-shape', 'Shape', async () => {
    if (e.layer?.kind === 'vector') await rasterizeLayer(e, e.layer.id, 'Rasterize Shape');
  }, { enabled: (e) => e.layer?.kind === 'vector' });
  cmd('layer.rasterize-fill', 'Fill Content', async () => {
    if (e.layer?.kind === 'solid') await rasterizeLayer(e, e.layer.id, 'Rasterize Fill');
  }, { enabled: (e) => e.layer?.kind === 'solid' });
  cmd('layer.rasterize-embedded', 'Embedded Object', async () => {
    if (e.layer?.kind === 'image') await rasterizeLayer(e, e.layer.id, 'Rasterize Embedded Object');
  }, { enabled: (e) => e.layer?.kind === 'image' });
  cmd('layer.clipping-mask', 'Create Clipping Mask', () => {
    const l = e.layer;
    if (!l) return;
    const list = containerOf(e.doc.layers, l.id)!;
    if (list.indexOf(l) === 0 && !l.clipped) {
      e.message('There is no layer below to clip to.');
      return;
    }
    e.editLayer(l.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask', (x) => {
      if (x.clipped) delete x.clipped;
      else x.clipped = true;
    });
  }, { shortcut: 'Mod+Alt+G', enabled: hasLayer, checked: (e) => !!e.layer?.clipped });
  for (const [id, label, shortcut, where] of [
    ['layer.bring-front', 'Bring to Front', 'Mod+Shift+]', 'front'],
    ['layer.bring-forward', 'Bring Forward', 'Mod+]', 'forward'],
    ['layer.send-backward', 'Send Backward', 'Mod+[', 'backward'],
    ['layer.send-back', 'Send to Back', 'Mod+Shift+[', 'back'],
  ] as const)
    cmd(id, label, () => arrange(e, where), { shortcut, enabled: hasLayer });
  cmd('layer.hide', 'Hide Layers', () => {
    const ids = [...e.selectedIds];
    e.command('Hide Layers', (d) => {
      for (const id of ids) {
        const l = findLayer(d.layers, id);
        if (l) l.visible = !l.visible;
      }
    });
  }, { shortcut: 'Mod+,', enabled: hasLayer });
  cmd('layer.lock-all', 'Lock Layers', () => {
    const ids = [...e.selectedIds];
    const lock = !e.layer?.locked;
    e.command(lock ? 'Lock Layers' : 'Unlock Layers', (d) => {
      for (const id of ids) {
        const l = findLayer(d.layers, id);
        if (l) l.locked = lock;
      }
    });
  }, { shortcut: 'Mod+/', enabled: hasLayer });
  cmd('layer.merge-down', 'Merge Down', () => mergeDown(e), { shortcut: 'Mod+E', enabled: hasLayer });
  cmd('layer.merge-visible', 'Merge Visible', () => mergeVisible(e, false), { shortcut: 'Mod+Shift+E', enabled: hasDoc });
  cmd('layer.stamp-visible', 'Stamp Visible', () => mergeVisible(e, true), { shortcut: 'Mod+Alt+Shift+E', hidden: true });
  cmd('layer.flatten', 'Flatten Image', () => flatten(e), { enabled: (e) => e.doc.layers.length > 0 });
  cmd('layer.mask-reveal-all', 'Reveal All', () => addMask(e, 'reveal'), { enabled: hasLayer });
  cmd('layer.mask-hide-all', 'Hide All', () => addMask(e, 'hide'), { enabled: hasLayer });
  cmd('layer.mask-reveal-selection', 'Reveal Selection', () => addMask(e, 'selection'), { enabled: (e) => !!e.layer && !!e.doc.selection });
  cmd('layer.mask-hide-selection', 'Hide Selection', () => addMask(e, 'hide-selection'), { enabled: (e) => !!e.layer && !!e.doc.selection });
  cmd('layer.mask-delete', 'Delete', () => {
    e.maskTarget = '';
    e.editLayer('Delete Layer Mask', (l) => {
      l.mask = null;
      delete l.maskAsset;
      delete l.pixelMask;
      delete l.maskStrokes;
      delete l.maskGrid;
      delete l.maskInverted;
      delete l.maskDisabled;
    });
  }, { enabled: (e) => !!e.layer && (hasMask(e.layer) || !!e.layer.maskGrid) });
  cmd('layer.mask-apply', 'Apply', () => applyMask(e), { enabled: (e) => !!e.layer && (hasMask(e.layer) || !!e.layer.maskGrid) && e.layer.kind !== 'group' && e.layer.kind !== 'adjustment' });
  cmd('layer.mask-toggle', 'Disable', () => e.editLayer('Toggle Layer Mask', (l) => (l.maskDisabled = !l.maskDisabled)), { enabled: (e) => !!e.layer && (hasMask(e.layer) || !!e.layer.maskGrid), checked: (e) => !!e.layer?.maskDisabled });
  cmd('layer.mask-invert', 'Invert Mask', () => e.editLayer('Invert Layer Mask', (l) => (l.maskInverted = !l.maskInverted)), { enabled: (e) => !!e.layer && (hasMask(e.layer) || !!e.layer.maskGrid) });

  // ----- View -----
  const zoomSteps = [1, 2, 3, 4, 5, 6.25, 8.33, 12.5, 16.67, 25, 33.33, 50, 66.67, 100, 150, 200, 300, 400, 500, 600, 700, 800, 1200, 1600, 2400, 3200, 6400].map((v) => v / 100);
  cmd('view.zoom-in', 'Zoom In', () => e.zoomBy(zoomSteps.find((z) => z > e.zoom * 1.001) ?? 64), { shortcut: ['Mod+=', 'Mod+Shift+=', 'Mod++'], recordable: false });
  cmd('view.zoom-out', 'Zoom Out', () => e.zoomBy([...zoomSteps].reverse().find((z) => z < e.zoom * 0.999) ?? 0.01), { shortcut: 'Mod+-', recordable: false });
  cmd('view.fit', 'Fit on Screen', () => e.fit(), { shortcut: 'Mod+0', recordable: false });
  cmd('view.fill', 'Fill Screen', () => {
    const v = e.el('#viewport');
    e.zoom = Math.max(v.clientWidth / e.doc.width, v.clientHeight / e.doc.height);
    e.pan = { x: 0, y: 0 };
    e.view();
    e.overlay();
  }, { recordable: false });
  cmd('view.actual-pixels', '100%', () => {
    e.zoomBy(1);
  }, { shortcut: ['Mod+1', 'Mod+Alt+0'], recordable: false });
  cmd('view.rulers', 'Rulers', () => {
    e.preferences.showRulers = !e.preferences.showRulers;
    e.savePreferences();
    e.view();
  }, { shortcut: 'Mod+R', checked: (e) => e.preferences.showRulers, recordable: false });
  cmd('window.toggle-panels', 'Show / Hide Panels', () => {
    e.root.classList.toggle('panels-hidden');
    e.view();
  }, { shortcut: 'Tab', hidden: true, recordable: false });
  let screenMode = 0;
  cmd('view.cycle-screen-mode', 'Change Screen Mode', () => {
    screenMode = (screenMode + 1) % 3;
    e.root.dataset.screenMode = String(screenMode);
    e.view();
  }, { shortcut: 'F', hidden: true, recordable: false });
  cmd('view.screen-standard', 'Standard Screen Mode', () => {
    screenMode = 0;
    e.root.dataset.screenMode = '0';
    e.view();
  }, { checked: () => screenMode === 0, recordable: false });
  cmd('view.screen-full-menus', 'Full Screen Mode With Menu Bar', () => {
    screenMode = 1;
    e.root.dataset.screenMode = '1';
    e.view();
  }, { checked: () => screenMode === 1, recordable: false });
  cmd('view.screen-full', 'Full Screen Mode', () => {
    screenMode = 2;
    e.root.dataset.screenMode = '2';
    void document.documentElement.requestFullscreen?.().catch(() => {});
    e.view();
  }, { checked: () => screenMode === 2, recordable: false });

  // ----- Window / Help -----
  // Workspaces live in features/workspace.
  for (const s of ['dark', 'medium', 'light', 'system'])
    cmd(`window.theme-${s}`, `${s[0].toUpperCase() + s.slice(1)} Theme`, () => e.setTheme(s), { menu: 'window.theme', checked: () => document.documentElement.dataset.theme === s, recordable: false });
  cmd('help.shortcuts', 'Keyboard Shortcuts', () => shortcutsDialog(e), { shortcut: 'Mod+Shift+/', recordable: false });
  cmd('help.about', 'About Photo Studio', () => information('Photo Studio', `${appIcon(64, 'about-logo')}<p>An open-source image editor that runs in your browser, built on WebGPU with a WebGL2 fallback. Documents stay on your device unless you save them to Puter.</p><p>Photo Studio is an independent open-source project.</p>`), { recordable: false });
  cmd('help.legal', 'Open-Source Licenses', () => information('Licenses', `<p>Photo Studio is MIT licensed. Third-party components: ag-psd (MIT), Lucide icons (ISC), pako (MIT/Zlib), PathKit (BSD-3-Clause), Rust png crate (MIT/Apache-2.0). Bundled fonts are licensed under the SIL Open Font License 1.1. See THIRD_PARTY_NOTICES.txt for full texts.</p>`), { recordable: false });

  // ----- Colors -----
  cmd('color.default', 'Default Colors', () => {
    e.setForeground('#000000');
    e.setBackground('#ffffff');
  }, { shortcut: 'D', hidden: true, recordable: false });
  cmd('color.swap', 'Switch Colors', () => {
    const fg = e.color;
    e.setForeground(e.background);
    e.setBackground(fg);
  }, { shortcut: 'X', hidden: true, recordable: false });
  cmd('color.pick-foreground', 'Foreground Color…', () => pickColor(e, true), { hidden: true, recordable: false });
  cmd('color.pick-background', 'Background Color…', () => pickColor(e, false), { hidden: true, recordable: false });
}

async function pickFiles(e: Editor, place: boolean) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = e.el<HTMLInputElement>('#file-input').accept;
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    void e.run(async () => {
      const { openFile } = await import('./files/open');
      for (const f of files) await openFile(e, f, f.name, place);
    });
  };
  input.click();
}
/** Help → Keyboard Shortcuts: every shortcut grouped by the menu that lists
 * its command, then tools and keys that are not commands. */
async function shortcutsDialog(e: Editor) {
  const { resolveMenu, withContributions } = await import('../app/menubar');
  const { menuSkeleton } = await import('../app/menus');
  const { groupTools, toolGroups } = await import('../app/toolbar');
  const mod = isMac ? '⌘' : 'Ctrl+';
  const alt = isMac ? '⌥' : 'Alt+';
  const row = (label: string, keys: string) => `<div class="shortcut-row"><span>${escapeXML(label)}</span><kbd>${escapeXML(keys)}</kbd></div>`;
  const section = (title: string, rows: string[]) => (rows.length ? `<section class="shortcut-section"><h3>${escapeXML(title)}</h3>${rows.join('')}</section>` : '');
  const listed = new Set<string>();
  const sections = menuSkeleton.map((m) => {
    const rows: string[] = [];
    const walk = (items: ReturnType<typeof resolveMenu>, path: string) => {
      for (const i of items) {
        if (i.kind === 'submenu') walk(i.items, `${path}${i.label} › `);
        else if (i.kind === 'command' && i.shortcut && !listed.has(i.id)) {
          listed.add(i.id);
          rows.push(row(path + i.label, i.shortcut));
        }
      }
    };
    walk(resolveMenu(e, withContributions(m.id, m.items), m.id), '');
    return section(m.label, rows);
  });
  const toolRows = toolGroups.flatMap((g) => {
    const list = groupTools(g).filter((t) => t.key);
    return list.length ? [row(list.map((t) => t.label.replace(/ Tool$/, '')).join(', '), list[0].key!.toUpperCase())] : [];
  });
  const keyboardOnly = [...commands.values()].filter((c) => c.shortcut && !listed.has(c.id) && !c.id.startsWith('window.panel.')).map((c) => row(c.label, formatShortcut(c.shortcut)));
  const other = [
    row('Brush size smaller / larger', '[  ]'),
    row('Brush hardness softer / harder', 'Shift+[  Shift+]'),
    row('Opacity of the painting tool or selected layers (0 = 100%, two digits for an exact value)', '0–9'),
    row('Flow of the painting tool', 'Shift+0–9'),
    row('Brush size and hardness by dragging', isMac ? '⌃⌥ drag' : 'Alt+right-drag'),
    row('Next tool in a toolbar slot', 'Shift+tool key'),
    row('Pan the view', 'Space drag'),
    row('Zoom the view', `${alt} scroll, ${mod} scroll`),
    row('Nudge with the Move tool (Shift: 10 px)', '← ↑ → ↓'),
    row('Commit / cancel a transform or edit', 'Enter / Esc'),
  ];
  const d = document.querySelector<HTMLDialogElement>('#dialog')!;
  d.innerHTML = `<form method="dialog" class="shortcut-help"><h2>Keyboard Shortcuts</h2><p class="muted">${isMac ? 'Mod is ⌘ (Command).' : 'Mod is Ctrl.'} Change them in Edit › Keyboard Shortcuts.</p><input type="search" class="shortcut-filter" placeholder="Filter" aria-label="Filter shortcuts"><div class="shortcut-sections">${sections.join('')}${section('Tools', toolRows)}${section('Keyboard only', keyboardOnly)}${section('Painting and navigation', other)}</div><div class="dialog-actions"><button type="button" data-customize-shortcuts>Customize…</button><button class="primary">Done</button></div></form>`;
  d.querySelector<HTMLInputElement>('.shortcut-filter')!.addEventListener('input', (ev) => {
    const q = (ev.target as HTMLInputElement).value.toLowerCase();
    d.querySelectorAll<HTMLElement>('.shortcut-row').forEach((r) => (r.hidden = !!q && !r.textContent!.toLowerCase().includes(q)));
    d.querySelectorAll<HTMLElement>('.shortcut-section').forEach((sec) => (sec.hidden = !sec.querySelector('.shortcut-row:not([hidden])')));
  });
  d.querySelector('[data-customize-shortcuts]')!.addEventListener('click', () => {
    d.close();
    void e.runCommand('edit.keyboard-shortcuts');
  });
  d.showModal();
}
// General → Color picker → System: the browser's own color chooser.
function systemColorPicker(e: Editor, foreground: boolean) {
  e.root.querySelector('.system-color-input')?.remove();
  const input = document.createElement('input');
  input.type = 'color';
  input.value = foreground ? e.color : e.background;
  input.className = 'sr-only system-color-input';
  input.setAttribute('aria-label', foreground ? 'Foreground color' : 'Background color');
  e.root.append(input);
  const set = () => (foreground ? e.setForeground(input.value) : e.setBackground(input.value));
  input.addEventListener('input', set);
  input.addEventListener('change', () => {
    set();
    input.remove();
  });
  if (typeof input.showPicker === 'function') input.showPicker();
  else input.click();
}
async function pickColor(e: Editor, foreground: boolean) {
  if (e.preferences.colorPicker === 'system') return systemColorPicker(e, foreground);
  const { pickColor: open } = await import('./color/picker');
  const c = await open(e, foreground ? e.color : e.background, foreground ? 'Foreground Color' : 'Background Color');
  if (c) (foreground ? e.setForeground(c) : e.setBackground(c));
}
function resizeCanvas(e: Editor, w: number, h: number, dx: number, dy: number, label: string) {
  e.command(label, (d) => {
    // Cropping with a negative origin enlarges the canvas.
    cropDocument(d, { x: -dx, y: -dy, width: w, height: h });
    d.selection = null;
    d.selectionMask = null;
  });
  e.fit();
}
async function trim(e: Editor) {
  const img = await compositeRGBA(e);
  let x0 = img.width,
    y0 = img.height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  if (x1 < 0) {
    e.message('Nothing to trim: the image is fully transparent.');
    return;
  }
  resizeCanvas(e, x1 - x0 + 1, y1 - y0 + 1, -x0, -y0, 'Trim');
}
function revealAll(e: Editor) {
  let x0 = 0,
    y0 = 0,
    x1 = e.doc.width,
    y1 = e.doc.height;
  for (const l of allLayers(e.doc.layers)) {
    if (l.kind === 'group' || l.kind === 'adjustment' || l.kind === 'solid') continue;
    // Rotated layers reach out to their corners.
    const t = transformBounds(l.transform);
    x0 = Math.min(x0, Math.floor(t.x));
    y0 = Math.min(y0, Math.floor(t.y));
    x1 = Math.max(x1, Math.ceil(t.x + t.width));
    y1 = Math.max(y1, Math.ceil(t.y + t.height));
  }
  resizeCanvas(e, Math.min(8192, x1 - x0), Math.min(8192, y1 - y0), -x0, -y0, 'Reveal All');
}
function arrange(e: Editor, where: 'front' | 'forward' | 'backward' | 'back') {
  const roots = e.selectedLayers;
  assertEditable(e.doc, roots, 'position');
  e.command('Arrange Layers', (d) => {
    for (const r of where === 'front' || where === 'backward' ? roots : [...roots].reverse()) {
      const list = containerOf(d.layers, r.id)!;
      const i = list.findIndex((l) => l.id === r.id);
      const [item] = list.splice(i, 1);
      const to = where === 'front' ? list.length : where === 'back' ? 0 : where === 'forward' ? Math.min(list.length, i + 1) : Math.max(0, i - 1);
      list.splice(to, 0, item);
    }
  });
}
async function layerVia(e: Editor, cut: boolean) {
  const l = e.layer;
  if (!l) return;
  if (!e.doc.selection) {
    if (cut) return;
    return performAction(e, 'duplicate');
  }
  const target = await pixelTarget(e, { allowMask: false, create: false });
  if (!target || target.kind !== 'pixels') return;
  const sel = selectionGrid(e.doc, e.assets.tiles)!;
  const b = selectionBounds(e.doc, sel)!;
  const src = readRGBA(e.assets.tiles, target.grid, b);
  const cover = readMask(e.assets.tiles, sel, b).data;
  const piece = new Uint8ClampedArray(src.data);
  const rest = new Uint8ClampedArray(src.data);
  for (let i = 0; i < cover.length; i++) {
    piece[i * 4 + 3] = (src.data[i * 4 + 3] * cover[i]) / 255;
    rest[i * 4 + 3] = (src.data[i * 4 + 3] * (255 - cover[i])) / 255;
  }
  const nl = newPixelLayer(cut ? `${l.name} cut` : `${l.name} copy`, e.doc, gridFromImage(e.assets.tiles, { width: b.width, height: b.height, data: piece }, b.x, b.y));
  const remaining = cut ? writeRect(e.assets.tiles, target.grid, b.x, b.y, { width: b.width, height: b.height, data: rest }) : undefined;
  const id = target.layer.id;
  e.command(cut ? 'Layer via Cut' : 'Layer via Copy', (d) => {
    if (remaining) setLayerPixels(findLayer(d.layers, id)!, remaining, d);
    const list = containerOf(d.layers, id)!;
    list.splice(list.findIndex((x) => x.id === id) + 1, 0, nl);
  });
  e.selected = nl.id;
  e.update();
}
async function copySelection(e: Editor, cut: boolean, merged: boolean) {
  const doc = e.doc;
  const sel = selectionGrid(doc, e.assets.tiles);
  const b = sel ? selectionBounds(doc, sel) : canvasRect(doc);
  if (!b) return;
  let src: RGBA8;
  if (merged) {
    const full = await compositeRGBA(e);
    src = cropImage(full, b);
  } else {
    const l = e.layer;
    if (!l) {
      e.message('Select a layer to copy from.');
      return;
    }
    src = l.kind === 'pixel' && l.pixels ? readRGBA(e.assets.tiles, l.pixels, b) : cropImage(await layerRGBA(e, l), b);
  }
  if (sel) {
    const cover = readMask(e.assets.tiles, sel, b).data;
    for (let i = 0; i < cover.length; i++) src.data[i * 4 + 3] = (src.data[i * 4 + 3] * cover[i]) / 255;
  }
  clipboard = { image: src, x: b.x, y: b.y };
  void writeSystemClipboard(src);
  if (cut) await clearSelection(e, 'Cut');
  else e.message(merged ? 'Copied merged pixels' : 'Copied');
}
async function writeSystemClipboard(img: RGBA8) {
  try {
    const canvas = new OffscreenCanvas(img.width, img.height);
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    await navigator.clipboard?.write?.([new ClipboardItem({ 'image/png': blob })]);
  } catch {
    /* The system clipboard is optional (permissions, unfocused page). */
  }
}
export function cropImage(img: RGBA8, r: { x: number; y: number; width: number; height: number }): RGBA8 {
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) {
    const sy = r.y + y;
    if (sy < 0 || sy >= img.height) continue;
    const x0 = Math.max(0, r.x),
      x1 = Math.min(img.width, r.x + r.width);
    if (x1 <= x0) continue;
    out.set(img.data.subarray((sy * img.width + x0) * 4, (sy * img.width + x1) * 4), (y * r.width + (x0 - r.x)) * 4);
  }
  return { width: r.width, height: r.height, data: out };
}
async function paste(e: Editor, inPlace: boolean) {
  let item = clipboard;
  if (!item) {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) {
          const { decodeBrowserImage } = await import('./files/open');
          const image = await decodeBrowserImage(await it.getType(type));
          item = { image, x: 0, y: 0 };
          inPlace = false;
          break;
        }
      }
    } catch {
      /* Clipboard read needs permission; fall through. */
    }
  }
  if (!item) {
    e.message('Nothing to paste.');
    return;
  }
  if (!e.hasDocument) {
    const s = e.sessionForOpen();
    const l = newPixelLayer('Layer 1', item.image, gridFromImage(s.assets.tiles, item.image));
    s.history.reset({ ...s.doc, name: 'Untitled', width: item.image.width, height: item.image.height, layers: [l], selection: null });
    s.hasDocument = true;
    e.selected = l.id;
    e.fit();
    e.update();
    return;
  }
  const b = e.doc.selection;
  const x = inPlace ? item.x : b ? Math.round(b.x + (b.width - item.image.width) / 2) : Math.round((e.doc.width - item.image.width) / 2);
  const y = inPlace ? item.y : b ? Math.round(b.y + (b.height - item.image.height) / 2) : Math.round((e.doc.height - item.image.height) / 2);
  const l = newPixelLayer(nextLayerName(e.doc), e.doc, gridFromImage(e.assets.tiles, item.image, x, y));
  insertAboveSelection(e, l, 'Paste');
  e.command('Deselect', (d) => applySelection(d, null));
}
async function clearSelection(e: Editor, label = 'Clear') {
  if (!e.doc.selection) {
    // Without a selection there are no pixels to clear, so Delete removes the selected layers.
    if (e.layer) await performAction(e, 'delete');
    return;
  }
  const target = await pixelTarget(e, { create: false });
  if (!target) return;
  const sel = selectionGrid(e.doc, e.assets.tiles)!;
  const b = selectionBounds(e.doc, sel)!;
  const cover = readMask(e.assets.tiles, sel, b).data;
  if (target.kind === 'pixels') {
    const src = readRGBA(e.assets.tiles, target.grid, b);
    for (let i = 0; i < cover.length; i++) src.data[i * 4 + 3] = (src.data[i * 4 + 3] * (255 - cover[i])) / 255;
    commitTarget(e, target, writeRect(e.assets.tiles, target.grid, b.x, b.y, src), label);
  } else {
    const m = readMask(e.assets.tiles, target.grid, b);
    for (let i = 0; i < cover.length; i++) m.data[i] = (m.data[i] * (255 - cover[i])) / 255;
    commitTarget(e, target, writeRect(e.assets.tiles, target.grid, b.x, b.y, m), label);
  }
}
async function fillDialog(e: Editor) {
  const contextFill = e.doc.selection ? commands.get('edit.context-fill-apply') : undefined;
  const v = await formDialog('Fill', [
    { name: 'contents', label: 'Contents', value: 'foreground', type: 'select', options: [['foreground', 'Foreground Color'], ['background', 'Background Color'], ['black', 'Black'], ['gray', '50% Gray'], ['white', 'White'], ['color', 'Color…'], ['pattern', 'Pattern (current in Patterns panel)'], ...(contextFill ? [['context', 'Context Fill'] as [string, string]] : [])] },
    { name: 'color', label: 'Color (when Contents is Color)', value: e.color, type: 'color' },
    { name: 'opacity', label: 'Opacity (%)', value: 100, type: 'number', min: 1, max: 100 },
    { name: 'preserve', label: 'Preserve Transparency', value: 'no', type: 'select', options: [['no', 'No'], ['yes', 'Yes']] },
  ], 'OK');
  if (!v) return;
  if (v.contents === 'pattern') return fillWithPattern(e, Number(v.opacity) / 100, v.preserve === 'yes');
  if (v.contents === 'context' && contextFill) return contextFill.run(e);
  const rgb: [number, number, number] =
    v.contents === 'foreground' ? hexRgb(e.color) : v.contents === 'background' ? hexRgb(e.background) : v.contents === 'black' ? [0, 0, 0] : v.contents === 'white' ? [255, 255, 255] : v.contents === 'gray' ? [128, 128, 128] : hexRgb(v.color);
  await fillWith(e, rgb, Number(v.opacity) / 100, v.preserve === 'yes');
}
export async function fillWith(e: Editor, rgb: [number, number, number], opacity: number, preserve: boolean) {
  const target = await pixelTarget(e);
  if (!target) return;
  const doc = e.doc;
  const sel = selectionGrid(doc, e.assets.tiles);
  const b = sel ? selectionBounds(doc, sel) : canvasRect(doc);
  if (!b) return;
  const cover = sel ? readMask(e.assets.tiles, sel, b).data : undefined;
  if (target.kind !== 'pixels') {
    const value = (rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114) | 0;
    const m = readMask(e.assets.tiles, target.grid, b);
    for (let i = 0; i < m.data.length; i++) {
      const k = opacity * (cover ? cover[i] / 255 : 1);
      m.data[i] = m.data[i] + (value - m.data[i]) * k;
    }
    commitTarget(e, target, writeRect(e.assets.tiles, target.grid, b.x, b.y, m), 'Fill');
    return;
  }
  const preserveAlpha = preserve || !!layerLock(doc.layers, target.layer.id, 'transparency');
  const src = readRGBA(e.assets.tiles, target.grid, b);
  const d = src.data;
  for (let i = 0; i < d.length / 4; i++) {
    const k = opacity * (cover ? cover[i] / 255 : 1);
    if (!k) continue;
    const ba = d[i * 4 + 3] / 255;
    if (preserveAlpha) {
      for (let c = 0; c < 3; c++) d[i * 4 + c] += (rgb[c] - d[i * 4 + c]) * k;
      continue;
    }
    const oa = k + ba * (1 - k);
    for (let c = 0; c < 3; c++) d[i * 4 + c] = oa ? (rgb[c] * k + d[i * 4 + c] * ba * (1 - k)) / oa : 0;
    d[i * 4 + 3] = oa * 255;
  }
  commitTarget(e, target, writeRect(e.assets.tiles, target.grid, b.x, b.y, src), 'Fill');
}
async function addMask(e: Editor, mode: 'reveal' | 'hide' | 'selection' | 'hide-selection') {
  const l = e.layer;
  if (!l) return;
  if (layerLock(e.doc.layers, l.id, 'all')) {
    e.message('Unlock this layer to add a mask.');
    return;
  }
  const store = e.assets.tiles;
  let grid;
  if (mode === 'reveal') grid = { ...emptyGrid(1), fill: 255, bounds: null };
  else if (mode === 'hide') grid = emptyGrid(1);
  else {
    const sel = selectionGrid(e.doc, store)!;
    const area = canvasRect(e.doc);
    const m = readMask(store, sel, area);
    if (mode === 'hide-selection') for (let i = 0; i < m.data.length; i++) m.data[i] = 255 - m.data[i];
    grid = writeRect(store, emptyGrid(1), 0, 0, m);
  }
  const id = l.id;
  e.command('Add Layer Mask', (d) => {
    const t = findLayer(d.layers, id)!;
    t.mask = null;
    delete t.maskAsset;
    delete t.pixelMask;
    delete t.maskStrokes;
    t.maskGrid = grid;
    delete t.maskDisabled;
    delete t.maskInverted;
    if (mode === 'selection' || mode === 'hide-selection') applySelection(d, null);
  });
  e.maskTarget = id;
  e.update();
}
async function applyMask(e: Editor) {
  const l = e.layer;
  if (!l) return;
  if (l.kind !== 'pixel') await rasterizeLayer(e, l.id);
  const cur = e.layer!;
  const maskGrid = cur.maskGrid ?? (await import('./pixels').then((m) => m.legacyMaskToGrid(e, cur)));
  if (!maskGrid || !cur.pixels?.bounds) return;
  const b = { ...cur.pixels.bounds, x: cur.pixels.bounds.x + cur.pixels.x, y: cur.pixels.bounds.y + cur.pixels.y };
  const src = readRGBA(e.assets.tiles, cur.pixels, b);
  const m = readMask(e.assets.tiles, maskGrid, b).data;
  for (let i = 0; i < m.length; i++) {
    const v = cur.maskInverted ? 255 - m[i] : m[i];
    if (!cur.maskDisabled) src.data[i * 4 + 3] = (src.data[i * 4 + 3] * v) / 255;
  }
  const grid = writeRect(e.assets.tiles, cur.pixels, b.x, b.y, src);
  e.command('Apply Layer Mask', (d) => {
    const t = findLayer(d.layers, cur.id)!;
    setLayerPixels(t, grid, d);
    delete t.maskGrid;
    t.mask = null;
    delete t.maskAsset;
    delete t.pixelMask;
    delete t.maskStrokes;
    delete t.maskInverted;
    delete t.maskDisabled;
  });
  e.maskTarget = '';
}
async function mergeDown(e: Editor) {
  const l = e.layer;
  if (!l) return;
  if (e.selectedIds.size > 1) return mergeSelected(e);
  const list = containerOf(e.doc.layers, l.id)!;
  const i = list.indexOf(l);
  if (i === 0) {
    e.message('There is no layer below to merge into.');
    return;
  }
  const below = list[i - 1];
  if (below.kind === 'group' || below.kind === 'adjustment') {
    e.message('The layer below cannot receive merged pixels.');
    return;
  }
  await mergeLayers(e, [below, l], below.id, 'Merge Down');
}
async function mergeSelected(e: Editor) {
  const roots = selectedRoots(e.doc.layers, e.selectedIds);
  if (roots.length < 2) return;
  const ordered = allLayers(e.doc.layers).filter((l) => roots.some((r) => r.id === l.id));
  await mergeLayers(e, ordered, ordered.at(-1)!.id, 'Merge Layers');
}
async function mergeLayers(e: Editor, layers: Layer[], keepId: string, label: string) {
  const doc = e.doc;
  const temp = { ...doc, layers: layers.map((l) => ({ ...l, clipped: false })) };
  const img = await compositeRGBA(e, temp);
  const grid = gridFromImage(e.assets.tiles, img);
  const ids = new Set(layers.map((l) => l.id));
  e.command(label, (d) => {
    const keep = findLayer(d.layers, keepId)!;
    const list = containerOf(d.layers, keepId)!;
    const merged = newPixelLayer(keep.name, d, grid);
    merged.id = keep.id;
    list.splice(list.indexOf(keep), 1, merged);
    for (const id of ids) {
      if (id === keepId) continue;
      const c = containerOf(d.layers, id);
      if (c) c.splice(c.findIndex((x) => x.id === id), 1);
    }
  });
  e.selected = keepId;
  e.update();
}
async function mergeVisible(e: Editor, stamp: boolean) {
  const img = await compositeRGBA(e);
  const grid = gridFromImage(e.assets.tiles, img);
  const l = newPixelLayer(stamp ? 'Stamp' : 'Merged', e.doc, grid);
  if (stamp) {
    insertAboveSelection(e, l, 'Stamp Visible');
    return;
  }
  e.command('Merge Visible', (d) => {
    const hidden = d.layers.filter((x) => !x.visible);
    d.layers = [...hidden, l];
  });
  e.selected = l.id;
  e.update();
}
async function flatten(e: Editor) {
  const img = await compositeRGBA(e);
  // Flattening fills transparency with white, like a background layer.
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) img.data[i + c] = img.data[i + c] * a + 255 * (1 - a);
    img.data[i + 3] = 255;
  }
  const l = newPixelLayer('Background', e.doc, gridFromImage(e.assets.tiles, img));
  e.command('Flatten Image', (d) => {
    d.layers = [l];
  });
  e.selected = l.id;
  e.update();
}
// Re-export grouping helper so other modules avoid importing model internals.
export { groupLayers };
