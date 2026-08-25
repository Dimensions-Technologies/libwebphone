# lwpBLF

> NOTE! It is not expected that an instance of this class be created outside of the libwebphone interals. To access this instance use the libwebphone instance method `getBLF()`. If you are unfamiliar with the structure of libwebphone its highly recommended you [start here](/README.md).

Busy Lamp Field (BLF) monitoring for other extensions - subscribes to each
configured key's SIP dialog or presence state (RFC 6665 SUBSCRIBE/NOTIFY) and
tracks whether it's idle, ringing, in a call, or unknown, so a consumer can
render presence lights / speed-dial keys the way a desk phone does.

Monitored extensions are assumed to be on the same SIP realm as the local
user - each key subscribes to `sip:{id}@{realm}`, where `realm` is taken from
the current [lwpUserAgent](lwpUserAgent.md)'s own authentication config, not
configured per key.

Subscriptions are resilient by design, not fire-and-forget:
- If the server terminates a subscription unexpectedly (expiry, error), it is
  automatically resubscribed after `resubscribe_delay`, doubling on each
  consecutive failure up to `max_resubscribe_delay` so a server that keeps
  rejecting the subscription is polled infrequently rather than hammered.
  Any NOTIFY received resets the backoff, since it proves the subscription is
  actually working again. A subscription that was terminated intentionally
  (`unsubscribe()`/`removeKey()`) is not resubscribed - the class tracks *why*
  a subscription ended to tell the two cases apart.
- A one-shot watchdog re-subscribes if the initial NOTIFY never arrives within
  `notify_timeout` of subscribing, defending against a SUBSCRIBE that's
  silently accepted but never confirmed. It does not recur once that first
  NOTIFY lands - an idle extension going quiet afterwards is normal, not a
  dead subscription.
- Subscriptions follow SIP registration automatically: all keys subscribe on
  `userAgent.registration.registered` and unsubscribe on
  `userAgent.registration.unregistered`/`userAgent.disconnected`/
  `userAgent.stopped` - there is no need to manually resubscribe after a
  reconnect.

Two event package formats are supported per key via `eventType`:
- `"dialog"` (default) - `application/dialog-info+xml` (RFC 4235). Richer:
  distinguishes ringing from in-call, and captures direction plus local/remote
  identity for the active dialog. If a monitored extension has more than one
  simultaneous dialog, the single most "active" one wins for status purposes,
  in priority order in-call > ringing > unknown > idle.
- `"presence"` - simple `open`/`closed` presence, mapped to idle/in-call only
  (no ringing distinction, no call identity).

## Methods

#### getKeys()

Returns:

| Type    | Description                                       |
| ------- | -------------------------------------------------- |
| [object] | Every monitored key, in the shape described under [Default Template](#default-template) below, plus internal bookkeeping (`subscriber`, `timeoutHandle`) not meant for consumer use |

#### getKey(id)

| Name | Type   | Default | Description                          |
| ---- | ------ | ------- | --------------------------------------- |
| id   | string |         | The monitored extension/user id to find |

Returns:

| Type          | Description                            |
| ------------- | ---------------------------------------- |
| object or undefined | The matching key, or undefined if not monitored |

#### addKey(id, name, eventType, acceptType)

| Name      | Type   | Default                          | Description                                   |
| --------- | ------ | --------------------------------- | ---------------------------------------------- |
| id        | string |                                   | The extension/user id to monitor (also used as the SUBSCRIBE target's user part) |
| name      | string | null (falls back to id)          | Display name for rendering                    |
| eventType | string | "dialog"                          | `"dialog"` or `"presence"` - which event package to subscribe to |
| acceptType | string | "application/dialog-info+xml"    | The Accept header / expected NOTIFY Content-Type for the subscription |

Adds a new key to monitor. Idempotent - if `id` is already monitored, returns
the existing key unchanged rather than creating a duplicate. If the user
agent is currently registered, subscribes immediately; otherwise the key
subscribes automatically the next time registration succeeds (see
`subscribeAll()`).

Returns:

| Type   | Description        |
| ------ | -------------------- |
| object | The added (or pre-existing) key |

#### removeKey(id)

| Name | Type   | Default | Description                  |
| ---- | ------ | ------- | ------------------------------- |
| id   | string |         | The monitored extension/user id |

Unsubscribes and stops monitoring `id`. No-ops if `id` isn't currently
monitored.

#### subscribe(id) / unsubscribe(id)

| Name | Type   | Default | Description                  |
| ---- | ------ | ------- | ------------------------------- |
| id   | string |         | The monitored extension/user id |

Manually (re)subscribe or unsubscribe a specific already-added key, without
removing it from the monitored list. No-ops if `id` isn't currently
monitored.

#### subscribeAll() / unsubscribeAll()

Subscribes or unsubscribes every currently monitored key. Called
automatically on SIP registration/unregistration/disconnect (see above) -
rarely needed directly.

#### updateRenders()

Re-paint / update all render targets.

## i18n

| Key     | Default (en) | Description                                    |
| ------- | ------------- | ------------------------------------------------- |
| idle    | Idle          | Status text for an idle monitored extension        |
| ringing | Ringing       | Status text for a ringing monitored extension       |
| incall  | In Call       | Status text for a monitored extension in a call     |
| unknown | Unknown       | Status text when status can't be determined         |

## Configuration

| Name              | Type    | Default                          | Description                                                                 |
| ------------------ | ------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| enabled            | boolean | true                               | Enables/disables the class instance                                          |
| keys               | array   | []                                 | Initial keys to monitor - each `{ id, name, eventType, acceptType }`, matching `addKey()`'s parameters. Subscribed automatically on registration, same as a key added later via `addKey()` |
| subscribe_expires  | number  | 1800                               | SIP SUBSCRIBE expiry, in seconds                                              |
| resubscribe_delay  | number  | 1000                               | Initial delay (ms) before automatically resubscribing after an unexpected server-side termination; doubles on each consecutive failure up to max_resubscribe_delay |
| max_resubscribe_delay | number | 60000                            | Ceiling (ms) for the resubscribe backoff delay                               |
| notify_timeout     | number  | 60000                              | One-shot confirmation deadline (ms) - if the initial NOTIFY never arrives after subscribing, treats the subscription as dead and resubscribes. Does not fire again once a NOTIFY has been received; ongoing health is covered by JsSIP's own refresh-before-expiry SUBSCRIBEs |
| renderTargets      | array   | []                                 | See [lwpRenderer](lwpRenderer.md)                                             |

## Events

### Emitted

| Event                     | Additional Parameters | Description                                                        |
| --------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| blf.created                |                          | Emitted when the class is instantiated                               |
| blf.key.added               | key (object)             | Emitted once addKey() has added a new key                            |
| blf.key.removed             | key (object)             | Emitted once removeKey() has removed a key                           |
| blf.key.subscribed          | key (object)             | Emitted once a SUBSCRIBE has been sent for a key                     |
| blf.key.unsubscribed        | key (object)             | Emitted once a key's subscription has ended (intentionally or not)   |
| blf.key.status.updated      | key (object)             | Emitted whenever a key's status changes                              |
| blf.key.status.idle         | key (object)             | Emitted alongside key.status.updated specifically when the new status is "idle" |
| blf.key.status.ringing      | key (object)             | Emitted alongside key.status.updated specifically when the new status is "ringing" |
| blf.key.status.incall       | key (object)             | Emitted alongside key.status.updated specifically when the new status is "incall" |
| blf.key.status.unknown      | key (object)             | Emitted alongside key.status.updated specifically when the new status is "unknown" |
| blf.key.callinfo.updated    | key (object)             | Emitted whenever a key's call identity info changes, even if status did not (e.g. switching between two simultaneous dialogs on the same monitored extension) |

### Consumed

| Event                              | Reason                                    |
| ------------------------------------- | -------------------------------------------- |
| userAgent.registration.registered      | Invokes subscribeAll()                     |
| userAgent.registration.unregistered    | Invokes unsubscribeAll()                   |
| userAgent.disconnected                 | Invokes unsubscribeAll()                   |
| userAgent.stopped                      | Invokes unsubscribeAll()                   |

## Default Template

### Data

Each entry in `data.keys` (the array driving the default template):

| Field         | Type              | Description                                                |
| -------------- | ------------------ | -------------------------------------------------------------- |
| id             | string             | The monitored extension/user id                             |
| name           | string             | Display name                                                |
| status         | string             | "idle", "ringing", "incall", or "unknown"                    |
| isIdle         | boolean            | True when status is "idle"                                   |
| isRinging      | boolean            | True when status is "ringing"                                |
| isInCall       | boolean            | True when status is "incall"                                 |
| isUnknown      | boolean            | True when status is "unknown"                                |
| callInfo       | object or null     | Present only for `eventType: "dialog"` keys with an active dialog - `{ direction, dialogState, localDisplay, localIdentity, remoteDisplay, remoteIdentity }` |

### HTML

The default template renders one block per monitored key:

```html
<div class="lwp-blf-key lwp-blf-{{status}}">
  <span class="lwp-blf-name">{{name}}</span>
  <span class="lwp-blf-status">...</span>
  <span class="lwp-blf-caller">...</span> <!-- only present with callInfo -->
</div>
```

`lwp-blf-{{status}}` gives each key a status-specific class (`lwp-blf-idle`,
`lwp-blf-ringing`, `lwp-blf-incall`, `lwp-blf-unknown`) for styling - the
default template ships unstyled (no CSS), so a consumer is expected to style
these classes themselves, or provide a fully custom template via
`renderTargets`.
