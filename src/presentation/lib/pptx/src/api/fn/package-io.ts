// Presentation I/O: load, save, and create.

import type { ContentTypes } from "../../internal/opc/index.ts";
import {
  type BlankDeckAspect,
  OpcPackage,
  type Part,
  buildBlankDeck,
} from "../../internal/parts/index.ts";
import {
  INTERNAL_PACKAGE,
  FIELD_DATE,
  type PresentationData,
} from "../_internal-symbols.ts";

/**
 * Anything that can be turned into a `Uint8Array` of PPTX bytes:
 *
 *   - `Uint8Array` — used as-is.
 *   - `ArrayBuffer` — wrapped without copying.
 *   - `Blob` or `File` — read via `arrayBuffer()`.
 */
export type PresentationInput = Uint8Array | ArrayBuffer | Blob;

const normalize = async (input: PresentationInput): Promise<Uint8Array> => {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  throw new TypeError(
    "loadPresentation: expected Uint8Array | ArrayBuffer | Blob",
  );
};

/**
 * Loads an existing `.pptx` and returns a `PresentationData` value.
 *
 * `snapshot`: `input` is bytes `savePresentation` returned, unchanged
 * since (an undo history keeps such snapshots). Parts the decks in memory
 * still hold are then shared rather than unpacked again, and their
 * compression is reused on the next save. Parts are never changed in
 * place, so sharing them is safe.
 */
export const loadPresentation = async (
  input: PresentationInput,
  options: { snapshot?: boolean } = {},
): Promise<PresentationData> => {
  const bytes = await normalize(input);
  const pkg = OpcPackage.load(bytes, options);
  return {
    [INTERNAL_PACKAGE]: pkg,
    [FIELD_DATE]: Date.now(),
    _slidesCache: null,
  };
};

/** Slide-canvas aspect ratio for {@link createPresentation}. */
export type PresentationSize = "16:9" | "4:3";

/**
 * Creates a fresh, immediately-authorable `PresentationData`.
 *
 * The returned deck carries a slide master, a default theme, and three
 * slide layouts — `'Blank'`, `'Title Slide'`, and `'Title and Content'` —
 * but no slides yet. Add one with {@link addSlide} (or the
 * `addBlankSlide` / `addTitleSlide` / `addContentSlide` helpers), then
 * `savePresentation` to emit a `.pptx` that opens cleanly in other
 * presentation apps.
 *
 * @param options.size Slide aspect ratio. `'16:9'` (12192000×6858000 EMU,
 *   the common widescreen default) or `'4:3'` (9144000×6858000). Defaults to
 *   `'16:9'`.
 */
export const createPresentation = (
  options: { size?: PresentationSize } = {},
): PresentationData => {
  const aspect: BlankDeckAspect = options.size ?? "16:9";
  const pkg = buildBlankDeck(aspect);
  return {
    [INTERNAL_PACKAGE]: pkg,
    [FIELD_DATE]: Date.now(),
    _slidesCache: null,
  };
};

/**
 * Serializes a presentation back to PPTX bytes.
 */
export const savePresentation = (
  pres: PresentationData,
): Promise<Uint8Array> => {
  return Promise.resolve(pres[INTERNAL_PACKAGE].save());
};

/**
 * A presentation as it stood when {@link snapshotPresentation} took it: its
 * parts, in order, with the bytes each held then. The bytes are the ones the
 * presentation itself holds (parts are replaced, never changed in place), so
 * a snapshot costs only what later edits replace, and an undo history of
 * snapshots holds each version of a part once.
 */
export interface PresentationSnapshot {
  readonly parts: ReadonlyArray<Readonly<Part>>;
  readonly contentTypes: Readonly<ContentTypes>;
}

/** Takes a {@link PresentationSnapshot} of `pres`, without serializing it. */
export const snapshotPresentation = (
  pres: PresentationData,
): PresentationSnapshot => {
  const pkg = pres[INTERNAL_PACKAGE];
  return Object.freeze({
    parts: Object.freeze(pkg.parts.map((part) => Object.freeze({ ...part }))),
    contentTypes: structuredClone(pkg.contentTypes),
  });
};

/**
 * A presentation made from a {@link PresentationSnapshot}, as
 * `loadPresentation` would read it from the bytes `savePresentation`
 * wrote at the time. It shares the snapshot's part bytes; the snapshot
 * stays as it was whatever is done to the presentation.
 */
export const restorePresentation = (
  snapshot: PresentationSnapshot,
): PresentationData => ({
  [INTERNAL_PACKAGE]: OpcPackage.fromParts(
    snapshot.parts,
    snapshot.contentTypes as ContentTypes,
  ),
  [FIELD_DATE]: Date.now(),
  _slidesCache: null,
});
