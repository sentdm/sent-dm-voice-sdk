# Sent Voice TypeScript SDK

This library lets a web app place and receive Sent Voice calls in the browser, with optional React helpers.

Your backend mints a short-lived voice token for each user with the Sent API. The SDK registers the browser with it, then places calls, receives them and reports how they go.

## Installation

```sh
npm install @sentdm/voice
```

## Quickstart

### 1. Mint voice tokens on your backend

Mint tokens on your server with your Sent API key, never in the browser, for the user who is signed in:

```ts
export async function createVoiceToken(identity: string): Promise<string> {
  const response = await fetch('https://api.sent.dm/v3/channels/voice/tokens', {
    method: 'POST',
    headers: { 'x-api-key': process.env['SENT_DM_API_KEY'] ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity }),
  });
  if (!response.ok) throw new Error(`Minting a voice token failed with status ${response.status}`);
  const { data } = (await response.json()) as { data: { token: string } };
  return data.token;
}
```

`identity` names the user in calls: letters, digits, `-` and `_`, up to 200 characters. The user is bound to your default voice number unless you pass `number`, one of the numbers you turned voice on for with `POST /v3/channels/voice`, and the token lasts `ttl` seconds (600 by default, at most 3600). Return the token as text from an endpoint of your own, such as `/api/voice-token`.

### 2. Serve the service worker

Incoming calls reach the browser as push messages, through a service worker your app serves. Copy the one this package ships next to your pages, for example:

```sh
cp node_modules/@sentdm/voice/sw.js public/sw.js
```

The SDK registers `sw.js` relative to the page. If you serve it elsewhere, or your app already has a service worker, give it a path and scope of its own so it does not replace yours:

```ts
import SentVoice from '@sentdm/voice';

const client = new SentVoice({
  tokenProvider: () => fetch('/api/voice-token').then((response) => response.text()),
  serviceWorker: { url: '/voice/sw.js', scope: '/voice/' },
});
```

### 3. Register and call

```ts
import SentVoice from '@sentdm/voice';

const client = new SentVoice({
  tokenProvider: () => fetch('/api/voice-token').then((response) => response.text()),
});

document.querySelector('#call')?.addEventListener('click', async () => {
  await client.register();
  const call = await client.connect({ to: '+14155551234' });
  call.on('connected', () => console.log('Connected'));
  call.on('disconnected', ({ state }) => console.log(`The call ended as ${state}`));
});
```

The first `register()` asks the user to allow notifications, which the browser needs to deliver incoming calls. Firefox and Safari only show that prompt after a user gesture, so call it from a click, as above. It rejects when notifications are blocked or the service worker cannot be registered.

## Token lifecycle

`tokenProvider` is how the SDK gets every token. It must return the `token` that `POST /v3/channels/voice/tokens` responded with, fetched fresh each time, because the SDK calls it again before each token expires.

- `register()` calls it and resolves once the client is `registered`. The client moves from `unregistered` to `registering` to `registered`, emitting each state as an event.
- A token provider that throws or rejects is retried after a short backoff, 2 more times by default (`registerRetries`); `register()` then rejects with a `NetworkError`. A value that is not a voice token rejects with a `TokenInvalidError` at once.
- The token is refreshed at 80% of its lifetime, or 30 seconds before it expires if that is earlier, but never before half of its lifetime has passed. `tokenWillExpire` fires first, then `tokenProvider` is called with the same retries. Nothing else changes for your app.
- If the retries run out, the client emits `error` with the cause and `offline` with a `TokenExpiredError`, then tries again about every 30 seconds until it is `registered` again; calling `register()` tries at once. Calls in progress go on, but `connect()` and `joinConference()` throw a `NotRegisteredError` while the client is offline.
- `unregister()` stops receiving calls and leaves calls in progress alone. `destroy()` ends every call and tears the client down for good.

Tokens stay in memory and are redacted from log messages.

```ts
import SentVoice from '@sentdm/voice';

const client = new SentVoice({
  tokenProvider: async () => {
    const response = await fetch('/api/voice-token');
    if (!response.ok) throw new Error(`Fetching the voice token failed with status ${response.status}`);
    return response.text();
  },
});

client.on('registered', () => console.log('Ready for calls'));
client.on('tokenWillExpire', ({ expiresAt }) => console.log('Refreshing, expires', new Date(expiresAt)));
client.on('offline', (reason) => console.warn(`Offline (${reason.code}), trying again every 30 seconds`));
```

## Calls

`connect({ to })` calls a phone number in E.164 format, like `'+14155551234'`, or another user of your app by identity, like `'ben'`. `joinConference({ name })` joins one of your account's rooms, named with letters, digits, `-` and `_`, up to 27 characters. Either throws a `SentVoiceError` with code `INVALID_ADDRESS` when `to` or `name` does not fit, and one with code `CALL_IN_PROGRESS` while a call is in progress or an incoming call is still waiting for an answer: the SDK handles one call at a time. Both open the microphone, and reject with a `MediaPermissionError` when the user refuses. `to` says who the user wants to reach; your backend's answer decides what rings.

A leg to a phone number, whether the answer connects the call to a number or a phone participant is added through the API, runs for at most what your account's balance affords at the destination's per-minute rate, capped at four hours by the provider. Legs to app users and rooms have no such limit because they cost nothing. A call that reaches the cap ends as `completed`.

```ts
import type SentVoice from '@sentdm/voice';

export async function callBen(client: SentVoice) {
  const call = await client.connect({ to: 'ben' });

  call.on('ringing', () => console.log('Ringing'));
  call.on('connected', () => call.sendDigits('1'));
  call.on('muteChanged', (isMuted) => console.log(isMuted ? 'Muted' : 'Unmuted'));
  call.on('disconnected', ({ state, error }) => console.log(`The call ended as ${state}`, error?.code));
  return call;
}
```

A call moves through `initiated`, `ringing`, `answered` and `connected`, and ends as `completed`, `failed`, `busy` or `noAnswer`, which `disconnected` reports. `hangup()` ends it, `mute()` toggles the microphone, `sendDigits()` sends DTMF, and `getStats()` reads its jitter, packet loss and round-trip time. `client.activeCall` is the call placed or answered last, until that call ends, and `activeCallChanged` reports each change. `client.calls` lists every call in progress.

The SDK plays the other party through an audio element it creates. Pass your own with the `audio: { element }` option.

### Receiving calls

```ts
import type SentVoice from '@sentdm/voice';

export function receiveCalls(client: SentVoice) {
  client.on('incomingCall', (invite) => {
    console.log('Incoming call from', invite.from);
    invite.on('cancelled', () => console.log('The caller hung up'));

    document.querySelector('#answer')?.addEventListener(
      'click',
      async () => {
        const call = await invite.accept();
        call.on('disconnected', ({ state }) => console.log(`The call ended as ${state}`));
      },
      { once: true },
    );
    document.querySelector('#decline')?.addEventListener('click', () => invite.reject(), { once: true });
  });
}
```

The microphone opens when the call arrives, and `accept()` asks for permission again if that was refused, then resolves with the call. When the user refuses, it rejects with a `MediaPermissionError` and the invite stays pending, so the user can try again. `reject()` declines the call, and `cancelled` fires when the caller hangs up first. A call that arrives while another one is in progress is declined for you.

### Call quality and reconnection

`qualityWarning` fires when a network metric of a connected call crosses its threshold, and again with `cleared: true` once it recovers. Stats are sampled every half second.

| `metric`     | Raised when                                                               | Cleared when                   |
| ------------ | ------------------------------------------------------------------------- | ------------------------------ |
| `jitter`     | incoming audio jitter is above 30 ms in 3 of the last 4 samples           | fewer than 3 of the last 4 are |
| `packetLoss` | over 1% of the incoming audio packets are lost in 3 of the last 4 samples | fewer than 3 of the last 4 are |
| `rtt`        | the round-trip time is above 300 ms                                       | it is 300 ms or less again     |

The `rtt` warning follows every sample, so it can go on and off while the round-trip time hovers around 300 ms. A warning still raised when the call ends is not cleared.

```ts
import type SentVoice from '@sentdm/voice';

export function showCallQuality(call: SentVoice.Call) {
  call.on('qualityWarning', ({ metric, cleared }) => console.log(metric, cleared ? 'recovered' : 'poor'));
  call.on('reconnecting', () => console.log('Connection lost, reconnecting'));
  call.on('reconnected', () => console.log('Connection back'));
}
```

When the connection drops for 2 seconds, the call goes `reconnecting`, and `reconnected` fires when it comes back on the same network. A call cannot move to a new network: after a network switch its connection does not come back, and a call that has not reconnected within 5 minutes ends as `failed` with a `NetworkError`.

## Handling errors

Every error the SDK throws or emits is a `SentVoiceError` with a stable `code`, a `category` (`auth`, `media`, `signaling`, `network`, `validation` or `capability`) and whether it is `retriable`. Check for the subclasses with `instanceof`:

```ts
import type SentVoice from '@sentdm/voice';
import { MediaPermissionError, SentVoiceError } from '@sentdm/voice/errors';

export async function answer(invite: SentVoice.CallInvite) {
  try {
    return await invite.accept();
  } catch (error) {
    if (error instanceof MediaPermissionError) console.warn('Allow microphone access to answer calls');
    else if (error instanceof SentVoiceError) console.error(error.code, error.message);
    throw error;
  }
}
```

| Error                        | `code`                    | `category`   | When                                                                                                                                                                  |
| ---------------------------- | ------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TokenInvalidError`          | `TOKEN_INVALID`           | `auth`       | `register()`: the token provider returned something that is not a voice token                                                                                         |
| `TokenExpiredError`          | `TOKEN_EXPIRED`           | `auth`       | the `offline` event: the token could not be refreshed                                                                                                                 |
| `NotRegisteredError`         | `NOT_REGISTERED`          | `validation` | `connect()` or `joinConference()` while not registered; registering, calling or choosing a device after `destroy()`                                                   |
| `MediaPermissionError`       | `MEDIA_PERMISSION_DENIED` | `media`      | `connect()`, `joinConference()` or `accept()`: the microphone could not be opened                                                                                     |
| `CallFailedError`            | `CALL_FAILED`             | `signaling`  | `accept()` on a call that ended before it was answered; a call the provider could not set up, such as to an identity that is not registered, ends as `failed` with it |
| `CallRejectedError`          | `CALL_REJECTED`           | `signaling`  | not raised yet: a call the other side declines ends as `busy`                                                                                                         |
| `NetworkError`               | `NETWORK`                 | `network`    | `register()`, when the token provider keeps failing or the calling provider cannot be loaded; a call whose connection failed or was lost                              |
| `CapabilityUnsupportedError` | `CAPABILITY_UNSUPPORTED`  | `capability` | `setOutputDevice()` where the browser cannot choose the speaker; listing devices over plain HTTP                                                                      |
| `SentVoiceError`             | `INVALID_ADDRESS`         | `validation` | `connect()` or `joinConference()` with a `to` or `name` that does not fit                                                                                             |
| `SentVoiceError`             | `CALL_IN_PROGRESS`        | `validation` | `connect()` or `joinConference()` while a call is in progress or an incoming call is waiting for an answer                                                            |
| `SentVoiceError`             | `UNKNOWN`                 | `signaling`  | anything else, such as `register()` failing because notifications are blocked                                                                                         |

Errors that happen outside a method call arrive as events: the client's `error` when a token refresh fails, and a call's `error`, followed by `disconnected` with `{ state: 'failed', error }`. The underlying provider error is not exposed on the error; the SDK reports it to Sent as telemetry.

## Devices

```ts
import type SentVoice from '@sentdm/voice';

const isHeadset = (device: MediaDeviceInfo) => device.label.includes('Headset');

export async function pickHeadset(client: SentVoice) {
  const microphone = (await client.audio.inputDevices()).find(isHeadset);
  if (microphone) await client.audio.setInputDevice(microphone.deviceId);
  const speaker = (await client.audio.outputDevices()).find(isHeadset);
  if (speaker) await client.audio.setOutputDevice(speaker.deviceId);
}

export function followHeadset(client: SentVoice) {
  client.audio.on('deviceChanged', () => pickHeadset(client).catch(console.error));
}
```

- `inputDevices()` and `outputDevices()` list the microphones and speakers. Browsers leave out labels, and may list a single device, until the user has allowed microphone access in the page, which the first call asks for.
- `setInputDevice()` switches the microphone of the call in progress and of later calls. While the device is missing, the default one is used.
- `setOutputDevice()` plays calls through a speaker. It throws a `CapabilityUnsupportedError` in browsers that cannot choose the audio output.
- Both work before `register()`, and take effect when it runs. To start with saved devices, pass `audio: { inputDeviceId, outputDeviceId }`.
- `deviceChanged` fires when a device is plugged in or out.

## Ringtones

The SDK plays no ringtone or ringback. Play your own on `incomingCall` and when a placed call is `ringing`, and stop it when the call is answered or ends:

```ts
import type SentVoice from '@sentdm/voice';

const ringtone = new Audio('/sounds/ringtone.mp3');
ringtone.loop = true;

const play = () => ringtone.play().catch(() => {});
const stop = () => {
  ringtone.pause();
  ringtone.currentTime = 0;
};

export function ringForIncomingCalls(client: SentVoice) {
  client.on('incomingCall', (invite) => {
    play();
    invite.on('accepted', stop).on('rejected', stop).on('cancelled', stop);
  });
}

export async function callWithRingback(client: SentVoice, to: string) {
  const call = await client.connect({ to });
  call.on('ringing', play).on('connected', stop).on('disconnected', stop);
  return call;
}
```

## React

`@sentdm/voice/react` wraps one client in a provider, with hooks that re-render on its events. It supports React 18 and 19.

```tsx
import { SentVoiceProvider, useActiveCall, useIncomingCall, useSentVoice } from '@sentdm/voice/react';

const getVoiceToken = () => fetch('/api/voice-token').then((response) => response.text());

export function App() {
  return (
    <SentVoiceProvider tokenProvider={getVoiceToken} autoRegister={false}>
      <Phone />
    </SentVoiceProvider>
  );
}

function Phone() {
  const { client, state, register } = useSentVoice();
  const invite = useIncomingCall();
  const { call, state: callState, isMuted, mute, hangup, duration } = useActiveCall();

  if (state !== 'registered') return <button onClick={register}>Go online</button>;
  if (invite) {
    return (
      <p>
        <button onClick={() => invite.accept()}>Answer</button>
        <button onClick={() => invite.reject()}>Decline</button>
      </p>
    );
  }
  if (call) {
    return (
      <p>
        {callState} for {duration} s <button onClick={() => mute()}>{isMuted ? 'Unmute' : 'Mute'}</button>
        <button onClick={hangup}>Hang up</button>
      </p>
    );
  }
  return <button onClick={() => client?.connect({ to: 'ben' })}>Call Ben</button>;
}
```

- `SentVoiceProvider` takes every client option, plus `autoRegister` (default `true`), which registers as soon as the client exists. Registering needs the notification permission, which Firefox and Safari only ask for after a user gesture, so the example registers from a click.
- The client is created after the provider mounts, so its children render first, on the server too, with `client` `null` and `state` `'unregistered'`. Unmounting destroys the client and ends its calls.
- Props are read once, when the client is created: remount the provider with a new `key` to change them, for example for another user. `tokenProvider` is the exception, the latest one is always used.
- `useSentVoice()` gives the client, its state, `register` and `unregister`. `useIncomingCall()` gives the newest invite still waiting for an answer, or `null`. `useActiveCall()` gives the active call with its state, `isMuted`, `mute`, `hangup`, `sendDigits` and `duration`, the seconds since it connected. `useAudioDevices()` gives the microphones and speakers with `setInput` and `setOutput`.
- The entry point is marked `'use client'` for the Next.js App Router.

## Telemetry

The SDK reports usage and call quality data to Sent, authenticated with the voice token:

- the SDK version, and the browser, its major version, the operating system, its version and the device type, as read from the user agent (the user agent itself is not sent)
- how long `register()` took, its attempts and, when it failed, its error; how long `unregister()` took
- for each call: its id, direction and outcome, how long it took to connect and how long it lasted, and at its end the average round-trip time, jitter and packet loss of samples taken every 10 seconds
- the errors the client and its calls report: code, category, whether retriable, the message, and the underlying provider error with its name, message, stack and properties

No audio, phone numbers or identities are added by the SDK; the underlying provider error travels as the provider produced it. Batches go to `https://api.sent.dm/v3/voice/telemetry` 3 seconds after the first event queued, so events that happen together share one request, and at once when a call ends, when the page is hidden and when the client is destroyed. A batch that fails, or that Sent refuses (for example with 404 while the telemetry endpoint is not deployed), is retried once, with the next batch or within 30 seconds, then dropped; telemetry never throws to your app and never delays a call. Turn it off with `telemetry: { disabled: true }`.

## Browser realities

- WebRTC requires a secure context: serve your app over HTTPS, or from `localhost` while developing. Over plain HTTP the browser hides the microphone and service worker APIs, so registering and calling fail. It is the first thing that breaks when you open the app from another device on your network.
- A page refresh or tab close ends any live call: WebRTC media dies with the page, and there is no resuming a call across reloads.
- Laptop sleep or a network switch does not unregister the client: incoming calls reach it through the browser's push service, which reconnects by itself, so the client stays `registered`, but calls that arrive while the device sleeps or is offline are missed. If a token refresh falls in that gap, the client goes `offline` and tries again about every 30 seconds until it is `registered` again (state passes `offline → registered`).
- One `SentVoice` instance per tab. The same identity registered in several tabs/devices creates independent per-device registrations at the provider (documented provider behavior); which devices ring on an incoming call is the provider's delivery semantics — inherited as-is, pinned down empirically during implementation testing. Every device rings, the first to answer takes the call, and the others see their invite cancelled. Tabs of one browser share a registration, so they all ring.
- Tokens are per-registration; each tab runs its own `tokenProvider` calls.
