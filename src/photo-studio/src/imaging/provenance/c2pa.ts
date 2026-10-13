// C2PA manifest stores (C2PA technical specification 1.x, readable by 2.x
// tools): a JUMBF superbox 'c2pa' holding manifests 'c2ma', each with an
// assertion store 'c2as', a claim 'c2cl' and a claim signature 'c2cs'.
// - Assertions are CBOR ('cbor' superbox and content box) or JSON ('json').
// - The claim lists each assertion as a hashed URI; the hash is SHA-256 over
//   the assertion's superbox without its 8-byte box header (LBox and TBox),
//   i.e. its description box followed by its content boxes. Claims of
//   version 2 list them as created_assertions and gathered_assertions.
// - Readers use only assertions the claim lists with a matching hash:
//   anything else in the store was not signed and is reported, not shown.
// - The signature is a COSE_Sign1 over the claim's CBOR bytes (cose.ts).
// - The hard binding "c2pa.hash.data" hashes the whole file except the bytes
//   of the embedded store container (its exclusion range). Only the active
//   (last) manifest is bound to the file; earlier ones describe ingredients.
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
  // Labels of the assertions in the store, as stored.
  assertions: string[];
  // Signature: `valid` means it matches the certificate embedded in the file.
  // No trust list or certificate chain is checked, so it never says who
  // signed. `checked` is false for algorithms that cannot be checked here.
  signature: { valid: boolean; checked: boolean; selfSigned: boolean; subject?: string; issuer?: string; notBefore?: string; notAfter?: string; algorithm?: string };
  // Every assertion the claim lists is present and unchanged, and the store
  // holds nothing else.
  assertionHashesValid: boolean;
  // Assertions in the store that the claim does not list (or extra copies
  // of a label): added after signing, and ignored.
  unlisted: string[];
  // The active manifest's hard binding: true when the file's bytes are the
  // signed ones, false when they changed or no listed binding exists.
  dataHashValid?: boolean;
  binding?: 'bound' | 'changed' | 'missing' | 'unchecked';
  // The record from the photo-studio.record assertion, unvalidated.
  record?: unknown;
  errors: string[];
};
export type C2paReport = { manifests: C2paManifestReport[]; active?: string; errors: string[] };

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const DIGESTS: Record<string, string> = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
async function digest(alg: string, bytes: Uint8Array): Promise<Uint8Array> {
  if (alg === 'sha256') return sha256(bytes);
  return new Uint8Array(await crypto.subtle.digest(DIGESTS[alg], bytes as Uint8Array<ArrayBuffer>));
}
/** Hash of `file` without the exclusion ranges. */
async function hashExcluding(file: Uint8Array, ranges: Exclusion[], alg: string): Promise<Uint8Array> {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const parts: Uint8Array[] = [];
  let p = 0;
  for (const r of sorted) {
    if (!Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.length) || r.length < 0 || r.start < p || r.start + r.length > file.length) throw new Error('The data hash exclusions are out of range.');
    parts.push(file.subarray(p, r.start));
    p = r.start + r.length;
  }
  parts.push(file.subarray(p));
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) all.set(x, (o += x.length) - x.length);
  return digest(alg, all);
}
// Hard bindings other than the data hash (BMFF, general boxes, collections).
const isHardBinding = (label: string) => /^c2pa\.hash\./.test(label);

async function readManifest(store: Uint8Array, m: JumbfSuperbox, file: Uint8Array | undefined, active: boolean): Promise<C2paManifestReport> {
  const errors: string[] = [];
  const report: C2paManifestReport = { label: m.label ?? '', actions: [], ingredients: [], assertions: [], signature: { valid: false, checked: true, selfSigned: false }, assertionHashesValid: false, unlisted: [], errors };
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
      const info = cborGet(claim, 'claim_generator_info');
      const first = Array.isArray(info) ? info[0] : info;
      const name = str(cborGet(first, 'name'));
      report.claimGenerator = str(cborGet(claim, 'claim_generator')) ?? (name && [name, str(cborGet(first, 'version'))].filter(Boolean).join('/'));
    } catch (e) {
      errors.push(`The claim cannot be read: ${(e as Error).message}`);
    }
  const cose = sigBox && firstContent(sigBox, 'cbor')?.data;
  if (!cose || !claimBytes) errors.push('The manifest has no claim signature.');
  else {
    const v = await verifySign1(cose, claimBytes);
    Object.assign(report.signature, { valid: v.valid, checked: v.checked, algorithm: v.algorithm });
    if (v.error) errors.push(v.error);
    if (v.certificate)
      try {
        const c = parseCertificate(v.certificate);
        Object.assign(report.signature, { selfSigned: c.selfSigned, subject: c.subject, issuer: c.issuer, notBefore: c.notBefore, notAfter: c.notAfter });
      } catch (e) {
        errors.push(`The signing certificate cannot be read: ${(e as Error).message}`);
      }
  }
  // Hashed assertion references in the claim (version 1: assertions;
  // version 2: created and gathered assertions). Each must match exactly one
  // assertion of its label by hash; only matched assertions are read.
  const v1 = cborGet(claim, 'assertions');
  const created = cborGet(claim, 'created_assertions'),
    gathered = cborGet(claim, 'gathered_assertions');
  const refs = Array.isArray(v1) ? v1 : Array.isArray(created) || Array.isArray(gathered) ? [...(Array.isArray(created) ? created : []), ...(Array.isArray(gathered) ? gathered : [])] : undefined;
  const claimAlg = str(cborGet(claim, 'alg')) ?? 'sha256';
  const listed = new Set<JumbfSuperbox>();
  const listedLabels = new Set<string>();
  let ok = !!refs?.length;
  if (refs) {
    for (const ref of refs) {
      const url = str(cborGet(ref, 'url')) ?? '';
      const want = cborGet(ref, 'hash');
      const alg = str(cborGet(ref, 'alg')) ?? claimAlg;
      const label = url.split('c2pa.assertions/').pop() ?? '';
      listedLabels.add(label);
      const candidates = assertions.filter((a) => a.label === label && a.end !== undefined);
      if (!candidates.length || !(want instanceof Uint8Array)) {
        ok = false;
        errors.push(`The claim refers to a missing assertion (${label || url}).`);
        continue;
      }
      if (!DIGESTS[alg]) {
        ok = false;
        errors.push(`The assertion ${label} is hashed with ${alg}, which cannot be checked here.`);
        continue;
      }
      let match: JumbfSuperbox | undefined;
      for (const a of candidates) if (!match && equal(await digest(alg, store.subarray(a.body ?? a.start! + 8, a.end)), want)) match = a;
      if (match) listed.add(match);
      else {
        ok = false;
        errors.push(`The assertion ${label} was changed after signing.`);
      }
    }
  } else if (claim !== undefined) errors.push('The claim lists no assertions.');
  // Anything else in the store was not signed.
  const counts = new Map<string, number>();
  for (const a of assertions) counts.set(a.label ?? '', (counts.get(a.label ?? '') ?? 0) + 1);
  for (const [label, n] of counts) if (n > 1) errors.unshift(`The manifest holds ${n} assertions labelled ${label}; only one can be signed.`);
  for (const a of assertions) if (!listed.has(a) && (listedLabels.has(a.label ?? '') ? (counts.get(a.label ?? '') ?? 0) > 1 : true)) report.unlisted.push(a.label ?? '');
  if (report.unlisted.length) errors.unshift(`The manifest holds assertions its claim does not list (${[...new Set(report.unlisted)].join(', ')}): they were added after signing and are ignored.`);
  report.assertionHashesValid = ok && !report.unlisted.length;
  // Assertions people read (signed ones only).
  const bindings: JumbfSuperbox[] = [];
  for (const a of assertions) {
    if (!listed.has(a)) continue;
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
              description: str(cborGet(params, 'description')) ?? str(cborGet(x, 'description')),
              count: typeof count === 'number' ? count : undefined,
            });
          }
      } else if (label.startsWith('c2pa.ingredient')) {
        const g = content(a);
        report.ingredients.push({ title: str(cborGet(g, 'dc:title')) ?? str(cborGet(g, 'title')) ?? '', format: str(cborGet(g, 'dc:format')), relationship: str(cborGet(g, 'relationship')), sha256: str(cborGet(g, 'photo-studio.sha256')) });
      } else if (isHardBinding(label.replace(/__\d+$/, ''))) bindings.push(a);
      else if (label === RECORD_ASSERTION) report.record = content(a);
    } catch (e) {
      errors.push(`The assertion ${label} cannot be read: ${(e as Error).message}`);
    }
  }
  // The active manifest's hard binding, from the signed assertion only.
  if (file && active) {
    const data = bindings.filter((b) => b.label?.replace(/__\d+$/, '') === 'c2pa.hash.data');
    if (data.length > 1) {
      report.binding = 'changed';
      errors.push('The claim lists more than one data hash; the file cannot be bound to one.');
    } else if (data.length === 1) {
      try {
        const d = content(data[0]);
        const ex = cborGet(d, 'exclusions');
        const ranges = (Array.isArray(ex) ? ex : []).map((r) => ({ start: Number(cborGet(r, 'start')), length: Number(cborGet(r, 'length')) }));
        const want = cborGet(d, 'hash');
        const alg = str(cborGet(d, 'alg')) ?? claimAlg;
        if (!DIGESTS[alg]) {
          report.binding = 'unchecked';
          errors.push(`The data hash uses ${alg}, which cannot be checked here.`);
        } else if (!(want instanceof Uint8Array)) {
          report.binding = 'missing';
          errors.push('The data hash is missing.');
        } else {
          report.binding = equal(await hashExcluding(file, ranges, alg), want) ? 'bound' : 'changed';
          if (report.binding === 'changed') errors.push('The file was changed after the manifest was signed.');
        }
      } catch (e) {
        report.binding = 'changed';
        errors.push(`The data hash cannot be checked: ${(e as Error).message}`);
      }
    } else if (bindings.length) {
      report.binding = 'unchecked';
      errors.push(`The manifest is bound to the file by ${bindings.map((b) => b.label).join(', ')}, which cannot be checked here.`);
    } else {
      report.binding = 'missing';
      errors.push('The manifest has no signed hard binding to the file.');
    }
    if (report.binding !== 'unchecked') report.dataHashValid = report.binding === 'bound';
  }
  return report;
}

/** Parse a manifest store and check signatures and hashes (against `file` when given). Never throws. */
export async function readManifestStore(store: Uint8Array, file?: Uint8Array): Promise<C2paReport> {
  try {
    const root = readJumbf(store);
    if (uuidFourcc(root.uuid) !== 'c2pa') return { manifests: [], errors: ['The JUMBF box is not a C2PA manifest store.'] };
    const boxes = (root.children as JumbfBox[]).filter((m): m is JumbfSuperbox => m.kind === 'super' && uuidFourcc(m.uuid) === 'c2ma');
    // The last manifest in the store is the active one; only it is bound to the file.
    const manifests: C2paManifestReport[] = [];
    for (const [i, m] of boxes.entries()) manifests.push(await readManifest(store, m, file, i === boxes.length - 1));
    return { manifests, active: manifests.at(-1)?.label, errors: manifests.length ? [] : ['The manifest store is empty.'] };
  } catch (e) {
    return { manifests: [], errors: [`The manifest store cannot be read: ${(e as Error).message}`] };
  }
}
