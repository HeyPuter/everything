// Repairs a package that lost parts other apps cannot open without.
//
// A presentation that arrives without its package relationships, a theme or
// a slide layout still opens here, because the reader falls back to defaults
// for what is missing. Saved as it is, the file keeps the gap, and other
// apps refuse it or offer to repair it. The gaps are filled the way the
// reader already reads them.

import {
  type PartName,
  type Relationships,
  emptyRels,
  nextRelId,
  partName,
  resolveTarget,
} from "../../internal/opc/index.ts";
import { DEFAULT_THEME_XML } from "../../internal/parts/blank-deck.ts";
import type { OpcPackage } from "../../internal/parts/index.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import {
  INTERNAL_PACKAGE,
  type PresentationData,
} from "../_internal-symbols.ts";
import { encode } from "./_helpers.ts";

const MAIN_TYPE =
  /presentationml\.(?:presentation|template|slideshow)\.main\+xml$|macroEnabled\.main\+xml$/;
const THEME_TYPE = "application/vnd.openxmlformats-officedocument.theme+xml";
const LAYOUT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml";
const CORE_TYPE = "application/vnd.openxmlformats-package.core-properties+xml";
const APP_TYPE =
  "application/vnd.openxmlformats-officedocument.extended-properties+xml";

// A layout with nothing of its own: its slides take everything from the
// master, as they were read while the layout was missing.
const BLANK_LAYOUT_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" preserve="1">' +
  '<p:cSld name="Layout"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
  "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>";

const relativeTarget = (from: PartName, to: PartName): string => {
  const a = from.split("/").slice(1, -1);
  const b = to.split("/").slice(1);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
};

const targetOf = (from: PartName | "/", target: string): PartName | null => {
  try {
    return resolveTarget(from, target);
  } catch {
    return null;
  }
};

// The package's own relationships: the main part, and the document
// properties when they are there.
const repairRootRels = (pkg: OpcPackage): boolean => {
  const rels = pkg.rootRels() ?? emptyRels();
  const has = (type: string) =>
    rels.items.some(
      (r) =>
        r.type === type &&
        r.targetMode !== "External" &&
        (() => {
          const name = targetOf("/", r.target);
          return !!name && !!pkg.getPart(name);
        })(),
    );
  let changed = false;
  const add = (type: string, test: (contentType: string) => boolean) => {
    if (has(type)) return;
    const part = pkg.parts.find((p) => test(p.contentType));
    if (!part) return;
    rels.items = rels.items.filter((r) => r.type !== type);
    rels.items.push({
      id: nextRelId(rels.items.map((r) => r.id)),
      type,
      target: part.name.slice(1),
      targetMode: "Internal",
    });
    changed = true;
  };
  add(REL_TYPES.officeDocument, (t) => MAIN_TYPE.test(t));
  add(REL_TYPES.coreProperties, (t) => t === CORE_TYPE);
  add(REL_TYPES.extendedProperties, (t) => t === APP_TYPE);
  if (changed) pkg.setRootRels(rels);
  return changed;
};

/**
 * Fills gaps other apps cannot open a presentation with: the package's own
 * relationships, a theme, a slide layout. A missing theme becomes the
 * default theme; a missing layout a master lists becomes a blank one under
 * that master; a slide whose layout is missing and listed by no master uses
 * its master's first layout. True when anything was repaired.
 */
export const repairPackage = (pres: PresentationData): boolean => {
  const pkg = pres[INTERNAL_PACKAGE];
  let changed = repairRootRels(pkg);
  const relsParts = pkg.parts.filter((p) => p.name.endsWith(".rels"));
  // Each part's relationships, read once.
  const owners: { owner: PartName; rels: Relationships }[] = [];
  for (const relsPart of relsParts) {
    const m = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(relsPart.name);
    if (!m || !m[1]) continue;
    const owner = partName(`${m[1]}/${m[2]}`);
    if (!pkg.getPart(owner)) continue;
    const rels = pkg.getRels(owner);
    if (rels) owners.push({ owner, rels });
  }
  const missing = (owner: PartName, target: string): PartName | null => {
    const name = targetOf(owner, target);
    return name && !pkg.getPart(name) ? name : null;
  };
  // Themes, and the layouts a master lists.
  for (const { owner, rels } of owners) {
    for (const rel of rels.items) {
      if (rel.targetMode === "External") continue;
      const isTheme = rel.type === REL_TYPES.theme;
      const isMasterLayout =
        rel.type === REL_TYPES.slideLayout &&
        pkg.getPart(owner)?.contentType.endsWith("slideMaster+xml");
      if (!isTheme && !isMasterLayout) continue;
      const name = missing(owner, rel.target);
      if (!name) continue;
      if (isTheme) pkg.addPart(name, THEME_TYPE, encode(DEFAULT_THEME_XML));
      else {
        pkg.addPart(name, LAYOUT_TYPE, encode(BLANK_LAYOUT_XML));
        pkg.setRels(name, {
          items: [
            {
              id: "rId1",
              type: REL_TYPES.slideMaster,
              target: relativeTarget(name, owner),
              targetMode: "Internal",
            },
          ],
        });
      }
      changed = true;
    }
  }
  // Slides whose layout is still missing take one their master has.
  const firstLayout = (() => {
    for (const { owner, rels } of owners) {
      if (!pkg.getPart(owner)?.contentType.endsWith("slideMaster+xml"))
        continue;
      for (const rel of rels.items)
        if (rel.type === REL_TYPES.slideLayout) {
          const name = targetOf(owner, rel.target);
          if (name && pkg.getPart(name)) return name;
        }
    }
    return null;
  })();
  for (const { owner, rels } of owners) {
    if (!pkg.getPart(owner)?.contentType.endsWith("slide+xml")) continue;
    const rel = rels.items.find((r) => r.type === REL_TYPES.slideLayout);
    if (!rel || !missing(owner, rel.target) || !firstLayout) continue;
    rel.target = relativeTarget(owner, firstLayout);
    pkg.setRels(owner, rels);
    changed = true;
  }
  if (changed) pres._slidesCache = null;
  return changed;
};
