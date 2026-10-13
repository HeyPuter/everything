/**
 * Shared state for the import/export modules that must exist before the
 * lazily loaded code runs: the app reference for paint-module hooks.
 */
export const paintHooks = { app: null };

/**
 * Further appearance that feature modules bake for export, as
 * { key, test(node) -> bool, bake(node, view, extra) -> node }. `bake` may
 * add virtual nodes to `extra`. Writers that handle a kind natively (SVG
 * patterns) leave it out with exportView(doc, { native: [key] }).
 */
export const exportBakers = [];

/**
 * SVG paint servers for paint types that feature modules add (pattern
 * swatches): type -> (writer, paint, node, mapped, exportSVG) -> id of a
 * definition added with writer.def(), or null. `mapped` is as for
 * gradients: true when the node is written in document space (offset by
 * writer.ox/oy), otherwise the text-local placement.
 */
export const svgPaintHooks = {};

/**
 * SVG export extensions from feature modules:
 *   attrs(node) -> string      extra attributes for an element (with a leading space)
 *   head(doc) -> string        extra markup at the top of the <svg> (e.g. <script>)
 *   element(node, writer, depth) -> string | undefined
 *                              markup that replaces the object's own (effects
 *                              SVG cannot express); writer.element(node, depth)
 *                              writes the plain element, writer.def(prefix, fn)
 *                              adds a <defs> entry
 */
export const svgExportHooks = { attrs: [], head: [], element: [] };

/**
 * Hooks that decorate an object's SVG markup (features add attributes or
 * wrap it in a link): fn(node, xml, { nl, depth, minify }) returns the new
 * markup, or undefined to keep it.
 */
export const svgNodeHooks = [];

/**
 * Writers for node types the exporters do not know (live kinds with
 * `exportSelf`, e.g. gradient meshes), registered by feature modules:
 *   svg: type -> (writer, node, depth) => markup
 *   pdf: type -> async (renderer, ctx, node) => void
 */
export const exportWriters = { svg: new Map(), pdf: new Map() };

/**
 * Importers for further file kinds (see kinds.js fileKind), registered by
 * feature modules: kind -> { place(app, editor, file, opts) -> Promise<id|null> }.
 */
export const fileImporters = {};

/**
 * Raster decoders for image formats browsers cannot show (TIFF, PSD...):
 * async (bytes, name) -> { mime, bytes } (a web format) or null.
 */
export const imageDecoders = [];

/**
 * Export formats from feature modules: key -> { label, ext, mime,
 * options(app, prefs) -> { title, fields: [elements], read() -> options } | null,
 * render(app, editor, region, options) -> Promise<Blob> }.
 */
export const exportFormats = new Map();
