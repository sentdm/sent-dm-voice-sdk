import { loadAdapter } from './adapter/loader';
import type { ProviderAdapter } from './adapter/types';
import { NotRegisteredError, SentVoiceError, TokenExpiredError } from './errors';
import { TypedEmitter } from './events';
import { createLog, parseLogLevel, type Log, type Logger, type LogLevel } from './log';
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
}

export interface SentVoiceEvents {
  registering: () => void;
  registered: () => void;
  unregistered: () => void;
  offline: (reason: SentVoiceError) => void;
  tokenWillExpire: (info: { expiresAt: number }) => void;
  error: (error: SentVoiceError) => void;
}

const destroyedError = () => new NotRegisteredError({ message: 'The client was destroyed.' });

export class SentVoice extends TypedEmitter<SentVoiceEvents> {
  static readonly version: string = VERSION;

  #tokenProvider: () => Promise<string>;
  #registerRetries: number;
  #log: Log;
  #state: SentVoice.ClientState = 'unregistered';
  #token: VoiceToken | undefined;
  #adapter: Promise<ProviderAdapter> | undefined;
  #registeredAdapter: ProviderAdapter | undefined;
  #adapterCalls: Promise<void> = Promise.resolve();
  #registering: Promise<void> | undefined;
  #run = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #wake: (() => void) | undefined;

  constructor({ tokenProvider, registerRetries = 2, logLevel, logger = console }: SentVoiceOptions) {
    super();
    this.#tokenProvider = tokenProvider;
    this.#registerRetries = registerRetries;
    this.#log = createLog(
      logger,
      parseLogLevel(logLevel, 'SentVoiceOptions.logLevel', createLog(logger, 'warn')) ?? 'warn',
    );
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

    this.#stop('unregistered');
    const unregistered = this.#unregisterAdapter();
    this.emit('unregistered');
    await unregistered;
  }

  /** Tears the client down for good; later calls throw `NotRegisteredError`. */
  async destroy(): Promise<void> {
    if (this.#state === 'destroyed') return;

    this.#stop('destroyed');
    await this.#unregisterAdapter().catch((error: unknown) =>
      this.#log.warn(`Unregistering on destroy failed: ${error}`),
    );
  }

  async #register(run: number, offline: boolean): Promise<void> {
    let token: VoiceToken;
    try {
      token = await this.#connect(run);
      this.#check(run);
    } catch (error) {
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

  async #connect(run: number): Promise<VoiceToken> {
    for (let retry = 0; ; retry++) {
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
      const adapter = await (this.#adapter ??= loadAdapter());
      this.#check(run);
      await adapter.register(token.jwt);
      this.#registeredAdapter = adapter;
    });
    return token;
  }

  #online(token: VoiceToken, run: number): void {
    this.#token = token;
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
}
