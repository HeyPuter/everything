// C2PA manifest stores (C2PA technical specification 1.x, readable by 2.x
// tools): a JUMBF superbox 'c2pa' holding manifests 'c2ma', each with an
// assertion store 'c2as', a claim 'c2cl' and a claim signature 'c2cs'.
// - Assertions are CBOR ('cbor' superbox and content box) or JSON ('json').
// - The claim lists each assertion as a hashed URI; the hash is SHA-256 over
//   the assertion's superbox without its 8-byte box header (LBox and TBox),
//   i.e. its description box followed by its content boxes.
// - The signature is a COSE_Sign1 over the claim's CBOR bytes (cose.ts).
// - The hard binding "c2pa.hash.data" hashes the whole file except the bytes
//   of the embedded store container (its exclusion range).
import { cborGet, decodeCbor, encodeCbor } from './cbor';
import { verifySign1, signSign1, type CoseSigner } from './cose';
import { contentBox, firstContent, readJumbf, superbox, uuidFourcc, writeJumbf, type JumbfBox, type JumbfSuperbox } from './jumbf';
import { parseCertificate } from './x509';
import { sha256 } from './hash';
import { mimeOf } from './xmp';
import type { ProvenanceRecord } from '../../model/provenance';

export const RECORD_ASSERTION = 'photo-studio.record';
const IPTC = 'http://cv.iptc.org/newscodes/digitalsourcetype/';
export type Exclusion = { start: number; length: number };
export type ManifestInput = {
  record: ProvenanceRecord;
  title: string;
  // Format of the file the manifest is embedded in ("png", "jpeg").
  format: string;
  manifestId: string;
  instanceId: string;
  generator: { name: string; version: string };
  now: Date;
};

type Action = { action: string; when?: string; softwareAgent?: string; digitalSourceType?: string; parameters?: Record<string, unknown> };
/** C2PA actions for a record: how it began, placed files, kept edits and assisted steps, by time. */
export function recordActions(r: ProvenanceRecord, agent: string): Action[] {
  const first: Action =
    r.origin === 'opened'
      ? { action: 'c2pa.opened', when: r.created, softwareAgent: agent, parameters: { description: 'Opened a file' } }
      : { action: 'c2pa.created', when: r.created, softwareAgent: agent, digitalSourceType: IPTC + (r.origin === 'captured' ? 'digitalCapture' : 'digitalCreation') };
  const rest: Action[] = [
    ...r.sources.filter((s) => s.role !== 'opened').map((s) => ({ action: 'c2pa.placed', when: s.when, softwareAgent: agent, parameters: { description: `Placed ${s.name}`, 'photo-studio.sha256': s.sha256 } })),
    ...r.steps
      .filter((s) => !s.undone)
      .map((s) => ({ action: 'c2pa.edited', when: s.when, softwareAgent: agent, parameters: { description: s.label, ...(s.count ? { count: s.count } : {}), ...(s.command ? { 'photo-studio.command': s.command } : {}), ...(s.tool ? { 'photo-studio.tool': s.tool } : {}) } })),
    ...r.ai.map((a) => ({
      action: 'c2pa.edited',
      when: a.when,
      softwareAgent: agent,
      digitalSourceType: IPTC + 'compositeWithTrainedAlgorithmicMedia',
      parameters: { description: `Assisted (${a.kind})`, 'photo-studio.command': a.command, ...(a.prompt ? { 'photo-studio.prompt': a.prompt } : {}), ...(a.model ? { 'photo-studio.model': a.model } : {}) },
    })),
  ];
  rest.sort((a, b) => (a.when! < b.when! ? -1 : a.when! > b.when! ? 1 : 0));
  return [first, ...rest];
}

const cborAssertion = (label: string, value: unknown) => superbox('cbor', label, [contentBox('cbor', encodeCbor(value))]);
const jsonAssertion = (label: string, value: unknown) => superbox('json', label, [contentBox('json', new TextEncoder().encode(JSON.stringify(value)))]);

/** A signed manifest store for `input` with the given hard-binding exclusion and hash. */
export async function buildManifestStore(input: ManifestInput, signer: CoseSigner, exclusion: Exclusion, dataHash: Uint8Array): Promise<Uint8Array> {
  const { record, generator } = input;
  const opened = record.sources.find((s) => s.role === 'opened');
  const ingredients = record.sources.map((s) => ({
    'dc:title': s.name,
    'dc:format': mimeOf(s.format),
    relationship: s === opened ? 'parentOf' : 'componentOf',
    'photo-studio.sha256': s.sha256,
  }));
  const assertions: JumbfSuperbox[] = [
    cborAssertion('c2pa.actions', { actions: recordActions(record, generator.name) }),
    ...ingredients.map((g, i) => cborAssertion(i ? `c2pa.ingredient__${i}` : 'c2pa.ingredient', g)),
    cborAssertion('c2pa.hash.data', { exclusions: [{ start: exclusion.start, length: exclusion.length }], name: 'jumbf manifest', alg: 'sha256', hash: dataHash, pad: new Uint8Array(0) }),
    jsonAssertion(RECORD_ASSERTION, record),
  ];
  const hashed = await Promise.all(assertions.map(async (a) => ({ url: `self#jumbf=c2pa.assertions/${a.label}`, hash: await sha256(writeJumbf(a).subarray(8)) })));
  const claim = encodeCbor({
    'dc:format': mimeOf(input.format),
    'dc:title': input.title,
    instanceID: `urn:uuid:${input.instanceId}`,
    claim_generator: `${generator.name.replace(/\s+/g, '_')}/${generator.version}`,
    claim_generator_info: [{ name: generator.name, version: generator.version }],
    signature: 'self#jumbf=c2pa.signature',
    assertions: hashed,
    alg: 'sha256',
  });
  const manifest = superbox('c2ma', `urn:uuid:${input.manifestId}`, [
    superbox('c2as', 'c2pa.assertions', assertions),
    superbox('c2cl', 'c2pa.claim', [contentBox('cbor', claim)]),
    superbox('c2cs', 'c2pa.signature', [contentBox('cbor', await signSign1(claim, signer))]),
  ]);
  return writeJumbf(superbox('c2pa', 'c2pa', [manifest]));
}

export type C2paAction = { action: string; when?: string; softwareAgent?: string; digitalSourceType?: string; description?: string; count?: number };
export type C2paManifestReport = {
  label: string;
  title?: string;
  format?: string;
  instanceId?: string;
  claimGenerator?: string;
  actions: C2paAction[];
  ingredients: { title: string; format?: string; relationship?: string; sha256?: string }[];
  assertions: string[];
  signature: { valid: boolean; selfSigned: boolean; subject?: string; issuer?: string; notBefore?: string; notAfter?: string; algorithm?: string };
  assertionHashesValid: boolean;
  dataHashValid?: boolean;
  // The record from the photo-studio.record assertion, unvalidated.
  record?: unknown;
  errors: string[];
};
export type C2paReport = { manifests: C2paManifestReport[]; active?: string; errors: string[] };

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
/** SHA-256 of `file` without the exclusion ranges. */
async function hashExcluding(file: Uint8Array, ranges: Exclusion[]): Promise<Uint8Array> {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const parts: Uint8Array[] = [];
  let p = 0;
  for (const r of sorted) {
    if (r.start < p || r.start + r.length > file.length) throw new Error('The data hash exclusions are out of range.');
    parts.push(file.subarray(p, r.start));
    p = r.start + r.length;
  }
  parts.push(file.subarray(p));
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) all.set(x, (o += x.length) - x.length);
  return sha256(all);
}

async function readManifest(store: Uint8Array, m: JumbfSuperbox, file: Uint8Array | undefined): Promise<C2paManifestReport> {
  const errors: string[] = [];
  const report: C2paManifestReport = { label: m.label ?? '', actions: [], ingredients: [], assertions: [], signature: { valid: false, selfSigned: false }, assertionHashesValid: false, errors };
  const astore = m.children.find((c): c is JumbfSuperbox => c.kind === 'super' && uuidFourcc(c.uuid) === 'c2as');
  const claimBox = m.children.find((c): c is JumbfSuperbox => c.kind === 'super' && uuidFourcc(c.uuid) === 'c2cl');
  const sigBox = m.children.find((c): c is JumbfSuperbox => c.kind === 'super' && uuidFourcc(c.uuid) === 'c2cs');
  const assertions = astore?.children.filter((c): c is JumbfSuperbox => c.kind === 'super') ?? [];
  report.assertions = assertions.map((a) => a.label ?? '');
  const content = (a: JumbfSuperbox) => {
    const c = firstContent(a);
    if (!c) return undefined;
    return c.type === 'json' ? JSON.parse(new TextDecoder().decode(c.data)) : decodeCbor(c.data);
  };
  const find = (label: string) => assertions.find((a) => a.label === label);
  // Claim and signature.
  const claimBytes = claimBox && firstContent(claimBox, 'cbor')?.data;
  let claim: unknown;
  if (!claimBytes) errors.push('The manifest has no claim.');
  else
    try {
      claim = decodeCbor(claimBytes);
      report.title = str(cborGet(claim, 'dc:title'));
      report.format = str(cborGet(claim, 'dc:format'));
      report.instanceId = str(cborGet(claim, 'instanceID'));
      report.claimGenerator = str(cborGet(claim, 'claim_generator'));
    } catch (e) {
      errors.push(`The claim cannot be read: ${(e as Error).message}`);
    }
  const cose = sigBox && firstContent(sigBox, 'cbor')?.data;
  if (!cose || !claimBytes) errors.push('The manifest has no claim signature.');
  else {
    const v = await verifySign1(cose, claimBytes);
    report.signature.valid = v.valid;
    report.signature.algorithm = v.algorithm;
    if (v.error) errors.push(v.error);
    if (v.certificate)
      try {
        const c = parseCertificate(v.certificate);
        Object.assign(report.signature, { selfSigned: c.selfSigned, subject: c.subject, issuer: c.issuer, notBefore: c.notBefore, notAfter: c.notAfter });
      } catch (e) {
        errors.push(`The signing certificate cannot be read: ${(e as Error).message}`);
      }
  }
  // Hashed assertion references in the claim.
  const refs = cborGet(claim, 'assertions');
  if (Array.isArray(refs)) {
    let ok = refs.length > 0;
    for (const ref of refs) {
      const url = str(cborGet(ref, 'url')) ?? '';
      const want = cborGet(ref, 'hash');
      const label = url.split('c2pa.assertions/').pop() ?? '';
      const box = find(label);
      if (!box || box.start === undefined || !(want instanceof Uint8Array)) {
        ok = false;
        errors.push(`The claim refers to a missing assertion (${label || url}).`);
        continue;
      }
      if (!equal(await sha256(store.subarray(box.start + 8, box.end)), want)) {
        ok = false;
        errors.push(`The assertion ${label} was changed after signing.`);
      }
    }
    report.assertionHashesValid = ok;
  } else if (claim !== undefined) errors.push('The claim lists no assertions.');
  // Assertions people read.
  for (const a of assertions) {
    const label = a.label ?? '';
    try {
      if (label === 'c2pa.actions' || label === 'c2pa.actions.v2') {
        const list = cborGet(content(a), 'actions');
        if (Array.isArray(list))
          for (const x of list) {
            const agent = cborGet(x, 'softwareAgent');
            const params = cborGet(x, 'parameters');
            const count = cborGet(params, 'count');
            report.actions.push({
              action: str(cborGet(x, 'action')) ?? '',
              when: str(cborGet(x, 'when')),
              softwareAgent: str(agent) ?? str(cborGet(agent, 'name')),
              digitalSourceType: str(cborGet(x, 'digitalSourceType')),
              description: str(cborGet(params, 'description')),
              count: typeof count === 'number' ? count : undefined,
            });
          }
      } else if (label.startsWith('c2pa.ingredient')) {
        const g = content(a);
        report.ingredients.push({ title: str(cborGet(g, 'dc:title')) ?? str(cborGet(g, 'title')) ?? '', format: str(cborGet(g, 'dc:format')), relationship: str(cborGet(g, 'relationship')), sha256: str(cborGet(g, 'photo-studio.sha256')) });
      } else if (label === 'c2pa.hash.data' && file) {
        const d = content(a);
        const ex = cborGet(d, 'exclusions');
        const ranges = (Array.isArray(ex) ? ex : []).map((r) => ({ start: Number(cborGet(r, 'start')), length: Number(cborGet(r, 'length')) }));
        const want = cborGet(d, 'hash');
        if (str(cborGet(d, 'alg')) && cborGet(d, 'alg') !== 'sha256') errors.push('Unsupported data hash algorithm.');
        else if (!(want instanceof Uint8Array)) errors.push('The data hash is missing.');
        else {
          report.dataHashValid = equal(await hashExcluding(file, ranges), want);
          if (!report.dataHashValid) errors.push('The file was changed after the manifest was signed.');
        }
      } else if (label === RECORD_ASSERTION) report.record = content(a);
    } catch (e) {
      errors.push(`The assertion ${label} cannot be read: ${(e as Error).message}`);
    }
  }
  if (file && !find('c2pa.hash.data')) errors.push('The manifest has no hard binding to the file.');
  return report;
}

/** Parse a manifest store and check signatures and hashes (against `file` when given). Never throws. */
export async function readManifestStore(store: Uint8Array, file?: Uint8Array): Promise<C2paReport> {
  try {
    const root = readJumbf(store);
    if (uuidFourcc(root.uuid) !== 'c2pa') return { manifests: [], errors: ['The JUMBF box is not a C2PA manifest store.'] };
    const manifests: C2paManifestReport[] = [];
    for (const m of root.children as JumbfBox[]) if (m.kind === 'super' && uuidFourcc(m.uuid) === 'c2ma') manifests.push(await readManifest(store, m, file));
    // The last manifest in the store is the active one.
    return { manifests, active: manifests.at(-1)?.label, errors: manifests.length ? [] : ['The manifest store is empty.'] };
  } catch (e) {
    return { manifests: [], errors: [`The manifest store cannot be read: ${(e as Error).message}`] };
  }
}

