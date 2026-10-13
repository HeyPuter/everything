// Color management feature: color picker, Color Settings, Assign/Convert to
// Profile, Image > Mode, bit depth, proof colors, gamut warning, mode-aware
// export and swatch libraries. The color engine loads on first use so the
// workspace starts without building profiles.
import type { Editor } from '../../editor';
import { registerCommand, registerOverlay, type Command } from '../../app/registry';
import type { ColorMode } from '../../model/document';
import { installSwatchLibraries } from './swatches';

type Mod = typeof import('./lazy');
let mod: Mod | undefined;
let loading: Promise<Mod> | undefined;
const load = () => (loading ??= import('./lazy').then((m) => (mod = m)));

/** Open the color picker; resolves with #rrggbb (document RGB) or null. */
export async function pickColor(e: Editor, initial: string, title?: string): Promise<string | null> {
  return (await import('./picker')).pickColor(e, initial, title);
}
/** Export a TIFF in the document's image mode ('cmyk' forces a CMYK separation). */
export async function exportModeTiff(e: Editor, force?: 'cmyk') {
  return (await load()).exportModeTiff(e, force);
}
export async function exportModePng(e: Editor) {
  return (await load()).exportModePng(e);
}
/** Apply the profile policy to a just-opened document (also run automatically). */
export async function applyOpenPolicy(e: Editor) {
  return (await load()).applyOpenPolicy(e);
}

const hasDoc = (e: Editor) => e.hasDocument;
const eight = (e: Editor) => e.hasDocument && (e.doc.bitsPerChannel ?? 8) === 8;
function cmd(id: string, label: string, run: (m: Mod, e: Editor) => unknown, extra: Partial<Command> = {}) {
  registerCommand({ id, label, run: async (e) => void (await run(await load(), e)), ...extra });
}

export function installColor(e: Editor) {
  // ----- Edit -----
  cmd('edit.color-settings', 'Color Settings…', (m, e) => m.colorSettingsDialog(e), { shortcut: 'Mod+Shift+K', recordable: false });
  cmd('edit.assign-profile', 'Assign Profile…', (m, e) => m.assignProfileDialog(e), { enabled: hasDoc });
  cmd('edit.convert-profile', 'Convert to Profile…', (m, e) => m.convertProfileDialog(e), { enabled: eight });

  // ----- Image > Mode -----
  const modes: [ColorMode, string, string][] = [
    ['bitmap', 'image.mode-bitmap', 'Bitmap…'],
    ['grayscale', 'image.mode-grayscale', 'Grayscale'],
    ['duotone', 'image.mode-duotone', 'Duotone…'],
    ['indexed', 'image.mode-indexed', 'Indexed Color…'],
    ['rgb', 'image.mode-rgb', 'RGB Color'],
    ['cmyk', 'image.mode-cmyk', 'CMYK Color'],
    ['lab', 'image.mode-lab', 'Lab Color'],
    ['multichannel', 'image.mode-multichannel', 'Multichannel'],
  ];
  for (const [mode, id, label] of modes)
    cmd(id, label, (m, e) => m.convertToMode(e, mode), {
      enabled: (e) => eight(e) && modeAllowed(e, mode),
      checked: (e) => e.hasDocument && (e.doc.mode ?? 'rgb') === mode,
    });
  cmd('image.color-table', 'Color Table…', (m, e) => m.colorTableDialog(e), { enabled: (e) => e.hasDocument && e.doc.mode === 'indexed' && !!e.doc.modeData?.palette });
  cmd('image.depth-8', '8 Bits/Channel', (m, e) => m.convertTo8Bit(e), { enabled: hasDoc, checked: (e) => (e.doc.bitsPerChannel ?? 8) === 8 });
  for (const depth of [16, 32] as const)
    registerCommand({
      id: `image.depth-${depth}`,
      label: `${depth} Bits/Channel`,
      enabled: hasDoc,
      checked: (e) => e.doc.bitsPerChannel === depth,
      recordable: false,
      run: (e) => {
        if (e.doc.bitsPerChannel === depth) return;
        e.message(
          (e.doc.bitsPerChannel ?? 8) === 8
            ? `Converting to ${depth} bits/channel is not supported: pixel layers store 8-bit tiles. High-depth editing is available for imported ${depth}-bit documents.`
            : `Converting between 16 and 32 bits/channel is not supported. Use 8 Bits/Channel to flatten the depth.`,
        );
      },
    });

  // ----- View: proofing -----
  const proofOn = (e: Editor) => !!mod && mod.proofState(e.session).on;
  const setupIs = (kind: string) => (e: Editor) => !!mod && mod.proofState(e.session).setup.kind === kind;
  cmd('view.proof-custom', 'Custom…', (m, e) => m.customProofDialog(e), { enabled: hasDoc, checked: setupIs('custom'), recordable: false });
  cmd('view.proof-cmyk', 'Working CMYK', (m, e) => m.setProof(e, m.workingCmykSetup()), { enabled: hasDoc, checked: (e) => !mod || setupIs('cmyk')(e), recordable: false });
  const plates = [['c', 'view.proof-cyan-plate', 'Working Cyan Plate'], ['m', 'view.proof-magenta-plate', 'Working Magenta Plate'], ['y', 'view.proof-yellow-plate', 'Working Yellow Plate'], ['k', 'view.proof-black-plate', 'Working Black Plate'], ['cmy', 'view.proof-cmy-plates', 'Working CMY Plates']] as const;
  for (const [plate, id, label] of plates)
    cmd(id, label, (m, e) => m.setProof(e, m.plateSetup(plate)), {
      enabled: hasDoc,
      checked: (e) => !!mod && mod.proofState(e.session).setup.kind === 'plate' && mod.proofState(e.session).setup.plate === plate,
      recordable: false,
      description: plate === 'cmy' ? 'Preview the separation printed without the black ink.' : 'Preview one ink of the working CMYK separation as a gray plate.',
    });
  for (const [vision, id, label, description] of [
    ['protan', 'view.proof-protan', 'Protan Color Vision', 'Simulate how people with reduced or missing red-sensitive cones see the image.'],
    ['deutan', 'view.proof-deutan', 'Deutan Color Vision', 'Simulate how people with reduced or missing green-sensitive cones see the image.'],
  ] as const)
    cmd(id, label, (m, e) => m.setProof(e, m.visionSetup(vision)), {
      enabled: hasDoc,
      checked: (e) => !!mod && mod.proofState(e.session).setup.kind === 'vision' && mod.proofState(e.session).setup.vision === vision,
      recordable: false,
      description,
    });
  registerCommand({
    id: 'view.hdr-preview-options',
    label: '32-Bit Preview Options…',
    enabled: (e) => e.hasDocument && e.doc.bitsPerChannel === 32,
    recordable: false,
    description: 'Choose how 32-bit values are shown on screen (exposure and gamma, highlight compression or a filmic curve)',
    run: async (e) => (await import('./hdr-preview')).hdrPreviewDialog(e),
  });
  cmd('view.proof-monitor-rgb', 'Monitor RGB', (m, e) => m.setProof(e, { ...m.workingCmykSetup(), kind: 'monitor', ref: 'builtin:srgb' }), { enabled: hasDoc, checked: setupIs('monitor'), recordable: false });
  cmd('view.proof-colors', 'Proof Colors', (m, e) => m.toggleProof(e), { shortcut: 'Mod+Y', enabled: hasDoc, checked: proofOn, recordable: false });
  cmd('view.gamut-warning', 'Gamut Warning', (m, e) => m.toggleGamut(e), {
    shortcut: 'Mod+Shift+Y',
    enabled: (e) => e.hasDocument && !setupIs('monitor')(e) && !setupIs('vision')(e),
    checked: (e) => !!mod && mod.proofState(e.session).gamut,
    recordable: false,
  });

  // ----- File > Export -----
  cmd('file.export-cmyk-tiff', 'Export CMYK TIFF', (m, e) => m.exportModeTiff(e, 'cmyk'), { enabled: hasDoc, menu: 'file.export', recordable: false, description: 'CMYK separation through the document (or working) CMYK profile, with the profile embedded.' });
  cmd('file.export-mode-tiff', 'Export TIFF in Image Mode', (m, e) => m.exportModeTiff(e), { enabled: (e) => e.hasDocument && ['grayscale', 'lab', 'bitmap', 'duotone', 'indexed'].includes(e.doc.mode ?? ''), menu: 'file.export', recordable: false });
  cmd('file.export-mode-png', 'Export PNG in Image Mode', (m, e) => m.exportModePng(e), { enabled: (e) => e.hasDocument && ['grayscale', 'bitmap', 'indexed'].includes(e.doc.mode ?? ''), menu: 'file.export', recordable: false });

  // Swatch libraries register synchronously so the panel menu lists them.
  installSwatchLibraries();

  registerOverlay('color.gamut-warning', (e) => (mod ? mod.gamutOverlaySvg(e) : ''));
  e.tabBadges.push((s) => (mod ? mod.proofBadge(s) : ''));
  e.onUpdate((e) => {
    if (!mod) {
      // Nothing to do until a document uses a mode or the user changed settings.
      if (e.doc.mode || hasStoredSettings()) void load().then(() => e.update());
      return;
    }
    mod.syncDisplay(e);
    if (e.doc.mode && e.doc.mode !== 'rgb') {
      const fg = mod.constrainColor(e.doc, e.color),
        bg = mod.constrainColor(e.doc, e.background);
      if (fg !== e.color) e.setForeground(fg);
      if (bg !== e.background) e.setBackground(bg);
    }
    void mod.applyOpenPolicy(e);
  });
}

function hasStoredSettings() {
  try {
    return localStorage.getItem('photo-studio-color-settings') !== null;
  } catch {
    return false;
  }
}
// Mirrors modeEnabled in modes.ts (kept here so menus need no engine load).
function modeAllowed(e: Editor, mode: ColorMode) {
  const m = e.doc.mode ?? 'rgb';
  if (m === mode) return mode === 'duotone' || mode === 'indexed';
  if (m === 'bitmap') return mode === 'grayscale';
  if (m === 'multichannel') return ['rgb', 'grayscale', 'cmyk', 'lab'].includes(mode);
  if (mode === 'multichannel') return ['rgb', 'cmyk', 'grayscale', 'duotone'].includes(m);
  if (mode === 'bitmap' || mode === 'duotone') return m === 'grayscale';
  if (mode === 'indexed') return m === 'rgb' || m === 'grayscale' || m === 'duotone';
  return true;
}
