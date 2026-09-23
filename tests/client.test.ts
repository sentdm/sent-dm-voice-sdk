import SentVoice, { type SentVoiceOptions } from '@sentdm/voice';
import { loadAdapter } from '@sentdm/voice/adapter/loader';
import type { CallEvent, CallTarget } from '@sentdm/voice/adapter/types';
import {
  NetworkError,
  NotRegisteredError,
  SentVoiceError,
  TokenExpiredError,
  TokenInvalidError,
} from '@sentdm/voice/errors';
import { version } from '../package.json';
import { MockAdapter } from './adapter/mock-adapter';
import { prefix, voiceToken } from './voice-token';

jest.mock('@sentdm/voice/adapter/loader');

type PendingFetch = { resolve: (jwt: string) => void; reject: (error: Error) => void };

const fetchFailure = new TypeError('Failed to fetch');
const refreshAt = 480_000;
const longestIdentity = 'agent_7-B'.padEnd(200, 'x');
const invalidAddress = { code: 'INVALID_ADDRESS', category: 'validation', retriable: false };

describe('SentVoice', () => {
  let adapter: MockAdapter;
  let tokenProvider: jest.Mock<Promise<string>, []>;

  const createClient = (options: Partial<SentVoiceOptions> = {}) =>
    new SentVoice({ tokenProvider, logLevel: 'off', telemetry: { disabled: true }, ...options });

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-09-22T12:00:00Z') });
    jest.spyOn(Math, 'random').mockReturnValue(0);
    adapter = new MockAdapter();
    jest.mocked(loadAdapter).mockClear().mockResolvedValue(adapter);
    tokenProvider = jest.fn(async () => voiceToken());
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('SentVoice.version is the package version', () => {
    expect(SentVoice.version).toBe(version);
  });

  test('register loads the adapter, registers it with the token and exposes the identity and number', async () => {
    const jwt = voiceToken();
    tokenProvider.mockResolvedValueOnce(jwt);
    const register = jest.spyOn(adapter, 'register');
    const client = createClient();
    const events: string[] = [];
    client.on('registering', () => events.push(`registering while ${client.state}`));
    client.on('registered', () => events.push(`registered while ${client.state}`));

    expect(loadAdapter).not.toHaveBeenCalled();
    expect(client).toMatchObject({ state: 'unregistered', identity: undefined, number: undefined });

    await client.register();

    expect(loadAdapter).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(jwt);
    expect(events).toEqual(['registering while registering', 'registered while registered']);
    expect(client).toMatchObject({ state: 'registered', identity: 'agent-42', number: '+38349111222' });
  });

  test('register hands the service worker and audio element options to the adapter', async () => {
    const serviceWorker = { url: '/voice/sw.js', scope: '/voice/' };
    const element = {} as HTMLAudioElement;
    const client = createClient({ serviceWorker, audio: { element } });

    await client.register();

    expect(loadAdapter).toHaveBeenCalledWith({ serviceWorker, audioElement: element });
  });

  test('register while registering or registered does not register again', async () => {
    const client = createClient();
    const registering = jest.fn();
    client.on('registering', registering);

    await Promise.all([client.register(), client.register()]);
    await client.register();

    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(registering).toHaveBeenCalledTimes(1);
  });

  test('register rejects garbage from the token provider with TokenInvalidError, without retrying', async () => {
    tokenProvider.mockResolvedValue({ token: voiceToken() } as never);
    const client = createClient();
    const unregistered = jest.fn();
    client.on('unregistered', unregistered);

    await expect(client.register()).rejects.toBeInstanceOf(TokenInvalidError);

    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(client.state).toBe('unregistered');
    expect(unregistered).toHaveBeenCalledTimes(1);
  });

  test('register retries retriable failures with backoff', async () => {
    tokenProvider.mockRejectedValueOnce(fetchFailure);
    adapter.failNext('register', new NetworkError());
    const client = createClient();

    const registered = client.register();
    await jest.advanceTimersByTimeAsync(0);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(500);
    expect(tokenProvider).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(999);
    expect(tokenProvider).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);

    await expect(registered).resolves.toBeUndefined();
    expect(tokenProvider).toHaveBeenCalledTimes(3);
    expect(client.state).toBe('registered');
  });

  test('register gives up with NetworkError once registerRetries retries have failed', async () => {
    tokenProvider.mockRejectedValue(fetchFailure);
    const client = createClient({ registerRetries: 3 });

    const registered = client.register();
    const rejected = expect(registered).rejects.toBeInstanceOf(NetworkError);
    await jest.advanceTimersByTimeAsync(500 + 1_000 + 2_000);

    await rejected;
    expect(tokenProvider).toHaveBeenCalledTimes(4);
    expect(client.state).toBe('unregistered');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a provider that fails to load is loaded again by the next register', async () => {
    const failure = new TypeError('Failed to fetch dynamically imported module');
    jest.mocked(loadAdapter).mockRejectedValueOnce(failure);
    const client = createClient();

    await expect(client.register()).rejects.toBe(failure);
    expect(client.state).toBe('unregistered');

    await client.register();

    expect(loadAdapter).toHaveBeenCalledTimes(2);
    expect(client.state).toBe('registered');
  });

  test('refresh fires at 80% of the lifetime, announces the expiry and re-registers with the new token', async () => {
    tokenProvider.mockImplementationOnce(async () => voiceToken());
    tokenProvider.mockImplementationOnce(async () => voiceToken({ 'sent:number': '+38349333444' }));
    const register = jest.spyOn(adapter, 'register');
    const client = createClient();
    const tokenWillExpire = jest.fn((_: { expiresAt: number }) => tokenProvider.mock.calls.length);
    client.on('tokenWillExpire', tokenWillExpire);
    await client.register();

    await jest.advanceTimersByTimeAsync(refreshAt - 1);
    expect(tokenWillExpire).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    expect(tokenWillExpire).toHaveBeenCalledWith({ expiresAt: Date.parse('2026-09-22T12:10:00Z') });
    expect(tokenWillExpire).toHaveReturnedWith(1);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenLastCalledWith(await tokenProvider.mock.results[1]!.value);
    expect(client).toMatchObject({ state: 'registered', number: '+38349333444' });

    await jest.advanceTimersByTimeAsync(refreshAt);
    expect(tokenProvider).toHaveBeenCalledTimes(3);
  });

  test('refresh fires 30 s before exp when 80% of the lifetime is later, with no tokenWillExpire listener', async () => {
    tokenProvider.mockImplementationOnce(async () =>
      voiceToken({ exp: Math.floor(Date.now() / 1000) + 100 }),
    );
    const client = createClient();
    await client.register();

    await jest.advanceTimersByTimeAsync(69_999);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(tokenProvider).toHaveBeenCalledTimes(2);
  });

  test('refresh never fires before half of the lifetime, so a short token is not refreshed at once', async () => {
    tokenProvider.mockImplementationOnce(async () => voiceToken({ exp: Math.floor(Date.now() / 1000) + 20 }));
    const client = createClient();
    await client.register();

    await jest.advanceTimersByTimeAsync(9_999);
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(tokenProvider).toHaveBeenCalledTimes(2);
  });

  test('a refresh that runs out of retries emits its cause, goes offline and recovers in the slow loop', async () => {
    const client = createClient();
    await client.register();
    const events: SentVoiceError[] = [];
    client.on('error', (error) => events.push(error));
    client.on('offline', (reason) => events.push(reason));
    const registered = jest.fn();
    client.on('registered', registered);
    tokenProvider.mockRejectedValue(fetchFailure);

    await jest.advanceTimersByTimeAsync(refreshAt + 500);
    expect(tokenProvider).toHaveBeenCalledTimes(3);
    expect(client.state).toBe('registered');
    await jest.advanceTimersByTimeAsync(1_000);

    expect(tokenProvider).toHaveBeenCalledTimes(4);
    expect(events).toEqual([expect.any(NetworkError), expect.any(TokenExpiredError)]);
    expect(client).toMatchObject({ state: 'offline', identity: 'agent-42' });

    await jest.advanceTimersByTimeAsync(30_000);
    expect(tokenProvider).toHaveBeenCalledTimes(5);
    expect(client.state).toBe('offline');

    tokenProvider.mockImplementation(async () => voiceToken());
    await jest.advanceTimersByTimeAsync(30_000);
    expect(tokenProvider).toHaveBeenCalledTimes(6);
    expect(client.state).toBe('registered');
    expect(registered).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(2);
  });

  test('register while offline tries at once, and the slow loop only carries on while it fails', async () => {
    const client = createClient({ registerRetries: 0 });
    await client.register();
    tokenProvider.mockRejectedValueOnce(fetchFailure).mockRejectedValueOnce(fetchFailure);
    await jest.advanceTimersByTimeAsync(refreshAt);
    expect(client.state).toBe('offline');

    await expect(client.register()).rejects.toBeInstanceOf(NetworkError);
    expect(client.state).toBe('offline');
    expect(jest.getTimerCount()).toBe(1);

    await client.register();
    expect(client.state).toBe('registered');
    await jest.advanceTimersByTimeAsync(30_000);
    expect(tokenProvider).toHaveBeenCalledTimes(4);
  });

  test('a live call survives a failed refresh', async () => {
    const client = createClient({ registerRetries: 0 });
    await client.register();
    const callId = adapter.receiveCall(`${prefix}=ben`);
    await adapter.answer(callId);
    const callEvents: CallEvent[] = [];
    adapter.onCallEvent((event) => callEvents.push(event));
    const unregister = jest.spyOn(adapter, 'unregister');
    const hangup = jest.spyOn(adapter, 'hangup');
    tokenProvider.mockRejectedValue(fetchFailure);

    await jest.advanceTimersByTimeAsync(refreshAt + 30_000);

    expect(client.state).toBe('offline');
    expect(callEvents).toEqual([]);
    expect(unregister).not.toHaveBeenCalled();
    expect(hangup).not.toHaveBeenCalled();
  });

  test('unregister stops refreshing, unregisters the adapter and clears the session', async () => {
    const client = createClient();
    await client.register();
    const unregister = jest.spyOn(adapter, 'unregister');
    const unregistered = jest.fn();
    client.on('unregistered', unregistered);

    await client.unregister();
    await client.unregister();

    expect(client).toMatchObject({ state: 'unregistered', identity: undefined, number: undefined });
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(unregistered).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    await client.register();
    expect(client.state).toBe('registered');
    expect(loadAdapter).toHaveBeenCalledTimes(1);
  });

  test.each<[string, (fetch: PendingFetch) => void]>([
    ['succeeds', ({ resolve }) => resolve(voiceToken())],
    ['fails', ({ reject }) => reject(fetchFailure)],
  ])('unregister during a token fetch rejects the pending register once the fetch %s', async (_, settle) => {
    let fetch!: PendingFetch;
    tokenProvider.mockImplementationOnce(
      () => new Promise((resolve, reject) => (fetch = { resolve, reject })),
    );
    const register = jest.spyOn(adapter, 'register');
    const client = createClient();

    const registered = client.register();
    await client.unregister();
    settle(fetch);

    await expect(registered).rejects.toBeInstanceOf(NotRegisteredError);
    expect(register).not.toHaveBeenCalled();
    expect(client.state).toBe('unregistered');
    expect(jest.getTimerCount()).toBe(0);

    await client.register();
    expect(client.state).toBe('registered');
  });

  test('unregister while the adapter is registering waits for it, then unregisters it', async () => {
    const client = createClient();
    const calls: string[] = [];
    let unregistered!: Promise<void>;
    jest.spyOn(adapter, 'register').mockImplementationOnce(async () => {
      calls.push('register');
      unregistered = client.unregister();
      await Promise.resolve();
      calls.push('registered');
    });
    jest.spyOn(adapter, 'unregister').mockImplementationOnce(async () => {
      calls.push('unregister');
    });

    await expect(client.register()).rejects.toBeInstanceOf(NotRegisteredError);
    await unregistered;

    expect(calls).toEqual(['register', 'registered', 'unregister']);
    expect(client.state).toBe('unregistered');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('unregister ends unregistered when the adapter fails, and rejects with its error', async () => {
    const client = createClient();
    await client.register();
    const failure = new NetworkError();
    adapter.failNext('unregister', failure);

    await expect(client.unregister()).rejects.toBe(failure);

    expect(client.state).toBe('unregistered');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('destroy is idempotent and terminal, even when the adapter fails to unregister', async () => {
    const client = createClient();
    await client.register();
    const unregister = jest.spyOn(adapter, 'unregister');
    adapter.failNext('unregister', new NetworkError());

    await client.destroy();
    await client.destroy();

    expect(client).toMatchObject({ state: 'destroyed', identity: undefined, number: undefined });
    expect(unregister).toHaveBeenCalledTimes(1);
    const destroyed = { code: 'NOT_REGISTERED', message: 'The client was destroyed.' };
    await expect(client.register()).rejects.toMatchObject(destroyed);
    await expect(client.unregister()).rejects.toMatchObject(destroyed);
  });

  test.each<[string, number]>([
    ['registered', 0],
    ['retrying a refresh', refreshAt],
    ['offline', refreshAt + 500 + 1_000],
  ])('destroy while %s leaves no timers behind', async (_, elapsed) => {
    const client = createClient();
    await client.register();
    tokenProvider.mockRejectedValue(fetchFailure);
    await jest.advanceTimersByTimeAsync(elapsed);
    const calls = tokenProvider.mock.calls.length;
    expect(jest.getTimerCount()).toBe(1);

    await client.destroy();

    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(600_000);
    expect(tokenProvider).toHaveBeenCalledTimes(calls);
  });

  test.each<[string, number, number]>([
    ['a refresh', 0, refreshAt],
    ['an offline retry', 3, refreshAt + 500 + 1_000 + 30_000],
  ])(
    'destroy while the adapter takes the token of %s leaves no timers behind',
    async (_, failures, elapsed) => {
      const client = createClient();
      await client.register();
      for (let failure = 0; failure < failures; failure++) tokenProvider.mockRejectedValueOnce(fetchFailure);
      jest.spyOn(adapter, 'register').mockImplementationOnce(async () => void client.destroy());

      await jest.advanceTimersByTimeAsync(elapsed);

      expect(client.state).toBe('destroyed');
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  test('destroy from an error listener ends the refresh failure there', async () => {
    const client = createClient({ registerRetries: 0 });
    await client.register();
    client.on('error', () => void client.destroy());
    const offline = jest.fn();
    client.on('offline', offline);
    tokenProvider.mockRejectedValue(fetchFailure);

    await jest.advanceTimersByTimeAsync(refreshAt);

    expect(client.state).toBe('destroyed');
    expect(offline).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('destroy during a retrying register rejects it and leaves no timers behind', async () => {
    tokenProvider.mockRejectedValue(fetchFailure);
    const client = createClient();

    const registered = client.register();
    await jest.advanceTimersByTimeAsync(0);
    await client.destroy();

    await expect(registered).rejects.toMatchObject({ message: 'The client was destroyed.' });
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('tokens never reach the logger, at any level', async () => {
    const lines: string[] = [];
    const capture = (message: string) => lines.push(message);
    const tokens: string[] = [];
    tokenProvider.mockImplementation(async () => {
      const jwt = voiceToken();
      tokens.push(jwt);
      return jwt;
    });
    jest.spyOn(adapter, 'register').mockImplementationOnce(async (jwt) => {
      throw new NetworkError({ message: `Invalid JWT: ${jwt}` });
    });
    const client = createClient({
      logger: { error: capture, warn: capture, info: capture, debug: capture },
      logLevel: 'debug',
    });

    const registered = client.register();
    await jest.advanceTimersByTimeAsync(500);
    await registered;
    for (let failure = 0; failure < 4; failure++) tokenProvider.mockRejectedValueOnce(fetchFailure);
    await jest.advanceTimersByTimeAsync(refreshAt + 500 + 1_000 + 30_000 + 30_000);
    await client.unregister();

    const output = lines.join('\n');
    expect(lines.length).toBeGreaterThan(5);
    expect(output).toContain('Invalid JWT: ***');
    expect(tokens.length).toBeGreaterThan(1);
    for (const jwt of tokens) expect(output).not.toContain(jwt);
  });

  test('an invalid logLevel warns and falls back to warn', async () => {
    const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
    const client = new SentVoice({
      tokenProvider,
      logger,
      logLevel: 'verbose' as never,
      registerRetries: 1,
      telemetry: { disabled: true },
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'SentVoiceOptions.logLevel was set to "verbose", expected one of ["off","error","warn","info","debug"]',
    );

    await client.register();
    tokenProvider.mockRejectedValue(fetchFailure);
    await jest.advanceTimersByTimeAsync(refreshAt + 500);

    expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining('going offline'));
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  test.each<[string, string, CallTarget, SentVoice.Address]>([
    [
      'an E.164 number',
      '+38349123456',
      { kind: 'number', number: '+38349123456' },
      { kind: 'number', number: '+38349123456' },
    ],
    ['an identity', 'ben', { kind: 'user', id: `${prefix}=ben` }, { kind: 'user', identity: 'ben' }],
    [
      'a 200-character identity',
      longestIdentity,
      { kind: 'user', id: `${prefix}=${longestIdentity}` },
      { kind: 'user', identity: longestIdentity },
    ],
  ])('connect to %s dials it and returns the call addressed to it', async (_, to, target, address) => {
    const client = createClient();
    await client.register();
    const call = jest.spyOn(adapter, 'call');

    await expect(client.connect({ to })).resolves.toMatchObject({
      from: { kind: 'user', identity: 'agent-42' },
      to: address,
    });

    expect(call).toHaveBeenCalledWith(target);
  });

  test.each<[string, string]>([
    ['a namespaced identity', 'k3x9=ben'],
    ['an empty string', ''],
    ['whitespace', ' '],
    ['an identity over 200 characters', 'x'.repeat(201)],
    ['a number with spaces', '+383 49 123 456'],
    ['a number with a leading zero', '+038349123456'],
    ['a number over 15 digits', '+1234567890123456'],
  ])('connect to %s throws INVALID_ADDRESS without dialing', async (_, to) => {
    const client = createClient();
    await client.register();
    const call = jest.spyOn(adapter, 'call');

    const connecting = client.connect({ to });

    await expect(connecting).rejects.toBeInstanceOf(SentVoiceError);
    await expect(connecting).rejects.toMatchObject(invalidAddress);
    expect(call).not.toHaveBeenCalled();
  });

  test.each<[string, string]>([
    ['a room', 'daily-standup'],
    ['a 27-character room', 'x'.repeat(27)],
  ])('joinConference to %s dials it under the account prefix', async (_, name) => {
    const client = createClient();
    await client.register();
    const joinConference = jest.spyOn(adapter, 'joinConference');

    await expect(client.joinConference({ name })).resolves.toMatchObject({
      to: { kind: 'conference', name },
    });

    expect(joinConference).toHaveBeenCalledWith(`${prefix}=${name}`);
  });

  test.each<[string, string]>([
    ['a namespaced room', 'k3x9=daily'],
    ['an empty string', ''],
    ['a room with a space', 'daily standup'],
    ['a room over 27 characters', 'x'.repeat(28)],
  ])('joinConference to %s throws INVALID_ADDRESS without dialing', async (_, name) => {
    const client = createClient();
    await client.register();
    const joinConference = jest.spyOn(adapter, 'joinConference');

    const joining = client.joinConference({ name });

    await expect(joining).rejects.toBeInstanceOf(SentVoiceError);
    await expect(joining).rejects.toMatchObject(invalidAddress);
    expect(joinConference).not.toHaveBeenCalled();
  });

  test.each<[string, (client: SentVoice) => Promise<unknown>]>([
    ['connect', (client) => client.connect({ to: 'ben' })],
    ['joinConference', (client) => client.joinConference({ name: 'daily-standup' })],
  ])('%s throws NotRegisteredError unless the client is registered', async (_, place) => {
    const client = createClient({ registerRetries: 0 });
    const call = jest.spyOn(adapter, 'call');
    const joinConference = jest.spyOn(adapter, 'joinConference');
    const notRegistered = { code: 'NOT_REGISTERED', message: 'The client is not registered.' };

    await expect(place(client)).rejects.toMatchObject(notRegistered);
    const registering = client.register();
    await expect(place(client)).rejects.toMatchObject(notRegistered);
    await registering;
    tokenProvider.mockRejectedValue(fetchFailure);
    await jest.advanceTimersByTimeAsync(refreshAt);
    expect(client.state).toBe('offline');
    await expect(place(client)).rejects.toMatchObject(notRegistered);
    await client.destroy();
    await expect(place(client)).rejects.toMatchObject({
      code: 'NOT_REGISTERED',
      message: 'The client was destroyed.',
    });

    expect(call).not.toHaveBeenCalled();
    expect(joinConference).not.toHaveBeenCalled();
  });

  test('calls holds placed and accepted calls, and activeCall follows the latest until it ends, announcing each change', async () => {
    const client = createClient();
    await client.register();
    const invites: SentVoice.CallInvite[] = [];
    client.on('incomingCall', (invite) => invites.push(invite));
    const activeCalls: Array<SentVoice.Call | null> = [];
    client.on('activeCallChanged', (call) => activeCalls.push(call));
    expect(client).toMatchObject({ calls: [], activeCall: null, isBusy: false });

    const placed = await client.connect({ to: 'ben' });
    adapter.receiveCall(`${prefix}=carol`);
    expect(client).toMatchObject({ calls: [placed], activeCall: placed, isBusy: true });

    const accepted = await invites[0]!.accept();
    expect(client).toMatchObject({ calls: [placed, accepted], activeCall: accepted, isBusy: true });

    await placed.disconnect();
    expect(client).toMatchObject({ calls: [accepted], activeCall: accepted, isBusy: true });

    await accepted.disconnect();
    expect(client).toMatchObject({ calls: [], activeCall: null, isBusy: false });
    expect(activeCalls).toEqual([placed, accepted, null]);
  });

  test('when the active call ends first, activeCall clears although an older call is still live', async () => {
    const client = createClient();
    await client.register();
    let invite!: SentVoice.CallInvite;
    client.on('incomingCall', (received) => (invite = received));
    const older = await client.connect({ to: 'ben' });
    adapter.receiveCall(`${prefix}=carol`);
    const newer = await invite.accept();

    await newer.disconnect();

    expect(client).toMatchObject({ calls: [older], activeCall: null, isBusy: false });
  });

  test('connect and joinConference throw CALL_IN_PROGRESS while a call is live or an invite is pending', async () => {
    const client = createClient();
    await client.register();
    const call = jest.spyOn(adapter, 'call');
    const joinConference = jest.spyOn(adapter, 'joinConference');
    const busy = { code: 'CALL_IN_PROGRESS', category: 'validation', retriable: false };
    let invite!: SentVoice.CallInvite;
    client.on('incomingCall', (received) => (invite = received));

    adapter.receiveCall(`${prefix}=carol`);
    await expect(client.connect({ to: 'ben' })).rejects.toMatchObject(busy);
    await invite.reject();
    const placed = await client.connect({ to: 'ben' });
    await expect(client.joinConference({ name: 'daily-standup' })).rejects.toMatchObject(busy);
    await placed.disconnect();
    await client.joinConference({ name: 'daily-standup' });

    expect(call).toHaveBeenCalledTimes(1);
    expect(joinConference).toHaveBeenCalledTimes(1);
  });

  test('unregister leaves live calls running and stops surfacing incoming calls', async () => {
    const client = createClient();
    await client.register();
    const call = await client.connect({ to: 'ben' });
    const incomingCall = jest.fn();
    client.on('incomingCall', incomingCall);
    const hangup = jest.spyOn(adapter, 'hangup');

    await client.unregister();
    adapter.receiveCall(`${prefix}=carol`);

    expect(hangup).not.toHaveBeenCalled();
    expect(incomingCall).not.toHaveBeenCalled();
    expect(client).toMatchObject({ calls: [call], activeCall: call, isBusy: true });
  });

  test('destroy hangs up live calls and rejects pending invites, then unregisters', async () => {
    const client = createClient();
    await client.register();
    const invites: SentVoice.CallInvite[] = [];
    client.on('incomingCall', (invite) => invites.push(invite));
    const placed = await client.connect({ to: 'ben' });
    adapter.receiveCall(`${prefix}=carol`);
    const accepted = await invites[0]!.accept();
    const pendingCallId = adapter.receiveCall('+38344555666');
    const hangup = jest.spyOn(adapter, 'hangup');
    const reject = jest.spyOn(adapter, 'reject');
    const unregister = jest.spyOn(adapter, 'unregister');

    await client.destroy();

    expect(hangup.mock.calls).toEqual([[placed.id], [accepted.id]]);
    expect(reject.mock.calls).toEqual([[pendingCallId]]);
    expect(Math.max(...hangup.mock.invocationCallOrder, ...reject.mock.invocationCallOrder)).toBeLessThan(
      unregister.mock.invocationCallOrder[0]!,
    );
    expect(invites[1]!.state).toBe('rejected');
    expect(client).toMatchObject({ calls: [], activeCall: null, isBusy: false });
  });

  test('destroy logs a call it fails to end and still unregisters', async () => {
    const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
    const client = createClient({ logger, logLevel: 'warn' });
    await client.register();
    await client.connect({ to: 'ben' });
    const failure = new NetworkError();
    adapter.failNext('hangup', failure);
    const unregister = jest.spyOn(adapter, 'unregister');

    await client.destroy();

    expect(logger.warn).toHaveBeenCalledWith(`Ending a call on destroy failed: ${failure}`);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  test('a call still dialing when the client is destroyed is hung up, and connect rejects', async () => {
    const client = createClient();
    await client.register();
    let dialed!: (callId: string) => void;
    jest.spyOn(adapter, 'call').mockImplementationOnce(() => new Promise((resolve) => (dialed = resolve)));
    const hangup = jest.spyOn(adapter, 'hangup');

    const connecting = client.connect({ to: 'ben' });
    await client.destroy();
    dialed('mock-call-7');

    await expect(connecting).rejects.toMatchObject({
      code: 'NOT_REGISTERED',
      message: 'The client was destroyed.',
    });
    expect(hangup).toHaveBeenCalledWith('mock-call-7');
    expect(client.calls).toEqual([]);
  });
});
