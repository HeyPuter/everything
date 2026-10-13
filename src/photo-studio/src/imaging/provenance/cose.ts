// COSE_Sign1 (RFC 9052 §4.2) with ES256 (RFC 9053 §2.1) and a detached
// payload, as C2PA claim signatures use it. The protected header holds the
// algorithm (1: -7) and the signing certificate as x5chain (33, RFC 9360).
import { CborTag, cborGet, decodeCbor, encodeCbor } from './cbor';
import { importPublicKey, parseCertificate } from './x509';

const ab = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;
export type CoseSigner = { privateKey: CryptoKey; certificate: Uint8Array };

const sigStructure = (protectedBytes: Uint8Array, payload: Uint8Array) => encodeCbor(['Signature1', protectedBytes, new Uint8Array(0), payload]);

/** A tagged COSE_Sign1 over `payload` (left detached: nil in the structure). */
export async function signSign1(payload: Uint8Array, signer: CoseSigner): Promise<Uint8Array> {
  const protectedBytes = encodeCbor(new Map<number, unknown>([[1, -7], [33, signer.certificate]]));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer.privateKey, ab(sigStructure(protectedBytes, payload))));
  return encodeCbor(new CborTag(18, [protectedBytes, new Map(), null, sig]));
}

export type Sign1Result = { valid: boolean; certificate?: Uint8Array; algorithm?: string; error?: string };
/** Check a COSE_Sign1 against its detached payload with the certificate it carries. */
export async function verifySign1(cose: Uint8Array, payload: Uint8Array): Promise<Sign1Result> {
  try {
    let v = decodeCbor(cose);
    if (v instanceof CborTag) {
      if (v.tag !== 18) return { valid: false, error: `Unexpected COSE tag ${v.tag}.` };
      v = v.value;
    }
    if (!Array.isArray(v) || v.length !== 4 || !(v[0] instanceof Uint8Array) || !(v[3] instanceof Uint8Array)) return { valid: false, error: 'Malformed COSE_Sign1.' };
    const [protectedBytes, unprotected, , sig] = v as [Uint8Array, unknown, unknown, Uint8Array];
    const header = protectedBytes.length ? decodeCbor(protectedBytes) : new Map();
    const alg = cborGet(header, 1);
    const chain = cborGet(header, 33) ?? cborGet(unprotected, 33);
    const certificate = chain instanceof Uint8Array ? chain : Array.isArray(chain) && chain[0] instanceof Uint8Array ? chain[0] : undefined;
    if (alg !== -7) return { valid: false, certificate, error: `Unsupported signature algorithm ${String(alg)}.` };
    if (!certificate) return { valid: false, algorithm: 'ES256', error: 'The signature carries no certificate.' };
    const key = await importPublicKey(parseCertificate(certificate).spki);
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, ab(sig), ab(sigStructure(protectedBytes, payload)));
    return { valid, certificate, algorithm: 'ES256', ...(valid ? {} : { error: 'The signature does not match the claim.' }) };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}
