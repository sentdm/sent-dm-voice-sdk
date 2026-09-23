import { loadSinchAdapter } from './sinch';
import type { AdapterFactory } from './types';

export const loadAdapter: AdapterFactory = loadSinchAdapter;
