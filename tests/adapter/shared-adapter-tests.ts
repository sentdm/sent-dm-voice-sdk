import type { CallEvent, CallTarget, IncomingCall, ProviderAdapter } from '@sentdm/voice/adapter/types';
import { voiceToken } from '../voice-token';

const prefix = '0f8fad5b-d9cb-469f-a165-70867728950e';
const caller = `${prefix}=agent-42`;
const phone: CallTarget = { kind: 'number', number: '+38349111222' };

export function describeSharedAdapterTests<Adapter extends ProviderAdapter>(
  name: string,
  createAdapter: () => Promise<Adapter>,
  receiveCall: (adapter: Adapter, from: string) => void,
): void {
  describe(`${name} shared tests`, () => {
    let adapter: Adapter;

    beforeEach(async () => {
      adapter = await createAdapter();
      await adapter.register(voiceToken());
    });

    test('register refreshes the token while registered and registers again after unregister', async () => {
      await expect(adapter.register(voiceToken())).resolves.toBeUndefined();
      await expect(adapter.unregister()).resolves.toBeUndefined();
      await expect(adapter.register(voiceToken())).resolves.toBeUndefined();
    });

    test('calls to a user, a number and a room get distinct call ids', async () => {
      const callIds = [
        await adapter.call({ kind: 'user', id: `${prefix}=ben` }),
        await adapter.call(phone),
        await adapter.joinConference(`${prefix}=daily-standup`),
      ];

      expect(new Set(callIds).size).toBe(3);
    });

    test('hangup ends the call with a completed ended event', async () => {
      const callId = await adapter.call(phone);
      const ended = new Promise<CallEvent>((resolve) =>
        adapter.onCallEvent((event) => {
          if (event.callId === callId && event.type === 'ended') resolve(event);
        }),
      );

      await adapter.hangup(callId);

      expect(await ended).toEqual({ callId, type: 'ended', reason: 'completed' });
    });

    test('an incoming call reaches onIncoming with its wire caller, and answer connects it', async () => {
      const incoming = new Promise<IncomingCall>((resolve) => adapter.onIncoming(resolve));
      receiveCall(adapter, caller);
      const { callId, from } = await incoming;
      const events: CallEvent[] = [];
      const connected = new Promise<void>((resolve) =>
        adapter.onCallEvent((event) => {
          if (event.callId !== callId) return;
          events.push(event);
          if (event.type === 'connected') resolve();
        }),
      );

      await adapter.answer(callId);
      await connected;

      expect(from).toBe(caller);
      expect(events).toEqual([
        { callId, type: 'answered' },
        { callId, type: 'connected' },
      ]);
    });

    test('reject ends an incoming call', async () => {
      const incoming = new Promise<IncomingCall>((resolve) => adapter.onIncoming(resolve));
      receiveCall(adapter, caller);
      const { callId } = await incoming;
      const ended = new Promise<CallEvent>((resolve) =>
        adapter.onCallEvent((event) => {
          if (event.callId === callId && event.type === 'ended') resolve(event);
        }),
      );

      await adapter.reject(callId);

      expect(await ended).toMatchObject({ callId, type: 'ended' });
    });

    test('mute, sendDigits and getStats work on a live call', async () => {
      const callId = await adapter.call(phone);

      expect(() => adapter.mute(callId, true)).not.toThrow();
      expect(() => adapter.mute(callId, false)).not.toThrow();
      expect(() => adapter.sendDigits(callId, '123#')).not.toThrow();
      await expect(adapter.getStats(callId)).resolves.toEqual({
        jitter: expect.any(Number),
        packetLoss: expect.any(Number),
        rtt: expect.any(Number),
      });
    });

    test('input and output devices can be set', async () => {
      await expect(adapter.setInputDevice('microphone-id')).resolves.toBeUndefined();
      await expect(adapter.setOutputDevice('speaker-id')).resolves.toBeUndefined();
    });
  });
}
