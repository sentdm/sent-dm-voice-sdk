type LogFn = (message: string, ...rest: unknown[]) => void;
export type Logger = {
  error: LogFn;
  warn: LogFn;
  info: LogFn;
  debug: LogFn;
};
export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

export type Log = Record<keyof Logger, (message: string) => void>;

const levelNumbers = {
  off: 0,
  error: 200,
  warn: 300,
  info: 400,
  debug: 500,
};

const jwtPattern = /eyJ[\w-]*\.[\w-]*\.[\w-]*/g;

const isLogLevel = (level: string): level is LogLevel =>
  Object.prototype.hasOwnProperty.call(levelNumbers, level);

export const parseLogLevel = (
  maybeLevel: string | undefined,
  sourceName: string,
  log: Log,
): LogLevel | undefined => {
  if (!maybeLevel) {
    return undefined;
  }
  if (isLogLevel(maybeLevel)) {
    return maybeLevel;
  }
  log.warn(
    `${sourceName} was set to ${JSON.stringify(maybeLevel)}, expected one of ${JSON.stringify(
      Object.keys(levelNumbers),
    )}`,
  );
  return undefined;
};

function noop() {}

function makeLogFn(fnLevel: keyof Logger, logger: Logger, logLevel: LogLevel) {
  if (levelNumbers[fnLevel] > levelNumbers[logLevel]) {
    return noop;
  }
  return (message: string) => logger[fnLevel](message.replace(jwtPattern, '***'));
}

export function createLog(logger: Logger, logLevel: LogLevel): Log {
  return {
    error: makeLogFn('error', logger, logLevel),
    warn: makeLogFn('warn', logger, logLevel),
    info: makeLogFn('info', logger, logLevel),
    debug: makeLogFn('debug', logger, logLevel),
  };
}
