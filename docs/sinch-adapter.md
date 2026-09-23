# Sinch adapter

Internal notes on `src/adapter/sinch.ts`, the only code that touches `sinch-rtc`. Nothing here is part of
the public surface, and none of it ships in the package.

Findings marked _source_ come from reading `sinch-rtc` 2.49.11. They stay provisional until the manual
checklist at the end has been run against a live application.

## Version

- `sinch-rtc` is pinned to exactly `2.49.11` (released 2026-09-18).
- Release cadence in 2026: 2.42.6 (Feb 25), 2.44.4 (Mar 16), 2.45.5 (Apr 8), 2.46.8 (Apr 16), 2.46.9 (Apr 20),
  2.47.7 (Jun 23), 2.48.11 (Jul 15), 2.49.11 (Sep 18): a minor release every three to eight weeks.
- Before upgrading, re-check every call listed in [Calls](#calls), the listener callbacks in [Events](#events),
  `CallEndCause`, and the untyped `getPeerConnectionStats()`, then run the checklist.

## Loading

`loadAdapter` is `loadSinchAdapter`, which runs `await import('sinch-rtc')` when the client registers for the
first time. Importing the SDK or creating a client never loads it, which keeps server-side rendering safe and
the WebRTC bundle out of pages that never register.

## Registration

- The token names the application key (`iss` is `//rtc.sinch.com/applications/{key}`) and the user id
  (`sub` ends in `/users/{prefix}={identity}`).
- The environment host is `ocra-euc1.api.sinch.com`. It has to match the region of the shared application: the
  prototype found that the global `ocra.api.sinch.com` did not route app-to-app signaling reliably to its EU
  application. Change the constant if the production application lives in another region.
- `register()` builds a client, enables managed push, then starts it. It resolves on `onClientStarted` and
  rejects on `onClientFailed`.
- `onCredentialsRequired` is answered with the latest token given to `register()`. Registering again while
  registered only replaces that token.
- `unregister()` calls `disableManagedPushSupport()`, which unregisters the service worker so an incoming push
  can no longer restart the client, then `terminate()`. Live calls keep running.

## Incoming calls

- _Source:_ `sinch-rtc` only subscribes to incoming invites from its push handler, so receiving calls needs
  managed push: `setSupportManagedPush()` before `start()`, a service worker served by the app, and the
  browser's notification permission.
- Apps serve a copy of `@sentdm/voice/sw.js` (`src/sw.js`, Sinch's documented basic worker: it forwards each push
  payload to the open pages). `serviceWorker.url` is resolved against the page and defaults to `sw.js`;
  `serviceWorker.scope` defaults to the worker's folder. Pick a path that does not replace the app's own worker.
- If push cannot be set up (no service worker support, missing worker file, permission denied, or no user
  gesture in browsers that require one for the permission prompt, such as Firefox and Safari), `sinch-rtc`
  fails `start()`, so `register()` rejects.
- _Source:_ a call that arrives while another call is live is declined by `sinch-rtc` itself and never reaches
  the adapter.
- _Source:_ `sinch-rtc` restarts itself when its remote configuration changes. The adapter attaches its
  incoming-call listener on every `onClientStarted` for that reason. A restart that fails is not visible to the
  core.

## Calls

| Seam               | `sinch-rtc`                                                       |
| ------------------ | ----------------------------------------------------------------- |
| `call` to a user   | `callClient.callUser(id)`                                         |
| `call` to a number | `callClient.callPhoneNumber(number)`                              |
| `joinConference`   | `callClient.callConference(room)`                                 |
| `answer`           | `call.answer()`                                                   |
| `reject`, `hangup` | `call.hangup()` (on an unanswered incoming call, reported denied) |
| `mute`             | `call.mute()` / `call.unmute()`                                   |
| `sendDigits`       | `call.sendDtmf(digits)`                                           |
| `getStats`         | `call.getPeerConnectionStats()`, present on calls but not typed   |
| `setInputDevice`   | `callClient.setAudioTrackConstraints({ deviceId: { exact } })`    |
| `setOutputDevice`  | `setSinkId()` on the playback element                             |

- `getStats` reads the inbound audio `jitter` (seconds, reported in ms), packet loss as
  `packetsLost / (packetsLost + packetsReceived)`, and `currentRoundTripTime` of the succeeded candidate pair
  (seconds, reported in ms). Anything not measured yet reads 0.
- `setInputDevice` applies to live and future calls. Before the client has started, the device is kept and
  applied on start. `setOutputDevice` throws `CapabilityUnsupportedError` where the browser has no `setSinkId`.
- `sinch-rtc` plays no audio. One playback element, `audio.element` or an `Audio` the adapter creates, plays
  the latest placed call from the moment it is placed (early media) or the latest answered incoming call, and
  is cleared when that call ends.
- A call that has ended is forgotten, and controls on it do nothing: `sinch-rtc` throws on a second hangup.

## Events

| `sinch-rtc`         | Seam                  |
| ------------------- | --------------------- |
| `onCallProgressing` | `ringing`             |
| `onCallAnswered`    | `answered`            |
| `onCallEstablished` | `connected`           |
| `onCallEnded`       | `ended`, mapped below |

- `onCallRinging` is not mapped: _source:_ `onCallProgressing` always fires first.
- _Source:_ there are no reconnect callbacks, so `reconnecting` and `reconnected` never fire on this provider.
  Media that drops after connecting ends the call five minutes later with `Inactive`.

## End causes

Provisional until observed.

| `CallEndCause`        | When (_source_)                                          | State       | Error           |
| --------------------- | -------------------------------------------------------- | ----------- | --------------- |
| `HungUp`              | either side hung up a connected call                     | `completed` |                 |
| `Canceled`            | the caller hung up before an answer                      | `completed` |                 |
| `OtherDeviceAnswered` | another device of the same identity answered             | `completed` |                 |
| `Denied`              | the callee declined                                      | `busy`      |                 |
| `NoAnswer`            | `sinch-rtc`'s setup timeout: 45 s outbound, 60 s inbound | `noAnswer`  |                 |
| `Timeout`             | not produced by 2.49.11                                  | `noAnswer`  |                 |
| `Failure`             | a remote error, a failed call-setup request, ICE failure | `failed`    | mapped as below |
| `Inactive`            | media disconnected for five minutes                      | `failed`    | `NetworkError`  |

Still unknown: how a phone that is busy or unanswered, and a call the backend refuses, arrive at the caller.

## Error mapping

| Where                      | Provider error                                               | Sent error                              |
| -------------------------- | ------------------------------------------------------------ | --------------------------------------- |
| `answer()`                 | microphone tracks unavailable (_source:_ its only rejection) | `MediaPermissionError`                  |
| call ended with `Failure`  | `SinchError` in the network domain, e.g. ICE failure (3002)  | `NetworkError`                          |
| call ended with `Inactive` |                                                              | `NetworkError`                          |
| `setOutputDevice()`        | no `setSinkId` in the browser                                | `CapabilityUnsupportedError`            |
| anything else              | see below                                                    | `SentVoiceError` `UNKNOWN`, `signaling` |

Unmapped errors keep the raw error in `providerDetail`. Known ones:

- Registration failures. `sinch-rtc` reports every failed start as `Unable to create instance!` and only logs the
  cause, so a rejected token, a network failure and a push setup failure look alike.
- Service worker registration failures from `setSupportManagedPush()`.
- `sendDtmf()` rejecting keys outside `0-9`, `#`, `*` and `A-D`.
- Failed call-setup requests (HTTP domain), for example `Unable to connect call`.

Observed during the manual checklist: none yet.

## Empirical checks

1. **Call headers and the Sent call id.** _Source:_ `call.headers` holds the headers returned by call setup
   (outbound) and the caller's headers from the invite (inbound). The backend sets no headers, so the `call_` id
   is not observable in the browser and `call.id` stays the provider call id. Confirm live by reading
   `call.headers` on both sides.
2. **Several tabs or devices for one identity.** _Source:_ every browser registers its own instance, stored in
   `localStorage` per application key and user id, so tabs of one browser usually share it. Calls are pushed to
   each instance with a push profile, every device rings, the first answer wins, and the others end with
   `OtherDeviceAnswered` (their invites are cancelled). The worker forwards a push to every open tab, so tabs
   sharing an instance all ring. Confirm live, including what the other tabs do after one answers.
3. **A token refresh that fails mid-call.** _Source:_ the token only authenticates creating or prolonging the
   instance. After that the instance authenticates itself until its own expiry, which is Sinch's default
   because the tokens carry no `sinch:rtc:instance:exp`. A failed refresh affects neither live nor incoming
   calls; the core's `offline` state only stops new calls being placed. A page reload reuses the stored instance
   without asking for a token. Confirm live with a short-lived token and a failing token provider.

Also pending observation: the caller value (`remoteUserId`) of a withheld phone number.

## Manual checklist

Needs the backend relay deployed, a voice-enabled number, two browsers over HTTPS (or `localhost`) serving
`sw.js`, and a phone. Record the date, the `CallEndCause` and `details.error` of every call, and add each new
error to [Error mapping](#error-mapping).

1. Register with a token from `POST /v3/voice/tokens`; allow notifications; confirm `registered`.
2. App to app, both directions: answer, then hang up from each side.
3. App to app: decline; caller cancels while ringing; let it ring out.
4. App to phone: answer; busy; no answer; the phone declines.
5. Phone to app: answer; decline; the caller hangs up first; a withheld number.
6. A room: join, leave.
7. During a call: mute, digits into a menu, `getStats`, switch the output and the input device.
8. One identity in two tabs and on two devices: who rings, who can answer, what the others see.
9. Refresh: a short-lived token; a token provider that starts failing mid-call.
10. Read `call.headers` on both sides of a call.
11. Deny notification permission and confirm `register()` rejects.
