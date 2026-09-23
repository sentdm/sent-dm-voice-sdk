/// <reference lib="dom" />
import Bowser from 'bowser';
import type { Call, CallStats } from './call';
import { SentVoiceError } from './errors';
import type { Log } from './log';
import { VERSION } from './version';

type EventType =
  | 'register.completed'
  | 'register.failed'
  | 'unregister.completed'
  | 'client.info'
  | 'client.error'
  | 'call.started'
  | 'call.connected'
  | 'call.quality'
  | 'call.ended';

type Payload = Partial<
  Record<
    | 'browser'
    | 'browser_version'
    | 'os'
    | 'os_version'
    | 'device_type'
    | 'duration_ms'
    | 'attempt'
    | 'direction'
    | 'outcome'
    | 'rtt_ms'
    | 'jitter_ms'
    | 'packet_loss'
    | 'samples'
    | 'code'
    | 'category',
    string | number
  >
>;

interface Entry {
  event: { type: EventType; call_id?: string; occurred_at: string; payload: Payload };
  retried: boolean;
}

const defaultBaseURL = 'https://api.sent.dm';
const path = '/v3/voice/telemetry';
const flushInterval = 30_000;
const sampleInterval = 10_000;
const maxEvents = 100;

function clientInfo(userAgent: string): Payload {
  const { browser, os, platform } = Bowser.parse(userAgent);
  const info: Payload = {};
  if (browser.name) info.browser = browser.name;
  const major = browser.version?.split('.')[0];
  if (major) info.browser_version = major;
  if (os.name) info.os = os.name;
  if (os.version) info.os_version = os.version;
  if (platform.type) info.device_type = platform.type;
  return info;
}

const average = (samples: CallStats[], metric: keyof CallStats) =>
  samples.reduce((sum, sample) => sum + sample[metric], 0) / samples.length;

export class Telemetry {
  #url: string;
  #log: Log;
  #token: string | undefined;
  #queue: Entry[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #sampling = new Set<ReturnType<typeof setInterval>>();
  #pageHide = () => this.#flush(true);
  #visibilityChange = () => {
    if (document.visibilityState === 'hidden') this.#flush(true);
  };

  constructor(baseURL: string | undefined, log: Log) {
    const base = baseURL || defaultBaseURL;
    this.#url = base + (base.endsWith('/') ? path.slice(1) : path);
    this.#log = log;
  }

  useToken(jwt: string): void {
    this.#token = jwt;
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#flush(), flushInterval);
    window.addEventListener('pagehide', this.#pageHide);
    document.addEventListener('visibilitychange', this.#visibilityChange);
  }

  registered(duration: number, attempts: number): void {
    this.#record('register.completed', { duration_ms: duration, attempt: attempts });
    this.#record('client.info', clientInfo(navigator.userAgent));
  }

  registerFailed(duration: number, attempts: number, error: unknown): void {
    this.#record(
      'register.failed',
      error instanceof SentVoiceError ?
        { duration_ms: duration, attempt: attempts, code: error.code, category: error.category }
      : { duration_ms: duration, attempt: attempts },
    );
  }

  unregistered(duration: number): void {
    this.#record('unregister.completed', { duration_ms: duration });
  }

  error(error: unknown, callId?: string): void {
    if (error instanceof SentVoiceError) {
      this.#record('client.error', { code: error.code, category: error.category }, callId);
    }
  }

  callStarted(call: Call): void {
    const { id, direction } = call;
    const startedAt = Date.now();
    const samples: CallStats[] = [];
    let connectedAt: number | undefined;
    let sampling: ReturnType<typeof setInterval> | undefined;

    this.#record('call.started', { direction }, id);
    call.on('connected', () => {
      connectedAt = Date.now();
      this.#record('call.connected', { direction, duration_ms: connectedAt - startedAt }, id);
      sampling = setInterval(() => {
        call.getStats().then(
          (stats) => samples.push(stats),
          () => {},
        );
      }, sampleInterval);
      this.#sampling.add(sampling);
    });
    call.on('error', (error) => this.error(error, id));
    call.on('disconnected', ({ state }) => {
      if (sampling) {
        clearInterval(sampling);
        this.#sampling.delete(sampling);
      }
      if (samples.length) {
        this.#record(
          'call.quality',
          {
            rtt_ms: average(samples, 'rtt'),
            jitter_ms: average(samples, 'jitter'),
            packet_loss: average(samples, 'packetLoss'),
            samples: samples.length,
          },
          id,
        );
      }
      this.#record(
        'call.ended',
        connectedAt === undefined ?
          { direction, outcome: state }
        : { direction, outcome: state, duration_ms: Date.now() - connectedAt },
        id,
      );
      this.#flush();
    });
  }

  destroyed(): void {
    this.#token = undefined;
    this.#queue = [];
    for (const sampling of this.#sampling) clearInterval(sampling);
    if (!this.#timer) return;
    clearInterval(this.#timer);
    window.removeEventListener('pagehide', this.#pageHide);
    document.removeEventListener('visibilitychange', this.#visibilityChange);
  }

  #record(type: EventType, payload: Payload, callId?: string): void {
    const occurredAt = new Date().toISOString();
    const event =
      callId === undefined ?
        { type, occurred_at: occurredAt, payload }
      : { type, call_id: callId, occurred_at: occurredAt, payload };
    this.#queue = [...this.#queue, { event, retried: false }].slice(-maxEvents);
  }

  #flush(keepalive = false): void {
    const token = this.#token;
    if (!token || !this.#queue.length) return;
    const entries = this.#queue;
    this.#queue = [];
    void this.#send(token, entries, keepalive);
  }

  async #send(token: string, entries: Entry[], keepalive: boolean): Promise<void> {
    try {
      const response = await fetch(this.#url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdk_version: VERSION, events: entries.map(({ event }) => event) }),
        keepalive,
      });
      if (response.ok) return;
      this.#log.debug(`Sending telemetry failed with status ${response.status}`);
    } catch (error) {
      this.#log.debug(`Sending telemetry failed: ${error}`);
    }

    const retries = entries.filter(({ retried }) => !retried).map(({ event }) => ({ event, retried: true }));
    this.#queue = [...retries, ...this.#queue].slice(-maxEvents);
  }
}
