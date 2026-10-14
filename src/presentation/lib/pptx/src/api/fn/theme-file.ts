// Theme files: a slide master with its layouts, theme and pictures saved on
// their own as an Office theme package (.thmx), and a master brought into a
// presentation from such a file or from another presentation (.pptx/.potx).
//
// A theme package's main part is a theme manager that points to the theme;
// the theme points to its slide master, which lists its layouts and points
// back to the theme, as a master does in a presentation. All parts live
// under /theme/.

import {
  type PartName,
  type Relationship,
  emptyRels,
  partName,
  resolveTarget,
} from "../../internal/opc/index.ts";
import { OpcPackage } from "../../internal/parts/index.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import {
  NS,
  firstChildElement,
  getAttrValue,
  parseXml,
  qname,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  type PresentationData,
} from "../_internal-symbols.ts";
import { decode, encode } from "./_helpers.ts";
import {
  _registerSlideMaster,
  addSlideMaster,
  getSlideMasters,
} from "./slide-masters.ts";
import { setSlideMasterThemeXml } from "./theme-design.ts";

const CT = {
  master:
    "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
  layout:
    "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
  themeManager:
    "application/vnd.openxmlformats-officedocument.themeManager+xml",
};
const OFFICE_DOCUMENT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const THUMBNAIL =
  "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

const relTarget = (from: string, to: string): string => {
  const a = from.split("/").slice(1, -1);
  const b = to.split("/").slice(1);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
};

const targetOf = (from: PartName, rel: Relationship): PartName =>
  rel.target.startsWith("/")
    ? partName(rel.target)
    : resolveTarget(from, rel.target);

/**
 * Every part a master depends on: the master, its layouts, its theme and
 * whatever they use (pictures, fonts…), in a stable order with the master
 * first. Relationships from the theme back to a master are not followed.
 */
const masterGraph = (pkg: OpcPackage, master: PartName): PartName[] => {
  const seen = new Map<string, PartName>();
  const visit = (name: PartName): void => {
    if (seen.has(name.toLowerCase())) return;
    const part = pkg.getPart(name);
    if (!part) throw new Error(`theme file: missing part ${name}`);
    seen.set(name.toLowerCase(), part.name);
    for (const rel of pkg.getRels(part.name)?.items ?? []) {
      if (rel.targetMode !== "Internal") continue;
      if (part.contentType === CT.theme && rel.type === REL_TYPES.slideMaster)
        continue;
      if (
        rel.type === REL_TYPES.slide ||
        rel.type === REL_TYPES.notesSlide ||
        rel.type === REL_TYPES.notesMaster
      )
        continue;
      visit(targetOf(part.name, rel));
    }
  };
  visit(master);
  return [...seen.values()];
};

/** Copies `names` from `source` into `target` under the names `rename` gives. */
const copyParts = (
  source: OpcPackage,
  target: OpcPackage,
  names: readonly PartName[],
  rename: Map<string, string>,
): void => {
  for (const name of names) {
    const part = source.getPart(name)!;
    const to = partName(rename.get(name.toLowerCase())!);
    target.addPart(to, part.contentType, part.data.slice());
  }
  for (const name of names) {
    const rels = source.getRels(name);
    if (!rels) continue;
    const to = rename.get(name.toLowerCase())!;
    const items = rels.items
      .map((rel) => {
        if (rel.targetMode !== "Internal") return { ...rel };
        const dest = rename.get(targetOf(name, rel).toLowerCase());
        return dest ? { ...rel, target: relTarget(to, dest) } : null;
      })
      .filter((r): r is Relationship => r !== null);
    target.setRels(partName(to), { items });
  }
};

/**
 * The slide master `pkg` offers: the first master of a presentation, or the
 * master a theme package's theme points to. `null` when there is none.
 */
const findMaster = (pkg: OpcPackage): PartName | null => {
  const main = pkg
    .rootRels()
    ?.items.find(
      (r) => r.type === OFFICE_DOCUMENT && r.targetMode === "Internal",
    );
  const mainName = main ? resolveTarget(partName("/"), main.target) : null;
  const mainPart = mainName ? pkg.getPart(mainName) : null;
  if (mainPart && mainName) {
    const rels = pkg.getRels(mainName)?.items ?? [];
    if (mainPart.contentType === CT.themeManager) {
      const theme = rels.find((r) => r.type === REL_TYPES.theme);
      const themeName = theme && targetOf(mainName, theme);
      const toMaster = themeName
        ? pkg
            .getRels(themeName)
            ?.items.find((r) => r.type === REL_TYPES.slideMaster)
        : null;
      if (themeName && toMaster) return targetOf(themeName, toMaster);
    } else {
      // A presentation: its first listed master.
      const root = parseXml(decode(mainPart.data)).root;
      const list = firstChildElement(
        root,
        qname("p", "sldMasterIdLst", NS.pml),
      );
      for (const entry of list?.children ?? []) {
        if (entry.kind !== "element") continue;
        const rId = getAttrValue(entry, qname("r", "id", NS.officeDocRels));
        const rel = rels.find((r) => r.id === rId);
        if (rel) return targetOf(mainName, rel);
      }
    }
  }
  const any = pkg.parts
    .filter((p) => p.contentType === CT.master)
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  return any?.name ?? null;
};

const firstTheme = (pkg: OpcPackage): PartName | null =>
  pkg.parts
    .filter((p) => p.contentType === CT.theme)
    .sort((a, b) => a.name.localeCompare(b.name))[0]?.name ?? null;

/**
 * Brings the slide master of a theme file (.thmx) or presentation
 * (.pptx/.potx) into `pres`, with all its layouts, its theme and the pictures
 * they use, after `options.after` (or at the end). A theme file with a theme
 * but no master gets the built-in master and layouts in that theme. Returns
 * the new master's part name.
 */
export const importSlideMasterFile = (
  pres: PresentationData,
  bytes: Uint8Array,
  options: { after?: string | null } = {},
): string => {
  let source: OpcPackage;
  try {
    source = OpcPackage.load(bytes);
  } catch {
    throw new Error("This file is not a theme or a presentation.");
  }
  const master = findMaster(source);
  if (!master) {
    const theme = firstTheme(source);
    if (!theme) throw new Error("This file has no theme in it.");
    const added = addSlideMaster(pres, { after: options.after ?? null });
    setSlideMasterThemeXml(pres, added, decode(source.getPart(theme)!.data));
    return added;
  }
  const target = pres[INTERNAL_PACKAGE];
  const names = masterGraph(source, master);
  const taken = new Set(target.parts.map((p) => p.name.toLowerCase()));
  const free = (make: (n: number) => string, start = 1): string => {
    let n = start;
    while (taken.has(make(n).toLowerCase())) n++;
    const name = make(n);
    taken.add(name.toLowerCase());
    return name;
  };
  const rename = new Map<string, string>();
  for (const name of names) {
    const type = source.getPart(name)!.contentType;
    let to: string;
    if (type === CT.master)
      to = free((n) => `/ppt/slideMasters/slideMaster${n}.xml`);
    else if (type === CT.layout)
      to = free((n) => `/ppt/slideLayouts/slideLayout${n}.xml`);
    else if (type === CT.theme) to = free((n) => `/ppt/theme/theme${n}.xml`);
    else {
      // Other parts keep their folder under /ppt/ and their file name, with
      // a number added when the name is taken.
      const rest = name.replace(/^\/(ppt|theme)\//i, "/");
      const m = /^(.*?)(\d*)(\.[^./]*)?$/.exec(rest)!;
      const stem = m[1]!,
        ext = m[3] ?? "";
      to = taken.has(`/ppt${rest}`.toLowerCase())
        ? free((n) => `/ppt${stem}${n}${ext}`, 1)
        : free(() => `/ppt${rest}`);
    }
    rename.set(name.toLowerCase(), to);
  }
  copyParts(source, target, names, rename);
  const copied = rename.get(master.toLowerCase())!;
  _registerSlideMaster(pres, copied, options.after ?? null);
  return copied;
};

/**
 * The slide master `masterPartName`, its layouts, its theme and the
 * pictures they use, as an Office theme package (.thmx). `thumbnail` (JPEG
 * or PNG bytes), when given, is the picture file browsers show for it.
 */
export const exportThemeFile = (
  pres: PresentationData,
  masterPartName: string,
  options: { thumbnail?: Uint8Array } = {},
): Uint8Array => {
  const source = pres[INTERNAL_PACKAGE];
  const master = partName(masterPartName);
  if (!getSlideMasters(pres).some((m) => m.partName === master))
    throw new Error(`exportThemeFile: no master ${masterPartName}`);
  const names = masterGraph(source, master);
  const themeName = names.find(
    (n) => source.getPart(n)!.contentType === CT.theme,
  );
  if (!themeName) throw new Error("exportThemeFile: the master has no theme");
  const out = OpcPackage.empty();
  const taken = new Set<string>();
  const rename = new Map<string, string>();
  let layouts = 0;
  for (const name of names) {
    const type = source.getPart(name)!.contentType;
    let to =
      type === CT.master
        ? "/theme/slideMasters/slideMaster1.xml"
        : type === CT.layout
          ? `/theme/slideLayouts/slideLayout${++layouts}.xml`
          : type === CT.theme
            ? name === themeName
              ? "/theme/theme/theme1.xml"
              : `/theme/theme/theme${taken.size + 2}.xml`
            : name.replace(/^\/ppt\//i, "/theme/");
    if (!to.startsWith("/theme/")) to = `/theme${to}`;
    taken.add(to.toLowerCase());
    rename.set(name.toLowerCase(), to);
  }
  copyParts(source, out, names, rename);
  const theme = rename.get(themeName.toLowerCase())!;
  const toMaster = {
    id: "rId1",
    type: REL_TYPES.slideMaster,
    target: relTarget(theme, "/theme/slideMasters/slideMaster1.xml"),
    targetMode: "Internal" as const,
  };
  const themeRels = out.getRels(partName(theme)) ?? emptyRels();
  themeRels.items = [
    ...themeRels.items.filter((r) => r.type !== REL_TYPES.slideMaster),
    {
      ...toMaster,
      id: `rId${themeRels.items.length + 1}`,
    },
  ];
  out.setRels(partName(theme), themeRels);
  const managerName = "/theme/theme/themeManager.xml";
  out.addPart(
    partName(managerName),
    CT.themeManager,
    encode(
      `${XML_DECL}<a:themeManager xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>`,
    ),
  );
  out.setRels(partName(managerName), {
    items: [
      {
        id: "rId1",
        type: REL_TYPES.theme,
        target: relTarget(managerName, theme),
        targetMode: "Internal",
      },
    ],
  });
  const root = {
    items: [
      {
        id: "rId1",
        type: OFFICE_DOCUMENT,
        target: managerName.slice(1),
        targetMode: "Internal" as const,
      },
    ] as Relationship[],
  };
  if (options.thumbnail?.length) {
    const png = options.thumbnail[0] === 0x89;
    const name = `/docProps/thumbnail.${png ? "png" : "jpeg"}`;
    out.addPart(
      partName(name),
      png ? "image/png" : "image/jpeg",
      options.thumbnail,
    );
    root.items.push({
      id: "rId2",
      type: THUMBNAIL,
      target: name.slice(1),
      targetMode: "Internal",
    });
  }
  out.setRootRels(root);
  return out.save();
};
