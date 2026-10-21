// Video and audio on slides.
//
// A media object is a `<p:pic>` whose picture is the poster frame (or, for
// sound, a speaker drawing) and whose `p:nvPr` names the media part twice:
// `a:videoFile`/`a:audioFile` (`r:link`, the ISO relationship) and the
// `p14:media` extension (`r:embed`, the embedded-media relationship), which
// also carries trim, fades and bookmarks. How it plays in a slide show —
// volume, looping, hiding, full screen, playing across slides, and whether it
// starts with the click sequence, automatically, or when clicked — lives in
// the slide's `p:timing` as a media node and a "media call" effect, the
// structures desktop editors write.

import type { Emu } from "../units.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import {
  NS,
  allChildElements,
  firstChildElement,
  getAttrValue,
  qname,
  type XmlElement,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  SHAPE_ELEMENT,
  SHAPE_SLIDE,
  SHAPE_SNAPSHOT,
  SLIDE_DOCUMENT,
  type SlideData,
  type SlideShapeData,
} from "../_internal-symbols.ts";
import {
  appendAndReturnNewShape,
  commitAndRefresh,
  nextShapeId,
} from "./_helpers.ts";
import {
  addPackageMediaPart,
  addSlideRelationship,
  slideRelationshipPart,
} from "./object-data.ts";
import { addSlideVectorPicture } from "./vector-picture.ts";
import {
  escapeXmlAttr,
  findElement,
  isNamed,
  xmlFragment,
} from "./xml-fragment.ts";

export type MediaKind = "video" | "audio";
export type MediaStart = "inClickSequence" | "automatically" | "whenClicked";

export interface MediaBookmark {
  readonly name: string;
  /** Milliseconds from the start of the (untrimmed) media. */
  readonly time: number;
}

export interface MediaOptions {
  /** Milliseconds trimmed from the start and the end. */
  readonly trimStart: number;
  readonly trimEnd: number;
  /** Fade durations in milliseconds. */
  readonly fadeIn: number;
  readonly fadeOut: number;
  /** 0–1. */
  readonly volume: number;
  readonly muted: boolean;
  readonly start: MediaStart;
  readonly fullScreen: boolean;
  readonly hideWhileNotPlaying: boolean;
  readonly loop: boolean;
  readonly rewind: boolean;
  readonly playAcrossSlides: boolean;
  readonly bookmarks: ReadonlyArray<MediaBookmark>;
}

export const DEFAULT_MEDIA_OPTIONS: MediaOptions = {
  trimStart: 0,
  trimEnd: 0,
  fadeIn: 0,
  fadeOut: 0,
  volume: 1,
  muted: false,
  start: "inClickSequence",
  fullScreen: false,
  hideWhileNotPlaying: false,
  loop: false,
  rewind: false,
  playAcrossSlides: false,
  bookmarks: [],
};

export interface SlideMedia {
  readonly kind: MediaKind;
  readonly partName: string;
  readonly contentType: string;
  readonly data: Uint8Array;
  readonly options: MediaOptions;
}

const P14_MEDIA_URI = "{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}";
const ATTR_ID = qname("", "id", "");
const attrOf = (e: XmlElement | null, local: string): string | null =>
  e ? getAttrValue(e, qname("", local, "")) : null;

const nvPrOf = (shape: SlideShapeData): XmlElement | null => {
  if (shape[SHAPE_SNAPSHOT].kind !== "picture") return null;
  const nv = firstChildElement(
    shape[SHAPE_ELEMENT],
    qname("p", "nvPicPr", NS.pml),
  );
  return nv && firstChildElement(nv, qname("p", "nvPr", NS.pml));
};

const mediaRefs = (nvPr: XmlElement) => {
  const video = firstChildElement(nvPr, qname("a", "videoFile", NS.dml));
  const audio = firstChildElement(nvPr, qname("a", "audioFile", NS.dml));
  const file = video ?? audio;
  const p14 = findElement(nvPr, (e) => isNamed(e, NS.p14, "media"));
  const embed = p14 && getAttrValue(p14, qname("r", "embed", NS.officeDocRels));
  const link = file && getAttrValue(file, qname("r", "link", NS.officeDocRels));
  return {
    kind: video ? ("video" as const) : audio ? ("audio" as const) : null,
    p14,
    embed,
    link,
  };
};

const ms = (value: string | null): number => {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/** Is this shape a video or audio object? */
export const getShapeMediaKind = (shape: SlideShapeData): MediaKind | null => {
  const nvPr = nvPrOf(shape);
  return nvPr ? mediaRefs(nvPr).kind : null;
};

/** The media behind a video or audio object, with its playback options. */
export const getShapeMedia = (shape: SlideShapeData): SlideMedia | null => {
  const nvPr = nvPrOf(shape);
  if (!nvPr) return null;
  const refs = mediaRefs(nvPr);
  if (!refs.kind) return null;
  const slide = shape[SHAPE_SLIDE];
  const part =
    slideRelationshipPart(slide, refs.embed) ??
    slideRelationshipPart(slide, refs.link);
  if (!part) return null;
  return {
    kind: refs.kind,
    partName: part.name,
    contentType: part.contentType,
    data: part.data,
    options: readOptions(shape, refs.p14, refs.kind),
  };
};

const readOptions = (
  shape: SlideShapeData,
  p14: XmlElement | null,
  kind: MediaKind,
): MediaOptions => {
  const trim = p14 && firstChildElement(p14, qname("p14", "trim", NS.p14));
  const fade = p14 && firstChildElement(p14, qname("p14", "fade", NS.p14));
  const marks = p14 && firstChildElement(p14, qname("p14", "bmkLst", NS.p14));
  const bookmarks: MediaBookmark[] = [];
  for (const b of marks?.children ?? [])
    if (b.kind === "element" && b.name.localName === "bmk")
      bookmarks.push({
        name: attrOf(b, "name") ?? "",
        time: ms(attrOf(b, "time")),
      });
  const timing = readTiming(shape[SHAPE_SLIDE], shape[SHAPE_SNAPSHOT].id, kind);
  return {
    ...DEFAULT_MEDIA_OPTIONS,
    trimStart: ms(attrOf(trim, "st")),
    trimEnd: ms(attrOf(trim, "end")),
    fadeIn: ms(attrOf(fade, "in")),
    fadeOut: ms(attrOf(fade, "out")),
    bookmarks,
    ...timing,
  };
};

// ---------------------------------------------------------------------------
// Authoring

const MEDIA_EXTENSIONS: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
};

/**
 * Adds a video or audio object. `poster` is the PNG shown while it is not
 * playing (a frame of the video, or a speaker drawing for sound); `posterSvg`
 * optionally gives a vector version of it.
 */
export const addSlideMedia = (
  slide: SlideData,
  media: {
    kind: MediaKind;
    data: Uint8Array;
    contentType: string;
    extension?: string;
    poster: Uint8Array;
    posterSvg?: Uint8Array | null;
  },
  opts: { x: Emu; y: Emu; w: Emu; h: Emu; name?: string },
  options: Partial<MediaOptions> & { durationMs?: number } = {},
): SlideShapeData => {
  const extension =
    media.extension ?? MEDIA_EXTENSIONS[media.contentType] ?? "bin";
  const part = addPackageMediaPart(slide[INTERNAL_PACKAGE], media.data, {
    stem: "media",
    extension,
    contentType: media.contentType,
  });
  const linkId = addSlideRelationship(
    slide,
    media.kind === "video" ? REL_TYPES.video : REL_TYPES.audio,
    part,
  );
  // A relationship of another type to the same part: the ids differ even
  // though the target is the same.
  const embedId = addSlideRelationship(slide, REL_TYPES.media, part);
  const id = nextShapeId(slide);
  const shape = addSlideVectorPicture(
    slide,
    { png: media.poster, svg: media.posterSvg ?? null },
    {
      ...opts,
      name: opts.name ?? `${media.kind === "video" ? "Video" : "Audio"} ${id}`,
    },
  );
  const element = shape[SHAPE_ELEMENT];
  const nv = firstChildElement(element, qname("p", "nvPicPr", NS.pml))!;
  const cNvPr = firstChildElement(nv, qname("p", "cNvPr", NS.pml))!;
  // Desktop editors mark a media picture's click as "media", which plays it.
  cNvPr.children.unshift(
    xmlFragment(`<a:hlinkClick r:id="" action="ppaction://media"/>`),
  );
  const nvPr = firstChildElement(nv, qname("p", "nvPr", NS.pml))!;
  nvPr.children = [
    xmlFragment(`<a:${media.kind}File r:link="${linkId}"/>`),
    xmlFragment(
      `<p:extLst><p:ext uri="${P14_MEDIA_URI}"><p14:media r:embed="${embedId}"/></p:ext></p:extLst>`,
    ),
  ];
  commitAndRefresh(shape);
  setShapeMediaOptions(shape, { ...DEFAULT_MEDIA_OPTIONS, ...options });
  return shape;
};

/** Writes playback options for a media object (all of them; merge first). */
export const setShapeMediaOptions = (
  shape: SlideShapeData,
  options: Partial<MediaOptions> & { durationMs?: number },
): void => {
  const nvPr = nvPrOf(shape);
  const refs = nvPr && mediaRefs(nvPr);
  if (!nvPr || !refs?.kind)
    throw new Error("setShapeMediaOptions: not a media object");
  const o: MediaOptions = { ...DEFAULT_MEDIA_OPTIONS, ...options };
  if (refs.p14) {
    const p14 = refs.p14;
    p14.children = p14.children.filter(
      (c) =>
        !(
          c.kind === "element" &&
          c.name.namespaceURI === NS.p14 &&
          ["trim", "fade", "bmkLst"].includes(c.name.localName)
        ),
    );
    const extra: XmlElement[] = [];
    if (o.trimStart || o.trimEnd)
      extra.push(
        xmlFragment(
          `<p14:trim${o.trimStart ? ` st="${o.trimStart}"` : ""}${o.trimEnd ? ` end="${o.trimEnd}"` : ""}/>`,
        ),
      );
    if (o.fadeIn || o.fadeOut)
      extra.push(
        xmlFragment(
          `<p14:fade${o.fadeIn ? ` in="${o.fadeIn}"` : ""}${o.fadeOut ? ` out="${o.fadeOut}"` : ""}/>`,
        ),
      );
    if (o.bookmarks.length)
      extra.push(
        xmlFragment(
          `<p14:bmkLst>${o.bookmarks
            .map(
              (b) =>
                `<p14:bmk name="${escapeXmlAttr(b.name)}" time="${Math.max(0, Math.round(b.time))}"/>`,
            )
            .join("")}</p14:bmkLst>`,
        ),
      );
    // trim, fade and bookmarks precede any extension list of their own.
    const at = p14.children.findIndex(
      (c) => c.kind === "element" && c.name.localName === "extLst",
    );
    p14.children.splice(at < 0 ? p14.children.length : at, 0, ...extra);
  }
  writeTiming(
    shape[SHAPE_SLIDE],
    shape[SHAPE_SNAPSHOT].id,
    refs.kind,
    o,
    options.durationMs,
  );
  commitAndRefresh(shape);
};

// ---------------------------------------------------------------------------
// Timing

const timingOf = (slide: SlideData): XmlElement | null =>
  firstChildElement(slide[SLIDE_DOCUMENT].root, qname("p", "timing", NS.pml));

const targets = (e: XmlElement, spid: number): boolean =>
  !!findElement(
    e,
    (x) => isNamed(x, NS.pml, "spTgt") && attrOf(x, "spid") === String(spid),
  );

const rootList = (timing: XmlElement | null): XmlElement | null => {
  if (!timing) return null;
  const root = findElement(
    timing,
    (e) => isNamed(e, NS.pml, "cTn") && attrOf(e, "nodeType") === "tmRoot",
  );
  return root && firstChildElement(root, qname("p", "childTnLst", NS.pml));
};

const mediaNodeFor = (
  list: XmlElement | null,
  spid: number,
): XmlElement | null => {
  for (const c of list?.children ?? [])
    if (
      c.kind === "element" &&
      c.name.namespaceURI === NS.pml &&
      (c.name.localName === "video" || c.name.localName === "audio") &&
      targets(c, spid)
    )
      return c;
  return null;
};

const isMediaCall = (e: XmlElement, spid: number) =>
  isNamed(e, NS.pml, "cTn") &&
  attrOf(e, "presetClass") === "mediacall" &&
  targets(e, spid);

// Does the step of the main sequence holding `call` start as the slide
// opens? A call With or After Previous in a later step plays at that step's
// click, in the click sequence, not as the slide opens.
const startsWithSlide = (timing: XmlElement, call: XmlElement): boolean => {
  const main = findElement(
    timing,
    (e) => isNamed(e, NS.pml, "cTn") && attrOf(e, "nodeType") === "mainSeq",
  );
  const steps =
    main && firstChildElement(main, qname("p", "childTnLst", NS.pml));
  const step = steps?.children.find(
    (c): c is XmlElement =>
      c.kind === "element" && !!findElement(c, (e) => e === call),
  );
  const stepTn = step && firstChildElement(step, qname("p", "cTn", NS.pml));
  const conditions =
    stepTn && firstChildElement(stepTn, qname("p", "stCondLst", NS.pml));
  if (!conditions) return true;
  const conds = allChildElements(conditions, qname("p", "cond", NS.pml));
  return (
    conds.some((c) => attrOf(c, "evt") === "onBegin") ||
    !conds.some((c) => attrOf(c, "delay") === "indefinite")
  );
};

const readTiming = (
  slide: SlideData,
  spid: number,
  kind: MediaKind,
): Partial<MediaOptions> => {
  const timing = timingOf(slide);
  const list = rootList(timing);
  const node = mediaNodeFor(list, spid);
  const out: {
    -readonly [K in keyof MediaOptions]?: MediaOptions[K];
  } = {};
  if (node) {
    const media = firstChildElement(node, qname("p", "cMediaNode", NS.pml));
    const cTn = media && firstChildElement(media, qname("p", "cTn", NS.pml));
    const vol = attrOf(media, "vol");
    if (vol !== null)
      out.volume = Math.max(0, Math.min(1, Number(vol) / 100000));
    out.muted = ["1", "true"].includes(attrOf(media, "mute") ?? "");
    out.hideWhileNotPlaying = ["0", "false"].includes(
      attrOf(media, "showWhenStopped") ?? "",
    );
    out.playAcrossSlides =
      kind === "audio" && Number(attrOf(media, "numSld") ?? "1") > 1;
    out.loop = attrOf(cTn, "repeatCount") === "indefinite";
    out.rewind = attrOf(cTn, "fill") === "remove";
    out.fullScreen = ["1", "true"].includes(attrOf(node, "fullScrn") ?? "");
  }
  const call = timing && findElement(timing, (e) => isMediaCall(e, spid));
  if (call) {
    const interactive = !!findElement(
      timing!,
      (e) =>
        isNamed(e, NS.pml, "cTn") &&
        attrOf(e, "nodeType") === "interactiveSeq" &&
        !!findElement(e, (x) => isMediaCall(x, spid)),
    );
    const nodeType = attrOf(call, "nodeType");
    out.start = interactive
      ? "whenClicked"
      : nodeType === "clickEffect" || !startsWithSlide(timing!, call)
        ? "inClickSequence"
        : "automatically";
  } else if (node) out.start = "whenClicked";
  return out;
};

const maxId = (root: XmlElement): number => {
  let max = 0;
  findElement(root, (e) => {
    if (isNamed(e, NS.pml, "cTn")) {
      const n = Number.parseInt(getAttrValue(e, ATTR_ID) ?? "", 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return false;
  });
  return max;
};

// Removes `node` and then each ancestor it leaves without element children,
// stopping at `stop`.
const removePruning = (
  root: XmlElement,
  node: XmlElement,
  stop: XmlElement,
) => {
  const path: XmlElement[] = [];
  const walk = (e: XmlElement): boolean => {
    if (e === node) return true;
    for (const c of e.children)
      if (c.kind === "element" && walk(c)) {
        path.push(e);
        return true;
      }
    return false;
  };
  if (!walk(root)) return;
  let child: XmlElement = node;
  for (const parent of path) {
    parent.children = parent.children.filter((c) => c !== child);
    if (parent === stop) return;
    if (
      parent.name.localName === "childTnLst" &&
      parent.children.some((c) => c.kind === "element")
    )
      return;
    child = parent;
  }
};

// The enclosing `p:par` of a media-call effect, found from the effect cTn.
const parentPar = (root: XmlElement, cTn: XmlElement): XmlElement | null => {
  let found: XmlElement | null = null;
  const walk = (e: XmlElement): void => {
    for (const c of e.children)
      if (c.kind === "element") {
        if (c === cTn && isNamed(e, NS.pml, "par")) found = e;
        else walk(c);
      }
  };
  walk(root);
  return found;
};

const ensureTiming = (slide: SlideData): XmlElement => {
  const existing = timingOf(slide);
  if (existing) {
    if (!rootList(existing)) {
      existing.children = existing.children.filter(
        (c) => !(c.kind === "element" && c.name.localName === "tnLst"),
      );
      existing.children.unshift(
        xmlFragment(
          `<p:tnLst><p:par><p:cTn id="${maxId(existing) + 1}" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst/></p:cTn></p:par></p:tnLst>`,
        ),
      );
    }
    return existing;
  }
  const timing = xmlFragment(
    `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst/></p:cTn></p:par></p:tnLst></p:timing>`,
  );
  const root = slide[SLIDE_DOCUMENT].root;
  // Before the slide's extension list, after cSld / clrMapOvr / transition.
  const at = root.children.findIndex(
    (c) => c.kind === "element" && c.name.localName === "extLst",
  );
  root.children.splice(at < 0 ? root.children.length : at, 0, timing);
  return timing;
};

const ensureMainSequence = (timing: XmlElement, list: XmlElement) => {
  const main = findElement(
    list,
    (e) => isNamed(e, NS.pml, "cTn") && attrOf(e, "nodeType") === "mainSeq",
  );
  if (main) return main;
  let id = maxId(timing);
  const seq = xmlFragment(
    `<p:seq concurrent="1" nextAc="seek"><p:cTn id="${++id}" dur="indefinite" nodeType="mainSeq"><p:childTnLst/></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>`,
  );
  list.children.unshift(seq);
  return firstChildElement(seq, qname("p", "cTn", NS.pml))!;
};

const writeTiming = (
  slide: SlideData,
  spid: number,
  kind: MediaKind,
  o: MediaOptions,
  durationMs: number | undefined,
): void => {
  const timing = ensureTiming(slide);
  const list = rootList(timing)!;
  // Clear what this object had: its media node, its effects, its trigger.
  const old = mediaNodeFor(list, spid);
  if (old) list.children = list.children.filter((c) => c !== old);
  for (;;) {
    const call = findElement(list, (e) => isMediaCall(e, spid));
    if (!call) break;
    const interactive = list.children.find(
      (c): c is XmlElement =>
        c.kind === "element" &&
        isNamed(c, NS.pml, "seq") &&
        !!findElement(
          c,
          (e) =>
            isNamed(e, NS.pml, "cTn") &&
            attrOf(e, "nodeType") === "interactiveSeq",
        ) &&
        !!findElement(c, (e) => e === call),
    );
    if (interactive) {
      list.children = list.children.filter((c) => c !== interactive);
      continue;
    }
    const par = parentPar(list, call);
    const main = findElement(
      list,
      (e) => isNamed(e, NS.pml, "cTn") && attrOf(e, "nodeType") === "mainSeq",
    );
    const stop = main
      ? firstChildElement(main, qname("p", "childTnLst", NS.pml))!
      : list;
    if (par) removePruning(list, par, stop);
    else break;
  }
  // A main sequence this object's effect was the last step of goes too: an
  // empty one is invalid, and desktop readers offer to repair the file.
  list.children = list.children.filter((c) => {
    if (c.kind !== "element" || !isNamed(c, NS.pml, "seq")) return true;
    const seqTn = firstChildElement(c, qname("p", "cTn", NS.pml));
    if (attrOf(seqTn, "nodeType") !== "mainSeq") return true;
    const steps =
      seqTn && firstChildElement(seqTn, qname("p", "childTnLst", NS.pml));
    return !!steps?.children.some((x) => x.kind === "element");
  });
  let id = maxId(timing);
  const seconds = (o.trimStart / 1000).toFixed(1);
  const dur = Math.max(1, Math.round(durationMs ?? 0)) || 1;
  const call = (nodeType: string, cmd = `playFrom(${seconds})`) =>
    `<p:par><p:cTn id="${++id}" presetID="${cmd === "togglePause" ? 2 : 1}" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="${nodeType}"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:cmd type="call" cmd="${cmd}"><p:cBhvr><p:cTn id="${++id}" dur="${dur}" fill="hold"/><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cBhvr></p:cmd></p:childTnLst></p:cTn></p:par>`;
  if (o.start === "whenClicked") {
    const seqId = ++id;
    list.children.push(
      xmlFragment(
        `<p:seq concurrent="1" nextAc="seek"><p:cTn id="${seqId}" restart="whenNotActive" fill="hold" evtFilter="cancelBubble" nodeType="interactiveSeq"><p:stCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cond></p:stCondLst><p:endSync evt="end" delay="0"><p:rtn val="all"/></p:endSync><p:childTnLst><p:par><p:cTn id="${++id}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="${++id}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${call("clickEffect", "togglePause")}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:nextCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cond></p:nextCondLst></p:seq>`,
      ),
    );
  } else {
    const main = ensureMainSequence(timing, list);
    id = maxId(timing);
    const steps = firstChildElement(main, qname("p", "childTnLst", NS.pml))!;
    const auto = o.start === "automatically";
    const mainId = attrOf(main, "id");
    const group = xmlFragment(
      `<p:par><p:cTn id="${++id}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/>${auto ? `<p:cond evt="onBegin" delay="0"><p:tn val="${mainId}"/></p:cond>` : ""}</p:stCondLst><p:childTnLst><p:par><p:cTn id="${++id}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${call(auto ? "afterEffect" : "clickEffect")}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`,
    );
    // Playing automatically happens as the slide opens: first in the sequence.
    if (auto) steps.children.unshift(group);
    else steps.children.push(group);
  }
  const vol = Math.round(Math.max(0, Math.min(1, o.volume)) * 100000);
  const node = xmlFragment(
    `<p:${kind}${kind === "video" && o.fullScreen ? ` fullScrn="1"` : ""}><p:cMediaNode vol="${vol}"${o.muted ? ` mute="1"` : ""}${kind === "audio" && o.playAcrossSlides ? ` numSld="999"` : ""}${o.hideWhileNotPlaying ? ` showWhenStopped="0"` : ""}><p:cTn id="${++id}"${o.loop ? ` repeatCount="indefinite"` : ""} fill="${o.rewind ? "remove" : "hold"}" display="${o.hideWhileNotPlaying ? 0 : 1}"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst>${o.playAcrossSlides && kind === "audio" ? `<p:endCondLst><p:cond evt="onStopAudio" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:endCondLst>` : ""}</p:cTn><p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl></p:cMediaNode></p:${kind}>`,
  );
  list.children.push(node);
  // The main sequence, then media nodes, then click triggers, as written by
  // desktop editors.
  const rank = (c: (typeof list.children)[number]) => {
    if (c.kind !== "element") return 1;
    if (c.name.localName === "video" || c.name.localName === "audio") return 1;
    const kind = findElement(c, (e) => isNamed(e, NS.pml, "cTn"));
    return attrOf(kind, "nodeType") === "interactiveSeq" ? 2 : 0;
  };
  list.children = list.children
    .map((c, i) => [c, i] as const)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(([c]) => c);
};
