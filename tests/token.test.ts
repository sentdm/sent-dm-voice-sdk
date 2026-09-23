import { TokenInvalidError } from '@sentdm/voice/errors';
import { decodeToken } from '@sentdm/voice/token';
import { issuer, prefix, voiceToken } from './voice-token';

const payload = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('decodeToken', () => {
  test('reads the prefix and identity from the userId, the bound number, and iat and exp in ms', () => {
    const jwt = voiceToken({ iat: 1_790_078_400, exp: 1_790_079_000 });

    expect(decodeToken(jwt)).toEqual({
      jwt,
      prefix,
      identity: 'agent-42',
      number: '+38349111222',
      issuedAt: 1_790_078_400_000,
      expiresAt: 1_790_079_000_000,
    });
  });

  test('the prefix ends at the first =', () => {
    const { prefix, identity } = decodeToken(voiceToken({ sub: `${issuer}/users/k3x9=agent=42` }));

    expect({ prefix, identity }).toEqual({ prefix: 'k3x9', identity: 'agent=42' });
  });

  test.each<[string, unknown]>([
    ['is not a string', { token: voiceToken() }],
    ['does not have three parts', voiceToken().split('.').slice(0, 2).join('.')],
    ['has a payload that is not base64url JSON', 'eyJhbGciOiJIUzI1NiJ9.bm90IGpzb24.c2ln'],
    ['has a payload that is not an object', `eyJhbGciOiJIUzI1NiJ9.${payload(42)}.c2ln`],
    ['has no iat', voiceToken({ iat: undefined })],
    ['has an exp that is not a number', voiceToken({ exp: '1790079000' })],
    ['expires when it is issued', voiceToken({ iat: 1_790_078_400, exp: 1_790_078_400 })],
    ['has a subject outside its issuer', voiceToken({ sub: `//elsewhere/users/${prefix}=agent-42` })],
    ['has a userId without a prefix', voiceToken({ sub: `${issuer}/users/agent-42` })],
    ['has an empty prefix', voiceToken({ sub: `${issuer}/users/=agent-42` })],
    ['has an empty identity', voiceToken({ sub: `${issuer}/users/${prefix}=` })],
    ['has no bound number', voiceToken({ 'sent:number': undefined })],
    ['has an empty bound number', voiceToken({ 'sent:number': '' })],
  ])('a token that %s is a TokenInvalidError', (_, jwt) => {
    expect(() => decodeToken(jwt)).toThrow(TokenInvalidError);
  });
});
