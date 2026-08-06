# lwpCallList

> NOTE! It is not expected that an instance of this class be created outside of the libwebphone interals. To access this instance use the libwebphone instance method `getCallList()`. If you are unfamiliar with the structure of libwebphone its highly recommended you [start here](/README.md).

Provides the necessary functionality to handle multiple calls at once, if this class is disabled libwebphone will only be able to make a single call at once.

## Methods

#### getCalls()

Provides the invoker with a list of all calls, includes a lwpCall without a
session used to denote a new call.

Returns:

| Type      | Description                   |
| --------- | ----------------------------- |
| [lwpCall] | An array of lwpCall instances |

#### getCall(callId)

Provides the invoker with the current primary call instance, if the primary call
has a session.

Returns:

| Type            | Description                                                           |
| --------------- | --------------------------------------------------------------------- |
| lwpCall or null | A lwpCall instance or null if there is no primary call with a session |

#### addCall(newCall)

| Name    | Type    | Default | Description                                      |
| ------- | ------- | ------- | ------------------------------------------------ |
| newCall | lwpCall |         | The new lwpCall instance to add to the call list |

Adds a call to the call list and makes it the primary if there isn't currently a
primary call with a session. If a [lwpConference](lwpConference.md) is
currently active *and* currently focused (the primary call is itself a
conference leg), the new call is added but never auto-promoted - it will
ring/wait without disturbing the conference until the user switches away
(see switchCall() below, which holds the conference as part of moving focus
off it) or splits it. Once focus has already moved off the conference - most
commonly to the "New Call" placeholder - a call arriving or being placed is
promoted exactly as it would be with no conference in play at all.

#### switchCall(callId)

| Name   | Type   | Default | Description                                   |
| ------ | ------ | ------- | --------------------------------------------- |
| callId | string |         | The lwpCall id to promote to the primary call |

If the callId matches a lwpCall instance that instance will be promoted to
primary and any current primary call (found by isPrimary(), regardless of
whether it has a session - so this correctly recognizes the session-less
"New Call" placeholder as the current selection too) will be demoted.
No-ops if callId already matches the current primary call, rather than
demoting and immediately re-promoting it (which would hold() then unhold()
an established call for no actual change).

If a [lwpConference](lwpConference.md) is already active, a click is first
checked against the conference itself:
- Already a member of the conference -> delegates to switchLeg(callId),
  changing which leg is flagged primary. If the conference is currently
  held (see below), this also resumes it as part of switching back.
- An eligible call not yet a member - held, or the current real primary
  (e.g. a freshly connected call you never explicitly held) -> delegates
  to addToConference(callId), growing the conference by that call (up to
  maxParticipants). If the conference is currently held, growing it also
  resumes every leg, since adding a new party to an otherwise-silent held
  conference wouldn't accomplish anything; otherwise every existing party
  simply stays live, you're just bringing another one in.
- Neither (e.g. the "New Call" placeholder, an unrelated ordinary call, or
  the conference is already at maxParticipants) -> falls through to the
  plain promote/demote below.

Switching away from an active call has always held it; a conference is
just a multi-party call from this perspective, so the plain promote/demote
is conference-aware: demoting a call that is currently a live conference
leg holds the *whole* conference (every leg, via
[lwpConference](lwpConference.md).hold()), not just the one you happened
to be focused on - otherwise the other part(y/ies) would be left live and
audible to each other while you dial something else. This is what lets
you click "New Call" during an active conference and have it (and
attempting to dial) behave exactly as it always has for a plain call.
Switching back to a leg (via switchLeg(), above) resumes the whole
conference again automatically. A call that isn't currently conferencing
keeps its normal per-call behavior (auto-hold if established, resume
paused elements on return) unchanged - this preserves ordinary call
switching for callers with no conferencing intent.

Starting a conference is only ever button-driven
([lwpCallControl](lwpCallControl.md).conference(), which requires exactly
one eligible held call). If there is more than one held call and you want
to start with a specific one, there is currently no click-based way to
pick it - only the single-unambiguous-candidate case is supported for
starting; growing an already-active conference by clicking is fully
supported.

#### removeCall(callId)

| Name   | Type   | Default | Description                                 |
| ------ | ------ | ------- | ------------------------------------------- |
| callId | string |         | The lwpCall id to remote from the call list |

If the callId matches a lwpCall instance that instance is removed from the call
list. Additionally, if the removed call is currently the primary and another
call exists in the list that has a session, the first occurance is promoted to
the new primary.

#### updateRenders()

Re-paint / update all render targets.

## i18n

| Key | Default (en) | Description                                                |
| --- | ------------ | ---------------------------------------------------------- |
| new | New Call     | Used as the label for the new call option in the call list |

## Configuration

| Name          | Type  | Default | Description                       |
| ------------- | ----- | ------- | --------------------------------- |
| renderTargets | array | []      | See [lwpRenderer](lwpRenderer.md) |

## Events

### Emitted

| Event                  | Additional Parameters                                     | Description                                  |
| ---------------------- | --------------------------------------------------------- | -------------------------------------------- |
| callList.created       |                                                           | Emitted when the class is instantiated       |
| calllist.calls.added   | newCall (lwpCall)                                         | Emitted when a new call is added to the list |
| calllist.calls.changed | newCall (lwpCall or null), previousCall (lwpCall or null) | Emitted when the primary call is changed     |
| calllist.calls.removed | terminatedCall (lwpCall)                                  | Emitted when a call is removed from the list |

### Consumed

| Event                    | Reason                                                    |
| ------------------------ | --------------------------------------------------------- |
| call.created             | Invokes addCall()                                         |
| call.terminated          | Invokes removeCall()                                      |
| callList.calls.added     | Invokes updateRenders() to show the new call in the list  |
| callList.calls.changed   | Invokes updateRenders() to show the changed the selection |
| call.promoted            | Invokes updateRenders() to update the shown call status   |
| call.progress            | Invokes updateRenders() to update the shown call status   |
| call.established         | Invokes updateRenders() to update the shown call status   |
| call.hold                | Invokes updateRenders() to update the shown call status   |
| call.unhold              | Invokes updateRenders() to update the shown call status   |
| call.muted               | Invokes updateRenders() to update the shown call status   |
| call.unmuted             | Invokes updateRenders() to update the shown call status   |
| conference.started       | Invokes updateRenders() to update the shown inConference status |
| conference.split         | Invokes updateRenders() to update the shown inConference status |
| conference.ended         | Invokes updateRenders() to update the shown inConference status (every leg is being hung up) |
| conference.leg.switched  | Invokes updateRenders() to update the shown primary/held status |
| conference.leg.added     | Invokes updateRenders() to show the newly-added member's inConference status |
| conference.leg.removed   | Invokes updateRenders() to reflect a member leaving a still-active conference |
| conference.hold          | Invokes updateRenders() to update the shown held status   |
| conference.unhold        | Invokes updateRenders() to update the shown held status   |
| conference.caller.muted  | Invokes updateRenders() to update the shown caller muted status |
| conference.caller.unmuted| Invokes updateRenders() to update the shown caller muted status |
| call.transfer.collecting | Invokes updateRenders() to update the shown call status   |
| call.transfer.complete   | Invokes updateRenders() to update the shown call status   |
| call.ended               | Invokes updateRenders() to update the shown call status   |
| call.failed              | Invokes updateRenders() to update the shown call status   |

## Default Template

### Data

### HTML
