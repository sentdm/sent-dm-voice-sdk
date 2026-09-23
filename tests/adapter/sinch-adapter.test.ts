import { loadSinchAdapter } from '@sentdm/voice/adapter/sinch';
import type { AdapterOptions, CallEvent, CallTarget, ProviderAdapter } from '@sentdm/voice/adapter/types';
import { CapabilityUnsupportedError, MediaPermissionError, SentVoiceError } from '@sentdm/voice/errors';
import { prefix, voiceToken } from '../voice-token';
import { describeSharedAdapterTests } from './shared-adapter-tests';
import {
  CallEndCause,
  ErrorType,
  FakeAudio,
  SinchError,
  calls,
  clients,
  failures,
  type FakeClient,
} from './sinch-rtc';

jest.mock('sinch-rtc', () => jest.requireActual('./sinch-rtc'));

Object.assign(globalThis, { Audio: FakeAudio });

const phone: CallTarget = { kind: 'number', number: '+38349111222' };
const unmapped = { code: 'UNKNOWN', category: 'signaling', retriable: false };
const networkFailure = new SinchError('ICE failed to connect', 3002, ErrorType.Network);
const httpFailure = new SinchError('Unable to connect call', 500, ErrorType.Http);

const lastClient = () => clients[clients.length - 1]!;
const lastAudio = () => FakeAudio.created[FakeAudio.created.length - 1]!;

describeSharedAdapterTests(
  'SinchAdapter',
  () => loadSinchAdapter({}),
  (_, from) => lastClient().callClient.receiveCall(from),
);

describe('SinchAdapter', () => {
  let adapter: ProviderAdapter;
  let events: CallEvent[];

  const load = async (options: AdapterOptions = {}) => {
    adapter = await loadSinchAdapter(options);
    adapter.onCallEvent((event) => events.push(event));
  };

  beforeEach(async () => {
    events = [];
    await load();
  });

  test.each<[string, AdapterOptions['serviceWorker'], FakeClient['push']]>([
    ['the default service worker', undefined, [undefined, undefined]],
    [
      'a service worker served elsewhere',
      { url: '/voice/sw.js', scope: '/voice/' },
      ['/voice/sw.js', { scope: '/voice/' }],
    ],
  ])(
    'register starts a client for the token user with %s enabling incoming calls',
    async (_, serviceWorker, push) => {
      await load({ serviceWorker });
      const jwt = voiceToken();

      await adapter.register(jwt);

      expect(lastClient()).toMatchObject({
        settings: {
          applicationKey: '0bb6f5e2-5ad1-4c3b-8b1b-5a0c1d2e3f40',
          userId: `${prefix}=agent-42`,
          environmentHost: 'ocra-euc1.api.sinch.com',
        },
        push,
        log: ['setSupportManagedPush', 'start'],
        credentials: [jwt],
      });
    },
  );

  test('register while registered keeps the client and answers its next credential request with the new token', async () => {
    const jwt = voiceToken();
    await adapter.register(jwt);
    const client = lastClient();
    const refreshed = voiceToken({ 'sent:number': '+38349333444' });

    await adapter.register(refreshed);
    client.requestCredentials();

    expect(lastClient()).toBe(client);
    expect(client.log).toEqual(['setSupportManagedPush', 'start']);
    expect(client.credentials).toEqual([jwt, refreshed]);
  });

  test.each<[string, () => Error, string[]]>([
    [
      'the client fails to start',
      () => {
        const failure = new SinchError('Unable to create instance!');
        failures.start.push(failure);
        return failure;
      },
      ['setSupportManagedPush', 'start', 'disableManagedPushSupport', 'terminate'],
    ],
    [
      'incoming calls cannot be enabled',
      () => {
        const failure = new Error('Unable to register ServiceWorker: sw.js');
        failures.push.push(failure);
        return failure;
      },
      ['setSupportManagedPush', 'disableManagedPushSupport', 'terminate'],
    ],
  ])('when %s, register rejects with the raw error kept and tears the client down', async (_, fail, log) => {
    const failure = fail();

    await expect(adapter.register(voiceToken())).rejects.toMatchObject({
      ...unmapped,
      providerDetail: failure,
    });
    expect(lastClient().log).toEqual(log);

    await adapter.register(voiceToken());
    expect(lastClient().isStarted()).toBe(true);
  });

  test('unregister stops incoming-call pushes and terminates the client, while a live call keeps reporting', async () => {
    await adapter.register(voiceToken());
    const callId = await adapter.call(phone);

    await adapter.unregister();
    calls.get(callId)!.end(CallEndCause.HungUp);

    expect(lastClient().log).toEqual([
      'setSupportManagedPush',
      'start',
      'disableManagedPushSupport',
      'terminate',
    ]);
    expect(events).toEqual([{ callId, type: 'ended', reason: 'completed' }]);
  });

  test.each<[string, (adapter: ProviderAdapter) => Promise<string>, { method: string; destination: string }]>(
    [
      [
        'a user',
        (adapter) => adapter.call({ kind: 'user', id: `${prefix}=ben` }),
        { method: 'callUser', destination: `${prefix}=ben` },
      ],
      [
        'a phone number',
        (adapter) => adapter.call(phone),
        { method: 'callPhoneNumber', destination: phone.number },
      ],
      [
        'a conference room',
        (adapter) => adapter.joinConference(`${prefix}=daily-standup`),
        { method: 'callConference', destination: `${prefix}=daily-standup` },
      ],
    ],
  )('a call to %s is placed with the matching provider call', async (_, place, placed) => {
    await adapter.register(voiceToken());

    const callId = await place(adapter);

    expect(lastClient().callClient.placed).toEqual([placed]);
    expect(calls.get(callId)?.remoteUserId).toBe(placed.destination);
  });

  test('provider progress, answer and establishment arrive as ringing, answered and connected', async () => {
    await adapter.register(voiceToken());
    const callId = await adapter.call(phone);
    const call = calls.get(callId)!;

    call.progress();
    call.answerRemotely();
    call.establish();
    call.end(CallEndCause.HungUp);

    expect(events).toEqual([
      { callId, type: 'ringing' },
      { callId, type: 'answered' },
      { callId, type: 'connected' },
      { callId, type: 'ended', reason: 'completed' },
    ]);
  });

  test.each<[string, CallEndCause, SinchError | undefined, object]>([
    ['HungUp', CallEndCause.HungUp, undefined, { reason: 'completed' }],
    ['Canceled', CallEndCause.Canceled, undefined, { reason: 'completed' }],
    ['OtherDeviceAnswered', CallEndCause.OtherDeviceAnswered, undefined, { reason: 'completed' }],
    ['Denied', CallEndCause.Denied, undefined, { reason: 'busy' }],
    ['NoAnswer', CallEndCause.NoAnswer, undefined, { reason: 'noAnswer' }],
    ['Timeout', CallEndCause.Timeout, undefined, { reason: 'noAnswer' }],
    ['Failure without an error', CallEndCause.Failure, undefined, { reason: 'failed' }],
    [
      'Failure on the network',
      CallEndCause.Failure,
      networkFailure,
      {
        reason: 'failed',
        error: expect.objectContaining({ code: 'NETWORK', providerDetail: networkFailure }),
      },
    ],
    [
      'Failure without a mapping',
      CallEndCause.Failure,
      httpFailure,
      { reason: 'failed', error: expect.objectContaining({ ...unmapped, providerDetail: httpFailure }) },
    ],
    [
      'Inactive',
      CallEndCause.Inactive,
      undefined,
      { reason: 'failed', error: expect.objectContaining({ code: 'NETWORK' }) },
    ],
  ])('a call the provider ends with %s ends as mapped', async (_, endCause, error, ended) => {
    await adapter.register(voiceToken());
    const callId = await adapter.call(phone);

    calls.get(callId)!.end(endCause, error);

    expect(events).toEqual([{ callId, type: 'ended', ...ended }]);
  });

  test('an answer that cannot get the microphone rejects with MediaPermissionError', async () => {
    await adapter.register(voiceToken());
    const call = lastClient().callClient.receiveCall(`${prefix}=ben`);
    const refused = new Error(
      'Could not get media tracks. Make sure you have granted required media permissions.',
    );
    call.answerFailure = refused;

    const answering = adapter.answer(call.id);

    await expect(answering).rejects.toBeInstanceOf(MediaPermissionError);
    await expect(answering).rejects.toMatchObject({ providerDetail: refused });
  });

  test('a call that has ended is not touched again, since the provider throws on a second hangup', async () => {
    await adapter.register(voiceToken());
    const call = lastClient().callClient.receiveCall(`${prefix}=ben`);
    call.end(CallEndCause.Canceled);

    await expect(adapter.hangup(call.id)).resolves.toBeUndefined();
    await expect(adapter.answer(call.id)).resolves.toBeUndefined();
    expect(events).toEqual([{ callId: call.id, type: 'ended', reason: 'completed' }]);
  });

  test('mute and sendDigits reach the provider call, and an error it throws keeps the raw error', async () => {
    await adapter.register(voiceToken());
    const callId = await adapter.call(phone);
    const call = calls.get(callId)!;
    const mute = jest.spyOn(call, 'mute');
    const unmute = jest.spyOn(call, 'unmute');
    const sendDtmf = jest.spyOn(call, 'sendDtmf');

    adapter.mute(callId, true);
    adapter.mute(callId, false);
    adapter.sendDigits(callId, '1#');
    let thrown: unknown;
    try {
      adapter.sendDigits(callId, '12x');
    } catch (error) {
      thrown = error;
    }

    expect(mute).toHaveBeenCalledTimes(1);
    expect(unmute).toHaveBeenCalledTimes(1);
    expect(sendDtmf).toHaveBeenCalledWith('1#');
    expect(thrown).toBeInstanceOf(SentVoiceError);
    expect(thrown).toMatchObject({ ...unmapped, providerDetail: expect.any(Error) });
  });

  test('getStats reads audio jitter, packet loss and round-trip time from the peer connection', async () => {
    await adapter.register(voiceToken());
    const callId = await adapter.call(phone);
    await expect(adapter.getStats(callId)).resolves.toEqual({ jitter: 0, packetLoss: 0, rtt: 0 });

    calls.get(callId)!.stats = new Map<string, object>([
      ['audio', { type: 'inbound-rtp', kind: 'audio', jitter: 0.012, packetsLost: 5, packetsReceived: 495 }],
      ['video', { type: 'inbound-rtp', kind: 'video', jitter: 0.5, packetsLost: 50, packetsReceived: 50 }],
      ['failed pair', { type: 'candidate-pair', state: 'failed', currentRoundTripTime: 2 }],
      ['pair', { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.18 }],
    ]) as unknown as RTCStatsReport;

    await expect(adapter.getStats(callId)).resolves.toEqual({ jitter: 12, packetLoss: 0.01, rtt: 180 });
  });

  test('a placed call plays through an element the SDK creates, until the call ends', async () => {
    await adapter.register(voiceToken());
    const callId = await adapter.call(phone);
    const call = calls.get(callId)!;
    const audio = lastAudio();

    expect(audio).toMatchObject({ autoplay: true, srcObject: call.incomingStream });
    call.end(CallEndCause.HungUp);
    expect(audio.srcObject).toBeNull();
  });

  test('an incoming call plays through the element the app gives once it is answered', async () => {
    const element = new FakeAudio();
    await load({ audioElement: element as unknown as HTMLAudioElement });
    await adapter.register(voiceToken());
    const call = lastClient().callClient.receiveCall(`${prefix}=ben`);
    expect(element.srcObject).toBeNull();

    await adapter.answer(call.id);

    expect(element).toMatchObject({ autoplay: true, srcObject: call.incomingStream });
  });

  test('setOutputDevice routes playback to the device, and is unsupported where the browser cannot', async () => {
    const element = new FakeAudio();
    await load({ audioElement: element as unknown as HTMLAudioElement });
    await adapter.setOutputDevice('speaker-id');
    expect(element.sinkId).toBe('speaker-id');

    await load({ audioElement: { autoplay: false, srcObject: null } as unknown as HTMLAudioElement });
    await expect(adapter.setOutputDevice('speaker-id')).rejects.toBeInstanceOf(CapabilityUnsupportedError);
  });

  test('an input device chosen before register applies once the client starts, and at once afterwards', async () => {
    await adapter.setInputDevice('microphone-id');
    await adapter.register(voiceToken());
    expect(lastClient().callClient.constraints).toEqual({ deviceId: { exact: 'microphone-id' } });

    await adapter.setInputDevice('headset-id');
    expect(lastClient().callClient.constraints).toEqual({ deviceId: { exact: 'headset-id' } });
  });
});
