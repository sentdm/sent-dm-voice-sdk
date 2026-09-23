/// <reference lib="dom" />
import { loadAdapter } from './adapter/loader';
import type { AdapterOptions, CallEvent, IncomingCall, ProviderAdapter } from './adapter/types';
import { AudioController, type AudioLifecycle } from './audio';
import {
  Call,
  type Address,
  type CallState,
  type CallStats,
  type DisconnectInfo,
  type QualityWarning,
} from './call';
import { NotRegisteredError, SentVoiceError, TokenExpiredError } from './errors';
import { TypedEmitter } from './events';
import { CallInvite, type CancelInfo } from './invite';
import { createLog, parseLogLevel, type Log, type Logger, type LogLevel } from './log';
import { Telemetry } from './telemetry';
import { fetchToken, offlineRetryDelay, refreshDelay, retryDelay, type VoiceToken } from './token';
import { VERSION } from './version';

export interface SentVoiceOptions {
  /**
   * Returns a voice token from your backend, which mints it with `POST /v3/voice/tokens`.
   * Called by `register()` and again before each token expires.
   */
  tokenProvider: () => Promise<string>;

  /**
   * The maximum number of times that registering or refreshing the voice token is retried
   * in case of a temporary failure, like a network error.
   *
   * @default 2
   */
  registerRetries?: number | undefined;

  /**
   * Set the log level.
   *
   * Defaults to 'warn'.
   */
  logLevel?: LogLevel | undefined;

  /**
   * Set the logger. Voice tokens are redacted from every message.
   *
   * Defaults to globalThis.console.
   */
  logger?: Logger | undefined;

  /**
   * Where your app serves the service worker that delivers incoming calls, a copy of
   * `@sentdm/voice/sw.js`. `url` is resolved against the page and defaults to `sw.js`;
   * `scope` defaults to the worker's folder.
   */
  serviceWorker?: { url?: string | undefined; scope?: string | undefined } | undefined;

  audio?:
    | {
        /**
         * The microphone to start with, a `deviceId` from `client.audio.inputDevices()`. The default
         * one is used while the device is missing.
         */
        inputDeviceId?: string | undefined;
        /**
         * The speaker to start with, a `deviceId` from `client.audio.outputDevices()`. The default
         * one is used when the device cannot be chosen.
         */
        outputDeviceId?: string | undefined;
        /** Plays the other party's audio through this element instead of one the SDK creates. */
        element?: HTMLAudioElement | undefined;
      }
    | undefined;

  /**
   * Usage and call quality data the SDK reports to Sent, authenticated with the voice token: the
   * browser and device, registration and call timings, call quality and error codes. `baseURL`
   * defaults to `https://api.sent.dm`; set `disabled` to report nothing.
   */
  telemetry?: { baseURL?: string | undefined; disabled?: boolean | undefined } | undefined;
}

export interface SentVoiceEvents {
  registering: () => void;
  registered: () => void;
  unregistered: () => void;
  incomingCall: (invite: CallInvite) => void;
  activeCallChanged: (call: Call | null) => void;
  offline: (reason: SentVoiceError) => void;
  tokenWillExpire: (info: { expiresAt: number }) => void;
  error: (error: SentVoiceError) => void;
}

const destroyedError = () => new NotRegisteredError({ message: 'The client was destroyed.' });

const invalidAddress = (message: string) =>
  new SentVoiceError({ code: 'INVALID_ADDRESS', category: 'validation', retriable: false, message });

const numberPattern = /^\+[1-9]\d{1,14}$/;
const namePattern = /^[A-Za-z0-9_-]+$/;
const identityMaxLength = 200;
const roomMaxLength = 27;

const isName = (value: string, maxLength: number) => value.length <= maxLength && namePattern.test(value);

export class SentVoice extends TypedEmitter<SentVoiceEvents> {
  static readonly version: string = VERSION;

  readonly audio: AudioController;
  #tokenProvider: () => Promise<string>;
  #registerRetries: number;
  #log: Log;
  #adapterOptions: AdapterOptions;
  #state: SentVoice.ClientState = 'unregistered';
  #token: VoiceToken | undefined;
  #adapter: Promise<ProviderAdapter> | undefined;
  #registeredAdapter: ProviderAdapter | undefined;
  #adapterCalls: Promise<void> = Promise.resolve();
  #registering: Promise<void> | undefined;
  #run = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #wake: (() => void) | undefined;
  #updates = new Map<string, (state: Exclude<CallState, 'initiated'>, error?: SentVoiceError) => void>();
  #invites = new Map<string, CallInvite>();
  #calls: Call[] = [];
  #activeCall: Call | null = null;
  #audioLifecycle: AudioLifecycle | undefined;
  #telemetry: Telemetry | undefined;

  constructor({
    tokenProvider,
    registerRetries = 2,
    logLevel,
    logger = console,
    serviceWorker,
    audio,
    telemetry,
  }: SentVoiceOptions) {
    super();
    this.#tokenProvider = tokenProvider;
    this.#registerRetries = registerRetries;
    this.#log = createLog(
      logger,
      parseLogLevel(logLevel, 'SentVoiceOptions.logLevel', createLog(logger, 'warn')) ?? 'warn',
    );
    this.#adapterOptions = { serviceWorker, audioElement: audio?.element };
    this.audio = new AudioController(this.#log, audio?.inputDeviceId, audio?.outputDeviceId, {
      check: () => {
        if (this.#state === 'destroyed') throw destroyedError();
      },
      onLifecycle: (lifecycle) => (this.#audioLifecycle = lifecycle),
    });
    if (!telemetry?.disabled) this.#telemetry = new Telemetry(telemetry?.baseURL, this.#log);
  }

  get state(): SentVoice.ClientState {
    return this.#state;
  }

  get identity(): string | undefined {
    return this.#token?.identity;
  }

  get number(): string | undefined {
    return this.#token?.number;
  }

  get calls(): Call[] {
    return [...this.#calls];
  }

  get activeCall(): Call | null {
    return this.#activeCall;
  }

  get isBusy(): boolean {
    return this.#activeCall !== null;
  }

  /** Fetches a token from `tokenProvider`, registers with it and keeps it refreshed. */
  async register(): Promise<void> {
    if (this.#state === 'destroyed') throw destroyedError();
    if (this.#state === 'registered') return;
    if (this.#registering) return this.#registering;

    const offline = this.#state === 'offline';
    const run = this.#cancel();
    if (!offline) this.#state = 'registering';
    const registering = (this.#registering = this.#register(run, offline));
    if (!offline) this.emit('registering');
    return registering;
  }

  /** Goes offline and stops receiving calls. */
  async unregister(): Promise<void> {
    if (this.#state === 'destroyed') throw destroyedError();
    if (this.#state === 'unregistered') return;

    const started = Date.now();
    this.#stop('unregistered');
    const unregistered = this.#unregisterAdapter();
    this.emit('unregistered');
    await unregistered;
    this.#telemetry?.unregistered(Date.now() - started);
  }

  /** Calls a phone number in E.164 format or another user of your app. */
  async connect({ to }: SentVoice.ConnectParams): Promise<Call> {
    if (to.startsWith('+')) {
      if (!numberPattern.test(to)) {
        throw invalidAddress(`'to' must be a phone number in E.164 format (e.g. +14155551234).`);
      }
      return this.#place({ kind: 'number', number: to }, (adapter) =>
        adapter.call({ kind: 'number', number: to }),
      );
    }

    if (!isName(to, identityMaxLength)) {
      throw invalidAddress(
        `'to' may only contain letters, digits, '-' and '_', up to ${identityMaxLength} characters.`,
      );
    }
    return this.#place({ kind: 'user', identity: to }, (adapter, prefix) =>
      adapter.call({ kind: 'user', id: `${prefix}=${to}` }),
    );
  }

  /** Joins one of your account's conference rooms. */
  async joinConference({ name }: SentVoice.JoinConferenceParams): Promise<Call> {
    if (!isName(name, roomMaxLength)) {
      throw invalidAddress(
        `'name' may only contain letters, digits, '-' and '_', up to ${roomMaxLength} characters.`,
      );
    }
    return this.#place({ kind: 'conference', name }, (adapter, prefix) =>
      adapter.joinConference(`${prefix}=${name}`),
    );
  }

  /** Ends every call and tears the client down for good; later calls throw `NotRegisteredError`. */
  async destroy(): Promise<void> {
    if (this.#state === 'destroyed') return;

    this.#stop('destroyed');
    this.#audioLifecycle?.destroyed();
    this.#telemetry?.destroyed();
    const endings = [
      ...[...this.#invites.values()].map((invite) => invite.reject()),
      ...this.#calls.map((call) => call.disconnect()),
    ];
    await Promise.all(
      endings.map((ending) =>
        ending.catch((error: unknown) => this.#log.warn(`Ending a call on destroy failed: ${error}`)),
      ),
    );
    await this.#unregisterAdapter().catch((error: unknown) =>
      this.#log.warn(`Unregistering on destroy failed: ${error}`),
    );
  }

  async #register(run: number, offline: boolean): Promise<void> {
    const started = Date.now();
    let attempts = 0;
    let token: VoiceToken;
    try {
      token = await this.#connect(run, () => attempts++);
      this.#check(run);
    } catch (error) {
      this.#telemetry?.registerFailed(Date.now() - started, attempts, error);
      if (run === this.#run) {
        this.#registering = undefined;
        if (offline) {
          this.#scheduleOfflineRetry(run);
        } else {
          this.#state = 'unregistered';
          this.emit('unregistered');
        }
      }
      throw error;
    }
    this.#registering = undefined;
    this.#telemetry?.registered(Date.now() - started, attempts);
    this.#online(token, run);
  }

  async #refresh(run: number, expiresAt: number): Promise<void> {
    this.emit('tokenWillExpire', { expiresAt });
    try {
      const token = await this.#connect(run);
      this.#check(run);
      this.#online(token, run);
    } catch (error) {
      if (run === this.#run) this.#offline(run, error as SentVoiceError);
    }
  }

  async #retryOffline(run: number): Promise<void> {
    try {
      const token = await this.#attempt(run);
      this.#check(run);
      this.#online(token, run);
    } catch (error) {
      if (run !== this.#run) return;
      this.#log.info(`Registration retry failed: ${error}`);
      this.#scheduleOfflineRetry(run);
    }
  }

  async #connect(run: number, onAttempt?: () => void): Promise<VoiceToken> {
    for (let retry = 0; ; retry++) {
      onAttempt?.();
      try {
        return await this.#attempt(run);
      } catch (error) {
        this.#check(run);
        if (!(error instanceof SentVoiceError) || !error.retriable || retry >= this.#registerRetries) {
          throw error;
        }

        const delay = retryDelay(retry);
        this.#log.info(
          `Registration attempt failed (${error}), retrying in ${Math.round(delay)} ms, ${
            this.#registerRetries - retry
          } attempts remaining`,
        );
        await this.#sleep(delay);
      }
    }
  }

  async #attempt(run: number): Promise<VoiceToken> {
    this.#check(run);
    const token = await fetchToken(this.#tokenProvider);
    await this.#callAdapter(async () => {
      const adapter = await (this.#adapter ??= this.#loadAdapter());
      this.#check(run);
      await adapter.register(token.jwt);
      this.#registeredAdapter = adapter;
    });
    return token;
  }

  async #loadAdapter(): Promise<ProviderAdapter> {
    const adapter = await loadAdapter(this.#adapterOptions);
    adapter.onIncoming((incoming) => this.#onIncoming(adapter, incoming));
    adapter.onCallEvent((event) => this.#onCallEvent(event));
    this.#audioLifecycle?.loaded(adapter);
    return adapter;
  }

  async #place(
    to: Address,
    dial: (adapter: ProviderAdapter, prefix: string) => Promise<string>,
  ): Promise<Call> {
    const { adapter, token } = this.#session();
    const callId = await this.#reported(dial(adapter, token.prefix));
    if (this.#state === 'destroyed') {
      await adapter
        .hangup(callId)
        .catch((error: unknown) => this.#log.warn(`Ending a call on destroy failed: ${error}`));
      throw destroyedError();
    }

    const call = this.#createCall(
      adapter,
      callId,
      'outbound',
      { kind: 'user', identity: token.identity },
      to,
    );
    this.#track(call);
    return call;
  }

  #session(): { adapter: ProviderAdapter; token: VoiceToken } {
    const adapter = this.#registeredAdapter;
    const token = this.#token;
    if (this.#state !== 'registered' || !adapter || !token) {
      throw this.#state === 'destroyed' ? destroyedError() : new NotRegisteredError();
    }
    return { adapter, token };
  }

  #onIncoming(adapter: ProviderAdapter, { callId, from }: IncomingCall): void {
    const token = this.#token;
    if (!token) return;

    const separator = from.indexOf('=');
    const caller: Address =
      separator < 0 ?
        { kind: 'number', number: from }
      : { kind: 'user', identity: from.slice(separator + 1) };
    const call = this.#createCall(adapter, callId, 'inbound', caller, {
      kind: 'user',
      identity: token.identity,
    });
    const invite = new CallInvite(call, {
      answer: () => this.#reported(adapter.answer(callId), callId),
      reject: () => adapter.reject(callId),
      accepted: () => this.#track(call),
    });
    this.#invites.set(callId, invite);
    this.emit('incomingCall', invite);
  }

  #onCallEvent(event: CallEvent): void {
    const update = this.#updates.get(event.callId);
    if (!update) return;
    if (event.type !== 'ended') {
      update(event.type === 'reconnected' ? 'connected' : event.type);
      return;
    }

    this.#updates.delete(event.callId);
    this.#invites.delete(event.callId);
    this.#calls = this.#calls.filter((call) => call.id !== event.callId);
    if (this.#activeCall?.id === event.callId) {
      this.#activeCall = null;
      this.emit('activeCallChanged', null);
    }
    update(event.reason, event.error);
  }

  #createCall(
    adapter: ProviderAdapter,
    callId: string,
    direction: 'inbound' | 'outbound',
    from: Address,
    to: Address,
  ): Call {
    this.#audioLifecycle?.callStarted();
    const call = new Call(callId, direction, from, to, {
      hangup: () => adapter.hangup(callId),
      mute: (muted) => adapter.mute(callId, muted),
      sendDigits: (digits) => adapter.sendDigits(callId, digits),
      getStats: () => adapter.getStats(callId),
      onUpdate: (update) => this.#updates.set(callId, update),
    });
    this.#telemetry?.callStarted(call);
    return call;
  }

  #reported<T>(operation: Promise<T>, callId?: string): Promise<T> {
    return operation.catch((error: unknown) => {
      this.#telemetry?.error(error, callId);
      throw error;
    });
  }

  #track(call: Call): void {
    this.#calls = [...this.#calls, call];
    this.#activeCall = call;
    this.emit('activeCallChanged', call);
  }

  #online(token: VoiceToken, run: number): void {
    this.#token = token;
    this.#telemetry?.useToken(token.jwt);
    const delay = refreshDelay(token);
    this.#log.debug(`Refreshing the voice token in ${delay} ms`);
    this.#timer = setTimeout(() => void this.#refresh(run, token.expiresAt), delay);
    if (this.#state === 'registered') return;

    this.#state = 'registered';
    this.emit('registered');
  }

  #offline(run: number, error: SentVoiceError): void {
    this.#log.warn(`Token refresh failed, going offline: ${error}`);
    this.#state = 'offline';
    this.#scheduleOfflineRetry(run);
    this.#telemetry?.error(error);
    this.emit('error', error);
    if (run === this.#run) this.emit('offline', new TokenExpiredError());
  }

  #scheduleOfflineRetry(run: number): void {
    this.#timer = setTimeout(() => void this.#retryOffline(run), offlineRetryDelay());
  }

  #unregisterAdapter(): Promise<void> {
    return this.#callAdapter(async () => {
      const adapter = this.#registeredAdapter;
      this.#registeredAdapter = undefined;
      await adapter?.unregister();
    });
  }

  #callAdapter(call: () => Promise<void>): Promise<void> {
    const result = this.#adapterCalls.then(call);
    this.#adapterCalls = result.catch(() => {});
    return result;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#wake = resolve;
      this.#timer = setTimeout(resolve, ms);
    });
  }

  #stop(state: 'unregistered' | 'destroyed'): void {
    this.#cancel();
    this.#state = state;
    this.#token = undefined;
    this.#registering = undefined;
  }

  #cancel(): number {
    clearTimeout(this.#timer);
    this.#wake?.();
    this.#timer = undefined;
    this.#wake = undefined;
    return ++this.#run;
  }

  #check(run: number): void {
    if (run === this.#run) return;
    throw this.#state === 'destroyed' ? destroyedError() : new NotRegisteredError();
  }
}

export declare namespace SentVoice {
  export type ClientState = 'unregistered' | 'registering' | 'registered' | 'offline' | 'destroyed';

  export interface ConnectParams {
    /** A phone number in E.164 format like `+14155551234`, or the identity of another user of your app. */
    to: string;
  }

  export interface JoinConferenceParams {
    /** The room name, private to your account: letters, digits, `-` and `_`, up to 27 characters. */
    name: string;
  }

  export {
    type Call as Call,
    type CallState as CallState,
    type Address as Address,
    type CallStats as CallStats,
    type DisconnectInfo as DisconnectInfo,
    type QualityWarning as QualityWarning,
  };

  export { type CallInvite as CallInvite, type CancelInfo as CancelInfo };

  export { type AudioController as AudioController };
}
