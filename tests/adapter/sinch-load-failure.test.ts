import { loadSinchAdapter } from '@sentdm/voice/adapter/sinch';
import { NetworkError } from '@sentdm/voice/errors';
import { providerDetailOf } from '@sentdm/voice/provider-detail';

const mockFailure = new TypeError('Failed to fetch dynamically imported module');

jest.mock('sinch-rtc', () => {
  throw mockFailure;
});

test('a provider that cannot be loaded rejects with NetworkError, keeping the raw error', async () => {
  const loading = loadSinchAdapter({});

  await expect(loading).rejects.toBeInstanceOf(NetworkError);
  const error = await loading.catch((error: unknown) => error as NetworkError);
  expect(providerDetailOf(error as NetworkError)).toBe(mockFailure);
});
