/**
 * Geometry feature: Pathfinder (panel, Properties section, commands),
 * Object > Path commands, Expand, and the Shape Builder, Scissors, Knife,
 * Eraser, Merge Brush and Join tools. Geometry runs in the Rust/WASM engine
 * (src/wasm/geom.wasm, built from wasm/geom).
 */
import './styles.css';
import { PathfinderPanel, pathfinderSection } from './panel.js';
import { registerGeometryCommands } from './commands.js';
import { GEOMETRY_TOOLS } from './tools.js';
import { PropertiesPanel } from '../../ui/panels/properties.js';

export function install(app) {
  for (const T of GEOMETRY_TOOLS) app.registerTool(T);
  app.registerPanel(PathfinderPanel);
  if (!PropertiesPanel.extraSections.some((s) => s.id === pathfinderSection.id)) PropertiesPanel.extraSections.push(pathfinderSection);
  registerGeometryCommands(app);
}
