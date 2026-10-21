// `OpcPackage` is the in-memory model of a `.pptx` archive at the OPC layer:
// an ordered list of parts plus a `[Content_Types].xml` map.
//
// Round-trip rules:
//
//   - Parts are kept in their original load order. New parts append at the
//     end. This matches common native output and keeps diffs small.
//   - `.rels` files are first-class parts. They are NOT auto-regenerated from
//     a parsed model on every save — that would force callers who only edit
//     content parts to pay the cost of round-tripping every relationship.
//     Higher-level edits that need a typed view go through `getRels` / `setRels`,
//     which parse on read and re-serialize on write back into the part.
//   - The package never invents content types. Callers must register an
//     override (or rely on the extension default) before adding a part whose
//     extension isn't already covered. Otherwise `validate()` will surface
//     the gap.

import {
  type ContentTypes,
  type PartName,
  type Relationships,
  type ZipEntry,
  emptyContentTypes,
  fromZipPath,
  lookupContentType,
  parseContentTypes,
  parseRels,
  partName,
  partNamesEqual,
  readZip,
  relsPartNameFor,
  serializeContentTypes,
  serializeRels,
  toZipPath,
  writeZip,
} from "../opc/index.ts";

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

const decode = (b: Uint8Array): string => TEXT_DECODER.decode(b);
const encode = (s: string): Uint8Array => TEXT_ENCODER.encode(s);

/** A single OPC part: name, content type, and bytes. */
export interface Part {
  readonly name: PartName;
  contentType: string;
  data: Uint8Array;
}

// Part arrays are intentionally mutable, so the package's name index may be
// stale after caller edits: getPart checks each hit against the array. Each
// immutable string's folded value is cached, keyed weakly by its part.
const foldedPartNames = new WeakMap<Part, { name: PartName; folded: string }>();

const foldedName = (p: Part): string => {
  const currentName = p.name;
  let cached = foldedPartNames.get(p);
  if (cached?.name !== currentName) {
    cached = { name: currentName, folded: currentName.toLowerCase() };
    foldedPartNames.set(p, cached);
  }
  return cached.folded;
};

const CONTENT_TYPES_PART = "[Content_Types].xml";

// A part's bytes are replaced, never changed in place, when it is written, so
// each `.rels` buffer is parsed once and every read gets a copy of the result.
// Reading a slide's layout, media or links goes through its relationships,
// and on a large deck re-parsing them dominated deck-wide reads.
const parsedRels = new WeakMap<Uint8Array, Relationships>();
const readRels = (data: Uint8Array): Relationships => {
  let rels = parsedRels.get(data);
  if (!rels) {
    rels = parseRels(decode(data));
    parsedRels.set(data, rels);
  }
  return { items: rels.items.map((item) => ({ ...item })) };
};

/**
 * In-memory model of an OPC package. Construct via `OpcPackage.load(bytes)`
 * to read an existing `.pptx`, or via `OpcPackage.empty()` to start from
 * scratch.
 */
export class OpcPackage {
  /**
   * Ordered list of parts. The order is the order parts will be written to
   * the ZIP central directory on `save()`. Direct mutation is allowed for
   * callers that need to reorder, but `addPart` / `removePart` are the
   * supported entry points.
   */
  readonly parts: Part[];
  /** Mutable Content_Types map. Direct mutation is allowed. */
  contentTypes: ContentTypes;

  private constructor(parts: Part[], contentTypes: ContentTypes) {
    this.parts = parts;
    this.contentTypes = contentTypes;
  }

  /**
   * Builds an empty package containing only the two default content-type
   * entries (xml, rels). No `.rels` or content parts yet — that's the caller's
   * job. PresentationML scaffolding will populate the typical PPTX skeleton.
   */
  static empty(): OpcPackage {
    return new OpcPackage([], emptyContentTypes());
  }

  /**
   * Loads a `.pptx` file from raw bytes. Parses `[Content_Types].xml`
   * eagerly; leaves part bodies as raw `Uint8Array`s for higher layers to
   * interpret.
   *
   * Throws if the archive is not a valid ZIP, or if `[Content_Types].xml` is
   * missing or malformed.
   */
  static load(bytes: Uint8Array): OpcPackage {
    const zip = readZip(bytes);
    let contentTypes: ContentTypes | null = null;
    const parts: Part[] = [];

    for (const entry of zip.entries) {
      if (entry.name === CONTENT_TYPES_PART) {
        contentTypes = parseContentTypes(decode(entry.data));
        continue;
      }
      // Some producers (native Windows output, third-party tools) include
      // explicit directory entries in the ZIP central directory — zero-byte
      // names ending with "/". They are not OPC parts; skip them so part-name
      // validation does not reject them.
      if (entry.name.endsWith("/")) continue;
      // Readers ignore deleted parts stored without content types here.
      if (/^\/?\[trash\]\//i.test(entry.name)) continue;
      const name = fromZipPath(entry.name);
      parts.push({
        name,
        contentType: "", // filled in after we've parsed Content_Types
        data: entry.data,
      });
    }

    if (contentTypes === null) {
      throw new Error("package is missing [Content_Types].xml");
    }

    for (const part of parts) {
      const ct = lookupContentType(contentTypes, part.name);
      if (ct === null) {
        throw new Error(
          `part "${part.name}" has no content type registered in [Content_Types].xml`,
        );
      }
      part.contentType = ct;
    }

    return new OpcPackage(parts, contentTypes);
  }

  /** Serialize the package to a `.pptx` byte stream. */
  save(): Uint8Array {
    const entries: ZipEntry[] = [];
    entries.push({
      name: CONTENT_TYPES_PART,
      data: encode(serializeContentTypes(this.contentTypes)),
    });
    for (const part of this.parts) {
      entries.push({ name: toZipPath(part.name), data: part.data });
    }
    return writeZip(entries);
  }

  /**
   * Looks up a part by name (case-insensitive per OPC §9.1.1.7).
   */
  getPart(name: PartName): Part | null {
    const folded = name.toLowerCase();
    // Where each name was last seen. The array may have been changed
    // directly since, so a hit is checked against what is there now, and a
    // miss still looks through every part.
    const at = this.partPositions.get(folded);
    if (at !== undefined) {
      const p = this.parts[at];
      if (p !== undefined && foldedName(p) === folded) return p;
    }
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i]!;
      if (foldedName(p) === folded) {
        this.indexParts();
        return p;
      }
    }
    return null;
  }

  private partPositions = new Map<string, number>();

  private indexParts(): void {
    this.partPositions.clear();
    for (let i = this.parts.length - 1; i >= 0; i--)
      this.partPositions.set(foldedName(this.parts[i]!), i);
  }

  /**
   * Adds a new part. Throws if a part with the same name (case-insensitive)
   * already exists. The caller is responsible for ensuring the content type
   * is resolvable — either by extension default or by a registered override.
   */
  addPart(name: PartName, contentType: string, data: Uint8Array): Part {
    if (this.getPart(name) !== null) {
      throw new Error(`part "${name}" already exists`);
    }
    const part: Part = { name, contentType, data };
    this.parts.push(part);
    // If neither an existing default nor an existing override covers this
    // content type, register an Override so the on-disk Content_Types stays
    // consistent. Callers can replace the override later if they prefer a
    // default.
    const existing = lookupContentType(this.contentTypes, name);
    if (existing !== contentType) {
      this.contentTypes.overrides.push({ partName: name, contentType });
    }
    return part;
  }

  /**
   * Removes a part by name. Returns true if a part was removed; false if no
   * part with that name was present. Also drops any matching `Override`
   * entry from Content_Types; defaults are left untouched.
   */
  removePart(name: PartName): boolean {
    let removed = false;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      if (p && partNamesEqual(p.name, name)) {
        this.parts.splice(i, 1);
        removed = true;
      }
    }
    if (removed) {
      this.contentTypes.overrides = this.contentTypes.overrides.filter(
        (o) => !partNamesEqual(o.partName, name),
      );
    }
    return removed;
  }

  /**
   * Reads (or parses, lazily) the relationships for the given part. Returns
   * `null` if the part has no sibling `.rels` part — this is normal for
   * content parts with no outgoing relationships.
   *
   * The returned `Relationships` is a fresh snapshot. Mutate it as needed,
   * then call `setRels(forPart, rels)` to persist the change back into the
   * package.
   */
  getRels(forPart: PartName): Relationships | null {
    const relsName = relsPartNameFor(forPart);
    const part = this.getPart(relsName);
    if (part === null) return null;
    return readRels(part.data);
  }

  /**
   * Writes relationships for the given part. Creates the sibling `.rels`
   * part if it didn't exist; replaces its bytes if it did. The relationships
   * part is given the standard relationships content type via the `rels`
   * extension default.
   */
  setRels(forPart: PartName, rels: Relationships): void {
    const relsName = relsPartNameFor(forPart);
    const bytes = encode(serializeRels(rels));
    const existing = this.getPart(relsName);
    if (existing !== null) {
      existing.data = bytes;
      return;
    }
    this.addPart(
      relsName,
      "application/vnd.openxmlformats-package.relationships+xml",
      bytes,
    );
  }

  /**
   * Convenience: read the package-root relationships (`/_rels/.rels`).
   * These point at the top-level parts — typically the presentation.xml,
   * core properties, and extended properties.
   */
  rootRels(): Relationships | null {
    const part = this.getPart(partName("/_rels/.rels"));
    if (part === null) return null;
    return readRels(part.data);
  }

  /** Convenience: write package-root relationships. */
  setRootRels(rels: Relationships): void {
    const name = partName("/_rels/.rels");
    const bytes = encode(serializeRels(rels));
    const existing = this.getPart(name);
    if (existing !== null) {
      existing.data = bytes;
      return;
    }
    this.addPart(
      name,
      "application/vnd.openxmlformats-package.relationships+xml",
      bytes,
    );
  }
}
