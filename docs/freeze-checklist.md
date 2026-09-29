# 1.0 freeze checklist

Internal. The public surface of the SDK design plan (client, calls, invites, devices, errors and the React
helpers) is what 1.0 freezes. Every difference between the plan and what ships is listed here with its
disposition, and anything not approved has to change before 1.0. All entries below were approved by the owner
on 2026-09-23.

## Surface

| Area                               | Plan                                                 | Ships                                                                                                                                                                                    | Disposition                  |
| ---------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `logLevel` option                  | `'silent'`, `'error'`, `'warn'`, `'info'`, `'debug'` | `'off'` instead of `'silent'`, as in `@sentdm/sentdm`                                                                                                                                    | Approved                     |
| `logger` option                    | `(level, msg, data?) => void`                        | an object with `error`, `warn`, `info` and `debug`, `console` by default, as in `@sentdm/sentdm`                                                                                         | Approved                     |
| `serviceWorker` option             | none                                                 | `{ url?, scope? }` of the worker that delivers incoming calls                                                                                                                            | Approved                     |
| `audio.element` option             | none                                                 | an `HTMLAudioElement` that plays the other party                                                                                                                                         | Approved                     |
| `telemetry` option                 | none                                                 | `{ baseURL?, disabled? }`                                                                                                                                                                | Approved                     |
| `client.identity`, `client.number` | `string`                                             | `string \| undefined`, undefined until registered                                                                                                                                        | Approved                     |
| `activeCallChanged` client event   | none                                                 | `(call: Call \| null)`, whenever `activeCall` is set or cleared                                                                                                                          | Approved                     |
| `call.id`                          | the Sent `call_` id once observable                  | the provider call id: the Sent id is not observable in the browser                                                                                                                       | Approved, as the plan allows |
| `Address`                          | user or number                                       | also `{ kind: 'conference', name }`, the `to` of a room call                                                                                                                             | Approved                     |
| `QualityWarning`                   | named only                                           | `{ metric: 'jitter' \| 'packetLoss' \| 'rtt'; cleared }`, relaying the provider's own warnings                                                                                           | Approved                     |
| `DisconnectInfo`, `CancelInfo`     | named only                                           | `{ state: 'completed' \| 'failed' \| 'busy' \| 'noAnswer'; error? }` and `{ error? }`                                                                                                    | Approved                     |
| Invite events                      | `cancelled`                                          | also `accepted` (with the call) and `rejected`                                                                                                                                           | Approved                     |
| `SentVoice` namespace              | params, states, `Address`, stats and event payloads  | also `Call`, `CallInvite` and `AudioController`, as types only                                                                                                                           | Approved                     |
| Error codes                        | the codes of the eight subclasses                    | also `INVALID_ADDRESS` (validation, a bad `to` or room name), `CALL_IN_PROGRESS` (validation, a call while one is live or an invite is pending) and `UNKNOWN` (unmapped provider errors) | Approved                     |
| Error type names                   | `SentVoice.ErrorCode`                                | `SentVoiceErrorCode` and `SentVoiceErrorCategory`, from `@sentdm/voice/errors`                                                                                                           | Approved                     |
| Error exports                      | `@sentdm/voice/errors`                               | also the root entry point                                                                                                                                                                | Approved                     |
| `providerDetail`                   | a public field, for the app's logs                   | not on the error: the raw provider error is kept internally and reported to Sent in telemetry                                                                                            | Approved 2026-09-24          |
| `SentVoiceProvider` props          | `tokenProvider`, `autoRegister`                      | every client option plus `autoRegister`, read once at mount except `tokenProvider`                                                                                                       | Approved                     |
| `SentVoiceProvider` unmount        | unregisters                                          | destroys the client, which ends its calls and unregisters                                                                                                                                | Approved                     |

## Behavior

| Area                          | Plan                                             | Ships                                                                                                   | Disposition |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------- |
| `qualityWarning`              | thresholds the SDK defines from its stats        | the provider's warnings and thresholds (see `sinch-adapter.md`), the round-trip one without hysteresis  | Approved    |
| `reconnecting`, `reconnected` | provider reconnect events                        | the provider's missing-media warning, raised and recovered                                              | Approved    |
| Telemetry unload flush        | `sendBeacon`                                     | `fetch` with `keepalive`, which can carry the bearer token                                              | Approved    |
| Sleep and network switches    | break a registration socket, re-register on wake | no registration socket: the client stays registered, and only a refresh failing in the gap goes offline | Approved    |

`CallRejectedError` exists as planned but is not raised yet: a call the other side declines ends as `busy`. How a
refusal from the customer's backend reaches the caller is still unknown (End causes in `sinch-adapter.md`).

## Packaging

| Area         | Plan                                                    | Ships                                                                                                          | Disposition |
| ------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------- |
| Exports      | `.`, `./react`, `./errors`                              | also `./sw.js`, the service worker apps serve                                                                  | Approved    |
| Dependencies | `sinch-rtc`, hidden                                     | also `bowser` for the telemetry device info, both pinned exact                                                 | Approved    |
| React        | unspecified                                             | optional peer `^18.0.0 \|\| ^19.0.0`                                                                           | Approved    |
| Repository   | `sentdm/sent-voice-typescript`, `packages/voice` layout | `sentdm/sent-dm-voice-sdk`, with the flat layout of `sent-dm-typescript`                                       | Approved    |
| Publishing   | `@sentdm/voice`, `0.x` during alpha                     | public access from the first `0.x` release, released by release-please from `main`, as in `sent-dm-typescript` | Approved    |

## Exclusions

Checked against `src/` on 2026-09-23. None of these exists, and no convenience API brings one in:

- **Video**: no video option, track, method or event. The adapter only places audio calls (`callUser`,
  `callPhoneNumber`, `callConference`).
- **SIP calling**: no SIP address kind in `connect()` or `Address`, and `callSip` is never called.
- **`hold()`**: not on `Call`.
- **Transfer and adding participants**: no `call.transfer()`; participants stay on the REST API.
- **Recording control**: no recording method, option or event.
- **Presence**: no presence API in the client or the React helpers.
- **Push to closed tabs**: pushes only deliver calls to open pages; the service worker never wakes a closed tab.
