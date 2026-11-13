import { isVectorGradient } from "../model/vector-gradient";
import { gradientStop } from "../model/gradient-edit";
import { hasMask } from '../model/masks';
import type { Editor } from '../editor';
import { assertEditable, groupLayers, placeDuplicates, reorderLayers, selectedRoots } from '../model/layers';
import { placeDuplicateArtboards } from '../model/artboard';
import { releaseBackground } from '../model/housekeeping';
import { Renderer } from '../renderer/renderer';
import {
  allLayers,
  containerOf,
  cropDocument,
  defaultFilters,
  layer,
  MAX_LAYERS,
  newDocument,
  resizeDocument,
  type Layer,
} from '../model/document';
import { deserialize, serialize } from '../model/serialization';
import { Assets, escapeXML } from '../model/assets';
import { readRGBA } from '../model/tiles';
import { PsdPreviewEditError, readOriginalPsd, saveOriginalPsd } from '../model/psd-original';
import { download, puter, canSignOut, signedOut } from '../persistence/puter';
import { formDialog, information } from './dialog';
export async function importFile(e: Editor, blob: Blob, name: string) {
  e.transform.apply();
  const isPsd = /\.ps[db]$/i.test(name);
  if (name.toLowerCase().endsWith('.photo') || isPsd) {
    const loaded = isPsd
      ? await (await import('../model/psd')).openPsd(blob, name, e.engine)
      : await deserialize(blob);
    if (
      e.dirty &&
      !(await formDialog(
        'Replace this document?',
        [],
        'Open project',
        'Unsaved changes to the current document will be lost.',
      ))
    ) {
      loaded.assets.clear();
      return false;
    }
    await e.renderer?.settle();
    e.assets.clear();
    e.assets = loaded.assets;
    e.history.reset(loaded.document);
    e.hasDocument = true;
    e.storage.reset();
    e.saved = e.doc;
    e.selected = e.doc.layers.at(-1)?.id ?? '';
    e.fit();
    e.update();
    e.message(isPsd ? 'PSD opened' : 'Project opened');
    if ('notice' in loaded && loaded.notice)
      information('PSD import', `<p>${escapeXML(String(loaded.notice))}</p>`);
    return true;
  }
  if (!blob.type || blob.type === 'application/octet-stream') {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const mime = (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        avif: 'image/avif',
      } as Record<string, string>
    )[ext];
    if (mime) blob = new Blob([blob], { type: mime });
  }
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(blob.type))
    throw new Error(
      'Import a PNG, JPEG, WebP, AVIF, GIF, PSD, or .photo project. Animated images use their first frame.',
    );
  const id = await e.assets.add(blob),
    bitmap = e.assets.get(id);
  const l = layer('image', name.replace(/\.[^.]+$/, ''), bitmap.width, bitmap.height);
  l.asset = id;
  l.assetColorSpace = 'srgb';
  const opensDocument = !e.hasDocument;
  e.command('Import image', (d) => {
    if (opensDocument) {
      d.width = bitmap.width;
      d.height = bitmap.height;
      d.name = l.name;
    }
    d.layers.push(l);
  });
  e.selected = l.id;
  if (opensDocument) e.fit();
  e.update();
  e.message('Image imported');
  return true;
}
function cloneLayer(l: Layer): Layer {
  const copy = structuredClone(l);
  for (const item of allLayers([copy])) {
    item.id = crypto.randomUUID();
    delete item.psdId;
  }
  copy.name += ' copy';
  // A document has one Background; its copy is an ordinary layer.
  if (copy.background) releaseBackground(copy);
  return copy;
}
export async function performAction(e: Editor, action: string): Promise<void> {
  // A committed transform may still be storing its assets. Undo must target
  // that edit, not the history step that happened to precede it.
  if (action === 'undo' || action === 'redo') await e.session.waitForEdits();
  if (e.transform.dragging && !e.transform.active) {
    e.transform.cancel();
    if (action === 'undo' || action === 'redo') return;
  }
  if (e.transform.active) {
    if (action === 'undo' || action === 'redo') {
      e.transform.cancel();
      return;
    }
    if (
      ![
        'transform',
        'transform-apply',
        'transform-cancel',
        'fit',
        'actual',
        'zoom-in',
        'zoom-out',
        'toggle-panels',
        'toggle-rulers',
        'show-history',
        'help',
      ].includes(action)
    )
      e.transform.apply();
  }
  const gradientAction =
    /^gradient-(add|remove)-(color|opacity)(?:-(\d+))?$/.exec(action);
  if (gradientAction && isVectorGradient(e.layer?.vector?.fill)) {
    const fill = gradientStop(
      e.layer.vector.fill,
      gradientAction[2] as "color" | "opacity",
      gradientAction[1] as "add" | "remove",
      gradientAction[3] === undefined ? undefined : Number(gradientAction[3]),
    );
    e.editLayer("Change gradient stops", (l) => {
      l.vector!.fill = fill;
    });
    return;
  }
  switch (action) {
    case 'transform':
      e.transform.begin();
      break;
    case 'transform-apply':
      e.transform.apply();
      break;
    case 'transform-cancel':
      e.transform.cancel();
      break;
    case 'import':
    case 'open-local':
      e.el<HTMLInputElement>('#file-input').accept =
        action === 'open-local'
          ? '.photo,.psd,.psb'
          : 'image/png,image/jpeg,image/webp,image/avif,image/gif,.psd,.psb';
      e.el<HTMLInputElement>('#file-input').click();
      break;
    case 'new': {
      const v = await formDialog(
        'New document',
        [
          { name: 'name', label: 'Name', value: 'Untitled' },
          {
            name: 'width',
            label: 'Width (px)',
            value: 1600,
            type: 'number',
            min: 1,
            max: 8192,
          },
          {
            name: 'height',
            label: 'Height (px)',
            value: 1000,
            type: 'number',
            min: 1,
            max: 8192,
          },
        ],
        'Create',
        e.dirty ? 'Unsaved changes will be replaced.' : 'Start with a transparent canvas.',
      );
      if (!v) return;
      const doc = newDocument(Number(v.width), Number(v.height), v.name);
      // The workspace is already interactive while graphics initialize. With
      // no renderer yet, there are no source users to wait for; start() will
      // render the latest document when initialization finishes.
      await e.renderer?.settle();
      e.assets.clear();
      e.assets = new Assets();
      e.history.reset(doc);
      e.hasDocument = true;
      e.storage.reset();
      e.saved = undefined;
      e.selected = '';
      e.fit();
      e.update();
      break;
    }
    case 'undo':
      e.history.undo();
      e.restoreSelection();
      break;
    case 'redo':
      e.history.redo();
      e.restoreSelection();
      break;
    case 'save': {
      const doc = e.doc,
        blob = await serialize(doc, e.assets); // The native picker remains interactive if dismissed.
      e.release();
      void e.storage
        .save(blob, doc.name)
        .then(() => {
          e.saved = doc;
          e.update();
          e.message('Saved to Puter');
        })
        .catch((error) => e.message(String(error)));
      break;
    }
    case 'save-local': {
      const doc = e.doc;
      download(await serialize(doc, e.assets), `${doc.name}.photo`);
      e.saved = doc;
      e.update();
      e.message('Project downloaded');
      break;
    }
    case 'save-psd': {
      await e.renderer.beforeReadback?.();
      const doc = structuredClone(e.doc);
      if (doc.psdOriginal) {
        // Preserving an unchanged original needs no GPU readback or re-encoding.
        try {
          const { blob, extension } = await saveOriginalPsd(doc, id => e.assets.blob(id));
          download(blob, `${doc.name}.${extension}`);
          e.message('Original PSD file downloaded with its layers retained.');
        } catch (error) {
          if (!(error instanceof PsdPreviewEditError)) throw error;
          information('PSD export', `<p>${escapeXML(error.message)}</p>`);
        }
        break;
      }
      const { savePsd } = await import('../model/psd');
      const renderer = await Renderer.create(document.createElement('canvas'), e.engine);
      try {
        const blob = await savePsd(doc, async (snapshot) => {
          await renderer.render(snapshot, e.assets);
          return renderer.rawPixels();
        }, async (l) => {
          // Pixel layers keep their pixels in tiles, not in a renderer source.
          if (l.kind === 'pixel' && l.pixels && (doc.bitsPerChannel ?? 8) === 8) {
            const t = l.transform;
            const img = readRGBA(e.assets.tiles, l.pixels, { x: Math.round(t.x), y: Math.round(t.y), width: l.sourceWidth, height: l.sourceHeight });
            return { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
          }
          return renderer.rawSourcePixels(l, e.assets);
        }, (id) => e.assets.blob(id));
        download(blob, `${doc.name}.psd`);
        e.message(
          'PSD downloaded. Text, masks and supported adjustment layers stay editable; fill layers and layer styles are rasterized. Save a .photo project to keep all editing controls.',
        );
      } finally {
        renderer.dispose();
      }
      break;
    }
    case 'save-original-psd': {
      const { blob, extension } = await readOriginalPsd(e.doc, id => e.assets.blob(id));
      download(blob, `${e.doc.name}-original.${extension}`);
      e.message('Original PSD file downloaded. Preview edits are not included.');
      break;
    }
    case 'cloud-open': {
      e.release();
      void e.storage
        .open()
        .then(async (file) => {
          await e.run(async () => {
            const opened = await importFile(e, file.blob, file.name);
            if (opened && file.name.endsWith('.photo')) e.storage.path = file.path;
          });
        })
        .catch((error) => e.message(String(error)));
      break;
    }
    case 'export': {
      const doc = e.doc;
      await e.render();
      const png = await e.engine.png(await e.renderer.displayPixels(), doc.width, doc.height);
      download(png, `${doc.name}.png`);
      e.message('PNG exported at full resolution');
      break;
    }
    case 'account': {
      const p = puter();
      if (!p.auth.isSignedIn()) {
        await p.auth.signIn();
        e.message('Connected to Puter');
      } else {
        const user = await p.auth.getUser();
        if (canSignOut(p.env)) {
          const v = await formDialog(
            'Puter account',
            [],
            'Sign out',
            `Signed in as ${user.username}. Your local document will stay open.`,
          );
          if (v) {
            p.auth.signOut();
            e.storage.reset();
            signedOut();
            e.message('Signed out');
          }
        } else information('Puter account', `<p>Signed in as ${escapeXML(user.username)}</p>`);
      }
      break;
    }
    case 'resize': {
      const v = await formDialog(
        'Image size',
        [
          {
            name: 'width',
            label: 'Width (px)',
            value: e.doc.width,
            type: 'number',
            min: 1,
            max: 8192,
          },
          {
            name: 'height',
            label: 'Height (px)',
            value: e.doc.height,
            type: 'number',
            min: 1,
            max: 8192,
          },
        ],
        'Resize',
        'Layers remain editable. Original image data is preserved.',
      );
      if (v) {
        e.command('Resize image', (d) => resizeDocument(d, Number(v.width), Number(v.height)));
        e.fit();
      }
      break;
    }
    case 'crop-apply':
      if (!e.doc.selection) {
        e.setTool('crop');
        e.message('Drag on the canvas to choose a crop area.');
      } else {
        e.command('Crop image', (d) => cropDocument(d, d.selection!));
        e.fit();
      }
      break;
    case 'select-all':
      e.command(
        'Select all',
        (d) => (d.selection = { x: 0, y: 0, width: d.width, height: d.height }),
      );
      break;
    case 'deselect':
      e.command('Deselect', (d) => (d.selection = null));
      break;
    case 'add-paint':
    case 'add-solid': {
      const l = layer(
        action === 'add-solid' ? 'solid' : 'paint',
        action === 'add-solid' ? 'Color fill' : 'Paint layer',
        e.doc.width,
        e.doc.height,
      );
      l.color = e.color;
      e.command('Add layer', (d) => d.layers.push(l));
      e.selected = l.id;
      e.update();
      if (action === 'add-paint') e.setTool('brush');
      break;
    }
    case 'text':
      await e.runCommand('type.add');
      break;
    case 'edit-text':
      await e.runCommand('type.edit');
      break;
    case 'delete': {
      assertEditable(e.doc, e.selectedLayers);
      e.command('Delete layers', (d) => {
        for (const l of selectedRoots(d.layers, e.selectedIds)) {
          const list = containerOf(d.layers, l.id)!;
          list.splice(list.indexOf(l), 1);
        }
      });
      break;
    }
    case 'duplicate': {
      const roots = e.selectedLayers;
      if (!roots.length) break;
      assertEditable(e.doc, roots);
      if (allLayers(e.doc.layers).length + allLayers(roots).length > MAX_LAYERS)
        throw new Error(`A document can contain up to ${MAX_LAYERS} layers.`);
      const copies = roots.map(cloneLayer);
      e.command('Duplicate layers', (d) => {
        placeDuplicates(d, roots, copies);
        placeDuplicateArtboards(d, copies);
      });
      e.selectLayers(copies.map((l) => l.id));
      e.update();
      break;
    }
    case 'raise':
    case 'lower':
      e.command('Reorder layers', (d) => reorderLayers(d, e.selectedIds, action === 'raise'));
      break;
    case 'group': {
      let id: string | undefined;
      e.command('Group layers', (d) => {
        id = groupLayers(d, e.selectedIds);
      });
      if (id) e.selected = id;
      e.update();
      break;
    }
    case 'ungroup': {
      const groups = e.selectedLayers.filter((l) => l.kind === 'group');
      assertEditable(e.doc, groups);
      if (
        groups.some(
          (l) =>
            l.opacity !== 1 ||
            l.blend !== 'normal' ||
            hasMask(l) ||
            Object.values(l.filters).some(Boolean),
        )
      )
        throw new Error(
          'Reset group adjustments, masks, opacity and blend mode before ungrouping.',
        );
      const ids = groups.flatMap((l) => l.children.map((c) => c.id));
      e.command('Ungroup layers', (d) => {
        for (const group of groups) {
          const list = containerOf(d.layers, group.id)!;
          const index = list.findIndex((l) => l.id === group.id);
          list.splice(index, 1, ...list[index].children);
        }
      });
      if (groups.length) e.selectLayers(ids);
      e.update();
      break;
    }
    case 'mask-hide':
    case 'mask-restore':
      e.color = action === 'mask-hide' ? '#000000' : '#ffffff';
      e.setForeground(e.color);
      break;
    case 'mask':
      e.editLayer('Add layer mask', (l) => {
        if (!hasMask(l)) {
          l.mask = e.doc.selection ? structuredClone(e.doc.selection) : null;
          l.maskStrokes = [];
        }
      });
      if (e.layer && hasMask(e.layer) && e.selectedIds.size === 1) {
        e.maskTarget = e.selected;
        e.setTool('brush');
        e.update();
      }
      break;
    case 'invert-mask':
      e.editLayer('Invert mask', (l) => {
        if (hasMask(l)) l.maskInverted = !l.maskInverted;
      });
      break;
    case 'toggle-mask':
      e.editLayer('Toggle mask', (l) => {
        if (hasMask(l)) l.maskDisabled = !l.maskDisabled;
      });
      break;
    case 'remove-mask':
      e.editLayer('Remove mask', (l) => {
        l.mask = null;
        delete l.maskAsset;
        delete l.pixelMask;
        delete l.maskStrokes;
        delete l.maskInverted;
        delete l.maskDisabled;
      });
      break;
    case 'reset-filters':
      e.editLayer('Reset adjustments', (l) => (l.filters = defaultFilters()));
      break;
    case 'fit':
      e.fit();
      e.overlay();
      break;
    case 'actual':
      e.zoom = 1;
      e.view();
      e.overlay();
      break;
    case 'zoom-in':
    case 'zoom-out':
      e.zoom = Math.max(0.02, Math.min(8, e.zoom * (action === 'zoom-in' ? 1.25 : 0.8)));
      e.view();
      e.overlay();
      break;
    case 'reset-color':
      e.color = '#000000';
      e.setForeground(e.color);
      break;
    case 'toggle-rulers':
      e.root.classList.toggle('rulers-hidden');
      e.fit();
      e.overlay();
      break;
    case 'show-history':
      e.root.classList.remove('panels-hidden');
      e.dock.show('history');
      e.fit();
      break;
    case 'toggle-panels':
      e.root.classList.toggle('panels-hidden');
      e.fit();
      break;
    case 'histogram': {
      await e.render();
      const bins = await e.engine.histogram(await e.renderer.displayPixels()),
        max = Math.max(...bins, 1);
      const points = Array.from(bins, (n, i) => `${i},${100 - (n / max) * 100}`).join(' ');
      information(
        'Luminance histogram',
        `<svg class="histogram" viewBox="0 0 256 100" role="img" aria-label="Luminance distribution from dark to light"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1"/></svg><p>Visible composite · transparent pixels excluded</p>`,
      );
      break;
    }
    case 'help':
      information(
        'Make room for your ideas',
        `<p>Import an image, then add layers and adjust their appearance. All adjustments and transforms remain editable.</p><div class="shortcut-list"><span>Move / Selection / Brush</span><kbd>V / M / B</kbd><span>Wand / Fill / Crop</span><kbd>W / G / C</kbd><span>Text / Pan</span><kbd>T / H</kbd><span>Undo / Redo</span><kbd>⌘ Z / ⇧ ⌘ Z</kbd><span>Save / Quick Export PNG</span><kbd>⌘ S / ⇧ ⌘ '</kbd><span>Free Transform</span><kbd>⌘ T</kbd><span>Nudge / Larger nudge</span><kbd>Arrow / ⇧ Arrow</kbd><span>Deselect / Fit</span><kbd>⌘ D / ⌘ 0</kbd></div><p>Use Ctrl instead of ⌘ on Windows. Scroll to zoom, or choose the hand tool to pan. Magic wand creates a mask on a duplicate of the visible composite. Flood fill creates a separate layer. GIF import uses the first frame.</p><p>With Move selected, drag the handles to resize a layer or use the round handle to rotate. Corners keep proportions by default; Shift toggles that behavior. Shift constrains rotation to 15° steps. Alt/Option bypasses snapping. Apply with Enter, or cancel with Escape. Transform sessions become one undo step. Shift-click a range of layers or Cmd/Ctrl-click to toggle layers. Drag rows above or below another layer, onto a group to move inside it, or onto the top-level drop area to move out. Group with Cmd/Ctrl+G and ungroup with Shift+Cmd/Ctrl+G. Shared transforms keep proportions; document-space group bitmap or painted masks must be removed before transforming, and rectangular masks must be removed before shared rotation. Enable Auto-select to pick a visible unlocked layer on the canvas; Shift-click toggles selection.</p><p>Open 8-bit, 16-bit and 32-bit RGB PSD/PSB files with basic raster layers, groups and solid RGB vector fills. Unsupported PSD features open as a single saved composite, and the complete original file is retained in .photo projects. Unchanged previews download the original layers; after preview edits, export PNG or save a project. File → Download original PSD retrieves the original without preview edits. For supported documents, File → Download PSD retains source pixels and bounds for unmodified raster layers, including integer moves. Editable vector fills retain their paths and transforms, and text layers stay editable (with their rendered pixels for readers without the fonts). Other raster transforms, masks and adjustments are baked within the canvas. Keep a .photo project to retain all editing controls.</p>`,
      );
      break;
  }
}
