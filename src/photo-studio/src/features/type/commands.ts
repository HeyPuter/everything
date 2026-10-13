// Type menu commands and the Warp Text dialog.

import type { Editor } from '../../editor';
import { commands, registerCommand, type Command } from '../../app/registry';
import { escapeXML } from '../../model/assets';
import { allLayers, findLayer, layer as newLayer, type Layer, type PhotoDocument } from '../../model/document';
import { layerLock } from '../../model/locks';
import { fitTextFrame, placeTextRect, rgbHexString } from '../../model/text-layer';
import { setVectorColor } from '../../color/vector';
import { rasterizeLayer } from '../pixels';
import {
  defaultWarp,
  insertText,
  textLength,
  type AntiAlias,
  type TextLayerData,
  type Warp,
  type WarpStyle,
} from '../../imaging/text/model';
import { invalidateMeasurements } from '../../imaging/text/layout';
import { localFontAccessSupported, prepareFonts } from '../../imaging/text/fonts';
import { forgetFontAvailability, missingFonts } from '../../renderer/text-source';
import { applyLayer, editLayers, insert, selectedTextLayers, session, startEdit, startNew, updateData, focusInput } from './session';
import { editable, forgetLayout, layoutOf, localBounds, ppiOf, replaceLayer } from './text-utils';
import { refreshFamilies, setAntiAlias, syncTypeOptions } from './options';
import { contoursToVectorMask } from './shape';
import { convertParagraphMode } from './convert';
import { dropTypePath } from './path-type';
import { isTypeTool } from './tools';

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.';

// The text layer a command acts on: the one being edited, else the selected one.
function target(e: Editor): Layer | undefined {
  if (session && !session.mask) return findLayer(e.doc.layers, session.layerId);
  const l = e.layer;
  return l?.kind === 'text' ? l : undefined;
}
const hasText = (e: Editor) => !!session || selectedTextLayers(e).length > 0;
function currentData(e: Editor): TextLayerData | undefined {
  if (session) return session.data;
  const l = target(e);
  return l ? editable(l, ppiOf(e)).textData : undefined;
}

export const WARP_STYLES: [WarpStyle, string][] = [
  ['none', 'None'], ['arc', 'Arc'], ['arc-lower', 'Arc Lower'], ['arc-upper', 'Arc Upper'], ['arch', 'Arch'], ['bulge', 'Bulge'],
  ['shell-lower', 'Shell Lower'], ['shell-upper', 'Shell Upper'], ['flag', 'Flag'], ['wave', 'Wave'], ['fish', 'Fish'], ['rise', 'Rise'],
  ['fisheye', 'Fish Eye'], ['inflate', 'Inflate'], ['squeeze', 'Squeeze'], ['twist', 'Twist'],
];

async function convertToShape(e: Editor) {
  const l0 = target(e);
  if (!l0) return;
  if (session) {
    const { commit } = await import('./session');
    await commit(e);
  }
  const l = editable(findLayer(e.doc.layers, l0.id) ?? l0, ppiOf(e));
  // Glyph outlines come from the font files; the parser loads on first use.
  const { textToPathAsync } = await import('../../imaging/text/outlines');
  const path = await textToPathAsync(l.textData, { resolution: ppiOf(e) });
  if (!path.contours.length) {
    e.message('There is no text to convert.');
    return;
  }
  const mask = contoursToVectorMask(path.contours);
  const b = path.bounds;
  const reference = { x: b.x, y: b.y, width: Math.max(1e-3, b.width), height: Math.max(1e-3, b.height) };
  const shape = newLayer('vector', l.name, 1, 1);
  shape.vector = { mask, reference, fill: { rgb: [0, 0, 0], space: 'srgb' } };
  setVectorColor(shape, rgbHexString(l.textData.content.paragraphs[0]?.runs[0]?.style.color ?? [0, 0, 0]));
  shape.transform = placeTextRect(l, reference);
  shape.sourceWidth = e.doc.width;
  shape.sourceHeight = e.doc.height;
  for (const k of ['visible', 'opacity', 'blend', 'fillOpacity', 'clipped', 'style', 'maskGrid', 'pixelMask', 'maskDisabled', 'maskInverted', 'colorLabel'] as const)
    if (l[k] !== undefined) (shape as unknown as Record<string, unknown>)[k] = structuredClone(l[k]);
  e.command('Convert to Shape', (d) => {
    const walk = (layers: Layer[]) => {
      const i = layers.findIndex((x) => x.id === l.id);
      if (i >= 0) layers[i] = structuredClone(shape);
      else layers.forEach((x) => walk(x.children));
    };
    walk(d.layers);
  });
  e.selectLayers([shape.id]);
  e.update();
  const notes = [...(path.missingFonts.length ? [`${path.missingFonts.join(', ')} drawn with Inter (only included fonts have outlines)`] : []), ...(path.approximations.length ? [`approximated: ${path.approximations.join(', ')}`] : [])];
  const colors = new Set(l.textData.content.paragraphs.flatMap((p) => p.runs.map((r) => r.style.color.join())));
  if (colors.size > 1) notes.push('the shape uses the first character color');
  if (notes.length) e.message(`Converted to shape; ${notes.join('; ')}.`);
}

// ------------------------------------------------------------ warp dialog

async function warpDialog(e: Editor) {
  const editing = !!session;
  const layers = editing ? [] : selectedTextLayers(e);
  const start = currentData(e);
  if (!start) return;
  if (!editing && layers.some((l) => layerLock(e.doc.layers, l.id, 'all'))) {
    e.message('Unlock the text layers to warp them.');
    return;
  }
  const original = start.warp ?? defaultWarp();
  const w: Warp = { ...original, ...(original.style === 'none' ? { bend: 50 } : {}) };
  const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
  const slider = (name: keyof Warp, label: string) =>
    `<label class="dialog-field type-warp-slider">${label}<input type="range" name="${name}" min="-100" max="100" step="1" value="${w[name]}"><output>${w[name]}%</output></label>`;
  dialog.innerHTML = `<form method="dialog" class="type-warp"><h2>Warp Text</h2>
<label class="dialog-field">Style <select name="style">${WARP_STYLES.map(([v, l]) => `<option value="${v}" ${v === original.style ? 'selected' : ''}>${escapeXML(l)}</option>`).join('')}</select></label>
<fieldset class="dialog-field type-warp-axis"><legend>Orientation</legend><label><input type="radio" name="axis" value="horizontal" ${w.axis === 'horizontal' ? 'checked' : ''}> Horizontal</label><label><input type="radio" name="axis" value="vertical" ${w.axis === 'vertical' ? 'checked' : ''}> Vertical</label></fieldset>
${slider('bend', 'Bend')}${slider('horizontal', 'Horizontal Distortion')}${slider('vertical', 'Vertical Distortion')}
<div class="dialog-actions"><button type="button" data-warp-cancel>Cancel</button><button type="submit" class="primary">OK</button></div></form>`;
  const form = dialog.querySelector('form')!;
  const read = (): Warp => {
    const f = new FormData(form);
    return { style: f.get('style') as WarpStyle, axis: f.get('axis') as Warp['axis'], bend: Number(f.get('bend')), horizontal: Number(f.get('horizontal')), vertical: Number(f.get('vertical')) };
  };
  const sync = () => {
    const none = read().style === 'none';
    for (const i of form.querySelectorAll<HTMLInputElement>('input[type=range], input[type=radio]')) i.disabled = none;
    for (const o of form.querySelectorAll<HTMLOutputElement>('output')) o.value = `${(o.previousElementSibling as HTMLInputElement).value}%`;
  };
  const ppi = ppiOf(e);
  const previewLayers = async (warp: Warp) => {
    let doc: PhotoDocument = e.doc;
    for (const l of layers) {
      const t = editable(l, ppi);
      const data = { ...t.textData, warp };
      await prepareFonts(data);
      doc = replaceLayer(doc, l.id, () => {
        const n: Layer = { ...t, textData: data };
        delete n.asset;
        fitTextFrame(n, localBounds(data, layoutOf(data, ppi)));
        return n;
      });
    }
    e.preview(doc);
  };
  const apply = (warp: Warp) => {
    if (editing && session) updateData(e, (d) => ({ ...d, warp }), 'warp');
    else void previewLayers(warp);
  };
  sync();
  form.addEventListener('input', () => {
    sync();
    apply(read());
  });
  apply(read());
  const result = await new Promise<Warp | null>((resolve) => {
    form.querySelector('[data-warp-cancel]')!.addEventListener('click', () => {
      dialog.close();
      resolve(null);
    });
    dialog.oncancel = () => resolve(null);
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const v = read();
      dialog.close();
      resolve(v);
    };
    dialog.showModal();
  });
  const finalWarp = result && result.style !== 'none' ? result : undefined;
  if (editing) {
    if (session) updateData(e, (d) => ({ ...d, warp: result ? finalWarp : start.warp }), 'warp');
    focusInput(e);
    return;
  }
  if (!result) {
    e.update();
    return;
  }
  await editLayers(e, 'Warp Text', (d) => ({ ...d, warp: finalWarp }), layers.map((l) => l.id));
}

// ------------------------------------------------------------ registration

export function installTypeCommands(e: Editor) {
  const cmd = (id: string, label: string, run: Command['run'], extra: Partial<Command> = {}) => registerCommand({ id, label, run, ...extra });
  cmd('type.add', 'Add Text', async (e) => {
    if (!e.hasDocument) return;
    if (!isTypeTool(e.tool)) e.setTool('type');
    await startNew(e, { x: e.doc.width / 2, y: e.doc.height / 2, vertical: e.tool.includes('vertical'), mask: false });
  }, { hidden: true });
  cmd('type.edit', 'Edit Text', async (e) => {
    const l = e.layer;
    if (l?.kind !== 'text' || session?.layerId === l.id) return;
    const vertical = editable(l, ppiOf(e)).textData.orientation === 'vertical';
    e.setTool(vertical ? 'type-vertical' : 'type');
    await startEdit(e, l.id, 'all');
  }, { hidden: true, enabled: (e) => e.layer?.kind === 'text' });

  for (const [aa, label] of [['none', 'None'], ['sharp', 'Sharp'], ['crisp', 'Crisp'], ['strong', 'Strong'], ['smooth', 'Smooth']] as [AntiAlias, string][])
    cmd(`type.aa-${aa}`, label, (e) => setAntiAlias(e, aa), {
      checked: (e) => (currentData(e)?.antiAlias ?? (e.settings.typeDefaults as { antiAlias?: string } | undefined)?.antiAlias ?? 'smooth') === aa,
    });
  const orient = (o: TextLayerData['orientation']) => async (e: Editor) => {
    if (!hasText(e)) {
      e.setTool(o === 'vertical' ? 'type-vertical' : 'type');
      return;
    }
    await applyLayer(e, 'Change Text Orientation', (d) => (d.path ? d : { ...d, orientation: o, ...(o === 'vertical' ? { block: undefined } : {}) }));
  };
  cmd('type.horizontal', 'Horizontal', orient('horizontal'), { checked: (e) => (currentData(e)?.orientation ?? (e.tool.includes('vertical') ? 'vertical' : 'horizontal')) === 'horizontal' });
  cmd('type.vertical', 'Vertical', orient('vertical'), { checked: (e) => (currentData(e)?.orientation ?? (e.tool.includes('vertical') ? 'vertical' : 'horizontal')) === 'vertical' });
  cmd('type.toggle-orientation', 'Toggle Text Orientation', async (e) => {
    const d = currentData(e);
    const next = (d?.orientation ?? (e.tool.includes('vertical') ? 'vertical' : 'horizontal')) === 'vertical' ? 'horizontal' : 'vertical';
    if (!hasText(e)) e.setTool(e.tool.includes('mask') ? (next === 'vertical' ? 'type-mask-vertical' : 'type-mask') : next === 'vertical' ? 'type-vertical' : 'type');
    else await orient(next)(e);
  }, { hidden: true });

  cmd('type.convert-to-shape', 'Convert to Shape', (e) => convertToShape(e), { enabled: (e) => !!target(e) });
  cmd('type.rasterize', 'Rasterize Type Layer', async (e) => {
    const l = target(e);
    if (!l) return;
    if (session) {
      const { commit } = await import('./session');
      await commit(e);
    }
    if (findLayer(e.doc.layers, l.id)) await rasterizeLayer(e, l.id, 'Rasterize Type');
  }, { enabled: (e) => !!target(e) });
  cmd('type.convert-paragraph', 'Convert to Paragraph Text', (e) => applyLayer(e, 'Convert Text Shape Type', (d) => (d.path ? dropTypePath(d, layoutOf(d, ppiOf(e))) : { ...convertParagraphMode(d, layoutOf(d, ppiOf(e))), block: undefined })), {
    enabled: (e) => !!currentData(e),
    description: 'Convert Text Shape Type: point text to paragraph text and back; path text to point text, area text to paragraph text.',
  });
  // Path text follows its path; warping does not apply to it.
  cmd('type.warp', 'Warp Text…', (e) => warpDialog(e), { enabled: (e) => !!currentData(e) && !currentData(e)!.path });
  cmd('type.paste-lorem', 'Paste Lorem Ipsum', async (e) => {
    if (session) {
      insert(e, LOREM, 'paste');
      focusInput(e);
      return;
    }
    const l = target(e);
    if (l) return editLayers(e, 'Paste Lorem Ipsum', (d) => ({ ...d, content: insertText(d.content, textLength(d.content), LOREM) }), [l.id]);
  }, { enabled: (e) => !!session || !!target(e) });
  cmd('type.update-all', 'Update All Text Layers', async (e) => {
    forgetFontAvailability();
    invalidateMeasurements();
    forgetLayout();
    await refreshFamilies();
    const ids = allLayers(e.doc.layers)
      .filter((l) => l.kind === 'text' && !layerLock(e.doc.layers, l.id, 'all') && !(l.asset && l.textData && missingFonts(l.textData).length))
      .map((l) => l.id);
    if (ids.length) await editLayers(e, 'Update All Text Layers', (d) => d, ids);
    e.update();
  }, { enabled: (e) => allLayers(e.doc.layers).some((l) => l.kind === 'text') });
  cmd('type.replace-missing', 'Replace All Missing Fonts', async (e) => {
    const ids = allLayers(e.doc.layers).filter((l) => l.textData && missingFonts(l.textData).length && !layerLock(e.doc.layers, l.id, 'all')).map((l) => l.id);
    if (!ids.length) return e.message('No text layer uses a missing font.');
    await editLayers(e, 'Replace Missing Fonts', (d) => {
      const missing = new Set(missingFonts(d));
      return { ...d, content: { paragraphs: d.content.paragraphs.map((p) => ({ style: p.style, runs: p.runs.map((r) => (missing.has(r.style.family) ? { text: r.text, style: { ...r.style, family: 'Inter' } } : r)) })) } };
    }, ids);
  }, { enabled: (e) => allLayers(e.doc.layers).some((l) => !!l.textData && missingFonts(l.textData).length > 0) });
  cmd('type.more-fonts', 'Use Local Fonts…', async (e) => {
    if (!localFontAccessSupported()) {
      e.message('This browser does not offer local font access. Installed fonts from a common list are detected automatically.');
      return;
    }
    const before = (await refreshFamilies()).length;
    const after = (await refreshFamilies(true)).length;
    forgetFontAvailability();
    syncTypeOptions(e);
    e.message(after > before ? `Added ${after - before} local font families.` : 'No additional local fonts are available (permission may have been declined).');
  }, { recordable: false, description: 'Ask the browser for permission to list fonts installed on this device.' });
  // The menu names the conversion that applies to the current text.
  const convert = commands.get('type.convert-paragraph')!;
  Object.defineProperty(convert, 'label', {
    get: () => {
      const d = currentData(e);
      if (d?.path) return d.path.kind === 'area' ? 'Convert to Paragraph Text' : 'Convert to Point Text';
      return d?.mode === 'paragraph' ? 'Convert to Point Text' : 'Convert to Paragraph Text';
    },
  });
  cmd('type.toggle-panels', 'Character and Paragraph Panels', (e) => e.dock.show('character', true), { hidden: true, recordable: false });
  void e;
}
