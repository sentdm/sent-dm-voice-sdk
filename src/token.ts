import { NetworkError, TokenInvalidError } from './errors';

export interface VoiceToken {
  jwt: string;
  prefix: string;
  identity: string;
  number: string;
  issuedAt: number;
  expiresAt: number;
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
  const separator = userId.indexOf('=');

  if (
    typeof iat !== 'number' ||
    typeof exp !== 'number' ||
    exp <= iat ||
    typeof number !== 'string' ||
    !number ||
    separator < 1 ||
    separator === userId.length - 1
  ) {
    throw new TokenInvalidError();
  }

  return {
    jwt,
    prefix: userId.slice(0, separator),
    identity: userId.slice(separator + 1),
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
