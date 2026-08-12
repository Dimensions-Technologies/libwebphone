# lwpCall

> NOTE! It is not expected that an instance of this class be created outside of the libwebphone interals. To access this instance use the libwebphone instance use the methods provided by lwpCallList or capture it via events. If you are unfamiliar with the structure of libwebphone its highly recommended you [start here](/README.md).

The libwebphone call class represents an instance of a call and provides all
in-call functionality. It is also repsonsible for managing the audio / video
sent as well as recieved.

Since there can be multiple instances of lwpCall only one of those instance can
be the primary at a time. The primary lwpCall is the instance that is producing
and sending media as well as the target for in-call controls.

> NOTE! If lwpCallList is enabled there will be a 'null' lwpCall instance created to represent new calls. This instance will not have a session, which can be checked via `hasSession()`.

## Methods

#### getId()

Provides a unique identifier for the instance of the lwpCall. This is either the
MediaStream ID from lwpMediaDevices or a locally generated UUID.

> NOTE! this is not related to any values from jssip or the SIP protocol.

Returns:

| Type   | Description                          |
| ------ | ------------------------------------ |
| string | A unique identifier for the instance |

#### hasSession()

Informs the invoker if a SIP session is currently active for this instance.

> The session is created with the first
> [SIP INVITE](https://tools.ietf.org/html/rfc3261) and removed with the end of
> the SIP dialog.

Returns:

| Type    | Description                                              |
| ------- | -------------------------------------------------------- |
| boolean | True when the instance is associated with an active call |

#### hasPeerConnection()

Informs the invoker if a WebRTC media (audio/video) peer connect is currently
active for this instance.

Returns:

| Type    | Description                                         |
| ------- | --------------------------------------------------- |
| boolean | True when the instance is has an active WebRTC peer |

#### getPeerConnection()

Returns:

| Type                                                                                                      | Description                                                       |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [RTCPeerConnection](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection) | The connection between the local device and a remote peer or null |

#### isPrimary()

Returns:

| Type    | Description                                                    |
| ------- | -------------------------------------------------------------- |
| boolean | True when the instance represents the currently connected call |

#### isInConference()

Returns:

| Type    | Description                                                                             |
| ------- | ----------------------------------------------------------------------------------------- |
| boolean | True when this call is currently a member of a local [lwpConference](lwpConference.md) |

#### getConferenceId()

Returns:

| Type           | Description                                                              |
| -------------- | ---------------------------------------------------------------------------- |
| string or null | The active conference's GUID, shared by every other call currently in the same conference, or null when isInConference() is false. See [lwpConference](lwpConference.md).getConferenceId(). Useful for grouping calls belonging to the same conference in your own UI without needing to ask lwpConference which calls are its legs. |

#### getRemoteAudio()

Returns:

| Type                                                                          | Description                                                |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [HTML audio](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/audio) | A HTML audio element connected to the remote audio stream. |

#### getRemoteVideo()

Returns:

| Type                                                                          | Description                                                |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [HTML video](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video) | A HTML video element connected to the remote audio stream. |

#### getLocalAudio()

Returns:

| Type                                                                          | Description                                                            |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [HTML audio](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/audio) | A HTML audio element connected to the local audio stream (microphone). |

#### getLocalVideo()

Returns:

| Type                                                                          | Description                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [HTML video](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video) | A HTML video element connected to the local audio stream (camera). |

#### isInProgress()

Returns:

| Type    | Description                                                                                  |
| ------- | -------------------------------------------------------------------------------------------- |
| boolean | True when the instance represents call in the progress state (not established and not ended) |

#### isEstablished()

Returns:

| Type    | Description                                                      |
| ------- | ---------------------------------------------------------------- |
| boolean | True when the instance represents an established (answered) call |

#### isEnded()

Returns:

| Type    | Description                                  |
| ------- | -------------------------------------------- |
| boolean | True when the instance represents ended call |

#### isRinging()

Returns:

| Type    | Description                                                                      |
| ------- | -------------------------------------------------------------------------------- |
| boolean | True when the instance represents a terminating call that is not yet established |

#### isInTransfer()

Returns:

| Type    | Description                                                            |
| ------- | ---------------------------------------------------------------------- |
| boolean | True when the instance represents a call in the process of transfering |

#### isAttendedTransferPending()

Returns:

| Type    | Description                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------- |
| boolean | True from attendedTransferStart() until either attendedTransfer() completes it or attendedTransferCancel() aborts it |

Unlike isInTransfer(), this is deliberately **not** cleared by losing
primary/focus - the expected next step (placing the consultation call,
which then takes over primary) does exactly that, and the flag needs to
survive it. See [lwpCallControl](lwpCallControl.md).transferAttended() for
the higher-level action that drives this end to end.

#### getDirection()

Returns:

| Type   | Description                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------- |
| string | Returns "terminating" when the instance was started by the peer (server), and "originating" when started locally (user) |

#### getAlertInfo()

The raw `Alert-Info` header value(s) from the INVITE, in the order they appeared. A platform uses this header to mark what kind of call it is - `<alert-internal>` for an internal call, for example - and lwpAudioContext matches these values against its configured ringtone mappings to decide how the call rings (see [Alert-Info ringtones](/docs/lwpAudioContext.md#alert-info-ringtones)).

Returns:

| Type  | Description                                                                                                                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| array | The header values exactly as they arrived, brackets and all: `["<alert-internal>"]`. Empty for an outbound call, or an inbound one without the header |

> JsSIP has no grammar rule for `Alert-Info`, so it is kept unparsed rather than being turned into a structured object - what comes back is what was on the wire.

#### localIdentity(details)

| Name    | Type    | Default | Description                                                                                      |
| ------- | ------- | ------- | ------------------------------------------------------------------------------------------------ |
| details | boolean | false   | If true, returns an object representing the local identity SIP header otherwise returns a string |

This returns either the string or an object indicating the local identity. The
object corresponds with the INVITE From header value when the direction is
originating, and with the To header value when the direction is terminating.

The string representation is the username of the URI when the display name and
username are identical. If they are not the string is the display name followed
by the username in parentheses.

Returns:

| Type                                                                                        | Description                                     |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| string or [JsSIP.NameAddrHeader](https://jssip.net/documentation/3.4.x/api/nameAddrHeader/) | Representation of the instance's local identity |

#### remoteIdentity(details)

| Name    | Type    | Default | Description                                                                                       |
| ------- | ------- | ------- | ------------------------------------------------------------------------------------------------- |
| details | boolean | false   | If true, returns an object representing the remote identity SIP header otherwise returns a string |

This returns either the string or an object indicating the remote identity. The
object corresponds with the INVITE To header value when the direction is
originating, and with the From header value when the direction is terminating.

The string representation is the username of the URI when the display name and
username are identical. If they are not the string is the display name followed
by the username in parentheses.

Returns:

| Type                                                                                        | Description                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| string or [JsSIP.NameAddrHeader](https://jssip.net/documentation/3.4.x/api/nameAddrHeader/) | Representation of the instance's remote identity |

#### remoteURIUser()

This returns the user representation of the instance's remote URI 

Returns:

| Type                                                                                        | Description                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
|                   string                       | User representation of the instance's remote URI |

#### terminate()

If the instance has a session, invokes the jssip terminate method described by
jssip as:

> Terminate the current session regardless its direction or state. Depending on
> the state of the session, this function may send a CANCEL request, a non-2xx
> final response, a BYE request, or even no request. For incoming sessions, if
> the user has not answered the incoming INVITE, this function sends the non-2xx
> final response with the optionally specified status code and reason phrase.
> 480 Unavailvable is responded by default. For outgoing sessions, if the
> original INVITE has not been already sent, it will never be sent. If the
> original INVITE has not been answered with a final response, the behavior
> depends on whether provisional response has been received. If provisional
> response has been received, a CANCEL request will be sent. If no provisional
> response has been received, the function will not send a CANCEL as per
> RFC 3261. If then a provisional response is received, the CANCEL request will
> be automatically sent. For both incoming and outgoing, if the INVITE session
> has been answered with final response, a BYE request will be sent.

Throws:

If the calls state is not appropriate for this method, it will throw an
[INVALID_STATE_ERROR](https://jssip.net/documentation/3.4.x/api/dom_exceptions/)
error.

#### cancel()

Identical funcationality to terminate(). However, developers are encuraged to
use cancel instead of terminate when appropriate as defined in the SIP standard
for possible future expansion.

#### hold()

If the instance has a session, invokes the jssip hold method described by jssip
as:

> Puts the call on hold by sending a Re-INVITE or UPDATE SIP request.

#### isOnHold(details)

| Name    | Type    | Default | Description                                                                         |
| ------- | ------- | ------- | ----------------------------------------------------------------------------------- |
| details | boolean | false   | If true, returns an object representing which "side" is on hold otherwise a boolean |

Returns:

The detail return is an Object with the properties local and remote and a
Boolean value asociated with each one. It represents whether the local and/or
remote peer are on hold.

```json
{
  "local": false,
  "remote": false
}
```

| Type             | Description                                  |
| ---------------- | -------------------------------------------- |
| string or Object | Representation of the instance's hold status |

#### unhold()

If the instance has a session, invokes the jssip unhold method described by
jssip as:

> Resumes the call from hold by sending a Re-INVITE or UPDATE SIP request.

#### mute(options)

| Name          | Type    | Default | Description                                    |
| ------------- | ------- | ------- | ---------------------------------------------- |
| options.audio | boolean | true    | If true, mute the audio being sent to the peer |
| options.video | boolean | true    | If true, mute the video being sent to the peer |

When no argument is provided both audio and video are muted.

#### unmute(options)

| Name          | Type    | Default | Description                                      |
| ------------- | ------- | ------- | ------------------------------------------------ |
| options.audio | boolean | true    | If true, unmute the audio being sent to the peer |
| options.video | boolean | true    | If true, unmute the video being sent to the peer |

When no argument is provided both audio and video are unmuted.

#### isMuted(details)

| Name    | Type    | Default | Description                                                                     |
| ------- | ------- | ------- | ------------------------------------------------------------------------------- |
| details | boolean | false   | If true, returns an object representing what media is muted otherwise a boolean |

Returns:

The detail return is an Object with the properties audio and video and a Boolean
value asociated with each one. It represents whether the local audio and/or
video is muted.

```json
{
  "audio": false,
  "video": false
}
```

The boolen return is true if either audio or video is muted.

| Type             | Description                                  |
| ---------------- | -------------------------------------------- |
| string or Object | Representation of the instance's mute status |

#### transfer(target, autoHold)

| Name     | Type    | Default | Description                                                        |
| -------- | ------- | ------- | ------------------------------------------------------------------ |
| target   | string  | null    | The target to transfer to                                          |
| autoHold | boolean | true    | When starting the transfer process, should the call be put on hold |

When the transfer method is invoked without a target the lwpCall instance will
start collecting any digits from the lwpDialpad. If autoHold is true it will
also put the call on hold. The next time that the funtion is envoked if a target
was collected from the lwpDialpad instance it will attempt to transfer the call
to that target. If no target was collected from lwpDialpad or the transfer
failed and autoHold is true, the call will be unheld.

When the transfer method is invoked with a target, the transfer is attempted
immediately.

Sending the SIP REFER and getting a successful response to it (`transfer.started`)
only means the request was accepted for processing - it says nothing about
whether the transfer target actually answered. That's only known once the far
end sends a NOTIFY as the referred-to call progresses:
- If the NOTIFY reports the referred-to call was answered, this call's job is
  done - the same way a desk phone releases itself once a blind transfer
  connects - so it hangs up automatically and emits `transfer.confirmed`.
- If the NOTIFY reports failure, or the REFER request itself is rejected, this
  behaves like any other failed transfer attempt: `transfer.failed` is
  emitted, and if autoHold was used to hold the call it is unheld again.

> NOTE! If an external application places a call on hold, then attempts a
> transfer by providing the target argument but leaves the autoHold enabled, if
> the transfer fails the call will be unheld.

Throws:

If the target is not appropriate for the transfer, it will throw an
[INVALID_TARGET_ERROR](https://jssip.net/documentation/3.4.x/api/dom_exceptions/)
error.

#### attendedTransferStart(autoHold)

| Name     | Type    | Default | Description                                          |
| -------- | ------- | ------- | ----------------------------------------------------- |
| autoHold | boolean | true    | Whether to hold the call as part of marking it pending |

Marks this call as the origin of an attended transfer
(isAttendedTransferPending() becomes true) and, if autoHold, holds it. From
this point [lwpDialpad](lwpDialpad.md).dial() routes typed digits into its
own target buffer instead of sending them as DTMF into this (held) call,
the same way it already does for isInTransfer(). No-ops (returns false) if
there's no session, the call is already in a conference, or a transfer is
already pending.

#### attendedTransferCancel(autoUnhold)

| Name       | Type    | Default | Description                                     |
| ---------- | ------- | ------- | ------------------------------------------------- |
| autoUnhold | boolean | true    | Whether to unhold the call as part of cancelling |

Aborts an attendedTransferStart() that's still waiting on a consultation
call, clearing isAttendedTransferPending() and, if autoUnhold, unholding
the call again. No-ops (returns false) if no transfer is pending.

#### attendedTransfer(targetCall)

| Name       | Type    | Default | Description                                                     |
| ---------- | ------- | ------- | ----------------------------------------------------------------- |
| targetCall | lwpCall | -       | The established call whose far end this call should be bridged to |

Completes an attended (consultative) transfer: bridges this call directly to
targetCall's far end and drops this end entirely, rather than plain
transfer()'s "send the far end wherever this dialpad target says." This is
typically called on the original, held party (this) with targetCall being
the established consultation call reached separately (e.g. via
lwpUserAgent.call() while this call is held) - see
[lwpCallControl](lwpCallControl.md).transferAttended() for the higher-level
action that finds that pairing automatically. Both calls must already have a
session; no-ops otherwise.

Unlike transfer(), which sends a plain REFER to the far end with the raw
dialed target, this sends a REFER on this call's dialog carrying a Replaces
header (RFC 3891) built from targetCall's dialog - so the referred-to party
reconnects directly into targetCall's existing dialog with its far end
instead of placing a fresh call. As with transfer(), a successful REFER
response (`transfer.started`) only means the request was accepted for
processing; the actual outcome is only known once the far end's NOTIFY
arrives:

- If the NOTIFY reports success, both this call and targetCall are hung up
  automatically (this end is no longer needed once the other two parties are
  bridged directly) and `transfer.confirmed` is emitted.
- If the NOTIFY reports failure, or the REFER request itself is rejected,
  `transfer.failed` is emitted and neither call is touched further - both
  remain exactly as they were (this call held, targetCall established), so
  the transfer can be retried.

Throws:

If the target derived from targetCall's remote identity is not appropriate
for the transfer, it will throw an
[INVALID_TARGET_ERROR](https://jssip.net/documentation/3.4.x/api/dom_exceptions/)
error.

#### transferToBlind(consultCall)

| Name       | Type    | Default | Description                                                        |
| ---------- | ------- | ------- | ------------------------------------------------------------------- |
| consultCall | lwpCall | -      | The in-progress (ringing or established) consultation call to downgrade |

Downgrades a still-in-progress attended transfer to a blind one: calls
transfer(target) on this call using consultCall's own remote identity as
the target, the same plain REFER (no Replaces) transfer() always sends -
unlike attendedTransfer(), consultCall does **not** need to have been
answered first, since a plain REFER's Refer-To only needs a URI, not a
confirmed dialog to reference. Useful when whoever's being consulted
doesn't actually need to be spoken to. consultCall is no longer needed
either way and is terminated as part of this (via terminate(), so it's
handled correctly whether it's still ringing or has since been answered).
See [lwpCallControl](lwpCallControl.md).transferAttendedToBlind() for the
higher-level action that finds this pairing automatically. Both calls must
already have a session; no-ops otherwise.

#### answer()

If the instance has a session, invokes the jssip answer method described by
jssip as:

> Answer the incoming session. This method is available for incoming sessions
> only.

If there is an available instance of lwpMediaDevices the local media streams for
the call will come from that class, otherwise the streams are created by jssip
per call.

Throws:

If the calls state is not appropriate for this method, it will throw an
[INVALID_STATE_ERROR](https://jssip.net/documentation/3.4.x/api/dom_exceptions/)
error.

#### reject()

Identical funcationality to terminate(). However, developers are encuraged to
use reject instead of terminate when appropriate as defined in the SIP standard
for possible future expansion.

#### renegotiate()

If the instance has a session and the call is not currently on hold, invokes the
jssip renegotiate method described by jssip as:

> Forces a SDP renegotiation. Useful after modifying the local stream attached
> to the underlying RTCPeerConnection (via the connection attribute).

If the call is on hold it will not invoke the jssip renegotiate because the
resume from hold will effectively renegotion when the Re-INVITE is sent to
restore the media streams.

#### sendDTMF(signal, options)

| Name                  | Type              | Default | Description                                                                                  |
| --------------------  | ----------------- | ------- | -------------------------------------------------------------------------------------------- |
| signal                | string or integer | null    | One or multiple valid DTMF symbols                                                           |
| options.duration      | string or integer | 100     | Positive decimal Number indicating the duration of the tone expressed in milliseconds        |
| options.interToneGap  | string or integer | 500     | Positive decimal Number indicating the interval between two tones expressed in milliseconds  |
| options.extraHeaders  | array             | null    | Optional Array of Strings with extra SIP headers for each INFO request                       |
| options.transportType | string or integer | 'INFO'  | Optional String INFO’ or ‘RFC2833’                                                           |


If the instance has a session, invokes the jssip sendDTMF method described by
jssip as:

> Send one or multiple DTMF tones making use of SIP INFO method.

If the calls state is not appropriate for this method, it will throw an
[INVALID_STATE_ERROR](https://jssip.net/documentation/3.4.x/api/dom_exceptions/)
error.

#### changeVolume(volume, kind)

| Name   | Type    | Default | Description                                                                                                                                     |
| ------ | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| volume | integer | null    | If null, match the lwpAudioContext remote channel volume, otherwise set to a value between 0 and 1                                              |
| kind   | string  | null    | If null, change the volume for all remote HTML media elements. Otherwise, specifies the kind of media to change the volume for (audio or video) |

#### replaceSenderTrack(newTrack)

| Name     | Type                                                                                  | Default | Description                                                                          |
| -------- | ------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| newTrack | [MediaStreamTrack](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack) |         | A MediaStream track to add to the call, replacing that media type if already present |

Based on the track.kind, replace or add the new track to the peerConnection.
This will also trigger renegotiation.

#### removeSenderTrack(kind)

| Name | Type   | Default | Description                                  |
| ---- | ------ | ------- | -------------------------------------------- |
| kind | string |         | The kind of media to remove (audio or video) |

If the call currently has a local media stream for the specified kind, remove it
from the call and trigger a renegotiation.

#### summary()

Returns an object with: callId, hasSession, progress, established, ended,
held, isAudioMuted, isVideoMuted, primary, inConference, conferenceId,
inTransfer, direction, terminating, originating, alertInfo, localIdentity,
remoteIdentity, remoteIdentityOverride - see the corresponding
getter/method above for each field's meaning.

## Configuration

| Name                  | Type     | Default | Description                                                                                                                                       |
| --------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| useAudioContext       | boolean  | false   | Should the lwpAudioContext be used as the destination for the remote audio. See note.                                                             |
| globalKeyShortcuts    | boolean  | true    | Should the event listeners in the 'keys' property be added to the document                                                                        |
| keys.spacebar.enabled | boolean  | true    | If true, and globalKeyShortcuts is also true, preform keys.spacebar.action if the spacebar is pressed when the body of the document has the focus |
| keys.spacebar.action  | function |         | By default this callback will toggle mute (both video and audio) for the duration the spacebar is held.                                           |

> If useAudioContext is true the lwpCall class will not unmute the elements used
> to play the remote audio, instead it is expected that the lwpAudioContext
> channels.remote.connectToMaster is set to true. This will direct the audio
> from the primary call to the AudioContext and out the master channel. However,
> this can cause delay and other audio artifacts in some browsers. As such, its
> more complicated but better to mute/unmute the remote audio elements in each
> active call as required (preformed when useAudioContext is false or default).
> To mimic the functionality of the lwpAudioContext remote channel lwpCall will
> update the sinkId (destination device) as well as the volume when
> lwpAudioContext remote channel is changed.

#### Codec Preferences

Unlike the rest of this page, this is read from the **top-level** libwebphone
config (`config.codecPreferences`), not `config.call` - it isn't per-call
config a consumer sets on individual calls, it applies to every call this
class creates.

| Name              | Type   | Default        | Description                                                                 |
| ------------------ | ------ | --------------- | ----------------------------------------------------------------------------- |
| codecPreferences.audio | array | [] (no filtering) | Ordered list of preferred audio codecs, e.g. `["OPUS"]` |
| codecPreferences.video | array | [] (no filtering) | Ordered list of preferred video codecs |

When non-empty, outbound SDP is munged (on generation, before it's sent) to
keep only the payload types matching an entry in the list - matched either by
codec name alone (`"OPUS"`) or a full `name/clockrate[/channels]` key
(`"opus/48000/2"`), case-insensitively. Ancillary payload types
(`telephone-event`, `cn`, `rtx`, `red`, `ulpfec` - DTMF and comfort-noise/
redundancy related) are always kept regardless of preference, since removing
them would break DTMF or resilience features unrelated to codec choice. If
none of the preferred codecs are present in the original SDP, munging is
skipped entirely and the original SDP is sent unmodified - a misconfigured
preference list degrades to "no filtering" rather than breaking the call.

Per-call overrides are also supported: if the [lwpUserAgent](lwpUserAgent.md)
session used to construct a call carries `session.data.codecPreferences`, it
takes priority over the top-level config for that call only.

> The spacebar shortcut works like a
> [push-to-talk](https://en.wikipedia.org/wiki/Push-to-talk) if the call is
> already muted. This can be useful if, for instance, you are in a conference
> and need to quickly say something but you are currently muted. The same
> shortcut works similarly if the call is already unmuted, holding the spacebar
> will temporarily mute the call. This could be useful, for instance, if you
> need to sneeze and don't want to startle the caller.

## Events

| Event                              | Additional Parameters                                                                                                      | Description                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| call.created                       |                                                                                                                            | Emitted when the class is instantiated                                                                                                                                                                                                                                                                      |
| call.transfer.collecting           |                                                                                                                            | Emitted when the call begins collecting the transfer target from lwpDialpad                                                                                                                                                                                                                                 |
| call.transfer.attended.collecting  |                                                                                                                            | Emitted by attendedTransferStart() when the call is marked as an attended transfer's origin                                                                                                                                                                                                                 |
| call.transfer.attended.cancelled   |                                                                                                                            | Emitted by attendedTransferCancel() when a pending attended transfer is aborted before a consultation call existed                                                                                                                                                                                          |
| call.transfer.started              | target (string or lwpCall)                                                                                                | Emitted after succesfully sending a SIP REFER (to transfer the call to the target). target is the dialed string for transfer(), or the lwpCall being bridged to for attendedTransfer()                                                                                                                     |
| call.transfer.failed               | target (string or lwpCall)                                                                                                | Emitted when no target was collected, the REFER request itself was rejected, or the far end's NOTIFY reports the referred-to call failed                                                                                                                                                                    |
| call.transfer.complete             | target (string or lwpCall)                                                                                                | Emitted once the transfer() call itself has finished running (i.e. the REFER was sent, or sending it failed) - not a statement about whether the transfer ultimately succeeds, see transfer.confirmed for that. Not emitted by attendedTransfer()                                                          |
| call.transfer.confirmed            | target (string or lwpCall)                                                                                                | Emitted when the far end's NOTIFY confirms the referred-to call was answered; for transfer() this call then hangs up automatically, for attendedTransfer() both this call and targetCall hang up automatically, same as a desk phone releasing itself once a transfer connects                            |
| call.answered                      |                                                                                                                            | Emitted when the call has been successfully answered                                                                                                                                                                                                                                                        |
| call.rejected                      |                                                                                                                            | Emitted when a terminating call has been successfully rejected (requires developers to use the lwpCall.reject() function)                                                                                                                                                                                   |
| call.renegotiated                  |                                                                                                                            | Emitted when the call has been successully renegotiated                                                                                                                                                                                                                                                     |
| call.send.dtmf                     | signal (string or integer)                                                                                                 | Emitted when the DTMF has been successfully sent, signal represents what was transmitted                                                                                                                                                                                                                    |
| call.local.audio.element           | element ([HTML audio element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/audio))                            | Emitted when the HTML audio element is created                                                                                                                                                                                                                                                              |
| call.local.video.element           | element ([HTML video element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video))                            | Emitted when the HTML video element is created                                                                                                                                                                                                                                                              |
| call.remote.audio.element          | element ([HTML audio element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/audio))                            | Emitted when the HTML audio element is created                                                                                                                                                                                                                                                              |
| call.remote.video.element          | element ([HTML video element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video))                            | Emitted when the HTML video element is created                                                                                                                                                                                                                                                              |
| call.ringing.started               |                                                                                                                            | Emitted when the call state requires ringing                                                                                                                                                                                                                                                                |
| call.ringing.stopped               |                                                                                                                            | Emitted when the call state nolonger requires ringing                                                                                                                                                                                                                                                       |
| call.peerconnection                | peerConnection ([RTCPeerConnection](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection)) | Emitted when a RTC Peer Connection is created                                                                                                                                                                                                                                                               |
| call.peerconnection.add.track      | event ([track event](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/track_event))                      | Emitted when a track is added to the RTC Peer Connection                                                                                                                                                                                                                                                    |
| call.peerconnection.remove.track   | event ([removestream event](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/removestream_event))        | Emitted when a track is removed from the RTC Peer Connection                                                                                                                                                                                                                                                |
| call.progress                      | event ([jssip progress](https://jssip.net/documentation/3.4.x/api/session/#event_progress))                                | As defined by jsssip "Fired when receiving or generating a 1XX SIP class response (>100) to the INVITE request. The event is fired before the SDP processing, if present, giving the chance to fine tune it if required or even drop it by removing the body of the response parameter in the data object." |
| call.established                   | event ([jssip confirmed](https://jssip.net/documentation/3.4.x/api/session/#event_confirmed))                              | As defined by jssip "Fired when the call is confirmed (ACK received/sent. "                                                                                                                                                                                                                                 |
| call.receive.dtmf                  | event ([jssip newDTMF](https://jssip.net/documentation/3.4.x/api/session/#event_newDTMF))                                  | As defined by jssip "Fired for an incoming or outgoing DTMF."                                                                                                                                                                                                                                               |
| call.receive.info                  | event ([jssip newInfo](https://jssip.net/documentation/3.4.x/api/session/#event_newInfo))                                  | As defined by jssip "Fired for an incoming or outgoing SIP INFO message."                                                                                                                                                                                                                                   |
| call.hold                          | event ([jssip hold](https://jssip.net/documentation/3.4.x/api/session/#event_hold))                                        | As defined by jssip "Fired when the user or the peer puts the other side on hold."                                                                                                                                                                                                                          |
| call.unhold                        | event ([jssip unhold](https://jssip.net/documentation/3.4.x/api/session/#event_unhold))                                    | As defined by jssip "Fired when the user or the peer resumes the other end from hold."                                                                                                                                                                                                                      |
| call.muted                         | event ([jssip muted](https://jssip.net/documentation/3.4.x/api/session/#event_muted))                                      | As defined by jssip "Fired when the local media is muted."                                                                                                                                                                                                                                                  |
| call.unmuted                       | event ([jssip unmuted](https://jssip.net/documentation/3.4.x/api/session/#event_unmuted))                                  | As defined by jssip "Fired when the local media is unmuted."                                                                                                                                                                                                                                                |
| call.ended                         | event ([jssip ended](https://jssip.net/documentation/3.4.x/api/session/#event_ended))                                      | As defined by jssip "Fired when an established call ends."                                                                                                                                                                                                                                                  |
| call.failed                        | event ([jssip failed](https://jssip.net/documentation/3.4.x/api/session/#event_failed))                                    | As defined by jssip "Fired when the session was unable to establish."                                                                                                                                                                                                                                       |
| call.timeupdate                    | answerTime (Date), duration (integer, milliseconds), prettyMilliseconds (string)                                           | Emitted every 100ms                                                                                                                                                                                                                                                                                         |
| call.terminated                    |                                                                                                                            | Emitted when the instance is destroyed                                                                                                                                                                                                                                                                      |
| call.promoted                      |                                                                                                                            | Emitted when the instance is made the primary                                                                                                                                                                                                                                                               |
| call.demoted                       |                                                                                                                            | Emitted when the instance looses its priority status                                                                                                                                                                                                                                                        |
| call.local.audio.removed           | trackParameters (lwpUtil.trackParameters)                                                                                  | Emitted when the local audio track is not discovered in the peerConnection                                                                                                                                                                                                                                  |
| call.local.video.removed           | trackParameters (lwpUtil.trackParameters)                                                                                  | Emitted when the local video track is not discovered in the peerConnection                                                                                                                                                                                                                                  |
| call.remote.audio.removed          | trackParameters (lwpUtil.trackParameters)                                                                                  | Emitted when the remote audio track is not discovered in the peerConnection                                                                                                                                                                                                                                 |
| call.remote.video.removed          | trackParameters (lwpUtil.trackParameters)                                                                                  | Emitted when the remote video track is not discovered in the peerConnection                                                                                                                                                                                                                                 |
| call.local.audio.added             | trackParameters (lwpUtil.trackParameters)                                                                                  | Emitted when the local audio track is discovered in the peerConnection                                                                                                                                                                                                                                      |
| call.local.video.added             | trackParameters (lwpUtil.trackParameters)                                                                                  | Emitted when the local video track is discovered in the peerConnection                                                                                                                                                                                                                                      |
| call.remote.audio.added            | trackParameters (lwpUtil.trackParameters)                                                                                  | Emitted when the remote audio track is discovered in the peerConnection                                                                                                                                                                                                                                     |
| call.remote.video.added            | trackParameters (lwpUtil.trackParameters)                                                                                  | Emitted when the remote video track is discovered in the peerConnection                                                                                                                                                                                                                                     |
| call.local.mediaStream.connect     | mediaStream ([MediaStream](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream))                                  | Emitted when the instance is promoted to primary and needs to streams connected                                                                                                                                                                                                                             |
| call.remote.mediaStream.connect    | mediaStream ([MediaStream](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream))                                  | Emitted when the instance is promoted to primary and needs to streams connected                                                                                                                                                                                                                             |
| call.local.audio.connect           | element ([HTML audio element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/audio))                            | Emitted when the instance is promoted to primary and has issued a play command to the HTML element                                                                                                                                                                                                          |
| call.local.video.connect           | element ([HTML video element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video))                            | Emitted when the instance is promoted to primary and has issued a play command to the HTML element                                                                                                                                                                                                          |
| call.remote.audio.connect          | element ([HTML audio element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/audio))                            | Emitted when the instance is promoted to primary and has issued a play command to the HTML element                                                                                                                                                                                                          |
| call.remote.video.connect          | element ([HTML video element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video))                            | Emitted when the instance is promoted to primary and has issued a play command to the HTML element                                                                                                                                                                                                          |
| call.local.mediaStream.disconnect  | mediaStream ([MediaStream](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream))                                  | Emitted when the instance is demoted needs to disconnect the streams                                                                                                                                                                                                                                        |
| call.remote.mediaStream.disconnect | mediaStream ([MediaStream](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream))                                  | Emitted when the instance is demoted and needs to disconnect the streams                                                                                                                                                                                                                                    |
| call.local.audio.disconnect        | element ([HTML audio element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/audio))                            | Emitted when the instance is demoted and has issued a pause command to the HTML element                                                                                                                                                                                                                     |
| call.local.video.disconnect        | element ([HTML video element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video))                            | Emitted when the instance is demoted and has issued a pause command to the HTML element                                                                                                                                                                                                                     |
| call.remote.audio.disconnect       | element ([HTML audio element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/audio))                            | Emitted when the instance is demoted and has issued a pause command to the HTML element                                                                                                                                                                                                                     |
| call.remote.video.disconnect       | element ([HTML video element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video))                            | Emitted when the instance is demoted and has issued a pause command to the HTML element                                                                                                                                                                                                                     |

> NOTE! For **unmuted audio** elements the pause is deferred rather than
> immediate: the element is muted first and actually paused a short moment
> later (~50ms), then unmuted. Pausing outright cuts the waveform wherever it
> happens to be, and if that isn't near a zero crossing it is heard as a
> click; muting first gives the element time to render near-silent audio
> before the cut. The `.disconnect` event is still emitted immediately, so an
> `element.paused` read from that handler will be `false` for that brief
> window, and `element.muted` will be `true`. Video and already-muted
> elements have nothing audible to click on and are paused immediately as
> before. Re-connecting the element (promoting the call again) cancels a
> pending pause and unmutes immediately, so a demote immediately followed by
> a promote is not left silent.
>
> The mute uses `muted` rather than writing `volume = 0` and restoring it,
> deliberately: `muted` is a separate axis from `volume`, so it cannot
> collide with anything else writing volume on these elements during that
> window (`changeVolume()` reacting to a master volume event, for instance).

> NOTE! All standard HTML media events for the local audio, local video, remote
> audio and remote video elements are emitted as call.{type}.{kind}.{eventName}
> with the additional parameters: element (HTML element), event (HTML media
> event). For example, call.remote.audio.muted.

### Consumed

| Event                              | Reason                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| mediaDevices.audio.input.changed   | Invokes either replaceSenderTrack() or removesSenderTrack()                                           |
| mediaDevices.video.input.changed   | Invokes either replaceSenderTrack() or removesSenderTrack()                                           |
| mediaDevices.audio.output.changed  | Updates the sinkId of the local audio, local video, remote audio and remote video HTML media elements |
| audioContext.channel.master.volume | Invokes changeVolume() to set the volume of the remote audio and remote video HTML media elements     |
| audioContext.channel.remote.volume | Invokes changeVolume() to set the volume of the remote audio and remote video HTML media elements     |
| keydown                            | Used to detect key presses on the document for the shortcut functionality                             |
| keyup                              | Used to detect key presses on the document for the shortcut functionality                             |

## Default Template

### Data

### HTML
