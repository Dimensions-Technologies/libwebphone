# lwpConference

> NOTE! It is not expected that an instance of this class be created outside of the libwebphone interals. To access this instance use the libwebphone instance method `getConference()`. If you are unfamiliar with the structure of libwebphone its highly recommended you [start here](/README.md).

Provides local, ad-hoc audio conferencing for up to `maxParticipants` (see
Configuration below), including the local user. Unlike a server-side
transfer/bridge, the browser itself mixes every leg using WebAudio - similar
to how a desk phone mixes local conference calls in its own DSP. There is no
SDP renegotiation for existing legs: each leg's outbound sender track is a
mixed track built from the local microphone plus every other leg's remote
audio, and growing an already-active conference by one more leg only wires
new WebAudio connections - no `replaceTrack()`/renegotiation on any
already-connected leg.

There is no roster UI - conferencing is driven entirely through
[lwpCallList](lwpCallList.md)'s existing call-list click-to-select
interaction, but only once a conference is already active (ordinary call
switching before that point is left completely alone, see
[lwpCallList](lwpCallList.md).switchCall()):
- Clicking a call already in the conference switches focus to it
  (`switchLeg()`).
- Clicking an eligible call not yet in the conference - held, or the
  current active/primary call - grows the conference by that call
  (`addToConference()`), up to `maxParticipants`.
- A consumer building their own roster UI can read `getLegs()` for the
  current participant list.

Starting a conference (when none is active yet) is button-driven only -
[lwpCallControl](lwpCallControl.md).conference() via `canMerge()`/`merge()`,
which requires exactly one eligible held call. If there's more than one,
there is currently no click-based way to pick which one to start with;
resolve down to one first (e.g. by ending the others), or note this as a
known gap if you need it - it is straightforward to add following the same
pattern as growing, just not implemented, since it wasn't the reported need.

A call arriving while a conference is active is not auto-promoted (see
[lwpCallList](lwpCallList.md).addCall()); it must be added via the call-list
click above, or reached by first calling `split()`, which fully dissolves
the conference (see split() below).

Which leg is flagged primary can change mid-conference via `switchLeg()` -
this only changes which leg [lwpCallControl](lwpCallControl.md)'s per-call
Hold/Unhold and Mute Caller/Unmute Caller controls target, letting any one
leg be individually held or muted.

There are three distinct kinds of "mute" here, easy to conflate:
- `mute()`/`unmute()` on any [lwpCall](lwpCall.md) leg (surfaced as the
  existing Mute Audio button): mutes **your own microphone**,
  conference-wide (one shared mic, so it affects every party regardless of
  which leg is focused) - tracked here via `isMuted()`, not per-call,
  precisely because which call is "primary" can change.
- `hold()`/`unhold()` on a focused leg directly (the existing Hold/Unhold
  button): genuinely per-leg real SIP hold - every other party stays
  connected to you.
- `muteCaller()`/`unmuteCaller()` here: mutes **that specific caller
  entirely** - both every other party's mix and your own local playback of
  them go silent. A real desk phone has one incoming decode path per leg,
  so there's no way to keep privately listening while cutting a participant
  off from everyone else; this mirrors that rather than offering a
  browser-only "listen but don't relay" option. The muted caller can still
  hear everyone else. Tracked per leg (by call identity, stable across
  switchLeg() calls), unlike your own mic mute - and reset automatically
  whenever the conference ends (split, or a leg hanging up), so a caller
  mute can never silently outlive the conference on an otherwise-ordinary
  call.

> NOTE! Because mixing happens locally, remote parties may hear their own
> echo if the local user's audio output is not the same physical device
> providing the browser's acoustic echo cancellation reference (most often an
> issue on laptop speakers without a headset). This is a browser/hardware
> limitation, not something this class can correct, and gets more likely to
> matter (not less) as more legs are added.

## Methods

#### isActive()

Returns:

| Type    | Description                                     |
| ------- | ------------------------------------------------ |
| boolean | True while a local conference is currently merged |

#### getConferenceId()

Returns:

| Type           | Description                                                              |
| -------------- | ---------------------------------------------------------------------------- |
| string or null | A fresh GUID generated when the conference starts, shared by every leg (including ones added later via addToConference()) for its lifetime; null when isActive() is false. Also readable from each member call via [lwpCall](lwpCall.md).getConferenceId() / summary().conferenceId - useful for grouping calls belonging to the same conference in your own UI. |

#### getLegs()

Returns:

| Type      | Description                                                 |
| --------- | -------------------------------------------------------------- |
| [lwpCall] | Every call currently in the conference, including the focused one. A copy - safe to read, not for mutating conference state. |

#### isLeg(call)

| Name | Type    | Default | Description          |
| ---- | ------- | ------- | ----------------------- |
| call | lwpCall |         | The call to check       |

Returns:

| Type    | Description                                              |
| ------- | ------------------------------------------------------------ |
| boolean | True when isActive() and call is currently a conference member |

#### canAdd(call)

| Name | Type    | Default | Description          |
| ---- | ------- | ------- | ----------------------- |
| call | lwpCall |         | The call to check       |

Whether `call` is currently eligible to be merged/added via
addToConference(): established, not already in a (different) conference,
and under `maxParticipants`. The hold requirement differs by situation:
- Growing an already-active conference (isActive() true): `call` must
  either be on hold, or be the current real primary/active call - the one
  call that's live and in focus right now. Only one call can ever be in
  that state at a time, so allowing it can't introduce a second candidate
  into canMerge()'s single-candidate picker-avoidance logic. This is what
  lets a freshly-connected call (never held) be added directly, without
  first putting it on hold.
- Starting a fresh conference (isActive() false): `call` must be on hold,
  and there must be a distinct, valid, established, non-conference primary
  call to merge it into.

Returns:

| Type    | Description                          |
| ------- | ---------------------------------------- |
| boolean | True when addToConference(call.getId()) would succeed |

#### isOnHold()

Returns:

| Type    | Description                                                        |
| ------- | -------------------------------------------------------------------- |
| boolean | True when isActive() and every leg is on hold                      |

#### isMuted()

Returns:

| Type    | Description                                                    |
| ------- | ------------------------------------------------------------------ |
| boolean | True when isActive() and the shared microphone is currently muted |

#### switchLeg(callId)

| Name   | Type   | Default | Description                                              |
| ------ | ------ | ------- | ---------------------------------------------------------- |
| callId | string |         | The id of the (currently non-primary) conference member to make primary |

Swaps which conference member is flagged primary. Switching between two
legs that are both already live never holds/disconnects/reconnects either
one. If the conference is currently held (e.g. because switching away from
it via [lwpCallList](lwpCallList.md).switchCall() held it), switching back
to a leg also resumes the whole conference automatically - the same way
promoting any other held call has always auto-resumed it - rather than
leaving it silently held. No-ops (returns false) if isActive() is false or
callId doesn't match a current member that isn't already primary. Returns
true if the switch happened.

Looks up whoever is *actually* primary right now (rather than trusting its
own last-tracked focus) before demoting them, so this works correctly even
if UI focus had moved away from the conference entirely (e.g. to the
[lwpCallList](lwpCallList.md) "New Call" placeholder) and is now moving
back - that outgoing call gets its normal demotion (not the side-effect-
free one), since it was never a conference member.

#### muteCaller()

Mutes the currently-focused leg entirely - every other party stops hearing
them, and so do you (their remote audio element is muted alongside
disconnecting their contribution to the mix). They can still hear everyone
else. No-ops if isActive() is false or the focused leg is already
caller-muted.

#### unmuteCaller()

Reverses muteCaller() for the currently-focused leg. No-ops if isActive() is
false or the focused leg isn't currently caller-muted.

#### isCallerMuted(call)

| Name | Type    | Default                | Description                                         |
| ---- | ------- | ----------------------- | ------------------------------------------------------ |
| call | lwpCall | the current primary leg | Which leg to check; defaults to whichever is focused |

Returns:

| Type    | Description                                                        |
| ------- | -------------------------------------------------------------------- |
| boolean | True when isActive() and the given (or focused) leg is caller-muted |

#### hold()

Places every leg of the active conference on real SIP hold, without
splitting the conference. No-ops if isActive() is false or isOnHold() is
already true. Unlike split(), the sender tracks, `isInConference()`, and the
mix graph are left exactly as they are - the graph just mixes silence while
no far end is transmitting.

#### unhold()

Resumes every leg of a held conference. No-ops if isActive() is false or
isOnHold() is false. Because hold() never tore anything down, this needs no
rebuild - everyone simply hears the mix again.

#### canMerge()

True when there is exactly one call eligible to merge/add right now - the
zero-ambiguity convenience case merge() acts on. With more than one
eligible call, this is false rather than guessing which one you meant -
with no picker UI, merging with any one alone would silently strand the
others (e.g. after a split leaves former legs as ordinary held calls, and
a new call arrives and connects). If a conference is already active, the
call-list click (see `addToConference()`) can pick a specific one to add
explicitly; if none is active yet, resolve the ambiguity some other way
first (e.g. by ending the calls you don't want) - starting fresh only
supports the single-candidate case.

Returns:

| Type    | Description                                    |
| ------- | ----------------------------------------------- |
| boolean | True when merge() would act                      |

#### merge()

Convenience wrapper for the single-candidate case: merges the primary call
with the one eligible held call (starting a conference), or adds it to an
already-active conference. No-ops if canMerge() is false.

#### addToConference(callId)

| Name   | Type   | Default | Description                                  |
| ------ | ------ | ------- | ------------------------------------------------ |
| callId | string |         | The lwpCall id to merge/add                       |

Unified start-or-grow entry point: merges `callId` with the current primary
if no conference is active yet, or adds it to the already-active
conference otherwise. [lwpCallList](lwpCallList.md)'s call-list click
dispatches to this for any eligible, not-yet-a-member call, but only once
a conference is already active - see the note above on why starting fresh
is button-driven only. No-ops if `canAdd(callId)` is false (not eligible,
already a member, or at `maxParticipants`). Every call in the conference
will report `isInConference() === true`; `summary()` includes
`inConference`.

Starting a conference (no conference active yet) acquires the shared
microphone tap asynchronously; growing an already-active conference is
synchronous - the mic tap is already running and no existing leg needs its
sender track touched (see the architecture note in the source for why).

#### split(reason)

| Name   | Type   | Default | Description                                             |
| ------ | ------ | ------- | --------------------------------------------------------- |
| reason | string | "user"  | Included on the emitted split event, e.g. "leg-ended" when a party hung up rather than the user splitting |

Ends the active conference entirely. Every leg has its original sender
track restored and is placed back on hold - mirroring a desk phone's
Split, this does not leave you actively connected to any party, and does
not support removing just one participant while keeping the rest
conferenced. No-ops if isActive() is false.

canAdd()/canMerge() do not require the primary call to be unheld, so the
same legs can be merged again directly after a split - addToConference()
will unhold the primary itself if needed, the same way its own Unhold
button does.

If a party hangs up while conferencing (rather than the user splitting):
- If more than one leg remains, the conference continues with the
  remaining legs. If the departing leg was *actually, currently* primary
  (real UI focus, not just this class's own last-tracked leg), focus
  reassigns to another remaining leg (`conference.leg.switched` fires). If
  focus had already moved away from the conference entirely (e.g. to the
  "New Call" placeholder mid-dial), it is left alone rather than being
  yanked back because a leg the user wasn't even looking at hung up -
  internal bookkeeping still updates so the right leg is ready when focus
  does return.
- If at most one leg remains, the conference automatically collapses
  (`conference.split`, reason: "leg-ended") and, unlike a manual split, the
  survivor (if any) stays active rather than being held - there is no one
  left to hold instead of.

#### endConference(reason)

| Name   | Type   | Default | Description                                             |
| ------ | ------ | ------- | --------------------------------------------------------- |
| reason | string | "user"  | Included on the emitted `conference.ended` event         |

Terminates every leg of the active conference with a real SIP hangup on
each - the single-click "clear down the whole call" action, as opposed to
split()'s "return everyone to an ordinary held call." No-ops if isActive()
is false.

Conference bookkeeping (active flag, legs, mix graph, `isInConference()`
on every leg, etc.) is torn down first, exactly like split() does and for
the same reason: each leg's own call.ended event needs to find the
conference already inactive, so the automatic leg-ended handling described
above doesn't try to reassign focus and "continue the conference" once per
leg as they hang up one after another - it should just end, once, cleanly.
Unlike split(), no leg has its original sender track restored, since none
of them are surviving as an ordinary call afterward.

## Configuration

| Name            | Type    | Default        | Description                                                                 |
| --------------- | ------- | -------------- | ----------------------------------------------------------------------------- |
| enabled         | boolean | true           | Enables/disables the class instance                                          |
| maxParticipants | number  | 5              | Maximum total participants **including the local user** - e.g. 5 allows the local user plus 4 other legs |
| micRequestId    | string  | "conference"   | The requestId used with [lwpMediaDevices](lwpMediaDevices.md).startStreams() for the dedicated microphone tap |

## Events

### Emitted

| Event                        | Additional Parameters                          | Description                                              |
| ----------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| conference.created            |                                                  | Emitted when the class is instantiated                   |
| conference.started            | primaryCall (lwpCall), heldCall (lwpCall)       | Emitted once addToConference() has started a new conference |
| conference.leg.added          | call (lwpCall)                                  | Emitted once addToConference() has grown an already-active conference |
| conference.leg.removed        | call (lwpCall)                                  | Emitted when a leg is removed and the conference continues with the rest |
| conference.split              | reason (string)                                 | Emitted once split() (or an automatic leg-ended collapse) has completed |
| conference.ended              | reason (string)                                 | Emitted once endConference() has hung up every leg               |
| conference.failed             | reason (string)                                 | Emitted when addToConference() could not complete, e.g. "no-microphone" |
| conference.hold                |                                                  | Emitted once hold() has placed every leg on hold           |
| conference.unhold              |                                                  | Emitted once unhold() has resumed every leg                |
| conference.leg.switched        | newPrimary (lwpCall), previousPrimary (lwpCall) | Emitted once switchLeg() (or a leg-ended reassignment) has changed which leg is primary |
| conference.caller.muted        | call (lwpCall)                                  | Emitted once muteCaller() has silenced a leg from everyone else |
| conference.caller.unmuted      | call (lwpCall)                                  | Emitted once unmuteCaller() has restored a leg to everyone else |

### Consumed

| Event                          | Reason                                                                 |
| ------------------------------- | ------------------------------------------------------------------------ |
| mediaDevices.audio.input.changed | Reconnects the conference's microphone tap to the newly selected device |
| call.conference.mute.changed     | Gates the shared microphone gain node and records isMuted() state, fired by any leg's mute()/unmute() while conferencing |
| call.ended                      | Triggers leg removal (or an automatic split()) if the ended call was a conference member |
| call.failed                     | Triggers leg removal (or an automatic split()) if the failed call was a conference member |
