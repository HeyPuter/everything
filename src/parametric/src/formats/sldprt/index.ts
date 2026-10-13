// Reads SolidWorks part files (.sldprt): finds the Parasolid solid stored in
// the file and converts it to STEP for the regular import path. The feature
// history is not read; the part arrives as an imported body.

import { SolidWorksError, findTransmits, readStreams } from './container';
import { Graph } from './geom';
import { writeStep } from './step';
import { XtError, type XtNode, type XtTransmit, parseTransmit } from './xt';

export { SolidWorksError };

export interface SolidWorksImport {
  step: string;
  solids: number;
  sheets: number;
  faces: number;
  approximated: number;
  skipped: number;
  problems: string[];
}

const OLD_VERSION = 'This part was saved by a SolidWorks version older than 2003, which Parametric cannot read. Open it in a newer SolidWorks and save it again, or export it as STEP.';

export async function solidWorksToStep(data: Uint8Array, name: string): Promise<SolidWorksImport> {
  if (/\.sldasm$/i.test(name)) throw new SolidWorksError('SolidWorks assemblies cannot be opened yet. Open each part (.sldprt) on its own, or export the assembly as STEP.');
  if (/\.slddrw$/i.test(name)) throw new SolidWorksError('SolidWorks drawings cannot be opened. Open the part (.sldprt) instead.');
  const { kind, streams } = await readStreams(data);
  const transmits = await findTransmits(streams);
  if (!transmits.length) {
    // Files from before about 2003 store their solid in a format this reader does not know.
    if (kind === 'ole2') throw new SolidWorksError(OLD_VERSION);
    throw new SolidWorksError('No solid geometry was found in this SolidWorks file.');
  }
  // Each configuration keeps its own bodies: the saved result in
  // Config-N-Partition, or, in newer files, in Config-N-FeatureBodies/LocalBodies
  // (one transmit per body). Take the lowest-numbered configuration with faces.
  interface Cand { config: number; partition: boolean; x: XtTransmit }
  const cands: Cand[] = [];
  let unreadable: Error | null = null;
  for (const t of transmits) {
    if (t.kind === 'deltas' || /GhostPartition|ResolvedFeatures/.test(t.stream)) continue;
    const m = /Config-(\d+)-/.exec(t.stream);
    let x: XtTransmit;
    try { x = parseTransmit(t.data); } catch (e) { unreadable = e as Error; continue; }
    let faces = 0;
    for (const n of x.nodes.values()) if (n.name === 'FACE') faces++;
    if (faces) cands.push({ config: m ? Number(m[1]) : 0, partition: /Partition$/.test(t.stream), x });
  }
  if (!cands.length) {
    if (unreadable instanceof XtError && /schema/.test(unreadable.message)) throw new SolidWorksError(OLD_VERSION);
    throw new SolidWorksError('No solid geometry was found in this SolidWorks file.');
  }
  const config = Math.min(...cands.map((c) => c.config));
  let chosen = cands.filter((c) => c.config === config);
  if (chosen.some((c) => c.partition)) chosen = chosen.filter((c) => c.partition);
  const bodies = (x: XtTransmit) => [...x.nodes.values()].filter((n: XtNode) => n.name === 'BODY');
  const r = writeStep(chosen.map((c) => ({ graph: new Graph(c.x.nodes), bodies: bodies(c.x) })), name.replace(/\.[^.]+$/, ''));
  if (!r.faces) throw new SolidWorksError('The solid in this SolidWorks file could not be converted.');
  return { step: r.text, solids: r.solids, sheets: r.sheets, faces: r.faces, approximated: r.approximated, skipped: r.skipped, problems: r.problems };
}
