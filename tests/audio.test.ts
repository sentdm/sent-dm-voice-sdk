import SentVoice, { type SentVoiceOptions } from '@sentdm/voice';
import { loadAdapter } from '@sentdm/voice/adapter/loader';
import { CapabilityUnsupportedError, SentVoiceError } from '@sentdm/voice/errors';
import { MockAdapter } from './adapter/mock-adapter';
import { prefix, voiceToken } from './voice-token';

jest.mock('@sentdm/voice/adapter/loader');

class FakeMediaDevices extends EventTarget {
  devices: MediaDeviceInfo[] = [];

  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    return this.devices;
  }
}

const device = (kind: MediaDeviceKind, deviceId: string) => ({ kind, deviceId }) as MediaDeviceInfo;

const setGlobal = (name: string, value: unknown) =>
  Object.defineProperty(globalThis, name, { configurable: true, value });

const notFound = new SentVoiceError({
  code: 'UNKNOWN',
  category: 'signaling',
  retriable: false,
  message: 'Requested device not found',
});

describe('AudioController', () => {
  let adapter: MockAdapter;
  let mediaDevices: FakeMediaDevices;
  let logger: Record<'error' | 'warn' | 'info' | 'debug', jest.Mock>;

  const createClient = (options: Partial<SentVoiceOptions> = {}) =>
    new SentVoice({
      tokenProvider: async () => voiceToken(),
      logger,
      logLevel: 'warn',
      telemetry: { disabled: true },
      ...options,
    });
  const placeCall = async (client: SentVoice) => {
    const call = await client.connect({ to: 'ben' });
    await call.disconnect();
  };
  const receiveCall = async (client: SentVoice) => {
    let invite!: SentVoice.CallInvite;
    client.once('incomingCall', (received) => (invite = received));
    adapter.receiveCall(`${prefix}_carol`);
    await invite.reject();
  };

  beforeEach(() => {
    jest.useFakeTimers();
    adapter = new MockAdapter();
    jest.mocked(loadAdapter).mockClear().mockResolvedValue(adapter);
    mediaDevices = new FakeMediaDevices();
    setGlobal('navigator', { mediaDevices });
    setGlobal(
      'HTMLMediaElement',
      class {
        setSinkId() {}
      },
    );
    logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('inputDevices lists the microphones and outputDevices the speakers', async () => {
    const builtIn = device('audioinput', 'built-in');
    const speakers = device('audiooutput', 'speakers');
    const headset = device('audioinput', 'headset');
    mediaDevices.devices = [builtIn, device('videoinput', 'camera'), speakers, headset];
    const client = createClient();

    await expect(client.audio.inputDevices()).resolves.toEqual([builtIn, headset]);
    await expect(client.audio.outputDevices()).resolves.toEqual([speakers]);
  });

  test('outside a secure context the lists reject with CapabilityUnsupportedError and deviceChanged attaches nothing', async () => {
    setGlobal('navigator', {});
    const client = createClient();

    expect(() => client.audio.on('deviceChanged', () => {})).not.toThrow();
    await expect(client.audio.inputDevices()).rejects.toBeInstanceOf(CapabilityUnsupportedError);
    await expect(client.audio.outputDevices()).rejects.toBeInstanceOf(CapabilityUnsupportedError);
  });

  test.each(['on', 'once'] as const)(
    'the first deviceChanged listener, added with %s, follows OS device changes until destroy',
    async (subscribe) => {
      const addEventListener = jest.spyOn(mediaDevices, 'addEventListener');
      const client = createClient();
      const deviceChanged = jest.fn();
      expect(addEventListener).not.toHaveBeenCalled();

      client.audio[subscribe]('deviceChanged', deviceChanged);
      mediaDevices.dispatchEvent(new Event('devicechange'));
      client.audio.on('deviceChanged', () => {});
      await client.destroy();
      mediaDevices.dispatchEvent(new Event('devicechange'));

      expect(addEventListener).toHaveBeenCalledTimes(1);
      expect(deviceChanged).toHaveBeenCalledTimes(1);
    },
  );

  test('once registered, the chosen devices reach the provider, and its errors reach the app', async () => {
    const client = createClient();
    await client.register();
    const setInputDevice = jest.spyOn(adapter, 'setInputDevice');
    const setOutputDevice = jest.spyOn(adapter, 'setOutputDevice');
    adapter.failNext('setOutputDevice', notFound);

    await client.audio.setInputDevice('headset');
    await expect(client.audio.setOutputDevice('gone')).rejects.toBe(notFound);
    await client.audio.setOutputDevice('headphones');

    expect(setInputDevice.mock.calls).toEqual([['headset']]);
    expect(setOutputDevice.mock.calls).toEqual([['gone'], ['headphones']]);
  });

  test('setOutputDevice throws CapabilityUnsupportedError before and after register where the browser cannot choose the output', async () => {
    setGlobal('HTMLMediaElement', class {});
    const setOutputDevice = jest.spyOn(adapter, 'setOutputDevice');
    const client = createClient();

    await expect(client.audio.setOutputDevice('headphones')).rejects.toBeInstanceOf(
      CapabilityUnsupportedError,
    );
    await client.register();
    await expect(client.audio.setOutputDevice('headphones')).rejects.toBeInstanceOf(
      CapabilityUnsupportedError,
    );

    expect(setOutputDevice).not.toHaveBeenCalled();
  });

  test('devices chosen before register replace the audio options and reach the provider when register loads it', async () => {
    const setInputDevice = jest.spyOn(adapter, 'setInputDevice');
    const setOutputDevice = jest.spyOn(adapter, 'setOutputDevice');
    const client = createClient({ audio: { inputDeviceId: 'built-in', outputDeviceId: 'speakers' } });

    await client.audio.setInputDevice('headset');
    await client.audio.setOutputDevice('headphones');
    expect(loadAdapter).not.toHaveBeenCalled();
    await client.register();

    expect(setInputDevice.mock.calls).toEqual([['headset']]);
    expect(setOutputDevice.mock.calls).toEqual([['headphones']]);
  });

  test.each<[string, () => void, string[]]>([
    [
      'a saved input device reaches the provider at register, silently when the browser lists it',
      () => (mediaDevices.devices = [device('audioinput', 'headset')]),
      [],
    ],
    [
      'a saved input device reaches the provider at register, silently while the browser hides device ids',
      () => (mediaDevices.devices = [device('audioinput', '')]),
      [],
    ],
    [
      'a saved input device reaches the provider at register, silently when devices cannot be listed',
      () => setGlobal('navigator', {}),
      [],
    ],
    [
      'a saved input device the browser does not list reaches the provider with a fallback warning',
      () => (mediaDevices.devices = [device('audioinput', 'built-in')]),
      ['The audio input device headset was not found, using the default device.'],
    ],
    [
      'a saved input device the provider cannot use falls back with a warning',
      () => adapter.failNext('setInputDevice', notFound),
      [`The audio input device headset could not be used, using the default device: ${notFound}`],
    ],
  ])('%s', async (_, setup, warnings) => {
    setup();
    const setInputDevice = jest.spyOn(adapter, 'setInputDevice');
    const client = createClient({ audio: { inputDeviceId: 'headset' } });

    await client.register();
    await jest.advanceTimersByTimeAsync(0);

    expect(setInputDevice.mock.calls).toEqual([['headset']]);
    expect(logger.warn.mock.calls).toEqual(warnings.map((warning) => [warning]));
  });

  test.each<[string, number, (client: SentVoice) => unknown, number, string[]]>([
    ['a saved output device that works at register is not tried again', 0, placeCall, 1, []],
    [
      'a saved output device that fails at register is tried once more on the first placed call',
      1,
      placeCall,
      2,
      [],
    ],
    [
      'a saved output device that fails at register is tried once more on the first incoming call',
      1,
      receiveCall,
      2,
      [],
    ],
    [
      'a saved output device that also fails on the first call falls back with a warning',
      2,
      placeCall,
      2,
      [`The audio output device speakers could not be used, using the default device: ${notFound}`],
    ],
  ])('%s', async (_, failures, firstCall, attempts, warnings) => {
    for (let failure = 0; failure < failures; failure++) adapter.failNext('setOutputDevice', notFound);
    const setOutputDevice = jest.spyOn(adapter, 'setOutputDevice');
    const client = createClient({ audio: { outputDeviceId: 'speakers' } });

    await client.register();
    await jest.advanceTimersByTimeAsync(0);
    expect(logger.warn).not.toHaveBeenCalled();
    await firstCall(client);
    await client.connect({ to: '+38349123456' });
    await jest.advanceTimersByTimeAsync(0);

    expect(setOutputDevice.mock.calls).toEqual(Array.from({ length: attempts }, () => ['speakers']));
    expect(logger.warn.mock.calls).toEqual(warnings.map((warning) => [warning]));
  });

  test('choosing an output device after register replaces a saved one still waiting for the first call', async () => {
    adapter.failNext('setOutputDevice', notFound);
    const setOutputDevice = jest.spyOn(adapter, 'setOutputDevice');
    const client = createClient({ audio: { outputDeviceId: 'speakers' } });
    await client.register();
    await jest.advanceTimersByTimeAsync(0);

    await client.audio.setOutputDevice('headphones');
    await placeCall(client);
    await jest.advanceTimersByTimeAsync(0);

    expect(setOutputDevice.mock.calls).toEqual([['speakers'], ['headphones']]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('after destroy the setters throw NotRegisteredError, the lists keep working and deviceChanged attaches nothing', async () => {
    mediaDevices.devices = [device('audioinput', 'headset')];
    const addEventListener = jest.spyOn(mediaDevices, 'addEventListener');
    const client = createClient();
    await client.register();
    await client.destroy();
    const destroyed = { code: 'NOT_REGISTERED', message: 'The client was destroyed.' };

    await expect(client.audio.setInputDevice('headset')).rejects.toMatchObject(destroyed);
    await expect(client.audio.setOutputDevice('headphones')).rejects.toMatchObject(destroyed);
    await expect(client.audio.inputDevices()).resolves.toEqual(mediaDevices.devices);
    client.audio.on('deviceChanged', () => {});

    expect(addEventListener).not.toHaveBeenCalled();
  });
});
