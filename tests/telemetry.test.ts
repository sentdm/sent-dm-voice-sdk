import SentVoice, { type SentVoiceOptions } from '@sentdm/voice';
import { loadAdapter } from '@sentdm/voice/adapter/loader';
import type { CallTarget } from '@sentdm/voice/adapter/types';
import type { CallStats } from '@sentdm/voice/call';
import { CallFailedError, MediaPermissionError, NetworkError, SentVoiceError } from '@sentdm/voice/errors';
import { MockAdapter } from './adapter/mock-adapter';
import fixture from './fixtures/telemetry-batch-request.json';
import { prefix, voiceToken } from './voice-token';

jest.mock('@sentdm/voice/adapter/loader');
jest.mock('@sentdm/voice/version', () => ({ VERSION: '0.1.0' }));

type SentEvent = { type: string; call_id?: string; occurred_at: string; payload: Record<string, unknown> };

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
}

class TimedAdapter extends MockAdapter {
  #note: (entry: string) => void;

  constructor(note: (entry: string) => void) {
    super();
    this.#note = note;
  }

  override register(token: string) {
    this.#note('register');
    return super.register(token);
  }

  override call(target: CallTarget) {
    this.#note('call');
    return super.call(target);
  }

  override answer(callId: string) {
    this.#note('answer');
    return super.answer(callId);
  }

  override hangup(callId: string) {
    this.#note('hangup');
    return super.hangup(callId);
  }

  override mute(callId: string, muted: boolean) {
    this.#note('mute');
    super.mute(callId, muted);
  }

  override sendDigits(callId: string, digits: string) {
    this.#note('sendDigits');
    super.sendDigits(callId, digits);
  }

  override getStats(): Promise<CallStats> {
    return new Promise((resolve) =>
      setTimeout(() => resolve({ jitter: 6, packetLoss: 0.01, rtt: 80 }), 5_000),
    );
  }
}

const now = Date.parse('2026-07-22T12:00:00Z');
const refreshAt = 480_000;
const chromeOnMac =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const accepted = { ok: true, status: 202 } as Response;
const fetchFailure = new TypeError('Failed to fetch');
const unmapped = new SentVoiceError({ code: 'UNKNOWN', category: 'signaling', retriable: false });

const setGlobal = (name: string, value: unknown) =>
  Object.defineProperty(globalThis, name, { configurable: true, value });

describe('telemetry', () => {
  let adapter: MockAdapter;
  let tokenProvider: jest.Mock<Promise<string>, []>;
  let fetchMock: jest.Mock<Promise<Response>, [string, RequestInit]>;
  let page: FakeDocument;

  const createClient = (options: Partial<SentVoiceOptions> = {}) =>
    new SentVoice({ tokenProvider, logLevel: 'off', ...options });
  const batches = () =>
    fetchMock.mock.calls.map(
      ([, init]) => JSON.parse(init.body as string) as { sdk_version: string; events: SentEvent[] },
    );
  const sent = () => batches().flatMap(({ events }) => events);

  beforeEach(() => {
    jest.useFakeTimers({ now });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    adapter = new MockAdapter();
    jest.mocked(loadAdapter).mockClear().mockResolvedValue(adapter);
    tokenProvider = jest.fn(async () => voiceToken());
    fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(async () => accepted);
    page = new FakeDocument();
    setGlobal('fetch', fetchMock);
    setGlobal('window', new EventTarget());
    setGlobal('document', page);
    setGlobal('navigator', { userAgent: chromeOnMac });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('a session sends the shared fixture batch byte for byte when its call ends', async () => {
    jest.setSystemTime(now - 1_000);
    jest
      .spyOn(adapter, 'register')
      .mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(unmapped), 250)))
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 412)));
    jest.spyOn(adapter, 'answer').mockRejectedValueOnce(new MediaPermissionError());
    jest
      .spyOn(adapter, 'getStats')
      .mockResolvedValueOnce({ jitter: 6, packetLoss: 0.01, rtt: 80 })
      .mockResolvedValueOnce({ jitter: 7, packetLoss: 0.014, rtt: 88 });
    const client = createClient();
    let invite!: SentVoice.CallInvite;
    client.on('incomingCall', (received) => (invite = received));

    const failed = expect(client.register()).rejects.toBe(unmapped);
    await jest.advanceTimersByTimeAsync(250);
    await failed;
    await jest.advanceTimersByTimeAsync(338);
    const registered = client.register();
    await jest.advanceTimersByTimeAsync(412);
    await registered;
    await jest.advanceTimersByTimeAsync(1_000);
    adapter.receiveCall(`${prefix}=ben`);
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(invite.accept()).rejects.toBeInstanceOf(MediaPermissionError);
    await jest.advanceTimersByTimeAsync(1_000);
    const call = await invite.accept();
    await jest.advanceTimersByTimeAsync(26_000);
    expect(fetchMock).not.toHaveBeenCalled();
    await call.disconnect();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].body).toBe(JSON.stringify(fixture));
  });

  test.each<[string, SentVoiceOptions['telemetry'], string]>([
    ['the Sent API', undefined, 'https://api.sent.dm/v3/voice/telemetry'],
    [
      'another base URL',
      { baseURL: 'https://staging.example/' },
      'https://staging.example/v3/voice/telemetry',
    ],
  ])('queued events go to %s every 30 s with the voice token as bearer', async (_, telemetry, url) => {
    const jwt = voiceToken();
    tokenProvider.mockResolvedValueOnce(jwt);
    const client = createClient({ telemetry });
    await client.register();

    await jest.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    expect(fetchMock).toHaveBeenCalledWith(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: expect.any(String),
      keepalive: false,
    });
    expect(sent().map(({ type }) => type)).toEqual(['register.completed', 'client.info']);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test.each<[string, () => void]>([
    [
      'the page is hidden',
      () => {
        page.visibilityState = 'hidden';
        page.dispatchEvent(new Event('visibilitychange'));
      },
    ],
    ['the page is left', () => window.dispatchEvent(new Event('pagehide'))],
  ])('when %s, queued events leave at once in a keepalive request', async (_, leave) => {
    const client = createClient();
    await client.register();
    page.dispatchEvent(new Event('visibilitychange'));
    expect(fetchMock).not.toHaveBeenCalled();

    leave();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(sent().map(({ type }) => type)).toEqual(['register.completed', 'client.info']);
  });

  test('register() outcomes carry their duration and attempts, and nothing leaves before the first registration', async () => {
    tokenProvider
      .mockRejectedValueOnce(fetchFailure)
      .mockRejectedValueOnce(fetchFailure)
      .mockRejectedValueOnce(fetchFailure);
    const client = createClient();

    const failed = expect(client.register()).rejects.toBeInstanceOf(NetworkError);
    await jest.advanceTimersByTimeAsync(1_500);
    await failed;
    window.dispatchEvent(new Event('pagehide'));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    tokenProvider.mockRejectedValueOnce(fetchFailure);
    const registered = client.register();
    await jest.advanceTimersByTimeAsync(500);
    await registered;
    await jest.advanceTimersByTimeAsync(30_000);

    expect(sent().map(({ type, payload }) => [type, payload])).toEqual([
      ['register.failed', { duration_ms: 1_500, attempt: 3, code: 'NETWORK', category: 'network' }],
      ['register.completed', { duration_ms: 500, attempt: 2 }],
      ['client.info', expect.any(Object)],
    ]);
  });

  test('placed calls report setup and connected time, and no quality without a full sample', async () => {
    const client = createClient();
    await client.register();
    adapter.scriptNextCall([
      { type: 'ringing', after: 1_000 },
      { type: 'connected', after: 2_000 },
      { type: 'ended', reason: 'completed', after: 5_000 },
    ]);
    await client.connect({ to: 'ben' });
    await jest.advanceTimersByTimeAsync(8_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    adapter.scriptNextCall([{ type: 'ringing' }, { type: 'ended', reason: 'busy', after: 4_000 }]);
    await client.connect({ to: '+38349123456' });
    await jest.advanceTimersByTimeAsync(4_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent().map(({ type, call_id, payload }) => [type, call_id, payload])).toEqual([
      ['register.completed', undefined, expect.any(Object)],
      ['client.info', undefined, expect.any(Object)],
      ['call.started', 'mock-call-1', { direction: 'outbound' }],
      ['call.connected', 'mock-call-1', { direction: 'outbound', duration_ms: 3_000 }],
      ['call.ended', 'mock-call-1', { direction: 'outbound', outcome: 'completed', duration_ms: 5_000 }],
      ['call.started', 'mock-call-2', { direction: 'outbound' }],
      ['call.ended', 'mock-call-2', { direction: 'outbound', outcome: 'busy' }],
    ]);
  });

  test('client.error reports error events and provider failures by code and category, not app mistakes', async () => {
    const client = createClient({ registerRetries: 0 });
    await client.register();
    adapter.failNext('call', unmapped);
    await expect(client.connect({ to: 'ben' })).rejects.toBe(unmapped);
    await expect(client.connect({ to: 'not an identity' })).rejects.toMatchObject({
      code: 'INVALID_ADDRESS',
    });
    adapter.scriptNextCall([{ type: 'ended', reason: 'failed', error: new CallFailedError() }]);
    await client.connect({ to: '+38349123456' });
    await jest.advanceTimersByTimeAsync(0);
    tokenProvider.mockRejectedValue(fetchFailure);
    await jest.advanceTimersByTimeAsync(refreshAt + 30_000);

    expect(
      sent()
        .filter(({ type }) => type === 'client.error')
        .map(({ call_id, payload }) => [call_id, payload]),
    ).toEqual([
      [undefined, { code: 'UNKNOWN', category: 'signaling' }],
      ['mock-call-1', { code: 'CALL_FAILED', category: 'signaling' }],
      [undefined, { code: 'NETWORK', category: 'network' }],
    ]);
  });

  test('client.info leaves out what the user agent does not tell, and never sends the user agent itself', async () => {
    setGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    });
    const client = createClient();
    await client.register();

    window.dispatchEvent(new Event('pagehide'));

    expect(sent().find(({ type }) => type === 'client.info')?.payload).toEqual({
      browser: 'Chrome',
      browser_version: '128',
      os: 'Chrome OS',
    });
  });

  test('the queue keeps the newest 100 events', async () => {
    const client = createClient();
    await client.register();
    for (let failure = 0; failure < 99; failure++) {
      adapter.failNext('call', unmapped);
      await expect(client.connect({ to: 'ben' })).rejects.toBe(unmapped);
    }

    await jest.advanceTimersByTimeAsync(30_000);

    const events = sent();
    expect(events).toHaveLength(100);
    expect(events[0]!.type).toBe('client.info');
    expect(events.slice(1).every(({ type }) => type === 'client.error')).toBe(true);
  });

  test.each<[string, () => Promise<Response>, string]>([
    [
      'the network fails',
      () => Promise.reject(fetchFailure),
      'Sending telemetry failed: TypeError: Failed to fetch',
    ],
    [
      'Sent refuses the batch',
      async () => ({ ok: false, status: 429 }) as Response,
      'Sending telemetry failed with status 429',
    ],
  ])(
    'when %s, a batch is retried once with the next flush, then dropped, silently but for a debug line',
    async (_, failure, line) => {
      fetchMock.mockImplementation(failure);
      const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
      const client = createClient({ logger, logLevel: 'debug' });
      const errors = jest.fn();
      client.on('error', errors);
      await client.register();

      await jest.advanceTimersByTimeAsync(30_000);
      adapter.failNext('call', unmapped);
      await expect(client.connect({ to: 'ben' })).rejects.toBe(unmapped);
      await jest.advanceTimersByTimeAsync(300_000);

      expect(batches().map(({ events }) => events.map(({ type }) => type))).toEqual([
        ['register.completed', 'client.info'],
        ['register.completed', 'client.info', 'client.error'],
        ['client.error'],
      ]);
      expect(logger.debug.mock.calls.filter(([message]) => message.startsWith('Sending telemetry'))).toEqual([
        [line],
        [line],
        [line],
      ]);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    },
  );

  test('the voice token travels only in the Authorization header, never in a body or a log line', async () => {
    const jwt = voiceToken();
    tokenProvider.mockResolvedValue(jwt);
    fetchMock.mockRejectedValue(new TypeError(`Failed to fetch with Bearer ${jwt}`));
    const lines: string[] = [];
    const capture = (message: string) => lines.push(message);
    const client = createClient({
      logger: { error: capture, warn: capture, info: capture, debug: capture },
      logLevel: 'debug',
    });
    await client.register();

    await jest.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, { headers, body }] of fetchMock.mock.calls) {
      expect(headers).toMatchObject({ Authorization: `Bearer ${jwt}` });
      expect(body).not.toContain(jwt);
    }
    expect(lines).toContain('Sending telemetry failed: TypeError: Failed to fetch with Bearer ***');
    expect(lines.join('\n')).not.toContain(jwt);
  });

  test('batches carry the latest token, and unregister leaves telemetry running', async () => {
    const tokens: string[] = [];
    tokenProvider.mockImplementation(async () => {
      const jwt = voiceToken();
      tokens.push(jwt);
      return jwt;
    });
    const client = createClient();
    await client.register();
    await jest.advanceTimersByTimeAsync(refreshAt);

    await client.unregister();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(
      fetchMock.mock.calls.map(([, init]) => (init.headers as Record<string, string>)['Authorization']),
    ).toEqual([`Bearer ${tokens[0]}`, `Bearer ${tokens[1]}`]);
    expect(batches()[1]!.events).toEqual([
      { type: 'unregister.completed', occurred_at: '2026-07-22T12:08:00.000Z', payload: { duration_ms: 0 } },
    ]);
  });

  test('destroy drops what is queued and stops sending, sampling and listening, whether its calls end at once or later', async () => {
    const addWindowListener = jest.spyOn(window, 'addEventListener');
    const removeWindowListener = jest.spyOn(window, 'removeEventListener');
    const addPageListener = jest.spyOn(page, 'addEventListener');
    const removePageListener = jest.spyOn(page, 'removeEventListener');
    const client = createClient();
    await client.register();
    let invite!: SentVoice.CallInvite;
    client.on('incomingCall', (received) => (invite = received));
    adapter.scriptNextCall([{ type: 'connected' }]);
    await client.connect({ to: 'ben' });
    adapter.receiveCall(`${prefix}=carol`);
    await invite.accept();
    const getStats = jest.spyOn(adapter, 'getStats');
    jest.spyOn(adapter, 'hangup').mockResolvedValueOnce();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(getStats).toHaveBeenCalledTimes(2);

    await client.destroy();
    window.dispatchEvent(new Event('pagehide'));
    await jest.advanceTimersByTimeAsync(600_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getStats).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
    expect(removeWindowListener.mock.calls).toEqual(addWindowListener.mock.calls);
    expect(removePageListener.mock.calls).toEqual(addPageListener.mock.calls);
  });

  test('with telemetry disabled nothing is sent, sampled, listened to or scheduled', async () => {
    const addWindowListener = jest.spyOn(window, 'addEventListener');
    const addPageListener = jest.spyOn(page, 'addEventListener');
    const getStats = jest.spyOn(adapter, 'getStats');
    const client = createClient({ telemetry: { disabled: true } });
    await client.register();
    adapter.scriptNextCall([{ type: 'connected' }, { type: 'ended', reason: 'completed', after: 20_000 }]);
    await client.connect({ to: 'ben' });

    await jest.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event('pagehide'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getStats).not.toHaveBeenCalled();
    expect(addWindowListener).not.toHaveBeenCalled();
    expect(addPageListener).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
  });

  test('call operations keep their timing with telemetry on, while its stats reads and requests take seconds', async () => {
    const run = async (telemetry: SentVoiceOptions['telemetry']) => {
      jest.clearAllTimers();
      jest.setSystemTime(now);
      const timeline: string[] = [];
      const note = (entry: string) => timeline.push(`${Date.now() - now} ${entry}`);
      const timed = new TimedAdapter(note);
      jest.mocked(loadAdapter).mockResolvedValue(timed);
      fetchMock.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(accepted), 5_000)),
      );
      const client = createClient({ telemetry });
      const track = (call: SentVoice.Call, name: string) => {
        for (const event of ['ringing', 'answered', 'connected', 'disconnected'] as const) {
          call.on(event, () => note(`${name} ${event}`));
        }
      };
      client.on('incomingCall', (invite) => {
        note('incomingCall');
        void invite.accept().then((call) => {
          note('accept resolved');
          track(call, 'incoming');
        });
      });
      timed.scriptNextCall([
        { type: 'ringing', after: 1_000 },
        { type: 'answered', after: 2_000 },
        { type: 'connected' },
      ]);

      void client.register().then(() => note('register resolved'));
      await jest.advanceTimersByTimeAsync(0);
      void client.connect({ to: 'ben' }).then((call) => {
        note('connect resolved');
        track(call, 'placed');
      });
      await jest.advanceTimersByTimeAsync(25_000);
      const placed = client.activeCall!;
      placed.mute();
      placed.sendDigits('1');
      void placed.disconnect().then(() => note('disconnect resolved'));
      await jest.advanceTimersByTimeAsync(0);
      timed.receiveCall(`${prefix}=carol`);
      await jest.advanceTimersByTimeAsync(15_000);
      void client.activeCall!.disconnect().then(() => note('incoming disconnect resolved'));
      await jest.advanceTimersByTimeAsync(0);
      void client.destroy().then(() => note('destroy resolved'));
      await jest.advanceTimersByTimeAsync(10_000);
      return timeline;
    };

    const withTelemetry = await run(undefined);
    expect(fetchMock).toHaveBeenCalled();
    expect(withTelemetry).toEqual(await run({ disabled: true }));
  });
});
