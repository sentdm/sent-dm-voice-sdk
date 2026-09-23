/// <reference lib="dom" />
import { CapabilityUnsupportedError } from './errors';
import { TypedEmitter } from './events';
import type { Log } from './log';

export interface AudioControllerEvents {
  deviceChanged: () => void;
}

interface AudioAdapter {
  setInputDevice(deviceId: string): Promise<void>;
  setOutputDevice(deviceId: string): Promise<void>;
}

export interface AudioLifecycle {
  loaded(adapter: AudioAdapter): void;
  callStarted(): void;
  destroyed(): void;
}

interface AudioProvider {
  check(): void;
  onLifecycle(lifecycle: AudioLifecycle): void;
}

export class AudioController extends TypedEmitter<AudioControllerEvents> {
  #log: Log;
  #provider: AudioProvider;
  #adapter: AudioAdapter | undefined;
  #pendingInput: string | undefined;
  #pendingOutput: string | undefined;
  #listening = false;
  #destroyed = false;
  #deviceChanged = () => this.emit('deviceChanged');

  constructor(
    log: Log,
    inputDeviceId: string | undefined,
    outputDeviceId: string | undefined,
    provider: AudioProvider,
  ) {
    super();
    this.#log = log;
    this.#pendingInput = inputDeviceId;
    this.#pendingOutput = outputDeviceId;
    this.#provider = provider;
    provider.onLifecycle({
      loaded: (adapter) => this.#load(adapter),
      callStarted: () => this.#retryOutput(),
      destroyed: () => this.#destroy(),
    });
  }

  /**
   * Lists the microphones. Browsers leave labels and ids empty, and may list only one, until the
   * user has allowed microphone access in the page, which the first call asks for.
   */
  inputDevices(): Promise<MediaDeviceInfo[]> {
    return this.#list('audioinput');
  }

  /** Lists the speakers, which browsers also hide until the user has allowed microphone access. */
  outputDevices(): Promise<MediaDeviceInfo[]> {
    return this.#list('audiooutput');
  }

  /**
   * Switches the microphone of the call in progress and of later calls, falling back to the
   * default one while the device is missing. Called before `register()`, it takes effect from `register()`.
   */
  async setInputDevice(deviceId: string): Promise<void> {
    this.#provider.check();
    if (!this.#adapter) {
      this.#pendingInput = deviceId;
      return;
    }
    await this.#adapter.setInputDevice(deviceId);
  }

  /**
   * Plays calls through this speaker. Throws `CapabilityUnsupportedError` in browsers that cannot
   * choose the audio output. Called before `register()`, it takes effect from `register()`.
   */
  async setOutputDevice(deviceId: string): Promise<void> {
    this.#provider.check();
    if (!('setSinkId' in HTMLMediaElement.prototype)) {
      throw new CapabilityUnsupportedError({
        message: 'Choosing the audio output device is not supported by this browser.',
      });
    }
    if (!this.#adapter) {
      this.#pendingOutput = deviceId;
      return;
    }
    this.#pendingOutput = undefined;
    await this.#adapter.setOutputDevice(deviceId);
  }

  override on<E extends keyof AudioControllerEvents>(event: E, listener: AudioControllerEvents[E]): this {
    this.#listen();
    return super.on(event, listener);
  }

  override once<E extends keyof AudioControllerEvents>(event: E, listener: AudioControllerEvents[E]): this {
    this.#listen();
    return super.once(event, listener);
  }

  async #list(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices) {
      throw new CapabilityUnsupportedError({
        message: 'Audio devices can only be listed in a secure context (HTTPS or localhost).',
      });
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === kind);
  }

  #load(adapter: AudioAdapter): void {
    this.#adapter = adapter;
    const input = this.#pendingInput;
    const output = this.#pendingOutput;

    if (input !== undefined) {
      adapter
        .setInputDevice(input)
        .catch((error: unknown) =>
          this.#log.warn(
            `The audio input device ${input} could not be used, using the default device: ${error}`,
          ),
        );
      void this.#checkInput(input);
    }
    if (output !== undefined) {
      adapter.setOutputDevice(output).then(
        () => (this.#pendingOutput = undefined),
        (error: unknown) =>
          this.#log.info(
            `The audio output device ${output} could not be used yet, retrying on the first call: ${error}`,
          ),
      );
    }
  }

  async #checkInput(deviceId: string): Promise<void> {
    const ids = (await this.inputDevices().catch(() => [])).map((device) => device.deviceId);
    if (ids.some(Boolean) && !ids.includes(deviceId)) {
      this.#log.warn(`The audio input device ${deviceId} was not found, using the default device.`);
    }
  }

  #retryOutput(): void {
    const output = this.#pendingOutput;
    if (output === undefined || !this.#adapter) return;

    this.#pendingOutput = undefined;
    this.#adapter
      .setOutputDevice(output)
      .catch((error: unknown) =>
        this.#log.warn(
          `The audio output device ${output} could not be used, using the default device: ${error}`,
        ),
      );
  }

  #listen(): void {
    if (this.#listening || this.#destroyed || !navigator.mediaDevices) return;
    navigator.mediaDevices.addEventListener('devicechange', this.#deviceChanged);
    this.#listening = true;
  }

  #destroy(): void {
    this.#destroyed = true;
    if (this.#listening) navigator.mediaDevices.removeEventListener('devicechange', this.#deviceChanged);
  }
}
