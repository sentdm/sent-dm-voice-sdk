import type { CallEvent, CallTarget, IncomingCall, ProviderAdapter } from '@sentdm/voice/adapter/types';
import type { CallStats } from '@sentdm/voice/call';
import type { SentVoiceError } from '@sentdm/voice/errors';

type Step<Event> = Event extends CallEvent ? Omit<Event, 'callId'> & { after?: number } : never;

/** Steps play in order, each `after` milliseconds (default 0) after the previous one. */
export type CallScript = Step<CallEvent>[];

export type FailableMethod = Exclude<keyof ProviderAdapter, 'onIncoming' | 'onCallEvent'>;

export class MockAdapter implements ProviderAdapter {
  #incomingListeners: Array<(call: IncomingCall) => void> = [];
  #callEventListeners: Array<(event: CallEvent) => void> = [];
  #failures = new Map<FailableMethod, SentVoiceError[]>();
  #scripts: CallScript[] = [];
  #calls = new Map<string, ReturnType<typeof setTimeout> | undefined>();
  #nextCallId = 1;

  failNext(method: FailableMethod, error: SentVoiceError): void {
    this.#failures.set(method, [...(this.#failures.get(method) ?? []), error]);
  }

  scriptNextCall(script: CallScript): void {
    this.#scripts.push(script);
  }

  /** Delivers an incoming call, then plays `script` as the caller's side of it. */
  receiveCall(from: string, script: CallScript = []): string {
    const callId = this.#open(script);
    for (const listener of this.#incomingListeners) listener({ callId, from });
    return callId;
  }

  async register(token: string): Promise<void> {
    this.#fail('register');
  }

  async unregister(): Promise<void> {
    this.#fail('unregister');
  }

  async call(target: CallTarget): Promise<string> {
    this.#fail('call');
    return this.#open(this.#scripts.shift() ?? []);
  }

  async joinConference(room: string): Promise<string> {
    this.#fail('joinConference');
    return this.#open(this.#scripts.shift() ?? []);
  }

  async answer(callId: string): Promise<void> {
    this.#fail('answer');
    this.#emit({ callId, type: 'answered' });
    this.#emit({ callId, type: 'connected' });
  }

  async reject(callId: string): Promise<void> {
    this.#fail('reject');
    this.#emit({ callId, type: 'ended', reason: 'completed' });
  }

  async hangup(callId: string): Promise<void> {
    this.#fail('hangup');
    this.#emit({ callId, type: 'ended', reason: 'completed' });
  }

  mute(callId: string, muted: boolean): void {
    this.#fail('mute');
  }

  sendDigits(callId: string, digits: string): void {
    this.#fail('sendDigits');
  }

  async getStats(callId: string): Promise<CallStats> {
    this.#fail('getStats');
    return { jitter: 0, packetLoss: 0, rtt: 0 };
  }

  onIncoming(listener: (call: IncomingCall) => void): void {
    this.#incomingListeners.push(listener);
  }

  onCallEvent(listener: (event: CallEvent) => void): void {
    this.#callEventListeners.push(listener);
  }

  async setInputDevice(deviceId: string): Promise<void> {
    this.#fail('setInputDevice');
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.#fail('setOutputDevice');
  }

  #fail(method: FailableMethod): void {
    const error = this.#failures.get(method)?.shift();
    if (error) throw error;
  }

  #open(script: CallScript): string {
    const callId = `mock-call-${this.#nextCallId++}`;
    this.#calls.set(callId, undefined);
    this.#play(callId, script);
    return callId;
  }

  #play(callId: string, [step, ...rest]: CallScript): void {
    if (!step) return;
    const { after = 0, ...event } = step;
    this.#calls.set(
      callId,
      setTimeout(() => {
        this.#play(callId, rest);
        this.#emit({ ...event, callId });
      }, after),
    );
  }

  #emit(event: CallEvent): void {
    if (!this.#calls.has(event.callId)) return;
    if (event.type === 'ended') {
      clearTimeout(this.#calls.get(event.callId));
      this.#calls.delete(event.callId);
    }
    for (const listener of this.#callEventListeners) listener(event);
  }
}
