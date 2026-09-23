import type { SentVoiceError } from './errors';
import { TypedEmitter } from './events';

export type CallState =
  | 'initiated'
  | 'ringing'
  | 'answered'
  | 'connected'
  | 'reconnecting'
  | 'completed'
  | 'failed'
  | 'busy'
  | 'noAnswer';

export type Address =
  | { kind: 'user'; identity: string }
  | { kind: 'number'; number: string }
  | { kind: 'conference'; name: string };

/** Jitter and rtt in milliseconds, packetLoss as a fraction between 0 and 1. */
export interface CallStats {
  jitter: number;
  packetLoss: number;
  rtt: number;
}

export interface DisconnectInfo {
  state: 'completed' | 'failed' | 'busy' | 'noAnswer';
  error?: SentVoiceError;
}

export interface QualityWarning {
  metric: 'jitter' | 'packetLoss' | 'rtt';
  value: number;
  threshold: number;
  cleared: boolean;
}

export interface CallEvents {
  ringing: () => void;
  answered: () => void;
  connected: () => void;
  reconnecting: () => void;
  reconnected: () => void;
  disconnected: (info: DisconnectInfo) => void;
  muteChanged: (isMuted: boolean) => void;
  qualityWarning: (warning: QualityWarning) => void;
  error: (error: SentVoiceError) => void;
}

interface CallProvider {
  hangup(): Promise<void>;
  mute(muted: boolean): void;
  sendDigits(digits: string): void;
  getStats(): Promise<CallStats>;
  onUpdate(listener: (state: Exclude<CallState, 'initiated'>, error?: SentVoiceError) => void): void;
}

const isEnded = (state: CallState): state is DisconnectInfo['state'] =>
  state === 'completed' || state === 'failed' || state === 'busy' || state === 'noAnswer';

export class Call extends TypedEmitter<CallEvents> {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly from: Address;
  readonly to: Address;
  #provider: CallProvider;
  #state: CallState;
  #isMuted = false;
  #startedAt: number | undefined;

  constructor(
    id: string,
    direction: 'inbound' | 'outbound',
    from: Address,
    to: Address,
    provider: CallProvider,
  ) {
    super();
    this.id = id;
    this.direction = direction;
    this.from = from;
    this.to = to;
    this.#provider = provider;
    this.#state = direction === 'inbound' ? 'ringing' : 'initiated';
    provider.onUpdate((state, error) => this.#update(state, error));
  }

  get state(): CallState {
    return this.#state;
  }

  get isMuted(): boolean {
    return this.#isMuted;
  }

  /** When the call connected, in epoch milliseconds. */
  get startedAt(): number | undefined {
    return this.#startedAt;
  }

  /** Hangs up; does nothing once the call has ended. */
  async disconnect(): Promise<void> {
    if (isEnded(this.#state)) return;
    await this.#provider.hangup();
  }

  hangup(): Promise<void> {
    return this.disconnect();
  }

  /** Mutes or unmutes the microphone, toggling when called without an argument. */
  mute(muted = !this.#isMuted): void {
    if (muted === this.#isMuted) return;
    this.#provider.mute(muted);
    this.#isMuted = muted;
    this.emit('muteChanged', muted);
  }

  sendDigits(digits: string): void {
    this.#provider.sendDigits(digits);
  }

  getStats(): Promise<CallStats> {
    return this.#provider.getStats();
  }

  #update(state: Exclude<CallState, 'initiated'>, error?: SentVoiceError): void {
    const previous = this.#state;
    if (
      (state === 'ringing' && previous !== 'initiated') ||
      (state === 'answered' && previous !== 'initiated' && previous !== 'ringing') ||
      (state === 'connected' && previous === 'connected') ||
      (state === 'reconnecting' && previous !== 'connected')
    ) {
      return;
    }

    this.#state = state;
    if (isEnded(state)) {
      if (error) this.emit('error', error);
      this.emit('disconnected', error ? { state, error } : { state });
    } else if (state === 'connected' && previous === 'reconnecting') {
      this.emit('reconnected');
    } else {
      if (state === 'connected') this.#startedAt = Date.now();
      this.emit(state);
    }
  }
}
