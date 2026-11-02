/**
 * Workflow Studio automations (original). Zapier/Make-inspired — not those products.
 * Local graph runner only; no LIVE third-party OAuth connectors (DOCUMENTED).
 */

/** @typedef {{ id:string, type:'trigger'|'action'|'filter', kind:string, config:Record<string,string|number|boolean> }} Node */
/** @typedef {{ id:string, from:string, to:string }} Edge */
/** @typedef {{ nodes:Node[], edges:Edge[] }} Flow */
/** @typedef {{ ok:boolean, steps: {nodeId:string, output:unknown}[], error?:string }} RunResult */

/** @returns {Flow} */
export function createFlow() {
  return {
    nodes: [
      { id: 't1', type: 'trigger', kind: 'manual', config: { name: 'Start' } },
      { id: 'a1', type: 'action', kind: 'set_var', config: { key: 'greeting', value: 'hello' } },
      { id: 'f1', type: 'filter', kind: 'equals', config: { key: 'greeting', equals: 'hello' } },
      { id: 'a2', type: 'action', kind: 'append', config: { key: 'greeting', suffix: ' world' } },
    ],
    edges: [
      { id: 'e1', from: 't1', to: 'a1' },
      { id: 'e2', from: 'a1', to: 'f1' },
      { id: 'e3', from: 'f1', to: 'a2' },
    ],
  };
}

/** Topological order following edges from triggers. */
export function orderNodes(flow) {
  /** @type {Map<string, string[]>} */
  const outs = new Map();
  for (const n of flow.nodes) outs.set(n.id, []);
  for (const e of flow.edges) {
    if (!outs.has(e.from)) continue;
    outs.get(e.from).push(e.to);
  }
  const triggers = flow.nodes.filter((n) => n.type === 'trigger').map((n) => n.id);
  /** @type {string[]} */
  const order = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {string} id */
  function walk(id) {
    if (seen.has(id)) return;
    seen.add(id);
    order.push(id);
    for (const next of outs.get(id) || []) walk(next);
  }
  for (const t of triggers) walk(t);
  return order.map((id) => flow.nodes.find((n) => n.id === id)).filter(Boolean);
}

/**
 * @param {Flow} flow
 * @param {Record<string, unknown>} [context]
 * @returns {RunResult}
 */
export function runFlow(flow, context = {}) {
  /** @type {Record<string, unknown>} */
  const ctx = { ...context };
  /** @type {{nodeId:string, output:unknown}[]} */
  const steps = [];
  try {
    for (const node of orderNodes(flow)) {
      if (node.type === 'filter') {
        const key = String(node.config.key || '');
        const want = node.config.equals;
        const pass = ctx[key] === want;
        steps.push({ nodeId: node.id, output: { pass } });
        if (!pass) return { ok: true, steps };
        continue;
      }
      if (node.type === 'trigger') {
        steps.push({ nodeId: node.id, output: { fired: true } });
        continue;
      }
      if (node.kind === 'set_var') {
        const key = String(node.config.key || 'value');
        ctx[key] = node.config.value;
        steps.push({ nodeId: node.id, output: { [key]: ctx[key] } });
        continue;
      }
      if (node.kind === 'append') {
        const key = String(node.config.key || 'value');
        ctx[key] = `${ctx[key] ?? ''}${node.config.suffix ?? ''}`;
        steps.push({ nodeId: node.id, output: { [key]: ctx[key] } });
        continue;
      }
      steps.push({ nodeId: node.id, output: { skipped: true } });
    }
    return { ok: true, steps };
  } catch (err) {
    return { ok: false, steps, error: err instanceof Error ? err.message : String(err) };
  }
}

/** @param {Flow} flow @param {Node} node */
export function addNode(flow, node) {
  return { ...flow, nodes: [...flow.nodes, node] };
}

/** @param {Flow} flow @param {Edge} edge */
export function addEdge(flow, edge) {
  return { ...flow, edges: [...flow.edges, edge] };
}
