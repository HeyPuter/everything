/**
 * Graphs: nine graph tools (column, stacked column, bar, stacked bar,
 * line, area, scatter, pie, radar), graphs as live artwork that keep their
 * data and options, the Graph Data window, and Object > Graph > Type, Data,
 * Design, Column and Marker. Ungroup and Expand turn a graph into ordinary
 * artwork.
 */
import './styles.css';
import './graph-live.js';
import { registerGraphIcons } from './icons.js';
import { GRAPH_TOOLS } from './graph-tools.js';
import { GraphDataWindow } from './graph-data.js';
import { selectedGraphs, graphOf, designsFor, importDesigns } from './graph-ops.js';
import { isGraph } from './graph-live.js';
import { graphTypeDialog, graphDesignDialog, graphColumnDialog, graphMarkerDialog } from './graph-dialogs.js';
import { expandLive } from '../../model/live.js';
import { selectionDoubleClickHooks } from '../../tools/selection.js';
import { clipboardHooks } from '../../ops/clipboard.js';

/** Copied graphs carry the column and marker designs they use; paste adds the missing ones. */
const designClipboardHook = {
  copy(doc, ids, data) {
    const designs = designsFor(doc, data.items.flatMap((it) => it.nodes));
    if (designs.length) data.graphDesigns = designs;
  },
  paste(doc, data, items) {
    if (data.graphDesigns?.length) importDesigns(doc, data.graphDesigns);
    return items;
  },
};

const hasGraph = (a) => selectedGraphs(a.editor).length > 0;

/** Expand selected graphs into plain groups (inside a transaction); returns the new ids by old id. */
function expandGraphs(doc, ids) {
  const out = new Map();
  for (const id of ids) {
    if (!isGraph(doc.get(id))) continue;
    const g = expandLive(doc, id);
    if (g) out.set(id, g.id);
  }
  return out;
}

function openDataOnDoubleClick(tool, target) {
  const g = graphOf(tool.editor.doc, target);
  if (!g || !tool.app.graphData) return false;
  tool.app.graphData.show(g.id);
  return true;
}

export function install(app) {
  registerGraphIcons();
  for (const T of GRAPH_TOOLS) app.registerTool(T);
  app.graphData = new GraphDataWindow(app);

  app.commands.register([
    { id: 'graph.type', label: 'Type...', enabled: hasGraph, run: (a) => graphTypeDialog(a) },
    {
      id: 'graph.data',
      label: 'Data...',
      enabled: hasGraph,
      run: (a) => a.graphData.show(selectedGraphs(a.editor)[0].id),
    },
    { id: 'graph.design', label: 'Design...', enabled: (a) => Boolean(a.editor), run: (a) => graphDesignDialog(a) },
    { id: 'graph.column', label: 'Column...', enabled: hasGraph, run: (a) => graphColumnDialog(a) },
    { id: 'graph.marker', label: 'Marker...', enabled: hasGraph, run: (a) => graphMarkerDialog(a) },
  ]);

  // Ungrouping a graph gives its artwork: expand it to a plain group first.
  const ungroup = app.commands.get('object.ungroup');
  if (ungroup) {
    app.commands.register({
      ...ungroup,
      run: (a, args) => {
        const ed = a.editor;
        const graphs = ed ? ed.topSelection().filter((id) => isGraph(ed.doc.get(id))) : [];
        if (!graphs.length) return ungroup.run(a, args);
        let map;
        ed.doc.transact('Ungroup', () => {
          map = expandGraphs(ed.doc, graphs);
          ed.select(ed.topSelection().map((id) => map.get(id) || id).concat([...map.values()]));
          return ungroup.run(a, args);
        });
        return true;
      },
    });
  }

  if (!clipboardHooks.includes(designClipboardHook)) clipboardHooks.push(designClipboardHook);

  // Double-clicking a graph opens its data.
  if (!selectionDoubleClickHooks.includes(openDataOnDoubleClick)) selectionDoubleClickHooks.push(openDataOnDoubleClick);
}
