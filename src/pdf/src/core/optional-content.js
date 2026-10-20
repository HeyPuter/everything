import { PDFArray, PDFDict, PDFName, PDFObjectCopier, PDFPage, PDFString } from 'pdf-lib';

const n = PDFName.of;
const array = (dict, key) => {
  const value = dict?.lookup(n(key));
  return value instanceof PDFArray ? value.asArray() : [];
};
const dictionary = (value) => (value instanceof PDFDict ? value : undefined);

/** Use PDF.js's OCG/OCMD evaluation so controls follow the same layers as the canvas. */
export const annotationLayerVisible = (annotation, config) =>
  !annotation.oc || !config || config.isVisible(annotation.oc);

function states(config, groups) {
  const base = config?.lookup(n('BaseState'));
  const result = new Map();
  if (base !== n('Unchanged')) for (const group of groups) result.set(group, base !== n('OFF'));
  const own = new Set(groups);
  for (const state of ['ON', 'OFF'])
    for (const group of array(config, state)) if (own.has(group)) result.set(group, state === 'ON');
  return result;
}

function combineConfig(
  ctx,
  left,
  right,
  leftGroups,
  rightGroups,
  { leftDefault = left, rightDefault = right, alternate = false, primary = left } = {},
) {
  const config = primary?.clone(ctx) || ctx.obj({});
  // BaseState applies to every group in the document. Make each input's state explicit
  // before combining them, including the tolerated (non-default) BaseState=OFF form.
  const visibility = new Map([...states(left, leftGroups), ...states(right, rightGroups)]);
  config.set(n('BaseState'), n(alternate ? 'Unchanged' : 'ON'));
  for (const state of ['ON', 'OFF']) {
    const groups = [...visibility]
      .filter(([, visible]) => visible === (state === 'ON'))
      .map(([group]) => group);
    if (groups.length && (alternate || state === 'OFF')) config.set(n(state), ctx.obj(groups));
    else config.delete(n(state));
  }
  // Order and RBGroups inherit from /D when absent from an alternate configuration.
  // The remaining array entries have empty defaults. Usage rules stay scoped to their
  // own OCGs; the PDF standard explicitly permits multiple entries for the same event.
  for (const key of ['Order', 'RBGroups', 'Locked', 'AS']) {
    const inherited = key === 'Order' || key === 'RBGroups';
    const a = inherited && !left?.has(n(key)) ? leftDefault : left;
    const b = inherited && !right?.has(n(key)) ? rightDefault : right;
    const values = [...array(a, key), ...array(b, key)];
    if (values.length || alternate) config.set(n(key), ctx.obj(values));
    else config.delete(n(key));
  }
  return config;
}

function mergeLayers(ctx, existing, incoming) {
  const leftGroups = array(existing, 'OCGs'),
    rightGroups = array(incoming, 'OCGs');
  const left = dictionary(existing.lookup(n('D'))),
    right = dictionary(incoming.lookup(n('D')));
  const merged = existing.clone(ctx);
  merged.set(n('OCGs'), ctx.obj([...leftGroups, ...rightGroups]));
  merged.set(n('D'), combineConfig(ctx, left, right, leftGroups, rightGroups));
  const configs = [];
  for (const value of array(existing, 'Configs')) {
    const config = dictionary(ctx.lookup(value));
    if (config)
      configs.push(
        combineConfig(ctx, config, right, leftGroups, rightGroups, {
          leftDefault: left,
          alternate: true,
        }),
      );
  }
  for (const value of array(incoming, 'Configs')) {
    const config = dictionary(ctx.lookup(value));
    if (config)
      configs.push(
        combineConfig(ctx, left, config, leftGroups, rightGroups, {
          rightDefault: right,
          alternate: true,
          primary: config,
        }),
      );
  }
  if (configs.length) merged.set(n('Configs'), ctx.obj(configs));
  else merged.delete(n('Configs'));
  return merged;
}

/** A flattened annotation still obeys its independent screen and print visibility flags. */
export function addAnnotationVisibilityLayer(doc, { view, print }) {
  const ctx = doc.context;
  const group = ctx.register(
    ctx.obj({
      Type: 'OCG',
      Name: PDFString.of(view ? 'Screen-only annotations' : 'Print-only annotations'),
      Usage: {
        View: { ViewState: view ? 'ON' : 'OFF' },
        Print: { PrintState: print ? 'ON' : 'OFF' },
      },
    }),
  );
  const incoming = ctx.obj({
    OCGs: [group],
    D: {
      BaseState: 'ON',
      Locked: [group],
      AS: ['View', 'Print'].map((event) => ({ Event: event, Category: [event], OCGs: [group] })),
    },
  });
  const existing = doc.catalog.lookup(n('OCProperties'));
  doc.catalog.set(
    n('OCProperties'),
    existing instanceof PDFDict ? mergeLayers(ctx, existing, incoming) : incoming,
  );
  return group;
}

/**
 * Copy pages and their catalog layer settings through one object-identity map. `prepare`
 * can adjust the copier before anything is copied.
 */
export async function copyPagesWithLayers(target, source, indices, prepare) {
  const key = n('OCProperties');
  await source.flush();
  const copier = PDFObjectCopier.for(source.context, target.context);
  prepare?.(copier);
  const sourcePages = source.getPages();
  const pages = indices.map((index) => {
    const node = copier.copy(sourcePages[index].node);
    return PDFPage.of(node, target.context.register(node), target);
  });
  if (!(source.catalog.lookup(key) instanceof PDFDict)) return pages;
  const incoming = copier.copy(source.catalog.get(key));
  const existing = target.catalog.lookup(key);
  target.catalog.set(
    key,
    existing instanceof PDFDict
      ? mergeLayers(target.context, existing, target.context.lookup(incoming))
      : incoming,
  );
  return pages;
}
