/**
 * @jest-environment jsdom
 */
import { act, render, renderHook } from '@testing-library/react';
import { createElement, type ComponentProps, type ReactNode } from 'react';
import SentVoice from '@sentdm/voice';
import { loadAdapter } from '@sentdm/voice/adapter/loader';
import { TokenInvalidError } from '@sentdm/voice/errors';
import {
  SentVoiceProvider,
  useActiveCall,
  useAudioDevices,
  useIncomingCall,
  useSentVoice,
} from '@sentdm/voice/react';
import { MockAdapter, type CallScript } from '../adapter/mock-adapter';
import { prefix, voiceToken } from '../voice-token';

jest.mock('@sentdm/voice/adapter/loader');

const hangsUp: CallScript = [{ type: 'ended', reason: 'completed', after: 1_000 }];

class FakeMediaDevices extends EventTarget {
  devices: MediaDeviceInfo[] = [];

  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    return this.devices;
  }
}

const device = (kind: MediaDeviceKind, deviceId: string) => ({ kind, deviceId }) as MediaDeviceInfo;

const advance = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));

describe('React helpers', () => {
  let adapter: MockAdapter;
  let mediaDevices: FakeMediaDevices;
  let tokenProvider: jest.Mock<Promise<string>, []>;
  let props: Partial<ComponentProps<typeof SentVoiceProvider>>;

  const wrapper = ({ children }: { children?: ReactNode }) =>
    createElement(
      SentVoiceProvider,
      { tokenProvider, logLevel: 'off', telemetry: { disabled: true }, ...props },
      children,
    );

  beforeEach(() => {
    jest.useFakeTimers();
    adapter = new MockAdapter();
    jest.mocked(loadAdapter).mockClear().mockResolvedValue(adapter);
    mediaDevices = new FakeMediaDevices();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', { configurable: true, value: () => {} });
    tokenProvider = jest.fn(async () => voiceToken());
    props = {};
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('children render before the client exists, which then registers once', async () => {
    const register = jest.spyOn(adapter, 'register');
    const states: Array<[SentVoice | null, SentVoice.ClientState]> = [];
    const { result } = renderHook(
      () => {
        const voice = useSentVoice();
        states.push([voice.client, voice.state]);
        return voice;
      },
      { wrapper },
    );

    expect(states[0]).toEqual([null, 'unregistered']);
    await advance(0);

    expect(result.current.client).toBeInstanceOf(SentVoice);
    expect(states.map(([, state]) => state)).toEqual([
      'unregistered',
      'unregistered',
      'registering',
      'registered',
    ]);
    expect(register).toHaveBeenCalledTimes(1);
  });

  test('under StrictMode the first client is destroyed without registering and only the kept one registers', async () => {
    const destroy = jest.spyOn(SentVoice.prototype, 'destroy');
    const register = jest.spyOn(adapter, 'register');
    const { result, unmount } = renderHook(() => useSentVoice(), { wrapper, reactStrictMode: true });
    await advance(0);

    const { client } = result.current;
    expect(destroy.mock.contexts).toHaveLength(1);
    expect(destroy.mock.contexts[0]).not.toBe(client);
    expect(result.current.state).toBe('registered');
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);

    unmount();

    expect(destroy.mock.contexts).toHaveLength(2);
    expect(destroy.mock.contexts[1]).toBe(client);
  });

  test('unmounting mid-call destroys the client: the call hangs up, the client unregisters and no timer is left', async () => {
    const hangup = jest.spyOn(adapter, 'hangup');
    const unregister = jest.spyOn(adapter, 'unregister');
    const { result, unmount } = renderHook(() => ({ voice: useSentVoice(), active: useActiveCall() }), {
      wrapper,
    });
    await advance(0);
    adapter.scriptNextCall([{ type: 'connected' }]);
    await act(() => result.current.voice.client!.connect({ to: 'ben' }));
    await advance(3_000);
    expect(result.current.active.duration).toBe(3);
    const { client } = result.current.voice;

    unmount();
    await advance(0);

    expect(client!.state).toBe('destroyed');
    expect(hangup).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('with autoRegister off, register and unregister call through, and do nothing before the client exists', async () => {
    props = { autoRegister: false };
    const renders: Array<ReturnType<typeof useSentVoice>> = [];
    const { result } = renderHook(
      () => {
        const voice = useSentVoice();
        renders.push(voice);
        return voice;
      },
      { wrapper },
    );
    await advance(0);
    const beforeClient = renders[0]!;

    await act(() => beforeClient.register());
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(result.current.state).toBe('unregistered');
    expect(result.current.register).not.toBe(beforeClient.register);

    await act(() => result.current.register());
    expect(result.current.state).toBe('registered');
    await act(() => result.current.unregister());
    expect(result.current.state).toBe('unregistered');
  });

  test('a failed automatic registration is caught, leaves the client unregistered and register gives the reason', async () => {
    tokenProvider.mockResolvedValue('not a token');
    const { result } = renderHook(() => useSentVoice(), { wrapper });
    await advance(0);

    expect(result.current.state).toBe('unregistered');
    await expect(act(() => result.current.register())).rejects.toBeInstanceOf(TokenInvalidError);
  });

  test('useSentVoice goes offline when refreshing fails and back once a retry succeeds', async () => {
    const { result } = renderHook(() => useSentVoice(), { wrapper });
    await advance(0);

    tokenProvider.mockRejectedValue(new TypeError('Failed to fetch'));
    await advance(480_000 + 500 + 1_000);
    expect(result.current.state).toBe('offline');
    tokenProvider.mockImplementation(async () => voiceToken());
    await advance(30_000);
    expect(result.current.state).toBe('registered');
  });

  test('refreshes call the latest tokenProvider prop and the client is kept', async () => {
    const { result, rerender } = renderHook(() => useSentVoice(), { wrapper });
    await advance(0);
    const { client } = result.current;
    const initial = tokenProvider;
    tokenProvider = jest.fn(async () => voiceToken());

    rerender();
    await advance(480_000);

    expect(initial).toHaveBeenCalledTimes(1);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(result.current.client).toBe(client);
  });

  test('useIncomingCall shows the newest pending invite, also to a late mount, falling back until none is left', async () => {
    let invite: SentVoice.CallInvite | null | undefined;
    const Incoming = () => {
      invite = useIncomingCall();
      return null;
    };
    const { rerender } = render(createElement(wrapper));
    await advance(0);

    act(() => void adapter.receiveCall(`${prefix}_carol`));
    rerender(createElement(wrapper, null, createElement(Incoming)));
    const first = invite!;
    expect(first).toMatchObject({ state: 'pending', from: { kind: 'user', identity: 'carol' } });

    act(() => void adapter.receiveCall('+38344555666'));
    const second = invite!;
    expect(second).toMatchObject({ state: 'pending', from: { kind: 'number', number: '+38344555666' } });

    await act(() => second.reject());
    expect(invite).toBe(first);
    await act(() => first.accept());
    expect(invite).toBeNull();

    act(() => void adapter.receiveCall(`${prefix}_dave`, hangsUp));
    expect(invite).toMatchObject({ state: 'pending', from: { kind: 'user', identity: 'dave' } });
    await advance(1_000);
    expect(invite).toBeNull();
  });

  test('useActiveCall follows placed and accepted calls with controls that do nothing without a call', async () => {
    const mute = jest.spyOn(adapter, 'mute');
    const sendDigits = jest.spyOn(adapter, 'sendDigits');
    const hangup = jest.spyOn(adapter, 'hangup');
    const { result } = renderHook(
      () => ({ voice: useSentVoice(), active: useActiveCall(), invite: useIncomingCall() }),
      { wrapper },
    );
    await advance(0);

    const noCall = result.current.active;
    expect(noCall).toMatchObject({ call: null, state: null, isMuted: false, duration: 0 });
    noCall.mute();
    noCall.sendDigits('1');
    await noCall.hangup();
    expect(mute).not.toHaveBeenCalled();
    expect(sendDigits).not.toHaveBeenCalled();
    expect(hangup).not.toHaveBeenCalled();

    adapter.scriptNextCall([
      { type: 'ringing', after: 500 },
      { type: 'answered', after: 1_000 },
      { type: 'connected', after: 200 },
    ]);
    const placed = await act(() => result.current.voice.client!.connect({ to: 'ben' }));
    expect(result.current.active).toMatchObject({ call: placed, state: 'initiated' });
    await advance(500);
    expect(result.current.active.state).toBe('ringing');
    await advance(1_000);
    expect(result.current.active.state).toBe('answered');
    await advance(200);
    expect(result.current.active.state).toBe('connected');

    act(() => result.current.active.mute());
    expect(result.current.active.isMuted).toBe(true);
    act(() => result.current.active.mute(false));
    expect(result.current.active.isMuted).toBe(false);
    result.current.active.sendDigits('42#');
    await act(() => result.current.active.hangup());

    expect(mute.mock.calls).toEqual([
      [placed.id, true],
      [placed.id, false],
    ]);
    expect(sendDigits).toHaveBeenCalledWith(placed.id, '42#');
    expect(hangup).toHaveBeenCalledWith(placed.id);
    expect(result.current.active).toMatchObject({ call: null, state: null, isMuted: false, duration: 0 });

    act(() => void adapter.receiveCall(`${prefix}_carol`));
    const accepted = await act(() => result.current.invite!.accept());
    expect(result.current.active).toMatchObject({ call: accepted, state: 'connected' });
  });

  test('duration ticks every second only while connected and resets when the call ends', async () => {
    const { result } = renderHook(() => ({ voice: useSentVoice(), active: useActiveCall() }), { wrapper });
    await advance(0);
    const timers = jest.getTimerCount();
    adapter.scriptNextCall([
      { type: 'connected', after: 1_000 },
      { type: 'reconnecting', after: 2_500 },
      { type: 'reconnected', after: 3_000 },
      { type: 'ended', reason: 'completed', after: 1_500 },
    ]);
    await act(() => result.current.voice.client!.connect({ to: 'ben' }));

    await advance(1_000);
    expect(result.current.active).toMatchObject({ state: 'connected', duration: 0 });
    await advance(2_500);
    expect(result.current.active).toMatchObject({ state: 'reconnecting', duration: 2 });
    await advance(2_999);
    expect(result.current.active.duration).toBe(2);
    await advance(1);
    expect(result.current.active).toMatchObject({ state: 'connected', duration: 5 });
    await advance(1_000);
    expect(result.current.active.duration).toBe(6);
    await advance(500);

    expect(result.current.active).toMatchObject({ call: null, state: null, duration: 0 });
    expect(jest.getTimerCount()).toBe(timers);
  });

  test('useAudioDevices lists devices again on each device change and sets them through the client', async () => {
    const builtIn = device('audioinput', 'built-in');
    const speakers = device('audiooutput', 'speakers');
    mediaDevices.devices = [builtIn, speakers];
    const setInputDevice = jest.spyOn(adapter, 'setInputDevice');
    const setOutputDevice = jest.spyOn(adapter, 'setOutputDevice');
    const renders: Array<ReturnType<typeof useAudioDevices>> = [];
    const { result } = renderHook(
      () => {
        const devices = useAudioDevices();
        renders.push(devices);
        return devices;
      },
      { wrapper },
    );
    const beforeClient = renders[0]!;
    expect(beforeClient).toMatchObject({ inputs: [], outputs: [] });
    await advance(0);
    expect(result.current).toMatchObject({ inputs: [builtIn], outputs: [speakers] });

    const headset = device('audioinput', 'headset');
    mediaDevices.devices = [builtIn, headset, speakers];
    mediaDevices.dispatchEvent(new Event('devicechange'));
    await advance(0);
    expect(result.current.inputs).toEqual([builtIn, headset]);

    await act(() => beforeClient.setInput('headset'));
    expect(setInputDevice).not.toHaveBeenCalled();
    await act(() => result.current.setInput('headset'));
    await act(() => result.current.setOutput('speakers'));
    expect(setInputDevice).toHaveBeenCalledWith('headset');
    expect(setOutputDevice).toHaveBeenCalledWith('speakers');
  });

  test('useAudioDevices keeps the lists empty where the browser cannot list devices', async () => {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    const { result } = renderHook(() => useAudioDevices(), { wrapper });
    await advance(0);

    expect(result.current).toMatchObject({ inputs: [], outputs: [] });
  });

  test('the hooks render only on SDK events, never while the SDK is idle', async () => {
    let renders = 0;
    renderHook(
      () => {
        renders++;
        useSentVoice();
        useIncomingCall();
        useActiveCall();
        useAudioDevices();
      },
      { wrapper },
    );
    await advance(0);
    const settled = renders;

    await advance(600_000);

    expect(renders).toBe(settled);
  });

  test.each<[string, () => unknown]>([
    ['useSentVoice', useSentVoice],
    ['useIncomingCall', useIncomingCall],
    ['useActiveCall', useActiveCall],
    ['useAudioDevices', useAudioDevices],
  ])('%s throws outside a SentVoiceProvider', (_, hook) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => renderHook(hook)).toThrow('The voice hooks must be used inside a SentVoiceProvider.');
  });
});
