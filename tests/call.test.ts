import SentVoice from '@sentdm/voice';
import { loadAdapter } from '@sentdm/voice/adapter/loader';
import { CallFailedError, NetworkError } from '@sentdm/voice/errors';
import { MockAdapter, type CallScript } from './adapter/mock-adapter';
import { voiceToken } from './voice-token';

jest.mock('@sentdm/voice/adapter/loader');

const now = Date.parse('2026-09-22T12:00:00Z');
const dropped = new NetworkError();

const record = (call: SentVoice.Call) => {
  const events: unknown[] = [];
  for (const event of ['ringing', 'answered', 'connected', 'reconnecting', 'reconnected'] as const) {
    call.on(event, () => events.push(`${event} while ${call.state}`));
  }
  call.on('error', (error) => events.push(error));
  call.on('disconnected', (info) => events.push(info));
  return events;
};

describe('Call', () => {
  let adapter: MockAdapter;
  let client: SentVoice;

  beforeEach(async () => {
    jest.useFakeTimers({ now });
    adapter = new MockAdapter();
    jest.mocked(loadAdapter).mockResolvedValue(adapter);
    client = new SentVoice({ tokenProvider: async () => voiceToken(), logLevel: 'off' });
    await client.register();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('an outbound call rings, is answered, connects and disconnects, moving its state first', async () => {
    adapter.scriptNextCall([
      { type: 'ringing', after: 500 },
      { type: 'answered', after: 3_000 },
      { type: 'connected', after: 200 },
      { type: 'ended', reason: 'completed', after: 60_000 },
    ]);
    const call = await client.connect({ to: 'ben' });
    const events = record(call);

    expect(call).toMatchObject({
      direction: 'outbound',
      state: 'initiated',
      isMuted: false,
      startedAt: undefined,
    });

    jest.advanceTimersByTime(3_700);
    expect(call).toMatchObject({ state: 'connected', startedAt: now + 3_700 });
    jest.advanceTimersByTime(60_000);

    expect(call.state).toBe('completed');
    expect(events).toEqual([
      'ringing while ringing',
      'answered while answered',
      'connected while connected',
      { state: 'completed' },
    ]);
  });

  test.each<[string, CallScript, unknown[]]>([
    [
      'busy',
      [{ type: 'ringing' }, { type: 'ended', reason: 'busy' }],
      ['ringing while ringing', { state: 'busy' }],
    ],
    [
      'noAnswer',
      [{ type: 'ringing' }, { type: 'ended', reason: 'noAnswer' }],
      ['ringing while ringing', { state: 'noAnswer' }],
    ],
    [
      'failed',
      [{ type: 'ringing' }, { type: 'ended', reason: 'failed', error: dropped }],
      ['ringing while ringing', dropped, { state: 'failed', error: dropped }],
    ],
  ])('a call the provider ends as %s disconnects in that state', async (state, script, expected) => {
    adapter.scriptNextCall(script);
    const call = await client.connect({ to: '+38349123456' });
    const events = record(call);

    jest.advanceTimersByTime(1_000);

    expect(call).toMatchObject({ state, startedAt: undefined });
    expect(events).toEqual(expected);
  });

  test.each<[string, CallScript, string[]]>([
    [
      'late and repeated progress',
      [
        { type: 'ringing' },
        { type: 'answered' },
        { type: 'ringing' },
        { type: 'connected' },
        { type: 'answered' },
        { type: 'connected' },
      ],
      ['ringing while ringing', 'answered while answered', 'connected while connected'],
    ],
    [
      'a connection before any ringing or answer',
      [{ type: 'connected' }, { type: 'ringing' }, { type: 'answered' }],
      ['connected while connected'],
    ],
    [
      'a reconnect before the call connected',
      [{ type: 'answered' }, { type: 'reconnecting' }, { type: 'connected' }],
      ['answered while answered', 'connected while connected'],
    ],
    [
      'a reconnect that never dropped',
      [{ type: 'connected' }, { type: 'reconnected' }],
      ['connected while connected'],
    ],
  ])('events out of order never move a call backwards: %s', async (_, script, expected) => {
    adapter.scriptNextCall(script);
    const call = await client.connect({ to: 'ben' });
    const events = record(call);

    jest.advanceTimersByTime(1_000);

    expect(call.state).toBe('connected');
    expect(events).toEqual(expected);
  });

  test('a call that loses its connection reports reconnecting, then reconnected, keeping startedAt', async () => {
    adapter.scriptNextCall([
      { type: 'connected' },
      { type: 'reconnecting', after: 10_000 },
      { type: 'reconnected', after: 2_000 },
    ]);
    const call = await client.connect({ to: 'ben' });
    const events = record(call);

    jest.advanceTimersByTime(12_000);

    expect(call).toMatchObject({ state: 'connected', startedAt: now });
    expect(events).toEqual([
      'connected while connected',
      'reconnecting while reconnecting',
      'reconnected while connected',
    ]);
  });

  test('mute toggles without an argument, reaching the provider and reporting each change once', async () => {
    const call = await client.connect({ to: 'ben' });
    const mute = jest.spyOn(adapter, 'mute');
    const changes: boolean[] = [];
    call.on('muteChanged', (isMuted) => changes.push(isMuted));

    call.mute();
    expect(call.isMuted).toBe(true);
    call.mute(true);
    call.mute();
    call.mute(false);

    expect(call.isMuted).toBe(false);
    expect(changes).toEqual([true, false]);
    expect(mute.mock.calls).toEqual([
      [call.id, true],
      [call.id, false],
    ]);
  });

  test('a mute the provider refuses throws and changes nothing', async () => {
    const call = await client.connect({ to: 'ben' });
    const failure = new CallFailedError();
    adapter.failNext('mute', failure);
    const muteChanged = jest.fn();
    call.on('muteChanged', muteChanged);

    expect(() => call.mute()).toThrow(failure);

    expect(call.isMuted).toBe(false);
    expect(muteChanged).not.toHaveBeenCalled();
  });

  test('sendDigits and getStats pass through to the provider for this call', async () => {
    const call = await client.connect({ to: '+38349123456' });
    const sendDigits = jest.spyOn(adapter, 'sendDigits');
    const stats = { jitter: 12, packetLoss: 0.01, rtt: 180 };
    const getStats = jest.spyOn(adapter, 'getStats').mockResolvedValueOnce(stats);

    call.sendDigits('123#');

    expect(sendDigits).toHaveBeenCalledWith(call.id, '123#');
    await expect(call.getStats()).resolves.toBe(stats);
    expect(getStats).toHaveBeenCalledWith(call.id);
  });

  test('hangup ends the call through the provider, and disconnect does nothing once it has ended', async () => {
    const call = await client.connect({ to: 'ben' });
    const hangup = jest.spyOn(adapter, 'hangup');
    const events = record(call);

    await call.hangup();
    await call.disconnect();

    expect(hangup).toHaveBeenCalledTimes(1);
    expect(hangup).toHaveBeenCalledWith(call.id);
    expect(call.state).toBe('completed');
    expect(events).toEqual([{ state: 'completed' }]);
  });
});
