import type { Address, Call } from './call';
import { CallFailedError, type SentVoiceError } from './errors';
import { TypedEmitter } from './events';

export interface CancelInfo {
  error?: SentVoiceError;
}

export interface CallInviteEvents {
  accepted: (call: Call) => void;
  rejected: () => void;
  cancelled: (info: CancelInfo) => void;
}

interface InviteProvider {
  answer(): Promise<void>;
  reject(): Promise<void>;
  accepted(): void;
}

const endedError = () => new CallFailedError({ message: 'The call ended before it was answered.' });

export class CallInvite extends TypedEmitter<CallInviteEvents> {
  readonly from: Address;
  readonly to: Address;
  #call: Call;
  #provider: InviteProvider;
  #state: 'pending' | 'accepted' | 'rejected' | 'cancelled' = 'pending';
  #accepting: Promise<Call> | undefined;

  constructor(call: Call, provider: InviteProvider) {
    super();
    this.from = call.from;
    this.to = call.to;
    this.#call = call;
    this.#provider = provider;
    call.on('disconnected', ({ error }) => {
      if (this.#state !== 'pending') return;
      this.#state = 'cancelled';
      this.emit('cancelled', error ? { error } : {});
    });
  }

  get state(): 'pending' | 'accepted' | 'rejected' | 'cancelled' {
    return this.#state;
  }

  /** Answers the call, asking for microphone permission if it was not granted yet. */
  async accept(): Promise<Call> {
    if (this.#state === 'accepted') return this.#call;
    if (this.#state !== 'pending') throw endedError();
    this.#accepting ??= this.#accept().finally(() => (this.#accepting = undefined));
    return this.#accepting;
  }

  /** Declines the call; does nothing unless it is still pending. */
  async reject(): Promise<void> {
    if (this.#state !== 'pending') return;
    this.#state = 'rejected';
    this.emit('rejected');
    await this.#provider.reject();
  }

  async #accept(): Promise<Call> {
    try {
      await this.#provider.answer();
    } catch (error) {
      if (this.#state === 'pending') throw error;
    }
    if (this.#state !== 'pending') throw endedError();
    this.#state = 'accepted';
    this.#provider.accepted();
    this.emit('accepted', this.#call);
    return this.#call;
  }
}
