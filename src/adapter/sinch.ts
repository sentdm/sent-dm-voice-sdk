/// <reference lib="dom" />
import type { Call, CallClient, CallListener, SinchClient } from 'sinch-rtc';
import type { CallStats } from '../call';
import {
  CapabilityUnsupportedError,
  MediaPermissionError,
  NetworkError,
  NotRegisteredError,
  SentVoiceError,
} from '../errors';
import { readClaims } from '../token';
import type {
  AdapterFactory,
  AdapterOptions,
  CallEvent,
  CallTarget,
  IncomingCall,
  ProviderAdapter,
} from './types';

type Sinch = typeof import('sinch-rtc');
type StatsCall = Call & { getPeerConnectionStats(): Promise<RTCStatsReport | null> };

const environmentHost = 'ocra-euc1.api.sinch.com';
const applicationPrefix = '//rtc.sinch.com/applications/';

const providerError = (error: unknown): SentVoiceError =>
  error instanceof SentVoiceError ? error : (
    new SentVoiceError({
      code: 'UNKNOWN',
      category: 'signaling',
      retriable: false,
      message: 'An unexpected calling error occurred.',
      providerDetail: error,
    })
  );

const rethrow = (error: unknown): never => {
  throw providerError(error);
};

const guard = <T>(action: () => T): T => {
  try {
    return action();
  } catch (error) {
    return rethrow(error);
  }
};

export const loadSinchAdapter: AdapterFactory = async (options) =>
  new SinchAdapter(await import('sinch-rtc'), options);

class SinchAdapter implements ProviderAdapter {
  #sinch: Sinch;
  #options: AdapterOptions;
  #client: SinchClient | undefined;
  #token = '';
  #inputDeviceId: string | undefined;
  #audio: HTMLAudioElement | undefined;
  #calls = new Map<string, Call>();
  #incomingListeners: Array<(call: IncomingCall) => void> = [];
  #callEventListeners: Array<(event: CallEvent) => void> = [];

  constructor(sinch: Sinch, options: AdapterOptions) {
    this.#sinch = sinch;
    this.#options = options;
  }

  async register(token: string): Promise<void> {
    this.#token = token;
    this.#client ??= await this.#start(token).catch(rethrow);
  }

  async unregister(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    if (client) await this.#stop(client).catch(rethrow);
  }

  async call(target: CallTarget): Promise<string> {
    const { callClient } = this.#started();
    const placing =
      target.kind === 'user' ? callClient.callUser(target.id) : callClient.callPhoneNumber(target.number);
    const call = await placing.catch(rethrow);
    this.#play(call);
    return this.#track(call);
  }

  async joinConference(room: string): Promise<string> {
    const call = await this.#started().callClient.callConference(room).catch(rethrow);
    this.#play(call);
    return this.#track(call);
  }

  async answer(callId: string): Promise<void> {
    const call = this.#calls.get(callId);
    if (!call) return;
    await call.answer().catch((error: unknown) => {
      throw new MediaPermissionError({ providerDetail: error });
    });
    this.#play(call);
  }

  async reject(callId: string): Promise<void> {
    return this.hangup(callId);
  }

  async hangup(callId: string): Promise<void> {
    guard(() => this.#calls.get(callId)?.hangup());
  }

  mute(callId: string, muted: boolean): void {
    const call = this.#calls.get(callId);
    if (muted) call?.mute();
    else call?.unmute();
  }

  sendDigits(callId: string, digits: string): void {
    guard(() => this.#calls.get(callId)?.sendDtmf(digits));
  }

  async getStats(callId: string): Promise<CallStats> {
    const call = this.#calls.get(callId) as StatsCall | undefined;
    const report = await call?.getPeerConnectionStats();
    const stats = { jitter: 0, packetLoss: 0, rtt: 0 };
    report?.forEach((entry) => {
      if (entry.type === 'inbound-rtp' && entry.kind === 'audio') {
        const lost = Math.max(0, entry.packetsLost ?? 0);
        const packets = lost + (entry.packetsReceived ?? 0);
        stats.jitter = (entry.jitter ?? 0) * 1000;
        stats.packetLoss = packets > 0 ? lost / packets : 0;
      } else if (entry.type === 'candidate-pair' && entry.state === 'succeeded') {
        stats.rtt = (entry.currentRoundTripTime ?? 0) * 1000;
      }
    });
    return stats;
  }

  onIncoming(listener: (call: IncomingCall) => void): void {
    this.#incomingListeners.push(listener);
  }

  onCallEvent(listener: (event: CallEvent) => void): void {
    this.#callEventListeners.push(listener);
  }

  async setInputDevice(deviceId: string): Promise<void> {
    this.#inputDeviceId = deviceId;
    if (this.#client?.isStarted()) this.#useInput(this.#client.callClient, deviceId);
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    const audio = this.#playback();
    if (!('setSinkId' in audio)) {
      throw new CapabilityUnsupportedError({
        message: 'Choosing the audio output device is not supported by this browser.',
      });
    }
    await audio.setSinkId(deviceId).catch(rethrow);
  }

  async #start(token: string): Promise<SinchClient> {
    const { iss, sub } = readClaims(token) as Record<'iss' | 'sub', string>;
    const client = this.#sinch.Sinch.getSinchClientBuilder()
      .applicationKey(iss.slice(applicationPrefix.length))
      .userId(sub.slice(`${iss}/users/`.length))
      .environmentHost(environmentHost)
      .build();
    const { url, scope } = this.#options.serviceWorker ?? {};

    try {
      await new Promise<void>((resolve, reject) => {
        client.addListener({
          onCredentialsRequired: (_, registration) => void registration.register(this.#token),
          onClientStarted: ({ callClient }) => {
            callClient.addListener({ onIncomingCall: (_, call) => this.#receive(call) });
            if (this.#inputDeviceId !== undefined) this.#useInput(callClient, this.#inputDeviceId);
            resolve();
          },
          onClientFailed: (_, error) => reject(error),
        });
        client
          .setSupportManagedPush(url, scope === undefined ? undefined : { scope })
          .then(() => client.start(), reject);
      });
    } catch (error) {
      await this.#stop(client).catch(() => {});
      throw error;
    }
    return client;
  }

  async #stop(client: SinchClient): Promise<void> {
    try {
      await client.disableManagedPushSupport();
    } finally {
      client.terminate();
    }
  }

  #started(): SinchClient {
    if (!this.#client) throw new NotRegisteredError();
    return this.#client;
  }

  #useInput(callClient: CallClient, deviceId: string): void {
    callClient.setAudioTrackConstraints({ deviceId: { exact: deviceId } });
  }

  #playback(): HTMLAudioElement {
    return (this.#audio ??= this.#options.audioElement ?? new Audio());
  }

  #play(call: Call): void {
    const audio = this.#playback();
    audio.autoplay = true;
    audio.srcObject = call.incomingStream ?? null;
  }

  #receive(call: Call): void {
    this.#track(call);
    for (const listener of this.#incomingListeners) listener({ callId: call.id, from: call.remoteUserId });
  }

  #track(call: Call): string {
    const listener: CallListener = {
      onCallProgressing: () => this.#emit({ callId: call.id, type: 'ringing' }),
      onCallAnswered: () => this.#emit({ callId: call.id, type: 'answered' }),
      onCallEstablished: () => this.#emit({ callId: call.id, type: 'connected' }),
      onCallEnded: () => {
        call.removeListener(listener);
        this.#calls.delete(call.id);
        if (this.#audio && this.#audio.srcObject === call.incomingStream) this.#audio.srcObject = null;
        this.#emit(this.#ended(call));
      },
    };
    call.addListener(listener);
    this.#calls.set(call.id, call);
    return call.id;
  }

  #ended({ id: callId, details: { endCause, error } }: Call): CallEvent {
    const { CallEndCause, ErrorType } = this.#sinch;
    switch (endCause) {
      case CallEndCause.Denied:
        return { callId, type: 'ended', reason: 'busy' };
      case CallEndCause.NoAnswer:
      case CallEndCause.Timeout:
        return { callId, type: 'ended', reason: 'noAnswer' };
      case CallEndCause.Inactive:
        return {
          callId,
          type: 'ended',
          reason: 'failed',
          error: new NetworkError({ providerDetail: error }),
        };
      case CallEndCause.Failure:
        if (!error) return { callId, type: 'ended', reason: 'failed' };
        return {
          callId,
          type: 'ended',
          reason: 'failed',
          error:
            error.domain === ErrorType.Network ?
              new NetworkError({ providerDetail: error })
            : providerError(error),
        };
      default:
        return { callId, type: 'ended', reason: 'completed' };
    }
  }

  #emit(event: CallEvent): void {
    for (const listener of this.#callEventListeners) listener(event);
  }
}
