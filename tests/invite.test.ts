import SentVoice from '@sentdm/voice';
import { loadAdapter } from '@sentdm/voice/adapter/loader';
import { CallFailedError, MediaPermissionError, NetworkError } from '@sentdm/voice/errors';
import { MockAdapter, type CallScript } from './adapter/mock-adapter';
import { prefix, voiceToken } from './voice-token';

jest.mock('@sentdm/voice/adapter/loader');

const hangsUp: CallScript = [{ type: 'ended', reason: 'completed', after: 1_000 }];
const dropped = new NetworkError();

describe('CallInvite', () => {
  let adapter: MockAdapter;
  let client: SentVoice;

  const receiveCall = (from: string, script?: CallScript) => {
    let invite: SentVoice.CallInvite | undefined;
    client.once('incomingCall', (received) => (invite = received));
    const callId = adapter.receiveCall(from, script);
    return { callId, invite: invite! };
  };

  beforeEach(async () => {
    jest.useFakeTimers();
    adapter = new MockAdapter();
    jest.mocked(loadAdapter).mockResolvedValue(adapter);
    client = new SentVoice({
      tokenProvider: async () => voiceToken(),
      logLevel: 'off',
      telemetry: { disabled: true },
    });
    await client.register();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test.each<[string, SentVoice.Address]>([
    [`${prefix}=ben`, { kind: 'user', identity: 'ben' }],
    ['+38344555666', { kind: 'number', number: '+38344555666' }],
  ])('a call from %s arrives as a pending invite addressed to this identity', (from, caller) => {
    const { invite } = receiveCall(from);

    expect(invite).toMatchObject({
      state: 'pending',
      from: caller,
      to: { kind: 'user', identity: 'agent-42' },
    });
    expect(client).toMatchObject({ calls: [], activeCall: null, isBusy: false });
  });

  test('accept answers once and resolves with the call, ringing until the provider reports it answered', async () => {
    const { callId, invite } = receiveCall(`${prefix}=ben`);
    const answer = jest.spyOn(adapter, 'answer').mockResolvedValueOnce(undefined);
    const reject = jest.spyOn(adapter, 'reject');

    const [call, sameCall] = await Promise.all([invite.accept(), invite.accept()]);
    await expect(invite.accept()).resolves.toBe(call);
    await invite.reject();

    expect(sameCall).toBe(call);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith(callId);
    expect(reject).not.toHaveBeenCalled();
    expect(invite.state).toBe('accepted');
    expect(call).toMatchObject({
      id: callId,
      direction: 'inbound',
      from: { kind: 'user', identity: 'ben' },
      to: { kind: 'user', identity: 'agent-42' },
      state: 'ringing',
    });
  });

  test('a refused microphone rejects accept with MediaPermissionError and leaves the invite pending', async () => {
    const { invite } = receiveCall(`${prefix}=ben`);
    const refused = new MediaPermissionError();
    adapter.failNext('answer', refused);

    await expect(invite.accept()).rejects.toBe(refused);
    expect(invite.state).toBe('pending');
    expect(client.calls).toEqual([]);

    await expect(invite.accept()).resolves.toMatchObject({ state: 'connected' });
    expect(invite.state).toBe('accepted');
  });

  test('reject declines a pending call without a cancelled event', async () => {
    const { callId, invite } = receiveCall(`${prefix}=ben`);
    const reject = jest.spyOn(adapter, 'reject');
    const cancelled = jest.fn();
    invite.on('cancelled', cancelled);

    await invite.reject();

    expect(reject).toHaveBeenCalledWith(callId);
    expect(invite.state).toBe('rejected');
    expect(cancelled).not.toHaveBeenCalled();
  });

  test('reject ends rejected even when the provider fails, and rejects with its error', async () => {
    const { invite } = receiveCall(`${prefix}=ben`);
    const failure = new NetworkError();
    adapter.failNext('reject', failure);

    await expect(invite.reject()).rejects.toBe(failure);

    expect(invite.state).toBe('rejected');
  });

  test.each<[string, CallScript, SentVoice.CancelInfo]>([
    ['hangs up', hangsUp, {}],
    ['fails', [{ type: 'ended', reason: 'failed', error: dropped, after: 1_000 }], { error: dropped }],
  ])('a call that %s before it is answered cancels the invite', (_, script, info) => {
    const { invite } = receiveCall(`${prefix}=ben`, script);
    const cancelled = jest.fn();
    invite.on('cancelled', cancelled);

    jest.advanceTimersByTime(1_000);

    expect(invite.state).toBe('cancelled');
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledWith(info);
  });

  test.each<[string, (invite: SentVoice.CallInvite) => unknown]>([
    ['rejected', (invite) => invite.reject()],
    ['cancelled', () => jest.advanceTimersByTime(1_000)],
  ])('a %s invite fails accept with CallFailedError and ignores reject', async (_, finish) => {
    const { invite } = receiveCall(`${prefix}=ben`, hangsUp);
    await finish(invite);
    const answer = jest.spyOn(adapter, 'answer');
    const reject = jest.spyOn(adapter, 'reject');

    await expect(invite.accept()).rejects.toBeInstanceOf(CallFailedError);
    await invite.reject();

    expect(answer).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  test.each<[string, SentVoice.CallInvite['state'], (invite: SentVoice.CallInvite) => unknown]>([
    ['the caller hangs up', 'cancelled', () => jest.advanceTimersByTime(1_000)],
    ['the invite is rejected', 'rejected', (invite) => invite.reject()],
  ])('when %s during an answer, accept fails with CallFailedError', async (_, state, finish) => {
    const { invite } = receiveCall(`${prefix}=ben`, hangsUp);
    let answer!: () => void;
    jest.spyOn(adapter, 'answer').mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));

    const accepted = invite.accept();
    await finish(invite);
    answer();

    await expect(accepted).rejects.toBeInstanceOf(CallFailedError);
    expect(invite.state).toBe(state);
    expect(client.calls).toEqual([]);
  });
});
