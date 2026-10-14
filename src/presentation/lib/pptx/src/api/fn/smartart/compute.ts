// Lays out a SmartArt model in a frame: the shapes of its saved drawing.
import { layoutEntry, DEFAULT_SMARTART_LAYOUT } from "./catalog.ts";
import { type ArtShape, fitText, mirror } from "./kit.ts";
import { type SmartArtModel, smartArtTree } from "./model.ts";

/**
 * Names each shape for its formatting: by its item and kind ("2/node",
 * "2/node:1" for the item's second node shape), or by kind and order for
 * shapes standing for no item ("trans:0").
 */
export const nameSmartArtShapes = (shapes: ArtShape[]): void => {
  const seen = new Map<string, number>();
  for (const s of shapes) {
    const base = s.item === undefined ? `#${s.role}` : `${s.item}/${s.role}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    s.key =
      s.item === undefined
        ? `${s.role}:${n}`
        : n
          ? `${s.item}/${s.role}:${n}`
          : `${s.item}/${s.role}`;
  }
};

/** The format-map name of a shape key: "node:1" of "2/node:1". */
export const shapeFormatName = (key: string): string =>
  key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;

export const layoutSmartArt = (
  model: SmartArtModel,
  w: number,
  h: number,
): ArtShape[] => {
  const entry =
    layoutEntry(model.layout) ?? layoutEntry(DEFAULT_SMARTART_LAYOUT)!;
  let shapes = entry.fn({ w, h, nodes: smartArtTree(model.items) });
  if (model.rightToLeft) shapes = mirror(shapes, w);
  nameSmartArtShapes(shapes);
  shapes = shapes.map((s) => {
    const item = s.item === undefined ? undefined : model.items[s.item];
    const format = (item ? item.format : model.format)?.[
      shapeFormatName(s.key!)
    ];
    let out: ArtShape = { ...s };
    if (item?.textStyle) out.textStyle = item.textStyle;
    if (!format) return out;
    out.format = format;
    if (format.geom && s.geom !== "custom") {
      const { adj: _layoutAdjustments, ...rest } = out;
      out = { ...rest, geom: format.geom };
    }
    const k = format.scale;
    if (k && k > 0 && k !== 1) {
      const cx = s.x + s.w / 2,
        cy = s.y + s.h / 2;
      const scaleRect = <
        R extends { x: number; y: number; w: number; h: number },
      >(
        r: R,
      ): R => ({
        ...r,
        x: cx + (r.x - cx) * k,
        y: cy + (r.y - cy) * k,
        w: r.w * k,
        h: r.h * k,
      });
      out = {
        ...scaleRect(out),
        ...(s.textBox ? { textBox: scaleRect(s.textBox) } : {}),
        ...(s.path
          ? {
              path: s.path.map((line) =>
                line.map(([x, y]) => [x * k, y * k] as const),
              ),
            }
          : {}),
      };
    }
    return out;
  });
  fitText(shapes);
  return shapes;
};
