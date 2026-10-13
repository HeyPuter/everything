// Attaching a provenance record to exported images and reading it back.
// Every export gets an XMP packet (summary manifest, full record and pixel
// hash); PNG and JPEG can also carry a C2PA-format manifest store signed with
// a self-signed key. Signatures only show that the file is unchanged since
// this key signed it; the key is not vouched for by anyone.
import { validateProvenance, type ProvenanceRecord } from '../../model/provenance';
import { insertStore, provenanceFormat, readStore, readXmpPacket, stripStore, supportsC2pa, writeXmpPacket, type ProvenanceFormat } from './containers';
import { buildManifestStore, readManifestStore, type C2paManifestReport, type C2paReport } from './c2pa';
import { pixelHash } from './hash';
import { buildXmpPacket, jsonLdManifest, parseXmpPacket } from './xmp';
import { createSelfSignedCertificate } from './x509';

export { provenanceFormat, type ProvenanceFormat, type C2paManifestReport };
export type ProvenanceSigner = { privateKey: CryptoKey; certificate: Uint8Array };

/** A new ECDSA P-256 key (private part not extractable) with a self-signed certificate valid for ten years. */
export async function createSigner(commonName: string, now = new Date()): Promise<ProvenanceSigner & { publicKey: CryptoKey }> {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 10);
  const certificate = await createSelfSignedCertificate(keys, { commonName, organization: 'Photo Studio (self-signed)', notBefore: now, notAfter });
  return { privateKey: keys.privateKey, publicKey: keys.publicKey, certificate };
}

const uuid = () => crypto.randomUUID();
// A JPEG segment holds at most 65533 bytes after its length field.
const JPEG_XMP_LIMIT = 65000;

export type AttachOptions = {
  title: string;
  // Omitted: XMP only. C2PA is written to PNG and JPEG and ignored otherwise.
  signer?: ProvenanceSigner;
  generator?: { name: string; version: string };
  now?: Date;
  // Canvas size for WebP files whose bitstream size cannot be read.
  width?: number;
  height?: number;
};
export type AttachResult = { bytes: Uint8Array; pixelHash: string; pixelHashMethod: string; signed: boolean };

/** XMP packet first (its pixel hash is of the image data, which attaching
 * does not change), then a C2PA store bound to the whole file. Earlier
 * provenance in the file is replaced. */
export async function attachProvenance(file: Uint8Array, format: ProvenanceFormat, record: ProvenanceRecord, opts: AttachOptions): Promise<AttachResult> {
  const now = opts.now ?? new Date();
  const generator = opts.generator ?? { name: 'Photo Studio', version: '1.0' };
  const base = stripStore(file, format);
  const ph = await pixelHash(base, format);
  const fields = { title: opts.title, format, pixelHash: ph.hash, pixelHashMethod: ph.method, modified: now.toISOString() };
  let packet = buildXmpPacket({ ...fields, manifest: jsonLdManifest(record, fields), record });
  // JPEG segments are small: drop the full record, then older steps, to fit.
  const size = (s: string) => new TextEncoder().encode(s).length;
  if (format === 'jpeg' && size(packet) > JPEG_XMP_LIMIT) {
    let maxSteps = record.steps.length;
    do {
      packet = buildXmpPacket({ ...fields, manifest: jsonLdManifest(record, { ...fields, maxSteps }) });
      maxSteps = Math.floor(maxSteps / 2);
    } while (size(packet) > JPEG_XMP_LIMIT && maxSteps > 0);
    if (size(packet) > JPEG_XMP_LIMIT) packet = buildXmpPacket({ ...fields, manifest: jsonLdManifest({ ...record, sources: record.sources.slice(-20), ai: record.ai.slice(-20), exports: record.exports.slice(-20) }, { ...fields, maxSteps: 0 }) });
  }
  const withXmp = writeXmpPacket(base, format, packet, opts.width && opts.height ? { width: opts.width, height: opts.height } : undefined);
  if (!opts.signer || !supportsC2pa(format)) return { bytes: withXmp, pixelHash: ph.hash, pixelHashMethod: ph.method, signed: false };

  const input = { record, title: opts.title, format, manifestId: uuid(), instanceId: uuid(), generator, now };
  const zero = new Uint8Array(32);
  // The exclusion must cover the container exactly, and the container's size
  // depends on the exclusion written inside it: iterate to a fixed point.
  let exclusion = { start: 0, length: 0 };
  let placed = insertStore(withXmp, format, await buildManifestStore(input, opts.signer, exclusion, zero));
  for (let i = 0; i < 8 && (placed.start !== exclusion.start || placed.length !== exclusion.length); i++) {
    exclusion = { start: placed.start, length: placed.length };
    placed = insertStore(withXmp, format, await buildManifestStore(input, opts.signer, exclusion, zero));
  }
  if (placed.start !== exclusion.start || placed.length !== exclusion.length) throw new Error('Could not lay out the provenance manifest.');
  // Everything outside the exclusion is final now; hash it and sign for real.
  const out = placed.bytes;
  const rest = new Uint8Array(out.length - exclusion.length);
  rest.set(out.subarray(0, exclusion.start));
  rest.set(out.subarray(exclusion.start + exclusion.length), exclusion.start);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', rest));
  const final = insertStore(withXmp, format, await buildManifestStore(input, opts.signer, exclusion, hash));
  if (final.length !== exclusion.length || final.start !== exclusion.start) throw new Error('The provenance manifest changed size while signing.');
  return { bytes: final.bytes, pixelHash: ph.hash, pixelHashMethod: ph.method, signed: true };
}

export type ProvenanceReport = {
  format?: ProvenanceFormat;
  // Pixel hash of the file as it is now.
  pixelHash?: string;
  pixelHashMethod?: string;
  xmp?: { recordedPixelHash?: string; pixelHashMethod?: string; pixelHashMatches?: boolean; manifest?: unknown; record?: ProvenanceRecord; title?: string };
  c2pa?: C2paReport;
  errors: string[];
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Read the provenance of any image file; problems are reported, never thrown. */
export async function inspectProvenance(file: Uint8Array): Promise<ProvenanceReport> {
  const report: ProvenanceReport = { errors: [] };
  const format = provenanceFormat(file);
  if (!format) {
    report.errors.push('Provenance can be read from PNG, JPEG, WebP and TIFF files.');
    return report;
  }
  report.format = format;
  try {
    const ph = await pixelHash(file, format);
    report.pixelHash = ph.hash;
    report.pixelHashMethod = ph.method;
  } catch (e) {
    report.errors.push(`The image data cannot be read: ${message(e)}`);
  }
  try {
    const packet = readXmpPacket(file, format);
    if (packet !== undefined) {
      const x = parseXmpPacket(packet);
      report.errors.push(...x.errors);
      const xmp: NonNullable<ProvenanceReport['xmp']> = { recordedPixelHash: x.pixelHash, pixelHashMethod: x.pixelHashMethod, manifest: x.manifest, title: x.title };
      if (x.record !== undefined)
        try {
          xmp.record = validateProvenance(x.record);
        } catch (e) {
          report.errors.push(message(e));
        }
      if (x.pixelHash && report.pixelHash) xmp.pixelHashMatches = x.pixelHashMethod === report.pixelHashMethod && x.pixelHash === report.pixelHash;
      report.xmp = xmp;
    }
  } catch (e) {
    report.errors.push(`The XMP packet cannot be read: ${message(e)}`);
  }
  try {
    const loc = readStore(file, format);
    if (loc) report.c2pa = await readManifestStore(loc.store, file);
  } catch (e) {
    report.errors.push(`The C2PA manifest cannot be read: ${message(e)}`);
  }
  return report;
}
