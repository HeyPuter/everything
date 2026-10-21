/**
 * X.509 certificates: reading the fields a signature panel shows (names, validity, key
 * usage), checking one certificate's signature with another's key, building chains, and
 * issuing the self-signed certificates of new digital IDs.
 */
import {
  OID,
  TAG,
  bitString,
  boolean,
  bytesEqual,
  decodeDer,
  explicit,
  hexOf,
  ia5String,
  implicit,
  integer,
  octetString,
  oid,
  pemBlocks,
  printableString,
  sequence,
  set,
  tlv,
  utf8String,
  x509Time,
} from './asn1.js';
import {
  describePublicKey,
  digest,
  randomBytes,
  readAlgorithm,
  signData,
  signatureAlgorithmFor,
  signatureScheme,
  subtle,
  verifySignature,
} from './pki-crypto.js';

const NAME_LABELS = {
  [OID.commonName]: 'CN',
  [OID.surname]: 'SN',
  [OID.serialNumber]: 'SERIALNUMBER',
  [OID.country]: 'C',
  [OID.locality]: 'L',
  [OID.state]: 'ST',
  [OID.street]: 'STREET',
  [OID.organization]: 'O',
  [OID.organizationalUnit]: 'OU',
  [OID.title]: 'T',
  [OID.givenName]: 'G',
  [OID.emailAddress]: 'E',
  [OID.domainComponent]: 'DC',
  [OID.userId]: 'UID',
};

/** A Name as its DER bytes, attribute list, and the attributes a UI shows. */
export function readName(node) {
  const attributes = [];
  for (const rdn of node.children)
    for (const atv of rdn.children) {
      const type = atv.child(0).oid();
      let value;
      try {
        value = atv.child(1).string();
      } catch {
        value = '';
      }
      attributes.push({ oid: type, label: NAME_LABELS[type] || type, value });
    }
  const first = (id) => attributes.find((a) => a.oid === id)?.value || '';
  return {
    der: node.der,
    attributes,
    commonName: first(OID.commonName),
    organization: first(OID.organization),
    organizationalUnit: first(OID.organizationalUnit),
    country: first(OID.country),
    email: first(OID.emailAddress),
    text: attributes
      .slice()
      .reverse()
      .map((a) => `${a.label}=${a.value}`)
      .join(', '),
  };
}

const KEY_USAGE_NAMES = [
  'digitalSignature',
  'nonRepudiation',
  'keyEncipherment',
  'dataEncipherment',
  'keyAgreement',
  'keyCertSign',
  'cRLSign',
  'encipherOnly',
  'decipherOnly',
];

function readExtensions(node) {
  const extensions = { list: [] };
  for (const ext of node.children) {
    const id = ext.child(0).oid();
    const critical =
      ext.children.length > 2 && ext.child(1).tag === TAG.BOOLEAN && ext.child(1).bool();
    const value = ext.children[ext.children.length - 1].octets();
    extensions.list.push({ oid: id, critical });
    try {
      const inner = decodeDer(value);
      if (id === OID.keyUsage) {
        const { bytes } = inner.bits();
        extensions.keyUsage = KEY_USAGE_NAMES.filter((_, i) => bytes[i >> 3] & (0x80 >> (i & 7)));
      } else if (id === OID.extKeyUsage) {
        extensions.extKeyUsage = inner.children.map((kid) => kid.oid());
      } else if (id === OID.basicConstraints) {
        const kids = inner.children;
        extensions.basicConstraints = {
          ca: kids[0]?.tag === TAG.BOOLEAN ? kids[0].bool() : false,
          pathLength: kids.find((kid) => kid.tag === TAG.INTEGER)?.int() ?? null,
        };
      } else if (id === OID.subjectKeyIdentifier) {
        extensions.subjectKeyIdentifier = inner.octets();
      } else if (id === OID.authorityKeyIdentifier) {
        const keyId = inner.children.find((kid) => kid.isContext(0));
        if (keyId) extensions.authorityKeyIdentifier = keyId.value;
      } else if (id === OID.subjectAltName) {
        extensions.emails = inner.children
          .filter((kid) => kid.isContext(1))
          .map((kid) => kid.string());
        extensions.dnsNames = inner.children
          .filter((kid) => kid.isContext(2))
          .map((kid) => kid.string());
      }
    } catch {
      // A malformed extension leaves the rest of the certificate readable.
    }
  }
  return extensions;
}

/**
 * Parse a DER (or PEM) certificate. Throws for input that is not a certificate.
 */
export function parseCertificate(input) {
  const der = typeof input === 'string' ? pemBlocks(input)[0]?.der : input;
  if (!der) throw new Error('No certificate found.');
  const root = decodeDer(der);
  const tbs = root.child(0);
  const kids = tbs.children;
  let i = 0;
  let version = 1;
  if (kids[0].isContext(0)) {
    version = kids[0].child(0).int() + 1;
    i++;
  }
  const serialNode = kids[i++];
  const signatureAlgorithm = readAlgorithm(kids[i++]);
  const issuer = readName(kids[i++]);
  const validity = kids[i++];
  const subject = readName(kids[i++]);
  const spkiNode = kids[i++];
  let extensions = { list: [] };
  for (; i < kids.length; i++)
    if (kids[i].isContext(3)) extensions = readExtensions(kids[i].child(0));
  const publicKey = describePublicKey(spkiNode.der);
  const certDer = root.der;
  return {
    der: certDer.slice(),
    tbs: tbs.der,
    version,
    serial: serialNode.bigInt(),
    serialDer: serialNode.der,
    serialHex: hexOf(serialNode.unsigned()).toUpperCase(),
    signatureAlgorithm,
    outerAlgorithm: readAlgorithm(root.child(1)),
    signature: root.child(2).bits().bytes,
    issuer,
    subject,
    notBefore: validity.child(0).time(),
    notAfter: validity.child(1).time(),
    spki: spkiNode.der,
    publicKey,
    extensions,
    email: subject.email || extensions.emails?.[0] || '',
    selfIssued: bytesEqual(issuer.der, subject.der),
  };
}

/** Parse a list of certificates given as DER bytes, PEM text, or already parsed. */
export function parseCertificateList(list = []) {
  const out = [];
  for (const item of list) {
    try {
      if (item?.tbs) out.push(item);
      else if (typeof item === 'string')
        for (const b of pemBlocks(item)) out.push(parseCertificate(b.der));
      else if (item instanceof Uint8Array || item instanceof ArrayBuffer) {
        const bytes = item instanceof Uint8Array ? item : new Uint8Array(item);
        if (bytes[0] === 0x2d) {
          for (const b of pemBlocks(new TextDecoder().decode(bytes)))
            out.push(parseCertificate(b.der));
        } else out.push(parseCertificate(bytes));
      }
    } catch {
      // Ignore entries that are not certificates.
    }
  }
  return out;
}

/** Whether `issuer`'s key signed `cert`. Resolves false (never throws) when it cannot tell. */
export async function verifyCertificateSignature(cert, issuer) {
  try {
    const scheme = signatureScheme(cert.signatureAlgorithm, null);
    return await verifySignature({
      spki: issuer.spki,
      scheme,
      data: cert.tbs,
      signature: cert.signature,
    });
  } catch {
    return false;
  }
}

export async function fingerprint(cert, hash = 'SHA-256') {
  return hexOf(await digest(hash, cert.der))
    .toUpperCase()
    .match(/../g)
    .join(':');
}

/** A short summary of a certificate for display and reports. */
export function certificateSummary(cert) {
  return {
    subject: cert.subject.text,
    issuer: cert.issuer.text,
    commonName: cert.subject.commonName,
    organization: cert.subject.organization,
    organizationalUnit: cert.subject.organizationalUnit,
    email: cert.email,
    serialNumber: cert.serialHex,
    validFrom: cert.notBefore,
    validTo: cert.notAfter,
    publicKey: cert.publicKey.description,
    keyUsage: cert.extensions.keyUsage || null,
    extendedKeyUsage: cert.extensions.extKeyUsage || null,
    isCA: !!cert.extensions.basicConstraints?.ca,
    selfIssued: cert.selfIssued,
    der: cert.der,
  };
}

/**
 * Whether a certificate may sign others: a certificate authority whose key usage, if stated,
 * includes certificate signing. Certificates older than version 3 have no such extensions.
 */
function mayIssue(cert) {
  const { basicConstraints, keyUsage } = cert.extensions;
  if (!basicConstraints) return cert.version < 3;
  return basicConstraints.ca && (!keyUsage || keyUsage.includes('keyCertSign'));
}
const isIssuerOf = (candidate, cert) => {
  if (!bytesEqual(candidate.subject.der, cert.issuer.der) || !mayIssue(candidate)) return false;
  const aki = cert.extensions.authorityKeyIdentifier;
  const ski = candidate.extensions.subjectKeyIdentifier;
  return !aki || !ski || bytesEqual(aki, ski);
};

/**
 * Build the chain from `leaf` through the `pool` of certificates, checking each link's
 * signature. Returns `{ chain, selfSigned, brokenLink }`: `selfSigned` when the chain ends in
 * a certificate that verifies with its own key; `brokenLink` when an issuer was found by name
 * but its key did not verify the certificate below it.
 */
export async function buildChain(leaf, pool) {
  const chain = [leaf];
  let current = leaf;
  let brokenLink = false;
  for (let guard = 0; guard < 16; guard++) {
    if (current.selfIssued) {
      const selfSigned = await verifyCertificateSignature(current, current);
      return { chain, selfSigned, brokenLink: brokenLink || !selfSigned };
    }
    const candidates = pool.filter((c) => isIssuerOf(c, current) && !chain.includes(c));
    let next = null;
    for (const candidate of candidates)
      if (await verifyCertificateSignature(current, candidate)) {
        next = candidate;
        break;
      }
    if (!next)
      return {
        chain,
        selfSigned: false,
        brokenLink: brokenLink || candidates.length > 0,
      };
    chain.push(next);
    current = next;
  }
  return { chain, selfSigned: false, brokenLink };
}

/**
 * Whether the chain is anchored in one of the trusted certificates: a chain member equals a
 * trusted certificate, or the last member was issued (and signed) by one.
 */
export async function chainTrust(chain, trusted) {
  if (!trusted.length) return { trusted: false, anchor: null };
  for (const cert of chain) {
    const match = trusted.find((t) => bytesEqual(t.der, cert.der));
    if (match) return { trusted: true, anchor: match };
  }
  const last = chain[chain.length - 1];
  for (const t of trusted)
    if (isIssuerOf(t, last) && (await verifyCertificateSignature(last, t)))
      return { trusted: true, anchor: t };
  return { trusted: false, anchor: null };
}

/* ---------- Issuing ---------- */
function nameDer({ name, email, organization, unit, country }) {
  const rdn = (id, value) => set(sequence(oid(id), value));
  const rdns = [];
  if (country) rdns.push(rdn(OID.country, printableString(country.slice(0, 2).toUpperCase())));
  if (organization) rdns.push(rdn(OID.organization, utf8String(organization)));
  if (unit) rdns.push(rdn(OID.organizationalUnit, utf8String(unit)));
  rdns.push(rdn(OID.commonName, utf8String(name)));
  if (email) rdns.push(rdn(OID.emailAddress, ia5String(email)));
  return sequence(...rdns);
}
const extension = (id, critical, value) =>
  sequence(oid(id), critical ? boolean(true) : null, octetString(value));

const KEY_TYPES = {
  'RSA-2048': {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  'RSA-3072': {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 3072,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  'P-256': { name: 'ECDSA', namedCurve: 'P-256' },
  'P-384': { name: 'ECDSA', namedCurve: 'P-384' },
};

/**
 * Generate a key pair and a self-signed X.509 v3 certificate for signing documents, like
 * Acrobat's "new digital ID" (key usage digitalSignature + nonRepudiation, extended key usage
 * emailProtection + Adobe Authentic Documents, basicConstraints CA:false).
 */
export async function createSelfSignedCertificate({
  name,
  email = '',
  organization = '',
  unit = '',
  country = '',
  keyType = 'RSA-2048',
  validityYears = 5,
  notBefore = new Date(),
} = {}) {
  if (!name || !String(name).trim()) throw new Error('A digital ID needs a name.');
  const params = KEY_TYPES[keyType];
  if (!params) throw new Error(`Unsupported key type ${keyType}.`);
  const keys = await subtle().generateKey(params, true, ['sign', 'verify']);
  const spki = new Uint8Array(await subtle().exportKey('spki', keys.publicKey));
  const subjectKey = decodeDer(spki).child(1).bits().bytes;
  const keyId = await digest('SHA-1', subjectKey);
  const start = new Date(Math.floor(notBefore.getTime() / 1000) * 1000);
  const end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + Math.max(1, Math.min(100, Math.round(validityYears))));
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  serial[0] |= 0x40;
  const subject = nameDer({
    name: String(name).trim(),
    email,
    organization,
    unit,
    country,
  });
  const signatureAlgorithm = signatureAlgorithmFor(keys.privateKey);
  const extensions = [
    extension(OID.basicConstraints, true, sequence()),
    // digitalSignature (bit 0) and nonRepudiation (bit 1): one byte, six unused bits.
    extension(OID.keyUsage, true, bitString(Uint8Array.of(0xc0), 6)),
    extension(
      OID.extKeyUsage,
      false,
      sequence(oid(OID.emailProtection), oid(OID.adobeAuthenticDocuments)),
    ),
    extension(OID.subjectKeyIdentifier, false, octetString(keyId)),
    extension(OID.authorityKeyIdentifier, false, sequence(implicit(0, keyId, false))),
  ];
  if (email)
    extensions.push(
      extension(OID.subjectAltName, false, sequence(tlv(0x81, new TextEncoder().encode(email)))),
    );
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(serial),
    signatureAlgorithm,
    subject,
    sequence(x509Time(start), x509Time(end)),
    subject,
    spki,
    explicit(3, sequence(...extensions)),
  );
  const signature = await signData(keys.privateKey, tbs);
  const der = sequence(tbs, signatureAlgorithm, bitString(signature));
  return {
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    certificate: der,
  };
}
