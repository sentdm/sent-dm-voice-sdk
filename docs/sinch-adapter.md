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
  `CallEndCause`, the quality warning names and thresholds, and the untyped `getPeerConnectionStats()`, then run
  the checklist.

## Loading

`loadAdapter` is `loadSinchAdapter`, which runs `await import('sinch-rtc')` when the client registers for the
first time. Importing the SDK or creating a client never loads it, which keeps server-side rendering safe and
the WebRTC bundle out of pages that never register. A load that fails rejects with `NetworkError`, so
`register()` retries it, and the core loads again on the next attempt.

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
- _Source:_ `sinch-rtc` opens the microphone (`getUserMedia`) when the invite arrives, before `answer()`;
  `answer()` asks again only when that failed, and rejects when it fails again.
- _Source:_ `sinch-rtc` ignores an `answer()` within 1.5 s of the previous one on the same call, so after a
  failed answer the adapter waits out that window before answering again.
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
| `setInputDevice`   | `callClient.setAudioTrackConstraints({ deviceId })`               |
| `setOutputDevice`  | `setSinkId()` on the playback element                             |

- `getStats` reads the inbound audio `jitter` (seconds, reported in ms), packet loss as
  `packetsLost / (packetsLost + packetsReceived)`, and `currentRoundTripTime` of the succeeded candidate pair
  (seconds, reported in ms). Anything not measured yet reads 0.
- `setInputDevice` applies to live and future calls. Before the client has started, the device is kept and
  applied on start. `setOutputDevice` throws `CapabilityUnsupportedError` where the browser has no `setSinkId`.
- The input device is preferred, not required (no `exact`): a missing one falls back to the default. _Source:_
  `sinch-rtc` carries on with an empty stream when `getUserMedia` fails, so a required device that is missing
  would leave a placed call without a microphone, make answering fail and cut the microphone of a live call.
- `sinch-rtc` plays no audio. One playback element, `audio.element` or an `Audio` the adapter creates, plays
  the latest placed call from the moment it is placed (early media) or the latest answered incoming call, and
  is cleared when that call ends.
- A call that has ended is forgotten, and controls on it do nothing: `sinch-rtc` throws on a second hangup.
- _Source:_ one call at a time. Every call shares one signaling subscription, which `sinch-rtc` cancels when
  any call ends, so a second live call loses its signaling; the core refuses `connect()` and `joinConference()`
  with `CALL_IN_PROGRESS` while a call is live or an invite is pending.
- _Source:_ a placed call whose `getUserMedia` failed carries an empty outgoing stream and no error. The adapter
  hangs it up and rejects with `MediaPermissionError`.

## Events

| `sinch-rtc`                                         | Seam                                 |
| --------------------------------------------------- | ------------------------------------ |
| `onCallProgressing`                                 | `ringing`                            |
| `onCallAnswered`                                    | `answered`                           |
| `onCallEstablished`                                 | `connected`                          |
| `onCallQualityWarningEvent` `missingMediaStream`    | `reconnecting`, `reconnected`        |
| `onCallQualityWarningEvent` `highInboundJitter`     | `qualityWarning` metric `jitter`     |
| `onCallQualityWarningEvent` `highInboundPacketLoss` | `qualityWarning` metric `packetLoss` |
| `onCallQualityWarningEvent` `highRemoteInboundRtt`  | `qualityWarning` metric `rtt`        |
| `onCallEnded`                                       | `ended`, mapped below                |

- `onCallRinging` is not mapped: _source:_ `onCallProgressing` always fires first.
- Each warning arrives as `Trigger`, then `Recover`, which becomes `reconnected` or a `qualityWarning` with
  `cleared: true`. _Source:_ the warnings are checked from the moment the call is established until it ends, and
  one still raised when the call ends is never recovered. The audio level warnings (`constantInboundAudioLevel`,
  `constantOutboundAudioLevel`, `zeroInboundAudioLevel`, `zeroOutboundAudioLevel`) are not mapped.
- _Source:_ there are no reconnect callbacks. `missingMediaStream` fires when the ICE connection has not been
  `connected` for 2 s after the call was established, and recovers when it is `connected` again. It counts every
  other ICE state as missing, `completed` included.
- _Source:_ `sinch-rtc` never restarts ICE. Media that comes back on the same network recovers the call; after a
  network switch it cannot. Media that stays down ends the call with `Inactive` five minutes after it dropped,
  unless the call ends another way first.

Quality thresholds (_source_; stats are read every 500 ms):

| Warning                 | Raised when                                                                        | Recovered when                      |
| ----------------------- | ---------------------------------------------------------------------------------- | ----------------------------------- |
| `highInboundJitter`     | inbound audio jitter above 30 ms in 3 of the last 4 samples                        | fewer than 3 of the last 4          |
| `highInboundPacketLoss` | inbound audio packets lost above 1% of those received, per sample, 3 of the last 4 | fewer than 3 of the last 4          |
| `highRemoteInboundRtt`  | round-trip time reported by the remote side above 300 ms in the latest sample      | the latest sample is 300 ms or less |

The round-trip time warning has no hysteresis, so it can go on and off while the time hovers around 300 ms.

## Network changes

_Source:_ a registered client holds no open connection. Incoming calls arrive as pushes through the service
worker, and the signaling channel only opens for a call.

- Sleep, a network switch or going offline leave the client registered, and nothing tells the core. Calls that
  arrive meanwhile are missed.
- The refresh timer can fire in that gap, and runs late after sleep: the token provider fails, the retries run
  out, the client goes `offline`, and the slow loop registers it again once the token provider is reachable.
- A call in progress follows [Events](#events): `reconnecting`, then `reconnected` or the `Inactive` end.

## End causes

Provisional until observed.

| `CallEndCause`        | When (_source_)                                                       | State       | Error           |
| --------------------- | --------------------------------------------------------------------- | ----------- | --------------- |
| `HungUp`              | either side hung up a connected call                                  | `completed` |                 |
| `Canceled`            | the caller hung up before an answer                                   | `completed` |                 |
| `OtherDeviceAnswered` | another device of the same identity answered                          | `completed` |                 |
| `Denied`              | the callee declined, this endpoint included when it rejects an invite | `busy`      |                 |
| `NoAnswer`            | `sinch-rtc`'s setup timeout: 45 s outbound, 60 s inbound              | `noAnswer`  |                 |
| `Timeout`             | not produced by 2.49.11                                               | `noAnswer`  |                 |
| `Failure`             | a remote error, a failed call-setup request, ICE failure              | `failed`    | mapped as below |
| `Inactive`            | media disconnected for five minutes                                   | `failed`    | `NetworkError`  |

Still unknown: how a phone that is busy or unanswered, and a call the backend refuses, arrive at the caller.

## Error mapping

| Where                        | Provider error                                               | Sent error                              |
| ---------------------------- | ------------------------------------------------------------ | --------------------------------------- |
| `import('sinch-rtc')`        | the module could not be loaded                               | `NetworkError`                          |
| `call()`, `joinConference()` | no audio track in the outgoing stream (microphone refused)   | `MediaPermissionError`                  |
| `answer()`                   | microphone tracks unavailable (_source:_ its only rejection) | `MediaPermissionError`                  |
| call ended with `Failure`    | `SinchError` in the network domain, e.g. ICE failure (3002)  | `NetworkError`                          |
| call ended with `Inactive`   |                                                              | `NetworkError`                          |
| `setOutputDevice()`          | no `setSinkId` in the browser                                | `CapabilityUnsupportedError`            |
| anything else                | see below                                                    | `SentVoiceError` `UNKNOWN`, `signaling` |

Unmapped errors keep the raw error in `providerDetail`. Known ones:

- Registration failures. `sinch-rtc` reports every failed start as `Unable to create instance!` and only logs the
  cause, so a rejected token, a network failure and a push setup failure look alike.
- Service worker registration failures from `setSupportManagedPush()`.
- `sendDtmf()` rejecting keys outside `0-9`, `#`, `*` and `A-D`.
- `setSinkId()` rejecting an id the page cannot list (`NotFoundError`). Output ids are only listed once the
  microphone has been opened in the page, so a saved output device can fail until the first call.
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
12. During a call: turn the network off for 10 s and back on; switch networks (Wi-Fi to cable or a hotspot);
    record `reconnecting`, `reconnected` and the end cause. Confirm a healthy call never reports `reconnecting`
    (the `completed` ICE state).
13. Sleep the laptop for a few minutes, while idle and during a call. After waking, confirm incoming calls ring
    again, and record what the call did.
14. With a short-lived token, go offline until a refresh fails: confirm `offline`, then `registered` once back
    online.
15. Degrade the network during a call (loss, delay and jitter with an OS-level network conditioner) and record
    which quality warnings are raised and cleared.
