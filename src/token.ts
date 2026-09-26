import { NetworkError, TokenInvalidError } from './errors';

export interface VoiceToken {
  jwt: string;
  prefix: string;
  identity: string;
  number: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * A provider-side id is `{prefix}_{name}`: the account's id, one underscore, the bare name. Readers
 * split on the first `_`: an account id never contains one while names may, so the prefix is opaque
 * here and nothing depends on its length or shape. The separator used to be `=`, which the calling
 * provider's library percent-encodes and then signs a second time, so every signed request was
 * refused; letters, digits, `-` and `_` are never encoded.
 */
const separator = '_';

/** The id the provider knows a user or room by. */
export const qualify = (prefix: string, name: string): string => `${prefix}${separator}${name}`;

/** The bare name behind one of this account's ids, or undefined when the id is not one of ours. */
export function unqualify(prefix: string, qualified: string): string | undefined {
  const head = `${prefix}${separator}`;
  return qualified.length > head.length && qualified.startsWith(head) ?
      qualified.slice(head.length)
    : undefined;
}

const refreshShare = 0.8;
const refreshMargin = 30_000;
const initialRetryDelay = 500;
const maxRetryDelay = 8_000;
const offlineRetryInterval = 30_000;

export async function fetchToken(tokenProvider: () => Promise<string>): Promise<VoiceToken> {
  let jwt: unknown;
  try {
    jwt = await tokenProvider();
  } catch {
    throw new NetworkError({ message: 'The token provider failed to fetch a voice token.' });
  }
  return decodeToken(jwt);
}

export function decodeToken(jwt: unknown): VoiceToken {
  if (typeof jwt !== 'string') throw new TokenInvalidError();

  const { iss, sub, iat, exp, 'sent:number': number } = readClaims(jwt);
  const users = `${iss}/users/`;
  const userId =
    typeof iss === 'string' && typeof sub === 'string' && sub.startsWith(users) ?
      sub.slice(users.length)
    : '';
  const separatorAt = userId.indexOf(separator);
  const prefix = separatorAt > 0 ? userId.slice(0, separatorAt) : '';
  const identity = separatorAt > 0 ? userId.slice(separatorAt + 1) : '';

  if (
    typeof iat !== 'number' ||
    typeof exp !== 'number' ||
    exp <= iat ||
    typeof number !== 'string' ||
    !number ||
    !prefix ||
    !identity
  ) {
    throw new TokenInvalidError();
  }

  return {
    jwt,
    prefix,
    identity,
    number,
    issuedAt: iat * 1000,
    expiresAt: exp * 1000,
  };
}

export function refreshDelay({ issuedAt, expiresAt }: VoiceToken): number {
  const lifetime = expiresAt - issuedAt;
  return Math.max(Math.min(lifetime * refreshShare, lifetime - refreshMargin), lifetime / 2);
}

export function retryDelay(retry: number): number {
  return Math.min(initialRetryDelay * 2 ** retry, maxRetryDelay) * jitter();
}

export function offlineRetryDelay(): number {
  return offlineRetryInterval * jitter();
}

function jitter(): number {
  return 1 - Math.random() * 0.25;
}

export function readClaims(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  const payload = parts.length === 3 ? parts[1] : undefined;
  if (payload === undefined) return {};

  try {
    const claims: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof claims === 'object' && claims !== null ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
