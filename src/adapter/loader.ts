import { CapabilityUnsupportedError } from '../errors';
import type { AdapterFactory } from './types';

export const loadAdapter: AdapterFactory = async () => {
  throw new CapabilityUnsupportedError({ message: 'No calling provider is available.' });
};
