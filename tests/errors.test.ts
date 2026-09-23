import * as root from '@sentdm/voice';
import { SentVoice } from '@sentdm/voice/client';
import {
  CallFailedError,
  CallRejectedError,
  CapabilityUnsupportedError,
  MediaPermissionError,
  NetworkError,
  NotRegisteredError,
  SentVoiceError,
  TokenExpiredError,
  TokenInvalidError,
  type SentVoiceErrorCategory,
  type SentVoiceErrorCode,
} from '@sentdm/voice/errors';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const taxonomy: Array<{
  ErrorClass: new (details?: { message?: string; providerDetail?: unknown }) => SentVoiceError;
  code: SentVoiceErrorCode;
  category: SentVoiceErrorCategory;
  retriable: boolean;
}> = [
  { ErrorClass: TokenExpiredError, code: 'TOKEN_EXPIRED', category: 'auth', retriable: true },
  { ErrorClass: TokenInvalidError, code: 'TOKEN_INVALID', category: 'auth', retriable: false },
  { ErrorClass: NotRegisteredError, code: 'NOT_REGISTERED', category: 'validation', retriable: false },
  { ErrorClass: MediaPermissionError, code: 'MEDIA_PERMISSION_DENIED', category: 'media', retriable: false },
  { ErrorClass: CallRejectedError, code: 'CALL_REJECTED', category: 'signaling', retriable: false },
  { ErrorClass: CallFailedError, code: 'CALL_FAILED', category: 'signaling', retriable: false },
  { ErrorClass: NetworkError, code: 'NETWORK', category: 'network', retriable: true },
  {
    ErrorClass: CapabilityUnsupportedError,
    code: 'CAPABILITY_UNSUPPORTED',
    category: 'capability',
    retriable: false,
  },
];

describe('error taxonomy', () => {
  test.each(taxonomy)(
    '$ErrorClass.name carries code $code, category $category, retriable $retriable',
    ({ ErrorClass, code, category, retriable }) => {
      const error = new ErrorClass();

      expect(error).toBeInstanceOf(ErrorClass);
      expect(error).toBeInstanceOf(SentVoiceError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.category).toBe(category);
      expect(error.retriable).toBe(retriable);
      expect(error.message).not.toBe('');
      expect(error.providerDetail).toBeUndefined();
    },
  );

  test.each(taxonomy)('$ErrorClass.name keeps a custom message and the provider detail', ({ ErrorClass }) => {
    const providerDetail = { reason: 'raw provider error' };
    const error = new ErrorClass({ message: 'custom message', providerDetail });

    expect(error.message).toBe('custom message');
    expect(error.providerDetail).toBe(providerDetail);
  });

  test('unmapped errors use the base class with the UNKNOWN code', () => {
    const providerDetail = new Error('raw provider error');
    const error = new SentVoiceError({
      code: 'UNKNOWN',
      category: 'signaling',
      retriable: false,
      providerDetail,
    });

    expect(error).toBeInstanceOf(SentVoiceError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('UNKNOWN');
    expect(error.category).toBe('signaling');
    expect(error.retriable).toBe(false);
    expect(error.providerDetail).toBe(providerDetail);
  });

  test('providerDetail is typed unknown', () => {
    const providerDetailIsUnknown: Equals<SentVoiceError['providerDetail'], unknown> = true;

    expect(providerDetailIsUnknown).toBe(true);
  });

  test('the root entry exports the client and re-exports the same error classes', () => {
    expect(root).toEqual({
      default: SentVoice,
      SentVoice,
      SentVoiceError,
      TokenExpiredError,
      TokenInvalidError,
      NotRegisteredError,
      MediaPermissionError,
      CallRejectedError,
      CallFailedError,
      NetworkError,
      CapabilityUnsupportedError,
    });
  });
});
