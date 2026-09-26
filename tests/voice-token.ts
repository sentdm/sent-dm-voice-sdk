export const prefix = '0f8fad5b-d9cb-469f-a165-70867728950e';
export const issuer = '//rtc.sinch.com/applications/0bb6f5e2-5ad1-4c3b-8b1b-5a0c1d2e3f40';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A token shaped like the ones `POST /v3/channels/voice/tokens` mints, issued now and valid for 600 s. */
export function voiceToken(claims: Record<string, unknown> = {}): string {
  const iat = Math.floor(Date.now() / 1000);
  return [
    encode({ alg: 'HS256', typ: 'JWT', kid: 'hkdfv1-20260922' }),
    encode({
      iss: issuer,
      sub: `${issuer}/users/${prefix}_agent-42`,
      iat,
      exp: iat + 600,
      nonce: '9f86d081884c7d659a2feaa0c55ad015',
      'sent:number': '+38349111222',
      ...claims,
    }),
    encode('signature'),
  ].join('.');
}
