// Canonical preset geometry shares the custom-geometry guide/path evaluator.
// Definitions are parsed lazily once; evaluated models never share mutable data.
import { parseXml, type XmlElement } from "../xml/index.ts";
import {
  parseConnectionSites,
  parseCustomGeometry,
  type CustomGeometry,
  type GeomPoint,
} from "./custom-geometry.ts";
import { PRESET_DEFINITIONS } from "./preset-definitions.ts";

const definitions = new Map<string, XmlElement>();

const presetDefinition = (preset: string): XmlElement | null => {
  // Keep the two legacy names accepted by the previous renderer. Their raw
  // authored names remain untouched; use the equivalent standard definitions.
  if (preset === "oval") preset = "ellipse";
  else if (preset === "flowChartCard") preset = "flowChartPunchedCard";
  if (!Object.hasOwn(PRESET_DEFINITIONS, preset)) return null;
  let definition = definitions.get(preset);
  if (!definition) {
    definition = parseXml(PRESET_DEFINITIONS[preset]!).root;
    definitions.set(preset, definition);
  }
  return definition;
};

export const parsePresetGeometry = (
  preset: string,
  w: number,
  h: number,
  adjustments: XmlElement | null = null,
): CustomGeometry | null => {
  const definition = presetDefinition(preset);
  return definition && parseCustomGeometry(definition, w, h, adjustments);
};

/** A preset's connection sites for a shape `w` × `h` EMU. */
export const presetConnectionSites = (
  preset: string,
  w: number,
  h: number,
  adjustments: XmlElement | null = null,
): GeomPoint[] | null => {
  const definition = presetDefinition(preset);
  return definition && parseConnectionSites(definition, w, h, adjustments);
};
