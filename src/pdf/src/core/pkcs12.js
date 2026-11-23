/**
 * PKCS#12 (.pfx/.p12) digital ID files (RFC 7292): import a private key and its certificates
 * from files made by Acrobat, OpenSSL (1.x legacy and 3.x), Windows and macOS, and export a
 * digital ID protected the way OpenSSL 3 does it (PBES2 with PBKDF2-HMAC-SHA256 and AES-256,
 * SHA-256 MAC), or optionally the legacy way (SHA-1/Triple DES) older systems need.
 */
import {
  OID,
  TAG,
  algorithmIdentifier,
  bmpString,
  bytesEqual,
  concatBytes,
  decodeDer,
  explicit,
  implicit,
  integer,
  nullValue,
  octetString,
  oid,
  sequence,
  set,
  setOf,
} from './asn1.js';
import {
  CryptoUnsupportedError,
  digest,
  importPrivateKey,
  randomBytes,
  readAlgorithm,
  subtle,
} from './pki-crypto.js';
import { desCbcDecrypt, desCbcEncrypt, rc2CbcDecrypt, PaddingError } from './legacy-ciphers.js';
import { rc4 } from './security.js';
import { hashSync } from './sha.js';
import { parseCertificate } from './x509.js';

export class Pkcs12PasswordError extends Error {
  constructor(message = 'Incorrect password for this digital ID file.') {
    super(message);
    this.name = 'Pkcs12PasswordError';
    this.code = 'password';
  }
}

const HASH_INFO = {
  'SHA-1': { oid: OID.sha1, length: 20, block: 64 },
  'SHA-256': { oid: OID.sha256, length: 32, block: 64 },
  'SHA-384': { oid: OID.sha384, length: 48, block: 128 },
  'SHA-512': { oid: OID.sha512, length: 64, block: 128 },
};
const HASH_BY_OID = Object.fromEntries(Object.entries(HASH_INFO).map(([name, v]) => [v.oid, name]));
const HMAC_BY_OID = {
  [OID.hmacSHA1]: 'SHA-1',
  [OID.hmacSHA256]: 'SHA-256',
  [OID.hmacSHA384]: 'SHA-384',
  [OID.hmacSHA512]: 'SHA-512',
};

/* ---------- Passwords ---------- */
/** The BMPString form PKCS#12 key derivation uses: UTF-16BE with a two-byte terminator. */
export function bmpPassword(password) {
  if (password == null) return new Uint8Array(0);
  const out = new Uint8Array(password.length * 2 + 2);
  for (let i = 0; i < password.length; i++) {
    out[i * 2] = password.charCodeAt(i) >> 8;
    out[i * 2 + 1] = password.charCodeAt(i) & 0xff;
  }
  return out;
}
const utf8 = (text) => new TextEncoder().encode(text ?? '');

/* ---------- Key derivation ---------- */
/** RFC 7292 appendix B: the PKCS#12 key derivation function. `id` 1 = key, 2 = IV, 3 = MAC. */
export function pkcs12Kdf(hashName, password, salt, iterations, id, length) {
  const { length: u, block: v } = HASH_INFO[hashName];
  const fill = (source) => {
    if (!source.length) return new Uint8Array(0);
    const out = new Uint8Array(v * Math.ceil(source.length / v));
    for (let i = 0; i < out.length; i++) out[i] = source[i % source.length];
    return out;
  };
  const D = new Uint8Array(v).fill(id);
  const I = concatBytes([fill(salt), fill(password)]);
  const out = new Uint8Array(length);
  for (let produced = 0; ;) {
    let A = hashSync(hashName, concatBytes([D, I]));
    for (let r = 1; r < iterations; r++) A = hashSync(hashName, A);
    out.set(A.subarray(0, Math.min(u, length - produced)), produced);
    produced += u;
    if (produced >= length) return out;
    const B = new Uint8Array(v);
    for (let i = 0; i < v; i++) B[i] = A[i % u];
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = I[j + k] + B[k] + carry;
        I[j + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
}
async function pbkdf2(password, salt, iterations, hash, length) {
  const key = await subtle().importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(
    await subtle().deriveBits({ name: 'PBKDF2', salt, iterations, hash }, key, length * 8),
  );
}
async function hmac(hash, key, data) {
  const k = await subtle().importKey('raw', key, { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, data));
}
async function aesCbc(operation, key, iv, data) {
  const k = await subtle().importKey('raw', key, 'AES-CBC', false, [operation]);
  try {
    return new Uint8Array(await subtle()[operation]({ name: 'AES-CBC', iv }, k, data));
  } catch {
    throw new PaddingError();
  }
}

/* ---------- Password-based encryption ---------- */
const PKCS12_PBE = {
  [OID.pbeSHA1TripleDES]: { cipher: 'des', keyLength: 24 },
  [OID.pbeSHA1TwoKeyTripleDES]: { cipher: 'des', keyLength: 16 },
  [OID.pbeSHA1RC2_128]: { cipher: 'rc2', keyLength: 16 },
  [OID.pbeSHA1RC2_40]: { cipher: 'rc2', keyLength: 5 },
  [OID.pbeSHA1RC4_128]: { cipher: 'rc4', keyLength: 16 },
  [OID.pbeSHA1RC4_40]: { cipher: 'rc4', keyLength: 5 },
};
const PBES1 = {
  [OID.pbeMD5DES]: { hash: 'MD5', cipher: 'des' },
  [OID.pbeSHA1DES]: { hash: 'SHA-1', cipher: 'des' },
  [OID.pbeMD5RC2]: { hash: 'MD5', cipher: 'rc2' },
  [OID.pbeSHA1RC2]: { hash: 'SHA-1', cipher: 'rc2' },
};
function rc2EffectiveBits(version) {
  if (version === 160) return 40;
  if (version === 120) return 64;
  if (version === 58) return 128;
  return version >= 256 ? version : 32;
}

/** Decrypt with a PKCS#5/PKCS#12 password-based encryption AlgorithmIdentifier. */
async function pbeDecrypt(algorithmNode, password, data) {
  const { oid: id, params } = readAlgorithm(algorithmNode);
  if (PKCS12_PBE[id]) {
    const { cipher, keyLength } = PKCS12_PBE[id];
    const salt = params.child(0).octets();
    const iterations = params.child(1).int();
    const pass = bmpPassword(password);
    const key = await pkcs12Kdf('SHA-1', pass, salt, iterations, 1, keyLength);
    if (cipher === 'rc4') return rc4(key, data);
    const iv = await pkcs12Kdf('SHA-1', pass, salt, iterations, 2, 8);
    return cipher === 'des'
      ? desCbcDecrypt(key, iv, data)
      : rc2CbcDecrypt(key, iv, data, keyLength * 8);
  }
  if (PBES1[id]) {
    const { hash, cipher } = PBES1[id];
    const salt = params.child(0).octets();
    const iterations = params.child(1).int();
    let dk = await digest(hash, concatBytes([utf8(password), salt]));
    for (let i = 1; i < iterations; i++)
      dk = hash === 'MD5' ? await digest(hash, dk) : hashSync(hash, dk);
    const key = dk.subarray(0, 8);
    const iv = dk.subarray(8, 16);
    return cipher === 'des' ? desCbcDecrypt(key, iv, data) : rc2CbcDecrypt(key, iv, data, 64);
  }
  if (id === OID.pbes2) {
    const kdf = readAlgorithm(params.child(0));
    const scheme = readAlgorithm(params.child(1));
    if (kdf.oid !== OID.pbkdf2)
      throw new CryptoUnsupportedError('Unsupported key derivation in digital ID file.');
    const kids = kdf.params.children;
    const salt = kids[0].octets();
    const iterations = kids[1].int();
    let keyLength = null;
    let prf = 'SHA-1';
    for (const kid of kids.slice(2)) {
      if (kid.tag === TAG.INTEGER) keyLength = kid.int();
      else if (kid.tag === TAG.SEQUENCE) {
        prf = HMAC_BY_OID[readAlgorithm(kid).oid];
        if (!prf) throw new CryptoUnsupportedError('Unsupported PBKDF2 hash in digital ID file.');
      }
    }
    const pass = utf8(password);
    if (
      scheme.oid === OID.aes128CBC ||
      scheme.oid === OID.aes192CBC ||
      scheme.oid === OID.aes256CBC
    ) {
      const length = {
        [OID.aes128CBC]: 16,
        [OID.aes192CBC]: 24,
        [OID.aes256CBC]: 32,
      }[scheme.oid];
      const key = await pbkdf2(pass, salt, iterations, prf, keyLength || length);
      return aesCbc('decrypt', key, scheme.params.octets(), data);
    }
    if (scheme.oid === OID.desEde3CBC || scheme.oid === OID.desCBC) {
      const length = scheme.oid === OID.desCBC ? 8 : 24;
      const key = await pbkdf2(pass, salt, iterations, prf, keyLength || length);
      return desCbcDecrypt(key, scheme.params.octets(), data);
    }
    if (scheme.oid === OID.rc2CBC) {
      const rc2 = scheme.params;
      const version = rc2.children.length > 1 ? rc2.child(0).int() : 32;
      const bits = rc2EffectiveBits(version);
      const key = await pbkdf2(pass, salt, iterations, prf, keyLength || bits / 8);
      return rc2CbcDecrypt(key, rc2.children[rc2.children.length - 1].octets(), data, bits);
    }
    throw new CryptoUnsupportedError('Unsupported cipher in digital ID file.');
  }
  throw new CryptoUnsupportedError(`Unsupported encryption in digital ID file (${id}).`);
}

/** Encrypt with PBES2 (PBKDF2-HMAC-SHA256, AES-256-CBC) or legacy SHA-1/3DES. */
async function pbeEncrypt(password, data, { iterations, legacy }) {
  const salt = randomBytes(legacy ? 8 : 16);
  if (legacy) {
    const pass = bmpPassword(password);
    const key = await pkcs12Kdf('SHA-1', pass, salt, iterations, 1, 24);
    const iv = await pkcs12Kdf('SHA-1', pass, salt, iterations, 2, 8);
    return {
      algorithm: algorithmIdentifier(
        OID.pbeSHA1TripleDES,
        sequence(octetString(salt), integer(iterations)),
      ),
      encrypted: desCbcEncrypt(key, iv, data),
    };
  }
  const iv = randomBytes(16);
  const key = await pbkdf2(utf8(password), salt, iterations, 'SHA-256', 32);
  return {
    algorithm: algorithmIdentifier(
      OID.pbes2,
      sequence(
        algorithmIdentifier(
          OID.pbkdf2,
          sequence(
            octetString(salt),
            integer(iterations),
            algorithmIdentifier(OID.hmacSHA256, nullValue()),
          ),
        ),
        algorithmIdentifier(OID.aes256CBC, octetString(iv)),
      ),
    ),
    encrypted: await aesCbc('encrypt', key, iv, data),
  };
}

/* ---------- MAC ---------- */
async function checkMac(macData, password, content) {
  const kids = macData.children;
  const digestInfo = kids[0];
  const algorithm = readAlgorithm(digestInfo.child(0));
  const expected = digestInfo.child(1).octets();
  const salt = kids[1].octets();
  const iterations = kids[2] ? kids[2].int() : 1;
  if (algorithm.oid === OID.pbmac1) {
    // RFC 9579: PBKDF2 over the UTF-8 password, then HMAC.
    const kdf = readAlgorithm(algorithm.params.child(0));
    const scheme = readAlgorithm(algorithm.params.child(1));
    const hash = HMAC_BY_OID[scheme.oid];
    const kdfKids = kdf.params.children;
    let prf = 'SHA-1';
    let keyLength = HASH_INFO[hash]?.length;
    for (const kid of kdfKids.slice(2)) {
      if (kid.tag === TAG.INTEGER) keyLength = kid.int();
      else if (kid.tag === TAG.SEQUENCE) prf = HMAC_BY_OID[readAlgorithm(kid).oid];
    }
    if (!hash || !prf) throw new CryptoUnsupportedError('Unsupported PBMAC1 algorithm.');
    const key = await pbkdf2(utf8(password), kdfKids[0].octets(), kdfKids[1].int(), prf, keyLength);
    return bytesEqual(await hmac(hash, key, content), expected);
  }
  const hash = HASH_BY_OID[algorithm.oid];
  if (!hash) throw new CryptoUnsupportedError('Unsupported integrity check in digital ID file.');
  const key = await pkcs12Kdf(
    hash,
    bmpPassword(password),
    salt,
    iterations,
    3,
    HASH_INFO[hash].length,
  );
  return bytesEqual(await hmac(hash, key, content), expected);
}

/* ---------- Import ---------- */
function readBagAttributes(node) {
  const attributes = {};
  for (const attr of node?.children || []) {
    const id = attr.child(0).oid();
    const value = attr.child(1).children[0];
    if (!value) continue;
    if (id === OID.localKeyId) attributes.localKeyId = value.octets();
    else if (id === OID.friendlyName) attributes.friendlyName = value.string();
  }
  return attributes;
}

async function readSafeContents(bytes, password, found) {
  for (const bag of decodeDer(bytes).children) {
    const type = bag.child(0).oid();
    const value = bag.child(1).child(0);
    const attributes = readBagAttributes(bag.children[2]);
    if (type === OID.keyBag) found.keys.push({ pkcs8: value.der.slice(), attributes });
    else if (type === OID.pkcs8ShroudedKeyBag) {
      const pkcs8 = await pbeDecrypt(value.child(0), password, value.child(1).octets());
      decodeDer(pkcs8); // a wrong password usually fails the padding; this catches the rest
      found.keys.push({ pkcs8, attributes });
    } else if (type === OID.certBag) {
      if (value.child(0).oid() !== OID.x509Certificate) continue;
      const der = value.child(1).child(0).octets().slice();
      found.certificates.push({ der, attributes });
    }
  }
}

function publicKeyMatches(jwk, cert) {
  const toB64Url = (bytes) => {
    let text = '';
    for (const b of bytes) text += String.fromCharCode(b);
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const key = cert.publicKey;
  if (jwk.kty === 'RSA' && key.type === 'RSA') return jwk.n === toB64Url(key.modulus);
  if (jwk.kty === 'EC' && key.type === 'EC') {
    const size = (key.point.length - 1) / 2;
    return (
      jwk.x === toB64Url(key.point.subarray(1, 1 + size)) &&
      jwk.y === toB64Url(key.point.subarray(1 + size))
    );
  }
  return false;
}

/**
 * Read a PKCS#12 file. Resolves to a digital ID `{ privateKey, certificate, chain, ... }`;
 * rejects with Pkcs12PasswordError for a wrong password and Error for unusable files.
 */
export async function importPkcs12(bytes, password = '') {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let pfx;
  try {
    pfx = decodeDer(data);
    if (pfx.child(0).int() !== 3) throw new Error();
  } catch {
    throw new Error('This is not a PKCS#12 digital ID file (.pfx or .p12).');
  }
  const authSafe = pfx.child(1);
  if (authSafe.child(0).oid() !== OID.data)
    throw new Error('Digital ID files protected with public keys are not supported.');
  const content = authSafe.child(1).child(0).octets();
  // Passwords: as typed; for an empty password also the "no password" form some tools use.
  const candidates = password ? [password] : ['', null];
  let chosen;
  if (pfx.children[2]) {
    for (const candidate of candidates)
      if (await checkMac(pfx.child(2), candidate, content)) {
        chosen = candidate;
        break;
      }
    if (chosen === undefined) throw new Pkcs12PasswordError();
  } else chosen = candidates[0];
  const found = { keys: [], certificates: [] };
  try {
    for (const info of decodeDer(content).children) {
      const type = info.child(0).oid();
      if (type === OID.data) await readSafeContents(info.child(1).child(0).octets(), chosen, found);
      else if (type === OID.encryptedData) {
        const encrypted = info.child(1).child(0).child(1);
        const algorithm = encrypted.child(1);
        const ciphertext = encrypted.child(2).octets();
        await readSafeContents(await pbeDecrypt(algorithm, chosen, ciphertext), chosen, found);
      }
    }
  } catch (error) {
    if (error instanceof PaddingError) throw new Pkcs12PasswordError();
    if (error instanceof CryptoUnsupportedError) throw error;
    throw new Error(`This digital ID file could not be read: ${error.message}`);
  }
  if (!found.keys.length) throw new Error('This digital ID file has no private key.');
  if (!found.certificates.length) throw new Error('This digital ID file has no certificate.');
  const certificates = found.certificates.map((c) => ({
    ...c,
    parsed: parseCertificate(c.der),
  }));
  const keyEntry = found.keys[0];
  const privateKey = await importPrivateKey(keyEntry.pkcs8, {
    extractable: true,
  });
  let jwk = null;
  try {
    jwk = await subtle().exportKey('jwk', privateKey);
  } catch {
    // Without the public half, fall back to the key id or the first certificate.
  }
  const leaf =
    (jwk && certificates.find((c) => publicKeyMatches(jwk, c.parsed))) ||
    certificates.find(
      (c) =>
        keyEntry.attributes.localKeyId &&
        bytesEqual(c.attributes.localKeyId, keyEntry.attributes.localKeyId),
    ) ||
    certificates[0];
  if (jwk && !publicKeyMatches(jwk, leaf.parsed))
    throw new Error("The digital ID's private key does not match any of its certificates.");
  const chain = certificates.filter((c) => c !== leaf).map((c) => c.der);
  return {
    privateKey,
    certificate: leaf.der,
    chain,
    friendlyName: keyEntry.attributes.friendlyName || leaf.attributes.friendlyName || '',
  };
}

/* ---------- Export ---------- */
/**
 * Write a digital ID as a PKCS#12 file. By default it is protected like OpenSSL 3 does it
 * (PBES2: PBKDF2-HMAC-SHA256 + AES-256-CBC; SHA-256 MAC). `legacy: true` writes the SHA-1 /
 * Triple DES form that older Windows and macOS versions require.
 */
export async function exportPkcs12(
  identity,
  password,
  { iterations = 2048, legacy = false, friendlyName } = {},
) {
  if (typeof password !== 'string') throw new Error('A password is required.');
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', identity.privateKey));
  const leaf = parseCertificate(identity.certificate);
  const localKeyId = await digest('SHA-1', leaf.der);
  const name = friendlyName ?? identity.friendlyName ?? leaf.subject.commonName;
  const attributes = (withKeyId) =>
    setOf([
      withKeyId ? sequence(oid(OID.localKeyId), set(octetString(localKeyId))) : null,
      name ? sequence(oid(OID.friendlyName), set(bmpString(name))) : null,
    ]);
  const certBag = (der, withKeyId) =>
    sequence(
      oid(OID.certBag),
      explicit(0, sequence(oid(OID.x509Certificate), explicit(0, octetString(der)))),
      withKeyId ? attributes(true) : null,
    );
  const certContents = sequence(
    certBag(leaf.der, true),
    ...(identity.chain || []).map((der) => certBag(der, false)),
  );
  const options = { iterations, legacy };
  const certEnc = await pbeEncrypt(password, certContents, options);
  const keyEnc = await pbeEncrypt(password, pkcs8, options);
  const keyBag = sequence(
    oid(OID.pkcs8ShroudedKeyBag),
    explicit(0, sequence(keyEnc.algorithm, octetString(keyEnc.encrypted))),
    attributes(true),
  );
  const authSafe = sequence(
    sequence(
      oid(OID.encryptedData),
      explicit(
        0,
        sequence(
          integer(0),
          sequence(oid(OID.data), certEnc.algorithm, implicit(0, certEnc.encrypted, false)),
        ),
      ),
    ),
    sequence(oid(OID.data), explicit(0, octetString(sequence(keyBag)))),
  );
  const macHash = legacy ? 'SHA-1' : 'SHA-256';
  const macSalt = randomBytes(legacy ? 8 : 16);
  const macKey = await pkcs12Kdf(
    macHash,
    bmpPassword(password),
    macSalt,
    iterations,
    3,
    HASH_INFO[macHash].length,
  );
  const mac = await hmac(macHash, macKey, authSafe);
  return sequence(
    integer(3),
    sequence(oid(OID.data), explicit(0, octetString(authSafe))),
    sequence(
      sequence(algorithmIdentifier(HASH_INFO[macHash].oid, nullValue()), octetString(mac)),
      octetString(macSalt),
      integer(iterations),
    ),
  );
}
