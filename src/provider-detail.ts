import type { SentVoiceError } from './errors';

// The raw provider error behind a SentVoiceError. Apps log and inspect the error and must not learn which
// provider is behind it, so the detail is kept here instead of on the error, and only the SDK's telemetry
// reads it. This file is not a package entry point.
const details = new WeakMap<SentVoiceError, unknown>();

export const attachProviderDetail = (error: SentVoiceError, detail: unknown): void => {
  if (detail !== undefined) details.set(error, detail);
};

export const providerDetailOf = (error: SentVoiceError): unknown => details.get(error);
