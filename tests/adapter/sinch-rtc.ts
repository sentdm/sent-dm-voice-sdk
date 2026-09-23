import { CallEndCause } from 'sinch-rtc/npm/src/calling/CallEndCause';
import { ErrorType, SinchError } from 'sinch-rtc/npm/src/SinchError';
import { ArgumentError } from 'sinch-rtc/npm/src/utils/Errors';

export { CallEndCause, ErrorType, SinchError };

interface ClientListener {
  onCredentialsRequired(client: FakeClient, registration: { register(jwt: string): Promise<void> }): void;
  onClientStarted(client: FakeClient): void;
  onClientFailed(client: FakeClient, error: SinchError): void;
}

interface CallClientListener {
  onIncomingCall(callClient: FakeCallClient, call: FakeCall): void;
}

interface CallListener {
  onCallProgressing?(call: FakeCall): void;
  onCallAnswered?(call: FakeCall): void;
  onCallEstablished?(call: FakeCall): void;
  onCallEnded?(call: FakeCall): void;
}

export const clients: FakeClient[] = [];
export const calls = new Map<string, FakeCall>();
export const failures: { start: SinchError[]; push: Error[] } = { start: [], push: [] };

let nextCallId = 1;

export class FakeCall {
  readonly id = `sinch-call-${nextCallId++}`;
  readonly incomingStream = {} as MediaStream;
  readonly details: { endCause: CallEndCause; error: SinchError | undefined } = {
    endCause: CallEndCause.None,
    error: undefined,
  };
  answerFailure: Error | undefined;
  stats: RTCStatsReport | null = null;
  #listeners = new Set<CallListener>();
  #established = false;

  constructor(
    readonly direction: 'inbound' | 'outbound',
    readonly remoteUserId: string,
  ) {
    calls.set(this.id, this);
  }

  addListener(listener: CallListener): void {
    this.#listeners.add(listener);
  }

  removeListener(listener: CallListener): void {
    this.#listeners.delete(listener);
  }

  progress(): void {
    this.#emit('onCallProgressing');
  }

  answerRemotely(): void {
    this.#emit('onCallAnswered');
  }

  establish(): void {
    this.#established = true;
    this.#emit('onCallEstablished');
  }

  async answer(): Promise<void> {
    if (this.answerFailure) throw this.answerFailure;
    this.#emit('onCallAnswered');
    this.establish();
  }

  hangup(): void {
    if (this.details.endCause !== CallEndCause.None) throw new Error('Invalid state (null)');
    this.end(
      this.#established ? CallEndCause.HungUp
      : this.direction === 'inbound' ? CallEndCause.Denied
      : CallEndCause.Canceled,
    );
  }

  end(endCause: CallEndCause, error?: SinchError): void {
    this.details.endCause = endCause;
    this.details.error = error;
    this.#emit('onCallEnded');
  }

  mute(): void {}

  unmute(): void {}

  sendDtmf(keys: string): void {
    if (!/^[0-9#*abcdABCD]+$/.test(keys)) throw new ArgumentError('Invalid DTMF keys', 'keys');
  }

  async getPeerConnectionStats(): Promise<RTCStatsReport | null> {
    return this.stats;
  }

  #emit(event: keyof CallListener): void {
    for (const listener of [...this.#listeners]) listener[event]?.(this);
  }
}

export class FakeCallClient {
  readonly placed: Array<{ method: string; destination: string }> = [];
  constraints: MediaTrackConstraints | null = null;
  #listeners: CallClientListener[] = [];

  addListener(listener: CallClientListener): void {
    this.#listeners.push(listener);
  }

  async callUser(userId: string): Promise<FakeCall> {
    return this.#place('callUser', userId);
  }

  async callPhoneNumber(phoneNumber: string): Promise<FakeCall> {
    return this.#place('callPhoneNumber', phoneNumber);
  }

  async callConference(conferenceId: string): Promise<FakeCall> {
    return this.#place('callConference', conferenceId);
  }

  setAudioTrackConstraints(constraints: MediaTrackConstraints | null): void {
    this.constraints = constraints;
  }

  receiveCall(from: string): FakeCall {
    const call = new FakeCall('inbound', from);
    for (const listener of this.#listeners) listener.onIncomingCall(this, call);
    return call;
  }

  #place(method: string, destination: string): FakeCall {
    this.placed.push({ method, destination });
    return new FakeCall('outbound', destination);
  }
}

export class FakeClient {
  readonly callClient = new FakeCallClient();
  readonly log: string[] = [];
  readonly credentials: string[] = [];
  push: [serviceWorker: string | undefined, registrationOptions: RegistrationOptions | undefined] | undefined;
  #listeners: ClientListener[] = [];
  #started = false;

  constructor(readonly settings: { applicationKey?: string; userId?: string; environmentHost?: string }) {}

  addListener(listener: ClientListener): void {
    this.#listeners.push(listener);
  }

  async setSupportManagedPush(
    serviceWorker?: string,
    registrationOptions?: RegistrationOptions,
  ): Promise<void> {
    this.log.push('setSupportManagedPush');
    const failure = failures.push.shift();
    if (failure) throw failure;
    this.push = [serviceWorker, registrationOptions];
  }

  async start(): Promise<void> {
    this.log.push('start');
    this.requestCredentials();
    const failure = failures.start.shift();
    this.#started = !failure;
    for (const listener of this.#listeners) {
      if (failure) listener.onClientFailed(this, failure);
      else listener.onClientStarted(this);
    }
  }

  requestCredentials(): void {
    for (const listener of this.#listeners) {
      listener.onCredentialsRequired(this, { register: async (jwt) => void this.credentials.push(jwt) });
    }
  }

  isStarted(): boolean {
    return this.#started;
  }

  async disableManagedPushSupport(): Promise<void> {
    this.log.push('disableManagedPushSupport');
  }

  terminate(): void {
    this.#started = false;
    this.log.push('terminate');
  }
}

class FakeClientBuilder {
  readonly #settings: FakeClient['settings'] = {};

  applicationKey(applicationKey: string): this {
    this.#settings.applicationKey = applicationKey;
    return this;
  }

  userId(userId: string): this {
    this.#settings.userId = userId;
    return this;
  }

  environmentHost(environmentHost: string): this {
    this.#settings.environmentHost = environmentHost;
    return this;
  }

  build(): FakeClient {
    const client = new FakeClient(this.#settings);
    clients.push(client);
    return client;
  }
}

export const Sinch = { getSinchClientBuilder: () => new FakeClientBuilder() };

export class FakeAudio {
  static readonly created: FakeAudio[] = [];
  autoplay = false;
  srcObject: MediaProvider | null = null;
  sinkId = '';

  constructor() {
    FakeAudio.created.push(this);
  }

  async setSinkId(sinkId: string): Promise<void> {
    this.sinkId = sinkId;
  }
}
