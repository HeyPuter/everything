// Slide size.

import type { Emu } from "../units.ts";
import {
  NS,
  attr,
  elem,
  firstChildElement,
  parseXml,
  qname,
  serializeXml,
} from "../../internal/xml/index.ts";
import { readPresentationPart } from "../../internal/presentationml/index.ts";
import {
  INTERNAL_PACKAGE,
  type PresentationData,
} from "../_internal-symbols.ts";
import { PRES_PART_NAME, decode, encode } from "./_helpers.ts";

// Slide size.

/**
 * Width × height of the slide canvas, in EMU. `type` is the
 * aspect-ratio hint (`screen4x3`, `screen16x9`, ...); the actual size
 * is always `width` × `height`.
 */
export interface SlideSize {
  readonly width: Emu;
  readonly height: Emu;
  readonly type?: string;
}

// The size is read from presentation.xml, which lists every slide; callers
// ask for it per shape, so it is read once per version of the part's bytes
// (they are replaced, not changed in place, when the part is written).
const slideSizes = new WeakMap<Uint8Array, SlideSize | null>();

/** Returns the slide canvas size, or `null` if `presentation.xml` omits it. */
export const getSlideSize = (pres: PresentationData): SlideSize | null => {
  const pkg = pres[INTERNAL_PACKAGE];
  const presPart = pkg.getPart(PRES_PART_NAME);
  if (presPart === null) return null;
  let size = slideSizes.get(presPart.data);
  if (size === undefined) {
    const root = parseXml(decode(presPart.data)).root;
    const model = readPresentationPart(root);
    size =
      model.slideSize === null
        ? null
        : {
            width: model.slideSize.cx as Emu,
            height: model.slideSize.cy as Emu,
            ...(model.slideSize.type !== undefined
              ? { type: model.slideSize.type }
              : {}),
          };
    slideSizes.set(presPart.data, size);
  }
  return size && { ...size };
};

const NAME_SLD_SZ_FN = qname("p", "sldSz", NS.pml);
const ATTR_CX = qname("", "cx", "");
const ATTR_CY = qname("", "cy", "");
const ATTR_TYPE = qname("", "type", "");
const NAME_SLD_ID_LST_FN = qname("p", "sldIdLst", NS.pml);

/**
 * Sets the slide canvas size. Creates `<p:sldSz>` when absent, replaces
 * its attributes when present. The `type` hint is preserved as given.
 *
 * Schema ordering: `<p:sldSz>` follows `<p:sldIdLst>` per ECMA-376
 * §19.2.1.26; we insert at the correct position when bootstrapping.
 */
export const setSlideSize = (pres: PresentationData, opts: SlideSize): void => {
  const pkg = pres[INTERNAL_PACKAGE];
  const presPart = pkg.getPart(PRES_PART_NAME);
  if (!presPart) throw new Error("presentation.xml is missing");
  const doc = parseXml(decode(presPart.data));

  let sldSz = firstChildElement(doc.root, NAME_SLD_SZ_FN);
  if (sldSz === null) {
    sldSz = elem(NAME_SLD_SZ_FN);
    const sldIdLst = firstChildElement(doc.root, NAME_SLD_ID_LST_FN);
    if (sldIdLst !== null) {
      const idx = doc.root.children.indexOf(sldIdLst);
      doc.root.children.splice(idx + 1, 0, sldSz);
    } else {
      doc.root.children.push(sldSz);
    }
  }

  sldSz.attrs = [
    attr(ATTR_CX, String(opts.width)),
    attr(ATTR_CY, String(opts.height)),
  ];
  if (opts.type !== undefined) sldSz.attrs.push(attr(ATTR_TYPE, opts.type));

  presPart.data = encode(serializeXml(doc));
};

import { emu as emuValue } from "../units.ts";

/** 10in × 7.5in (`screen4x3`). */
export const SLIDE_SIZE_4_3: SlideSize = {
  width: emuValue(9144000),
  height: emuValue(6858000),
  type: "screen4x3",
};

/** 13.333in × 7.5in (`screen16x9`) — the common widescreen default. */
export const SLIDE_SIZE_16_9: SlideSize = {
  width: emuValue(12192000),
  height: emuValue(6858000),
  type: "screen16x9",
};

/** 13.333in × 8.33in (`screen16x10`). */
export const SLIDE_SIZE_16_10: SlideSize = {
  width: emuValue(12192000),
  height: emuValue(7620000),
  type: "screen16x10",
};
