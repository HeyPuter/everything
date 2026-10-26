import { describe, expect, it } from 'vitest';
import { tokenClaims } from '../../src/shared/token.js';

const encode = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

describe('tokenClaims', () => {
  it('reads the long token shape as is', () => {
    expect(tokenClaims(encode({ type: 'access-token', user_uid: '35f24693-88b5-4e85-a074-a24468abce47', exp: 5 })))
      .toMatchObject({ type: 'access-token', user_uid: '35f24693-88b5-4e85-a074-a24468abce47', exp: 5 });
  });
  it('unpacks the compact v2 shape: t for the type, uu and au as base64 UUID bytes', () => {
    const claims = tokenClaims(encode({ t: 't', v: '2', uu: 'NfJGk4i1ToWgdKJEaKvORw==', au: 'JhSfC4MEUii5lXctrc9BDg==', iat: 1, exp: 2 }));
    expect(claims).toMatchObject({ type: 'access-token', user_uid: '35f24693-88b5-4e85-a074-a24468abce47', app_uid: '26149f0b-8304-5228-b995-772dadcf410e', exp: 2 });
  });
  it('rejects malformed input and tokens that mix both shapes', () => {
    expect(tokenClaims('not a token')).toEqual({});
    expect(tokenClaims(encode({ t: 't', type: 'session' }))).toEqual({});
    expect(tokenClaims(encode({ t: 't', uu: 'short' })).user_uid).toBeUndefined();
  });
});
