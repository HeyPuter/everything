// COSE_Sign1 (RFC 9052 §4.2) with a detached payload, as C2PA claim
// signatures use it. The protected header holds the algorithm (1) and the
// signing certificate as x5chain (33, RFC 9360). Signing uses ES256 (-7);
// reading also checks ES384, ES512, PS256-512 and Ed25519 where WebCrypto
// provides them.
import { CborTag, cborGet, decodeCbor, encodeCbor } from './cbor';
import { parseCertificate } from './x509';

const ab = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;
export type CoseSigner = { privateKey: CryptoKey; certificate: Uint8Array };

const sigStructure = (protectedBytes: Uint8Array, payload: Uint8Array) => encodeCbor(['Signature1', protectedBytes, new Uint8Array(0), payload]);

/** A tagged COSE_Sign1 over `payload` (left detached: nil in the structure). */
export async function signSign1(payload: Uint8Array, signer: CoseSigner): Promise<Uint8Array> {
  const protectedBytes = encodeCbor(new Map<number, unknown>([[1, -7], [33, signer.certificate]]));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer.privateKey, ab(sigStructure(protectedBytes, payload))));
  return encodeCbor(new CborTag(18, [protectedBytes, new Map(), null, sig]));
}

// Signature algorithms (COSE IDs, RFC 9053 and RFC 8230) and how WebCrypto
// checks them. ECDSA signatures are raw r||s in COSE, as WebCrypto wants them.
type Alg = { name: string; key: RsaHashedImportParams | EcKeyImportParams | Algorithm; params: AlgorithmIdentifier | EcdsaParams | RsaPssParams };
const ALGS: Record<number, Alg> = {
  [-7]: { name: 'ES256', key: { name: 'ECDSA', namedCurve: 'P-256' }, params: { name: 'ECDSA', hash: 'SHA-256' } },
  [-35]: { name: 'ES384', key: { name: 'ECDSA', namedCurve: 'P-384' }, params: { name: 'ECDSA', hash: 'SHA-384' } },
  [-36]: { name: 'ES512', key: { name: 'ECDSA', namedCurve: 'P-521' }, params: { name: 'ECDSA', hash: 'SHA-512' } },
  [-37]: { name: 'PS256', key: { name: 'RSA-PSS', hash: 'SHA-256' }, params: { name: 'RSA-PSS', saltLength: 32 } },
  [-38]: { name: 'PS384', key: { name: 'RSA-PSS', hash: 'SHA-384' }, params: { name: 'RSA-PSS', saltLength: 48 } },
  [-39]: { name: 'PS512', key: { name: 'RSA-PSS', hash: 'SHA-512' }, params: { name: 'RSA-PSS', saltLength: 64 } },
  [-8]: { name: 'Ed25519', key: { name: 'Ed25519' }, params: { name: 'Ed25519' } },
};

// `checked` is false when the signature could not be checked at all (an
// algorithm this browser does not provide); `valid` is then false too.
export type Sign1Result = { valid: boolean; checked: boolean; certificate?: Uint8Array; algorithm?: string; error?: string };
/** Check a COSE_Sign1 against its detached payload with the certificate it
 * carries. This shows only that the payload is unchanged since that
 * certificate's key signed it: the certificate itself is not checked. */
export async function verifySign1(cose: Uint8Array, payload: Uint8Array): Promise<Sign1Result> {
  let certificate: Uint8Array | undefined;
  let algorithm: string | undefined;
  try {
    let v = decodeCbor(cose);
    if (v instanceof CborTag) {
      if (v.tag !== 18) return { valid: false, checked: true, error: `Unexpected COSE tag ${v.tag}.` };
      v = v.value;
    }
    if (!Array.isArray(v) || v.length !== 4 || !(v[0] instanceof Uint8Array) || !(v[3] instanceof Uint8Array)) return { valid: false, checked: true, error: 'Malformed COSE_Sign1.' };
    const [protectedBytes, unprotected, , sig] = v as [Uint8Array, unknown, unknown, Uint8Array];
    const header = protectedBytes.length ? decodeCbor(protectedBytes) : new Map();
    const id = cborGet(header, 1);
    const chain = cborGet(header, 33) ?? cborGet(unprotected, 33);
    certificate = chain instanceof Uint8Array ? chain : Array.isArray(chain) && chain[0] instanceof Uint8Array ? chain[0] : undefined;
    const alg = typeof id === 'number' ? ALGS[id] : undefined;
    algorithm = alg?.name ?? (id === undefined ? undefined : `COSE algorithm ${String(id)}`);
    if (!alg) return { valid: false, checked: false, certificate, algorithm, error: `The signature uses ${algorithm ?? 'no stated algorithm'}, which cannot be checked here.` };
    if (!certificate) return { valid: false, checked: true, algorithm, error: 'The signature carries no certificate.' };
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey('spki', ab(parseCertificate(certificate).spki), alg.key, false, ['verify']);
    } catch (error) {
      if ((error as Error)?.name === 'NotSupportedError') return { valid: false, checked: false, certificate, algorithm, error: `The signature uses ${alg.name}, which this browser cannot check.` };
      throw error;
    }
    const valid = await crypto.subtle.verify(alg.params, key, ab(sig), ab(sigStructure(protectedBytes, payload)));
    return { valid, checked: true, certificate, algorithm, ...(valid ? {} : { error: 'The signature does not match the claim.' }) };
  } catch (error) {
    return { valid: false, checked: true, certificate, algorithm, error: error instanceof Error ? error.message : String(error) };
  }
}
