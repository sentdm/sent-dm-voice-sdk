import { attachProviderDetail } from './provider-detail';

export type SentVoiceErrorCode =
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'NOT_REGISTERED'
  | 'MEDIA_PERMISSION_DENIED'
  | 'CALL_REJECTED'
  | 'CALL_FAILED'
  | 'NETWORK'
  | 'CAPABILITY_UNSUPPORTED'
  | 'INVALID_ADDRESS'
  | 'CALL_IN_PROGRESS'
  | 'UNKNOWN';

export type SentVoiceErrorCategory = 'auth' | 'media' | 'signaling' | 'network' | 'validation' | 'capability';

type ErrorDetails = {
  message?: string;
  /** The underlying provider error. It is reported to Sent and cannot be read from the error. */
  providerDetail?: unknown;
};

export class SentVoiceError extends Error {
  readonly code: SentVoiceErrorCode;
  readonly category: SentVoiceErrorCategory;
  readonly retriable: boolean;

  constructor({
    code,
    category,
    retriable,
    message,
    providerDetail,
  }: ErrorDetails & { code: SentVoiceErrorCode; category: SentVoiceErrorCategory; retriable: boolean }) {
    super(message);
    this.code = code;
    this.category = category;
    this.retriable = retriable;
    attachProviderDetail(this, providerDetail);
  }
}

export class TokenExpiredError extends SentVoiceError {
  constructor({ message, providerDetail }: ErrorDetails = {}) {
    super({
      code: 'TOKEN_EXPIRED',
      category: 'auth',
      retriable: true,
      message: message ?? 'The voice token expired and could not be refreshed.',
      providerDetail,
    });
  }
}

export class TokenInvalidError extends SentVoiceError {
  constructor({ message, providerDetail }: ErrorDetails = {}) {
    super({
      code: 'TOKEN_INVALID',
      category: 'auth',
      retriable: false,
      message: message ?? 'The token provider returned an invalid voice token.',
      providerDetail,
    });
  }
}

export class NotRegisteredError extends SentVoiceError {
  constructor({ message, providerDetail }: ErrorDetails = {}) {
    super({
      code: 'NOT_REGISTERED',
      category: 'validation',
      retriable: false,
      message: message ?? 'The client is not registered.',
      providerDetail,
    });
  }
}

export class MediaPermissionError extends SentVoiceError {
  constructor({ message, providerDetail }: ErrorDetails = {}) {
    super({
      code: 'MEDIA_PERMISSION_DENIED',
      category: 'media',
      retriable: false,
      message: message ?? 'Microphone permission was denied.',
      providerDetail,
    });
  }
}

export class CallRejectedError extends SentVoiceError {
  constructor({ message, providerDetail }: ErrorDetails = {}) {
    super({
      code: 'CALL_REJECTED',
      category: 'signaling',
      retriable: false,
      message: message ?? 'The call was rejected.',
      providerDetail,
    });
  }
}

export class CallFailedError extends SentVoiceError {
  constructor({ message, providerDetail }: ErrorDetails = {}) {
    super({
      code: 'CALL_FAILED',
      category: 'signaling',
      retriable: false,
      message: message ?? 'The call failed.',
      providerDetail,
    });
  }
}

export class NetworkError extends SentVoiceError {
  constructor({ message, providerDetail }: ErrorDetails = {}) {
    super({
      code: 'NETWORK',
      category: 'network',
      retriable: true,
      message: message ?? 'The network connection failed.',
      providerDetail,
    });
  }
}

export class CapabilityUnsupportedError extends SentVoiceError {
  constructor({ message, providerDetail }: ErrorDetails = {}) {
    super({
      code: 'CAPABILITY_UNSUPPORTED',
      category: 'capability',
      retriable: false,
      message: message ?? 'This capability is not supported.',
      providerDetail,
    });
  }
}
