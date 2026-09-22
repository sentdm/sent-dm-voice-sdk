import type { CallEvent, CallTarget, IncomingCall } from '@sentdm/voice/adapter/types';
import { CallFailedError, NetworkError } from '@sentdm/voice/errors';
import { MockAdapter, type CallScript, type FailableMethod } from './mock-adapter';
import { describeSharedAdapterTests } from './shared-adapter-tests';

const prefix = '0f8fad5b-d9cb-469f-a165-70867728950e';
const caller = `${prefix}=agent-42`;
const room = `${prefix}=daily-standup`;
const phone: CallTarget = { kind: 'number', number: '+38349111222' };

describeSharedAdapterTests('MockAdapter', async () => new MockAdapter());

describe('MockAdapter', () => {
  let adapter: MockAdapter;
  let events: CallEvent[];

  beforeEach(() => {
    jest.useFakeTimers();
    adapter = new MockAdapter();
    events = [];
    adapter.onCallEvent((event) => events.push(event));
  });

  afterEach(() => jest.useRealTimers());

  test.each<{ method: FailableMethod; invoke: (callId: string) => Promise<unknown> }>([
    { method: 'register', invoke: () => adapter.register('token') },
    { method: 'unregister', invoke: () => adapter.unregister() },
    { method: 'call', invoke: () => adapter.call(phone) },
    { method: 'joinConference', invoke: () => adapter.joinConference(room) },
    { method: 'answer', invoke: (callId) => adapter.answer(callId) },
    { method: 'reject', invoke: (callId) => adapter.reject(callId) },
    { method: 'hangup', invoke: (callId) => adapter.hangup(callId) },
    { method: 'getStats', invoke: (callId) => adapter.getStats(callId) },
    { method: 'setInputDevice', invoke: () => adapter.setInputDevice('microphone-id') },
    { method: 'setOutputDevice', invoke: () => adapter.setOutputDevice('speaker-id') },
  ])('failNext rejects only the next $method with the injected error', async ({ method, invoke }) => {
    const callId = adapter.receiveCall(caller);
    const error = new CallFailedError();
    adapter.failNext(method, error);

    await expect(invoke(callId)).rejects.toBe(error);
    await invoke(callId);
  });

  test.each<{ method: FailableMethod; invoke: (callId: string) => void }>([
    { method: 'mute', invoke: (callId) => adapter.mute(callId, true) },
    { method: 'sendDigits', invoke: (callId) => adapter.sendDigits(callId, '1') },
  ])('failNext throws only on the next $method with the injected error', ({ method, invoke }) => {
    const callId = adapter.receiveCall(caller);
    const error = new CallFailedError();
    adapter.failNext(method, error);

    expect(() => invoke(callId)).toThrow(error);
    expect(() => invoke(callId)).not.toThrow();
  });

  test('receiveCall delivers the call to onIncoming, and answer connects it', async () => {
    const incoming: IncomingCall[] = [];
    adapter.onIncoming((call) => incoming.push(call));

    const callId = adapter.receiveCall(caller);
    await adapter.answer(callId);

    expect(incoming).toEqual([{ callId, from: caller }]);
    expect(events).toEqual([
      { callId, type: 'answered' },
      { callId, type: 'connected' },
    ]);
  });

  test('reject ends an incoming call', async () => {
    const callId = adapter.receiveCall(caller);

    await adapter.reject(callId);

    expect(events).toEqual([{ callId, type: 'ended', reason: 'completed' }]);
  });

  test('receiveCall plays the caller script, such as hanging up before the call is answered', () => {
    const callId = adapter.receiveCall(caller, [{ type: 'ended', reason: 'completed', after: 30_000 }]);

    jest.advanceTimersByTime(30_000);

    expect(events).toEqual([{ callId, type: 'ended', reason: 'completed' }]);
  });

  test('scriptNextCall plays a full call lifecycle, each step after its delay', async () => {
    adapter.scriptNextCall([
      { type: 'ringing', after: 500 },
      { type: 'answered', after: 3_000 },
      { type: 'connected', after: 200 },
      { type: 'ended', reason: 'completed', after: 60_000 },
    ]);
    const callId = await adapter.call(phone);

    jest.advanceTimersByTime(499);
    expect(events).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(events.map(({ type }) => type)).toEqual(['ringing']);
    jest.advanceTimersByTime(3_200);
    expect(events.map(({ type }) => type)).toEqual(['ringing', 'answered', 'connected']);
    jest.advanceTimersByTime(60_000);
    expect(events).toEqual([
      { callId, type: 'ringing' },
      { callId, type: 'answered' },
      { callId, type: 'connected' },
      { callId, type: 'ended', reason: 'completed' },
    ]);
  });

  test.each<{ scenario: string; script: CallScript }>([
    {
      scenario: 'a mid-call drop',
      script: [
        { type: 'ringing' },
        { type: 'answered' },
        { type: 'connected' },
        { type: 'ended', reason: 'failed', error: new NetworkError() },
      ],
    },
    { scenario: 'busy', script: [{ type: 'ringing' }, { type: 'ended', reason: 'busy' }] },
    { scenario: 'no answer', script: [{ type: 'ringing' }, { type: 'ended', reason: 'noAnswer' }] },
  ])('scriptNextCall plays $scenario, after which the call emits nothing more', async ({ script }) => {
    adapter.scriptNextCall(script);
    const callId = await adapter.call(phone);

    jest.runAllTimers();
    await adapter.hangup(callId);

    expect(events).toEqual(script.map((step) => ({ ...step, callId })));
  });

  test('hangup from an event listener cancels the script steps that have not played yet', async () => {
    adapter.scriptNextCall([{ type: 'ringing' }, { type: 'answered', after: 5_000 }]);
    const callId = await adapter.call(phone);
    adapter.onCallEvent((event) => {
      if (event.type === 'ringing') adapter.hangup(callId);
    });

    jest.advanceTimersByTime(0);

    expect(jest.getTimerCount()).toBe(0);
    expect(events).toEqual([
      { callId, type: 'ringing' },
      { callId, type: 'ended', reason: 'completed' },
    ]);
  });

  test('each call or conference join plays the next queued script', async () => {
    adapter.scriptNextCall([{ type: 'ringing' }]);
    adapter.scriptNextCall([{ type: 'connected' }]);
    const callId = await adapter.call(phone);
    const roomCallId = await adapter.joinConference(room);

    jest.runAllTimers();

    expect(events).toEqual([
      { callId, type: 'ringing' },
      { callId: roomCallId, type: 'connected' },
    ]);
  });
});
