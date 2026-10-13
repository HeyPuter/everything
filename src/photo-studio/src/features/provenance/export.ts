// Attaching the document's provenance to an exported file, and the
// browser's signing key: an ECDSA P-256 key made on first use, its private
// part not extractable, kept in IndexedDB with a self-signed certificate.
import type { DocumentSession } from '../../app/session';
import { IndexedDbStore, MemoryStore, type LocalStore } from '../../persistence/local-store';
import { addExport, withoutPrompts, type ProvenanceRecord } from '../../model/provenance';
import { attachProvenance, createSigner, provenanceFormat, type ProvenanceFormat, type ProvenanceSigner } from '../../imaging/provenance';
import { noteExport, recordOf } from './recorder';

export type ProvenanceMode = 'none' | 'record' | 'signed';
export const PROVENANCE_FORMATS: string[] = ['png', 'jpeg', 'webp', 'tiff'];

let store: LocalStore<'keys'> | undefined;
let signer: Promise<ProvenanceSigner> | undefined;
/** This browser's signing key (made and stored on first use). */
export function browserSigner(): Promise<ProvenanceSigner> {
  signer ??= (async () => {
    store ??= typeof indexedDB !== 'undefined' ? new IndexedDbStore<'keys'>('photo-studio-provenance', ['keys']) : new MemoryStore<'keys'>();
    try {
      const saved = await store.get<ProvenanceSigner>('keys', 'signer');
      if (saved?.privateKey && saved.certificate) return saved;
    } catch {
      /* Storage unavailable: a key for this page only. */
    }
    const made = await createSigner('Photo Studio signing key (this browser)');
    const kept: ProvenanceSigner = { privateKey: made.privateKey, certificate: made.certificate };
    try {
      await store.put('keys', 'signer', kept);
    } catch {
      /* Kept for this page. */
    }
    return kept;
  })();
  signer.catch(() => (signer = undefined));
  return signer;
}

/** Add provenance to encoded bytes of an export of `s` and note the export.
 * Formats without provenance support are returned unchanged. */
export async function withProvenance(s: DocumentSession, bytes: Uint8Array, name: string, mode: ProvenanceMode, opts: { prompts: boolean; width?: number; height?: number }): Promise<Uint8Array> {
  const format = provenanceFormat(bytes) as ProvenanceFormat | undefined;
  if (mode === 'none' || !format) {
    noteExport(s, { name, format: format ?? (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? 'unknown').toLowerCase(), when: new Date().toISOString() });
    return bytes;
  }
  const now = new Date();
  // The attached record already lists this export.
  const record: ProvenanceRecord = structuredClone(recordOf(s));
  addExport(record, { name, format, when: now.toISOString(), ...(mode === 'signed' && (format === 'png' || format === 'jpeg') ? { signed: true } : {}) });
  const out = await attachProvenance(bytes, format, opts.prompts ? record : withoutPrompts(record), {
    title: s.doc.info?.title?.trim() || s.doc.name,
    signer: mode === 'signed' ? await browserSigner() : undefined,
    now,
    width: opts.width,
    height: opts.height,
  });
  noteExport(s, { name, format, when: now.toISOString(), pixelHash: out.pixelHash, pixelHashMethod: out.pixelHashMethod, ...(out.signed ? { signed: true } : {}) });
  return out.bytes;
}
