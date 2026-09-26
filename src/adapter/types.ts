/// <reference lib="dom" />
import type { CallStats, QualityWarning } from '../call';
import type { SentVoiceError } from '../errors';

/**
 * The seam between the SDK core and a calling provider. It covers only what the public surface
 * needs and must never be reachable from a public entry point.
 *
 * - Ids are wire ids: the core adds and strips the tenant prefix, so user ids, room names and
 *   incoming `from` values are already namespaced.
 * - `register` while registered hands the provider a fresh token.
 * - Every failure is a `SentVoiceError`. A provider error without a mapping becomes one with code
 *   `UNKNOWN`, category `signaling` and the raw error kept as provider detail, which only telemetry reads.
 * - Calls are identified by the provider call id. Their events start once the id is known from
 *   `call`, `joinConference` or `onIncoming`, and `ended` is the last event of every call,
 *   including one ended by `reject` or `hangup`.
 * - `reject` declines an incoming call that has not been answered.
 * - Stats report jitter and rtt in milliseconds and packetLoss as a fraction between 0 and 1.
 */
export interface ProviderAdapter {
  register(token: string): Promise<void>;
  unregister(): Promise<void>;
  call(target: CallTarget): Promise<string>;
  joinConference(room: string): Promise<string>;
  answer(callId: string): Promise<void>;
  reject(callId: string): Promise<void>;
  hangup(callId: string): Promise<void>;
  mute(callId: string, muted: boolean): void;
  sendDigits(callId: string, digits: string): void;
  getStats(callId: string): Promise<CallStats>;
  onIncoming(listener: (call: IncomingCall) => void): void;
  onCallEvent(listener: (event: CallEvent) => void): void;
  setInputDevice(deviceId: string): Promise<void>;
  setOutputDevice(deviceId: string): Promise<void>;
}

export type AdapterFactory = (options: AdapterOptions) => Promise<ProviderAdapter>;

export interface AdapterOptions {
  serviceWorker?: { url?: string | undefined; scope?: string | undefined } | undefined;
  audioElement?: HTMLAudioElement | undefined;
}

export type CallTarget = { kind: 'user'; id: string } | { kind: 'number'; number: string };

export interface IncomingCall {
  callId: string;
  from: string;
}

export type CallEvent =
  | { callId: string; type: 'ringing' }
  | { callId: string; type: 'answered' }
  | { callId: string; type: 'connected' }
  | { callId: string; type: 'reconnecting' }
  | { callId: string; type: 'reconnected' }
  | { callId: string; type: 'qualityWarning'; warning: QualityWarning }
  | {
      callId: string;
      type: 'ended';
      reason: 'completed' | 'failed' | 'busy' | 'noAnswer';
      error?: SentVoiceError;
    };
