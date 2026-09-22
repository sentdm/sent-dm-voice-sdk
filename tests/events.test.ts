import { TypedEmitter } from '@sentdm/voice/events';

interface TestEvents {
  ready: () => void;
  muteChanged: (isMuted: boolean) => void;
  progress: (step: number, label: string) => void;
}

class TestEmitter extends TypedEmitter<TestEvents> {
  override emit<E extends keyof TestEvents>(event: E, ...args: Parameters<TestEvents[E]>): void {
    super.emit(event, ...args);
  }
}

describe('TypedEmitter', () => {
  test('on calls every listener with the payload, in registration order', () => {
    const emitter = new TestEmitter();
    const calls: string[] = [];
    emitter.on('progress', (step, label) => calls.push(`first ${step} ${label}`));
    emitter.on('progress', (step, label) => calls.push(`second ${step} ${label}`));

    emitter.emit('progress', 1, 'one');
    emitter.emit('progress', 2, 'two');

    expect(calls).toEqual(['first 1 one', 'second 1 one', 'first 2 two', 'second 2 two']);
  });

  test('once calls the listener for the next emit only', () => {
    const emitter = new TestEmitter();
    const listener = jest.fn();
    emitter.once('muteChanged', listener);

    emitter.emit('muteChanged', true);
    emitter.emit('muteChanged', false);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(true);
  });

  test('off removes on and once listeners', () => {
    const emitter = new TestEmitter();
    const onListener = jest.fn();
    const onceListener = jest.fn();
    emitter.on('ready', onListener);
    emitter.once('ready', onceListener);

    emitter.off('ready', onListener);
    emitter.off('ready', onceListener);
    emitter.emit('ready');

    expect(onListener).not.toHaveBeenCalled();
    expect(onceListener).not.toHaveBeenCalled();
  });

  test('a listener is registered only once per event', () => {
    const emitter = new TestEmitter();
    const listener = jest.fn();
    emitter.on('ready', listener);
    emitter.on('ready', listener);
    emitter.once('ready', listener);

    emitter.emit('ready');
    emitter.emit('ready');
    expect(listener).toHaveBeenCalledTimes(2);

    emitter.off('ready', listener);
    emitter.emit('ready');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test('off and emit without listeners do nothing', () => {
    const emitter = new TestEmitter();

    expect(() => emitter.off('ready', () => {})).not.toThrow();
    expect(() => emitter.emit('ready')).not.toThrow();
  });

  test('listeners only affect emits that start after they change', () => {
    const emitter = new TestEmitter();
    const added = jest.fn();
    const removed = jest.fn();
    emitter.on('ready', () => {
      emitter.on('ready', added);
      emitter.off('ready', removed);
    });
    emitter.on('ready', removed);

    emitter.emit('ready');
    expect(added).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();

    emitter.emit('ready');
    expect(added).toHaveBeenCalledTimes(1);
  });

  test('on, once and off return the emitter', () => {
    const emitter = new TestEmitter();
    const listener = () => {};

    expect(emitter.on('ready', listener)).toBe(emitter);
    expect(emitter.once('ready', listener)).toBe(emitter);
    expect(emitter.off('ready', listener)).toBe(emitter);
  });

  describe('when a listener throws', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('the remaining listeners run and the error is rethrown asynchronously', () => {
      const emitter = new TestEmitter();
      const failure = new Error('listener failed');
      const next = jest.fn();
      emitter.on('ready', () => {
        throw failure;
      });
      emitter.on('ready', next);

      expect(() => emitter.emit('ready')).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);
      expect(() => jest.runAllTimers()).toThrow(failure);
    });
  });

  test('listeners and payloads are typed by the event map', () => {
    const emitter = new TestEmitter();

    // @ts-expect-error unknown event
    emitter.on('unknown', () => {});
    // @ts-expect-error listener does not match the payload
    emitter.on('muteChanged', (isMuted: string) => isMuted);
    // @ts-expect-error payload does not match the event
    emitter.emit('progress', 'one', 1);

    emitter.on('muteChanged', (isMuted) => {
      const typed: boolean = isMuted;
      expect(typed).toBe(true);
    });
    emitter.emit('muteChanged', true);
  });

  test('emit is not public', () => {
    const emitter = new TypedEmitter<TestEvents>();

    // @ts-expect-error emit is protected
    expect(() => emitter.emit('ready')).not.toThrow();
  });
});
