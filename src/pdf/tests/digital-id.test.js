import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OID,
  bytesOfHex,
  decodeDer,
  generalizedTime,
  hexOf,
  integer,
  octetString,
  oid,
  pemBlocks,
  sequence,
  setOf,
  toPem,
  utcTime,
  utf8String,
} from '../src/core/asn1.js';
import {
  desCbcDecrypt,
  desCbcEncrypt,
  desEncryptBlock,
  rc2CbcDecrypt,
  rc2CbcEncrypt,
  rc2EncryptBlock,
} from '../src/core/legacy-ciphers.js';
import { hashSync } from '../src/core/sha.js';
import { buildChain, chainTrust, parseCertificate } from '../src/core/x509.js';
import { Pkcs12PasswordError, exportPkcs12, importPkcs12 } from '../src/core/pkcs12.js';
import { createSelfSignedId, describeIdentity } from '../src/core/digital-signature.js';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const scratch = () => mkdtempSync(join(tmpdir(), 'digital-id-'));
const openssl = (args, options = {}) =>
  execFileSync('openssl', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });

describe('ASN.1 DER', () => {
  it('round-trips integers of every sign and size', () => {
    for (const value of [
      0n,
      1n,
      127n,
      128n,
      255n,
      256n,
      -1n,
      -128n,
      -129n,
      -256n,
      2n ** 64n + 5n,
      -(2n ** 70n),
    ]) {
      expect(decodeDer(integer(value)).bigInt()).toBe(value);
    }
    expect(hexOf(integer(128))).toBe('02020080');
    expect(hexOf(integer(-129))).toBe('0202ff7f');
    expect(hexOf(integer(Uint8Array.of(0, 0, 0x80)))).toBe('02020080');
  });

  it('round-trips object identifiers and strings', () => {
    for (const id of [
      '1.2.840.113549.1.7.2',
      '2.16.840.1.101.3.4.2.1',
      '1.2.840.113583.1.1.5',
      '2.999.3',
    ])
      expect(decodeDer(oid(id)).oid()).toBe(id);
    expect(decodeDer(utf8String('Zoë 签名')).string()).toBe('Zoë 签名');
  });

  it('reads UTCTime and GeneralizedTime', () => {
    const date = new Date(Date.UTC(2031, 4, 6, 7, 8, 9));
    expect(decodeDer(utcTime(date)).time().getTime()).toBe(date.getTime());
    expect(decodeDer(generalizedTime(date)).time().getTime()).toBe(date.getTime());
    expect(
      decodeDer(Uint8Array.from([0x17, 13, ...Buffer.from('991231235959Z')]))
        .time()
        .getUTCFullYear(),
    ).toBe(1999);
  });

  it('sorts SET OF and ignores trailing padding', () => {
    const set = setOf([oid('2.5.4.3'), integer(5), oid('1.2.3')]);
    expect(decodeDer(set).children.map((kid) => kid.tag)).toEqual([0x02, 0x06, 0x06]);
    const padded = new Uint8Array(set.length + 40);
    padded.set(set);
    expect(decodeDer(padded).end).toBe(set.length);
  });

  it('reads BER indefinite lengths and constructed strings', () => {
    // A SEQUENCE (indefinite) holding a constructed OCTET STRING (indefinite) of two parts.
    const ber = bytesOfHex('3080' + '2480' + '040161' + '04026263' + '0000' + '0000');
    const node = decodeDer(ber);
    expect(node.end).toBe(ber.length);
    expect(new TextDecoder().decode(node.child(0).octets())).toBe('abc');
    // An unterminated indefinite length is an error.
    expect(() => decodeDer(bytesOfHex('3080040161'))).toThrow();
  });

  it('rejects malformed input with errors, not crashes', () => {
    for (const hex of ['', '30', '3005020101', '3084ffffffff', '1f'])
      expect(() => decodeDer(bytesOfHex(hex)).children).toThrow();
  });

  it('reads and writes PEM', () => {
    const der = sequence(integer(42));
    const blocks = pemBlocks(`junk\n${toPem('CERTIFICATE', der)}more`);
    expect(blocks).toHaveLength(1);
    expect(hexOf(blocks[0].der)).toBe(hexOf(der));
  });
});

describe('legacy ciphers', () => {
  it('match DES and RC2 known answers', () => {
    expect(
      hexOf(desEncryptBlock(bytesOfHex('133457799BBCDFF1'), bytesOfHex('0123456789ABCDEF'))),
    ).toBe('85e813540f0ab405');
    expect(hexOf(rc2EncryptBlock(bytesOfHex('0000000000000000'), new Uint8Array(8), 63))).toBe(
      'ebb773f993278eff',
    );
    expect(
      hexOf(rc2EncryptBlock(bytesOfHex('ffffffffffffffff'), bytesOfHex('ffffffffffffffff'), 64)),
    ).toBe('278b27e42e2f0d49');
    expect(
      hexOf(
        rc2EncryptBlock(bytesOfHex('88bca90e90875a7f0f79c384627bafb2'), new Uint8Array(8), 128),
      ),
    ).toBe('2269552ab0f85ca6');
  });

  it('round-trip CBC with padding', () => {
    const data = randomBytes(37);
    const iv = randomBytes(8);
    const key = randomBytes(24);
    expect(Buffer.from(desCbcDecrypt(key, iv, desCbcEncrypt(key, iv, data)))).toEqual(data);
    const rc2Key = randomBytes(5);
    expect(Buffer.from(rc2CbcDecrypt(rc2Key, iv, rc2CbcEncrypt(rc2Key, iv, data, 40), 40))).toEqual(
      data,
    );
  });

  it.skipIf(!hasOpenssl)('agree with OpenSSL', () => {
    const data = Buffer.from('hello world, this is a test of cbc');
    const key = '0123456789abcdef23456789abcdef01456789abcdef0123';
    const iv = '1122334455667788';
    const des = openssl(['enc', '-des-ede3-cbc', '-K', key, '-iv', iv], {
      input: data,
    });
    expect(hexOf(desCbcEncrypt(bytesOfHex(key), bytesOfHex(iv), data))).toBe(des.toString('hex'));
    const rc2 = spawnSync(
      'openssl',
      [
        'enc',
        '-provider',
        'legacy',
        '-provider',
        'default',
        '-rc2-40-cbc',
        '-K',
        '0102030405',
        '-iv',
        iv,
      ],
      {
        input: data,
      },
    );
    if (rc2.status === 0)
      expect(hexOf(rc2CbcEncrypt(bytesOfHex('0102030405'), bytesOfHex(iv), data, 40))).toBe(
        rc2.stdout.toString('hex'),
      );
  });
});

describe('synchronous SHA', () => {
  it('matches node:crypto', () => {
    for (const length of [0, 3, 55, 56, 64, 111, 112, 128, 1000]) {
      const data = randomBytes(length);
      for (const [name, node] of [
        ['SHA-1', 'sha1'],
        ['SHA-256', 'sha256'],
        ['SHA-384', 'sha384'],
        ['SHA-512', 'sha512'],
      ])
        expect(hexOf(hashSync(name, data))).toBe(createHash(node).update(data).digest('hex'));
    }
  });
});

describe('digital IDs', () => {
  for (const keyType of ['RSA-2048', 'P-256']) {
    it(`creates a self-signed ${keyType} certificate for document signing`, async () => {
      const id = await createSelfSignedId({
        name: 'Jane Signer',
        email: 'jane@example.com',
        organization: 'Acme',
        unit: 'Legal',
        country: 'us',
        keyType,
        validityYears: 3,
      });
      const cert = parseCertificate(id.certificate);
      expect(cert.version).toBe(3);
      expect(cert.subject.commonName).toBe('Jane Signer');
      expect(cert.subject.organization).toBe('Acme');
      expect(cert.subject.country).toBe('US');
      expect(cert.email).toBe('jane@example.com');
      expect(cert.selfIssued).toBe(true);
      expect(cert.extensions.keyUsage).toEqual(['digitalSignature', 'nonRepudiation']);
      expect(cert.extensions.extKeyUsage).toEqual([
        OID.emailProtection,
        OID.adobeAuthenticDocuments,
      ]);
      expect(cert.extensions.basicConstraints).toEqual({
        ca: false,
        pathLength: null,
      });
      expect(cert.extensions.subjectKeyIdentifier).toHaveLength(20);
      expect(cert.notAfter.getUTCFullYear() - cert.notBefore.getUTCFullYear()).toBe(3);
      expect(cert.publicKey.type).toBe(keyType === 'P-256' ? 'EC' : 'RSA');
      const chain = await buildChain(cert, []);
      expect(chain.selfSigned).toBe(true);
      expect((await chainTrust(chain.chain, [cert])).trusted).toBe(true);
      expect(describeIdentity(id).commonName).toBe('Jane Signer');
      if (hasOpenssl) {
        const dir = scratch();
        writeFileSync(join(dir, 'c.der'), id.certificate);
        const text = openssl([
          'x509',
          '-inform',
          'DER',
          '-in',
          join(dir, 'c.der'),
          '-noout',
          '-text',
        ]).toString();
        expect(text).toContain('Digital Signature, Non Repudiation');
        expect(text).toContain('E-mail Protection, 1.2.840.113583.1.1.5');
        expect(text).toContain('CA:FALSE');
        writeFileSync(join(dir, 'c.pem'), toPem('CERTIFICATE', id.certificate));
        // The certificate's own signature verifies.
        expect(
          openssl(['verify', '-CAfile', join(dir, 'c.pem'), join(dir, 'c.pem')]).toString(),
        ).toContain('OK');
      }
    });
  }

  it('refuses a digital ID without a name', async () => {
    await expect(createSelfSignedId({ name: '  ' })).rejects.toThrow(/name/);
  });
});

describe('PKCS#12', () => {
  it('exports and imports a digital ID (PBES2 and legacy)', async () => {
    const id = await createSelfSignedId({
      name: 'Round Trip',
      keyType: 'P-256',
    });
    for (const legacy of [false, true]) {
      const p12 = await exportPkcs12(id, 'pa55 wörd', { legacy });
      const back = await importPkcs12(p12, 'pa55 wörd');
      expect(hexOf(back.certificate)).toBe(hexOf(id.certificate));
      expect(back.privateKey.algorithm.name).toBe('ECDSA');
      expect(back.friendlyName).toBe('Round Trip');
      await expect(importPkcs12(p12, 'wrong')).rejects.toBeInstanceOf(Pkcs12PasswordError);
    }
  });

  it('tells a wrong password apart from an unsupported PBMAC1 integrity check', async () => {
    const { errorText } = await import('../src/digital-id-dialog.js');
    const id = await createSelfSignedId({ name: 'PBMAC1', keyType: 'P-256' });
    const p12 = await exportPkcs12(id, 'secret');
    const wrong = await importPkcs12(p12, 'nope').catch((error) => error);
    expect(errorText(wrong)).toMatch(/password is not right/);
    // RFC 9579 PBMAC1 whose PBKDF2 uses a PRF this app does not know.
    const pfx = decodeDer(p12);
    const salt = randomBytes(16);
    const pbmac1 = sequence(
      oid(OID.pbmac1),
      sequence(
        sequence(
          oid(OID.pbkdf2),
          sequence(octetString(salt), integer(2048), integer(32), sequence(oid('1.2.3.4.5'))),
        ),
        sequence(oid(OID.hmacSHA256)),
      ),
    );
    const crafted = sequence(
      pfx.child(0).der,
      pfx.child(1).der,
      sequence(sequence(pbmac1, octetString(new Uint8Array(32))), octetString(salt), integer(1)),
    );
    const unsupported = await importPkcs12(crafted, 'secret').catch((error) => error);
    expect(unsupported.message).toBe('Unsupported PBMAC1 algorithm.');
    expect(errorText(unsupported)).toBe('Unsupported PBMAC1 algorithm.');
  });

  it('rejects files that are not PKCS#12', async () => {
    await expect(importPkcs12(new Uint8Array([1, 2, 3]), 'x')).rejects.toThrow(/PKCS#12/);
  });

  it.skipIf(!hasOpenssl)(
    'imports OpenSSL files: default (AES), -legacy (3DES/RC2-40), empty password, SHA-512 MAC',
    async () => {
      const dir = scratch();
      const run = (args) => openssl(args, { cwd: dir });
      run([
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        'rsa.key',
        '-out',
        'rsa.crt',
        '-days',
        '30',
        '-subj',
        '/CN=OpenSSL RSA/O=Test Org',
      ]);
      run([
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-384',
        '-nodes',
        '-keyout',
        'ec.key',
        '-out',
        'ec.crt',
        '-days',
        '30',
        '-subj',
        '/CN=OpenSSL EC',
      ]);
      const variants = [
        ['rsa-modern.p12', 'rsa', 'secret', []],
        ['rsa-legacy.p12', 'rsa', 'secret', ['-legacy']],
        ['rsa-empty.p12', 'rsa', '', []],
        ['ec-legacy.p12', 'ec', 'secret', ['-legacy']],
        [
          'ec-sha512.p12',
          'ec',
          'secret',
          ['-macalg', 'sha512', '-keypbe', 'AES-128-CBC', '-certpbe', 'AES-128-CBC'],
        ],
      ];
      for (const [file, key, password, extra] of variants) {
        const made = spawnSync(
          'openssl',
          [
            'pkcs12',
            '-export',
            ...extra,
            '-in',
            `${key}.crt`,
            '-inkey',
            `${key}.key`,
            '-out',
            file,
            '-passout',
            `pass:${password}`,
          ],
          { cwd: dir },
        );
        if (made.status !== 0) continue; // e.g. no legacy provider
        const id = await importPkcs12(new Uint8Array(readFileSync(join(dir, file))), password);
        expect(parseCertificate(id.certificate).subject.commonName).toBe(
          key === 'rsa' ? 'OpenSSL RSA' : 'OpenSSL EC',
        );
        expect(id.privateKey.algorithm.name).toBe(key === 'rsa' ? 'RSASSA-PKCS1-v1_5' : 'ECDSA');
      }
    },
  );

  it.skipIf(!hasOpenssl)('exports files OpenSSL reads (MAC, certificate and key)', async () => {
    const dir = scratch();
    const id = await createSelfSignedId({
      name: 'Exported Signer',
      keyType: 'RSA-2048',
    });
    for (const legacy of [false, true]) {
      const file = join(dir, legacy ? 'legacy.p12' : 'modern.p12');
      writeFileSync(file, await exportPkcs12(id, 'secret', { legacy }));
      const info = spawnSync(
        'openssl',
        ['pkcs12', '-info', '-nokeys', '-in', file, '-passin', 'pass:secret'],
        { encoding: 'utf8' },
      );
      expect(info.status).toBe(0);
      expect(info.stdout + info.stderr).toContain(legacy ? 'MAC: sha1' : 'MAC: sha256');
      // OpenSSL 3.0 prints "CN = Exported Signer", later versions "CN=Exported Signer".
      expect(info.stdout).toMatch(/CN ?= ?Exported Signer/);
      const keyOut = spawnSync(
        'openssl',
        ['pkcs12', '-in', file, '-nocerts', '-nodes', '-passin', 'pass:secret'],
        { encoding: 'utf8' },
      );
      expect(keyOut.status).toBe(0);
      expect(keyOut.stdout).toContain('BEGIN PRIVATE KEY');
      const bad = spawnSync('openssl', [
        'pkcs12',
        '-info',
        '-nokeys',
        '-in',
        file,
        '-passin',
        'pass:nope',
      ]);
      expect(bad.status).not.toBe(0);
    }
  });
});
