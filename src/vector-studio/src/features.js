/**
 * Feature modules: each registers its tools, panels, commands and hooks on
 * the app before start(). Keeping registration here means features can be
 * developed independently and the core does not import them. Type installs
 * last because it wraps the clipboard and Select All commands for editing.
 */
import { installHome } from './ui/home.js';
import { install as installFiles } from './features/files/index.js';
import { install as installIO } from './features/io/index.js';
import { install as installGeometry } from './features/geometry/index.js';
import { install as installPaint } from './features/paint/index.js';
import { install as installArtboards } from './features/artboards/index.js';
import { install as installBrushes } from './features/brushes/index.js';
import { install as installType } from './features/type/index.js';
import { install as installLiquify } from './features/liquify/index.js';
import { install as installShortcuts } from './features/shortcuts/index.js';
import { install as installLibraries } from './features/libraries/index.js';
import { install as installScripts } from './features/scripts/index.js';
import { install as installVariables } from './features/variables/index.js';
import { install as installSvgInteractivity } from './features/svg-interactivity/index.js';
import { install as installSymbols } from './features/symbols/index.js';
import { install as installRepeat } from './features/repeat/index.js';
import { install as installRegions } from './features/regions/index.js';
import { install as installInterlace } from './features/interlace/index.js';
import { install as installPerspective } from './features/perspective/index.js';
import { install as installPanels } from './features/panels/index.js';
import { install as installTrace } from './features/trace/index.js';
import { install as installEffects } from './features/effects/index.js';
import { install as installThreeD } from './features/three-d/index.js';
import { install as installPixelEffects } from './features/pxfx/index.js';
import { install as installEnvelope } from './features/envelope/index.js';
import { install as installMesh } from './features/mesh/index.js';
import { install as installGraphs } from './features/graphs/index.js';
import { install as installFlare } from './features/flare/index.js';
import { install as installDimension } from './features/dimension/index.js';
import { install as installCollab } from './features/collab/index.js';
import { install as installCorners } from './features/corners/index.js';
import { install as installPatterns } from './features/patterns/index.js';
import { install as installSlices } from './features/slices/index.js';
import { install as installWorkspace } from './features/workspace/index.js';
import { install as installLayers } from './features/layers/index.js';
import { install as installPrepress } from './features/prepress/index.js';

export function installFeatures(app) {
  installHome(app);
  installIO(app);
  installFiles(app);
  installGeometry(app);
  installPaint(app);
  installArtboards(app);
  installLiquify(app);
  installRepeat(app);
  installInterlace(app);
  installPerspective(app);
  installBrushes(app);
  installTrace(app);
  installEffects(app);
  installThreeD(app);
  installPixelEffects(app);
  installEnvelope(app);
  installPatterns(app);
  installSlices(app);
  installWorkspace(app);
  // After workspace: color-managed proofs extend its Proof Setup.
  installPrepress(app);
  installType(app);
  // After type: paint regions chain onto the paint hooks type sets.
  installRegions(app);
  // After type: symbols chain the paint hooks type sets.
  installSymbols(app);
  installLibraries(app);
  installScripts(app);
  installVariables(app);
  installSvgInteractivity(app);
  installPanels(app);
  installLayers(app);
  // After Type: the mesh paint hook wraps the type one.
  installMesh(app);
  installGraphs(app);
  installFlare(app);
  installDimension(app);
  installCorners(app);
  // After the document features: sharing wraps Save and gates editing commands.
  installCollab(app);
  // Last: shortcut sets apply to every command and tool registered above.
  installShortcuts(app);
}
