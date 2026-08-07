# lwpCallControl

> NOTE! It is not expected that an instance of this class be created outside of the libwebphone interals. To access this instance use the libwebphone instance method `getCallControl()`. If you are unfamiliar with the structure of libwebphone its highly recommended you [start here](/README.md).

Provides call controls such as redial, answer, cancel, hangup, hold/unhold,
mute/unmute and transfer.

## Methods

#### redial()

Starts a new call to the last dialed number.

#### cancel()

Ends the primary call attempt (used for calls not yet established).

#### hangup()

Ends the primary call (used for established calls).

#### hold()

Places the primary call on hold. While in a conference this holds only that
one leg - every other party stays connected to you, hearing you but not the
held party (who is genuinely on SIP hold and transmits nothing). Use
holdConference() to hold every leg at once.

#### unhold()

Resumes the primary call if on hold.

#### mute()

Mutes audio being transmitted on the primary call.

#### unmute()

Unmutes audio being transmitted on the primary call.

#### muteCaller()

While the primary call is in a conference, mutes that leg entirely (both the
other party's mix and your own local playback of them) via
[lwpConference](lwpConference.md).muteCaller() - not to be confused with
mute(), which mutes your own microphone. No-ops otherwise.

#### unmuteCaller()

Reverses muteCaller() via [lwpConference](lwpConference.md).unmuteCaller().
No-ops if the primary call is not in a conference.

### muteVideo()

Mutes video being transmitted on the primary call.

### unmuteVideo()

Unmutes video being transmitted on the primary call.

#### transfer()

Starts or completes a started transfer on the primary call.

#### transferAttended()

Drives an attended (consultative) transfer on the primary call through up
to three clicks, without ever needing to manually switch to "New Call" in
[lwpCallList](lwpCallList.md):

1. **Nothing pending yet** - holds the primary call and marks it as the
   transfer's origin via [lwpCall](lwpCall.md).attendedTransferStart().
   From this point, digits typed into [lwpDialpad](lwpDialpad.md) are
   collected as a dial target instead of being sent as DTMF into the
   (held) call - the same routing blind transfer's collecting state
   already relies on. The button label switches to "Attended Transfer"
   (shown while idle) -> stays as-is here since nothing's been typed yet.
2. **Pending, no consultation call yet** - places a call to whatever's
   been typed into the dialpad. Because the origin call is already held,
   [lwpCallList](lwpCallList.md).addCall() automatically promotes the new
   call to primary, so it becomes the "current call" for this same button
   without the user switching focus themselves. The button label switches
   to "Call" while waiting for digits. Clicked with nothing typed, this
   instead cancels back to step 1 (unholds the origin call, clears the
   pending flag) - the same empty-target-means-abort convention transfer()
   uses.
3. **Consultation call established** - with exactly one other held,
   non-conference call now found (the origin), pressing it again completes
   the transfer: the origin call is bridged directly to the consultation
   call's far end via a SIP REFER carrying a Replaces header (RFC 3891),
   and both of this end's legs are hung up once the far end confirms. The
   button label switches to "Transfer (complete)" once ready.

If the consultation call placed in step 2 ends before the transfer
completes - cancelled while ringing, rejected, hung up, or failed to
connect - the origin call's pending transfer is abandoned automatically
(unheld, pending flag cleared), rather than being left stuck showing "Call"
indefinitely with no consultation call left to place it against.

#### transferAttendedToBlind()

Downgrades an in-progress attended transfer to a blind one: while the
consultation call placed by transferAttended() is primary - ringing or
already established, either works - completes the transfer immediately via
[lwpCall](lwpCall.md).transferToBlind() instead of waiting for/needing it
to be answered and consulted with first. The origin call REFERs directly to
whoever's being consulted, and the (no longer needed) consultation call is
terminated as part of this. Shown as a "Complete as Blind Transfer" button
alongside the primary call's other controls whenever it's a pending
attended transfer's consultation call; no-ops otherwise.

#### conference()

Merges the primary call with the single eligible held call into a local,
browser-mixed conference (or, if already in a conference, adds that call to
it - up to `maxParticipants`). See [lwpConference](lwpConference.md) for
details. No-ops if [lwpConference](lwpConference.md).canMerge() is false -
including when there's more than one held call to choose from, in which
case use the call list (see [lwpCallList](lwpCallList.md).switchCall())
instead to pick explicitly. The rendered button label switches from
"Conference" to "Add to Conference" once a conference is already active.

#### split()

Undoes an active conference entirely, returning every leg to being an
ordinary held call, as they were before the conference started. Does not
support removing just the primary leg while keeping the rest conferenced.

#### endConference()

Clears down the entire active conference with a single click - hangs up
every leg via [lwpConference](lwpConference.md).endConference(), rather
than split()'s "return everyone to an ordinary held call." No-ops if the
primary call is not in a conference.

#### holdConference()

Places every leg of the active conference on hold via
[lwpConference](lwpConference.md).hold(), without splitting it. No-ops if
the primary call is not in a conference.

#### unholdConference()

Resumes every leg of a held conference via
[lwpConference](lwpConference.md).unhold(). No-ops if the primary call is
not in a conference.

#### answer()

Answers the primary call.

#### updateRenders(call)

| Name | Type    | Description                                                  |
| ---- | ------- | ------------------------------------------------------------ |
| call | lwpCall | The call to consider the primary when rendering the elements |

Re-paint / update all render targets.

## i18n

| Key              | Default (en)        | Description                                             |
| ---------------- | ------------------- | ------------------------------------------------------- |
| answer           | Answer              | Used as the text for the answer action                  |
| redial           | Redial              | Used as the text for the redial action                  |
| cancel           | Cancel              | Used as the text for the cancel action                  |
| hangup           | Hung Up             | Used as the text for the hang up action                 |
| hold             | Hold                | Used as the text for the hold action                    |
| unhold           | Resume              | Used as the text for the unhold action                  |
| mute             | Mute Audio          | Used as the text for the mute action                    |
| unmute           | Unmute Audio        | Used as the text for the unmute action                  |
| mutecaller       | Mute Caller         | Used as the text for the mute-caller action              |
| unmutecaller     | Unmute Caller       | Used as the text for the unmute-caller action            |
| muteVideo        | Mute Video          | Used as the text for the mute video action              |
| unmuteVideo      | Unmute Video        | Used as the text for the unmute video action            |
| transferblind    | Blind Transfer      | Used as the text for the start blind transfer action    |
| transferattended | Attended Transfer   | Used as the text for the start attended transfer action |
| transferattendedcall | Call            | Used as the text for placing an attended transfer's consultation call, once digits have been dialed |
| transferattendedasblind | Complete as Blind Transfer | Used as the text for transferAttendedToBlind()'s button |
| transfercomplete | Transfer (complete) | Used as the text for the complete transfer action       |
| conference       | Conference          | Used as the text for the start-conference action (shown when not yet in a conference) |
| addtoconference  | Add to Conference   | Used as the text for the conference() button once already in a conference |
| split            | Split               | Used as the text for the split-conference action         |
| endconference    | End Conference      | Used as the text for the endConference() action           |
| holdconference   | Hold Conference     | Used as the text for the hold-conference action          |
| unholdconference | Resume Conference   | Used as the text for the resume-conference action        |

## Configuration

| Name          | Type  | Default | Description                       |
| ------------- | ----- | ------- | --------------------------------- |
| renderTargets | array | []      | See [lwpRenderer](lwpRenderer.md) |

## Events

### Emitted

| Event               | Additional Parameters | Description                            |
| ------------------- | --------------------- | -------------------------------------- |
| callControl.created |                       | Emitted when the class is instantiated |

### Consumed

| Event                            | Reason                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------ |
| call.promoted                    | Invokes updateRenders() to show call controls relevant to the new primary call |
| call.primary.progress            | Invokes updateRenders() to show call controls relevant to the new call state   |
| call.primary.established         | Invokes updateRenders() to show call controls relevant to the new call state   |
| call.primary.hold                | Invokes updateRenders() to show call controls relevant to the new call state   |
| call.primary.unhold              | Invokes updateRenders() to show call controls relevant to the new call state   |
| call.primary.muted               | Invokes updateRenders() to show call controls relevant to the new call state   |
| call.primary.unmuted             | Invokes updateRenders() to show call controls relevant to the new call state   |
| call.primary.transfer.collecting | Invokes updateRenders() to show call controls relevant to the new call state   |
| call.primary.transfer.complete   | Invokes updateRenders() to show call controls relevant to the new call state   |
| call.primary.transfer.attended.collecting | Invokes updateRenders() to switch the attended transfer button to its "Call" label |
| call.primary.transfer.attended.cancelled  | Invokes updateRenders() to restore the attended transfer button to its idle label |
| call.primary.terminated          | Invokes updateRenders() to show call controls relevant to the new call state   |
| call.terminated                  | If the terminated call was a pending attended transfer's consultation call (see transferAttended()), cancels that transfer on its origin call |
| conference.started               | Invokes updateRenders() to show split/holdConference, hide transfer, and switch the conference() button label to "Add to Conference" |
| conference.split                 | Invokes updateRenders() to show transfer, hide split/holdConference, and restore the "Conference" button label |
| conference.ended                 | Invokes updateRenders() to show transfer, hide split/endConference/holdConference, and restore the "Conference" button label |
| conference.leg.added             | Invokes updateRenders() to reflect the grown conference (e.g. canConference availability) |
| conference.leg.removed           | Invokes updateRenders() to reflect the shrunk conference                       |
| conference.hold                  | Invokes updateRenders() to show unholdConference in place of holdConference    |
| conference.unhold                | Invokes updateRenders() to show holdConference in place of unholdConference    |
| conference.caller.muted          | Invokes updateRenders() to show unmuteCaller in place of muteCaller            |
| conference.caller.unmuted        | Invokes updateRenders() to show muteCaller in place of unmuteCaller            |
| userAgent.call.failed            | Invokes updateRenders() re-enable any disable HTML elements                    |

## Default Template

### Data

### HTML
