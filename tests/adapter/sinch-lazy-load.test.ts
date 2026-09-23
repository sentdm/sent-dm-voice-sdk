import SentVoice from '@sentdm/voice';
import { voiceToken } from '../voice-token';

const mockLoaded = jest.fn();

jest.mock('sinch-rtc', () => {
  mockLoaded();
  return jest.requireActual('./sinch-rtc');
});

test('sinch-rtc loads on the first register, not when the SDK is imported or a client is created', async () => {
  const client = new SentVoice({ tokenProvider: async () => voiceToken(), logLevel: 'off' });
  expect(mockLoaded).not.toHaveBeenCalled();

  await client.register();
  expect(mockLoaded).toHaveBeenCalledTimes(1);

  await client.destroy();
});
