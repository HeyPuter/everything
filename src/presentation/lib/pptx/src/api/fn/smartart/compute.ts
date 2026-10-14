// Lays out a SmartArt model in a frame: the shapes of its saved drawing.
import { layoutEntry, DEFAULT_SMARTART_LAYOUT } from "./catalog.ts";
import { type ArtShape, fitText, mirror } from "./kit.ts";
import { type SmartArtModel, smartArtTree } from "./model.ts";

export const layoutSmartArt = (
  model: SmartArtModel,
  w: number,
  h: number,
): ArtShape[] => {
  const entry =
    layoutEntry(model.layout) ?? layoutEntry(DEFAULT_SMARTART_LAYOUT)!;
  let shapes = entry.fn({ w, h, nodes: smartArtTree(model.items) });
  if (model.rightToLeft) shapes = mirror(shapes, w);
  fitText(shapes);
  return shapes;
};
