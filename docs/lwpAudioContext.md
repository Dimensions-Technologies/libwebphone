# lwpAudioContext

> NOTE! It is not expected that an instance of this class be created outside of the libwebphone interals. To access this instance use the libwebphone instance method `getAudioContext()`. If you are unfamiliar with the structure of libwebphone its highly recommended you [start here](/README.md).

The libwebphone audio context class contains all the functionality related to the browsers [AudioContext](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext). This is used to play ringing audio, generate DTMF tones, and provide volume controls.

Ringing audio is a bundled WAV ringtone (see `channels.ringer.files`, selected via `selectRingtone()`), decoded once into an `AudioBuffer` and played through the AudioContext graph as a looping `AudioBufferSourceNode` for the duration of the ring. Routing it through the graph is what makes a click-free stop possible: the fade is scheduled on the audio clock and interpolated per sample by the audio thread, which no JS-timer-driven fade on an `<audio>` element can match. Looping is likewise sample-accurate, so there is no seam. Nothing oscillates in the background between rings - the source node is created per ring and discarded after it stops.

An inbound call can ring with a different ringtone to the selected one, chosen by the `Alert-Info` header on its INVITE - see [Alert-Info ringtones](#alert-info-ringtones) below.

Only the ringtones that are actually reachable are kept decoded - the selected one, whatever is being previewed, the ring in progress along with any calls queued or waiting behind it, and (while `channels.ringer.alertInfo.prewarm` is on) the ringtones the Alert-Info mappings point at. `decodeAudioData` resamples to the context's rate, so holding all of `channels.ringer.files` decoded would cost several megabytes.

### Alert-Info ringtones

A platform can mark an inbound call by putting an `Alert-Info` header on the INVITE, which is how a phone knows to ring differently for, say, an internal call than an external one:

```
Alert-Info: <alert-internal>
```

`channels.ringer.alertInfo.mappings` maps those header values to ringtones. Two keys are configured out of the box - `alert-internal` and `alert-external` - and a host application can add any others it needs (a door phone, a hotline) at runtime with [setAlertInfoRingtone()](#setalertinforingtonekey-ringtoneid). A mapping left unset falls back to the selected ringtone, so a mapping only has to be filled in where a distinct ringtone is actually wanted.

Keys are stored without the `<>` a SIP header wraps them in, and matched case-insensitively, so `alert-internal`, `<alert-internal>` and `<ALERT-INTERNAL>` are all the same mapping.

The default `matchMode` of `"token"` matches a key as a whole word anywhere in the header value. That covers the bare form above as well as the URI forms other platforms send (`<http://pbx/alert-internal>`, `<sip:x@pbx>;info=alert-internal`), while keeping `alert-internal` distinct from `alert-internal-2` - hyphens and underscores count as part of a word rather than as boundaries. `"exact"` compares the whole value instead, after stripping the surrounding `<>`. Where neither fits, `channels.ringer.alertInfo.matcher` replaces the matching entirely.

Mappings are matched in order, built-in keys first, and the first key matching any of the call's `Alert-Info` values wins - so a call carrying two headers is decided by mapping order, not header order.

Where two calls ring at once each keeps its own ringtone, but only one is audible: the ringer follows the call at the front of the ring queue, so a call arriving behind one that is already ringing is heard - with its own mapped ringtone - only once the call ahead of it is answered or cleared. See [startRinging()](#startringingrequestid-ringtoneid).

> **The library does not persist these mappings.** They live in the instance's config for its lifetime only. A host application that lets users customise them is responsible for storing them and passing them back in via `channels.ringer.alertInfo.mappings` when it constructs libwebphone - the same division of responsibility as `channels.ringer.selected`.

### Call waiting tone

A call arriving while another call is already **established** is not rung for. Ringing a full ringtone over the top of a conversation is unusable - it is loud, it is continuous, and it drowns out the party you are actually talking to. Instead the call is announced the way a desk phone announces one: a single short beep, repeated every `channels.ringer.callWaiting.interval` seconds (30 by default, configurable between 10 and 60) for as long as the call is waiting.

Held calls count as established. Being on hold is still being on a call, and it is exactly the case the old behaviour handled worst - the ringtone would play over a call the user intended to come back to.

Two calls ringing at once, with nothing established, is unchanged: neither is a call waiting situation, so they use the ring queue as before (see [startRinging()](#startringingrequestid-ringtoneid)).

The beep is generated (an `OscillatorNode` shaped by a gain envelope) rather than decoded, since it is a single tone - there is nothing to load and nothing to keep warm.

It plays out of the **speaker** - the `audiooutput` device, where call audio is - and not the ring output device or the [secondary ring output](#secondary-ring-output). The person it is for is already on a call and already wearing the headset; a beep sent to the ring device would be aimed at a room they are not listening to. It reaches that device the same way the DTMF tones do, over the `tonesDestinationStream`, and so is scaled by master volume (mirrored onto the element) but not by the ringer volume.

It has its own gain node rather than being connected to `tonesGain`, so the DTMF feedback volume - 0.15 by default - doesn't scale it, and turning keypress feedback down doesn't silence the call waiting tone with it. `channels.ringer.callWaiting.volume` sets its level independently.

Which of the two treatments a call gets is re-decided whenever the calls around it change, not only when it arrives:

- the established call clears while the waiting call is still ringing -> the waiting call takes the ringer over and rings properly, with the ringtone its own `Alert-Info` settled on when it arrived
- a call becomes established while another is still ringing (answering an outbound call placed during an inbound one) -> the ringing call drops to the beep

Only one cycle runs however many calls are waiting - three waiting calls are one beep every interval, not three. A call arriving behind one that is already waiting is beeped for as it arrives rather than waiting out the interval in progress.

`channels.ringer.callWaiting.enabled` turns the tone off, and [setCallWaitingEnabled()](#setcallwaitingenabledenabled) does the same at runtime. With it off a second call is presented **silently** - it still appears in the call list and can be answered, it simply makes no sound. It does not fall back to ringing over the active call; that is the behaviour this replaces. Toggling it mid-call takes effect immediately, on a call already waiting.

#### Tracing the call waiting tone

Debug mode traces every routing decision, queue change and beep to the console, alongside the SIP trace:

```js
webphone.getUserAgent().startDebug();   // stopDebug() turns both back off
```

The trace is a namespaced [debug](https://www.npmjs.com/package/debug) logger, `libwebphone:callWaiting`, created on the same `debug` instance JsSIP uses - so it prints in the same styled `namespace message` form as `JsSIP:Transport`, the one toggle owns both, and the two interleave in the console in the order things actually happened.

> It is written with `console.log`, deliberately overriding `debug`'s own `console.debug`. Chrome files `console.debug` under the **Verbose** log level and hides it by default, so JsSIP's own trace only appears once that level is enabled in the console's filter - this one does not depend on it. If the trace still doesn't appear, `getAudioContext().isCallWaitingDebug()` says whether the namespace is actually enabled, which separates "not logging" from "not visible". To have it on before the first call can arrive, enable it at construction rather than calling `startDebug()` afterwards:

```js
const webphone = new libwebphone({ userAgent: { debug: true } });
```

The trace answers the two questions a silent call waiting tone raises, in order:

- **Did the call get here, and how was it routed?** `call.created` and `call.ringing.started` mark arrival; `shouldWait` shows the decision along with every other call it was based on (session, established, held, ended), so a wrong decision names the call that caused it.
- **Was a beep actually produced, and could it be heard?** `cycle.start`/`beep.scheduled`/`beep.played` track the cycle, and `beep.played` carries the output path with it - the AudioContext state, and whether the `audiooutput` element is playing, muted, and still carrying the tones stream. A beep that is scheduled onto a paused or re-pointed element is silence the scheduling side cannot otherwise see.

`beep.dropped`, `beep.failed` and `beep.timer.stale` name the three ways a beep is skipped: superseded while the context resumed, the context not running, and the cycle having stopped before the timer fired.

[getCallWaitingDiagnostics()](#getcallwaitingdiagnostics) returns the same picture as a single object, for reading back at the moment something is wrong. It does not depend on the trace being on.

> **Cost with debug off is a boolean read.** Every trace point passes its details as a function rather than an object, and that function is only called once the logger is enabled - so with debug off nothing walks the call list, maps a queue or reads an element's state. Nothing is polled or timed either: the trace only ever describes work the library was doing anyway.

> As with the ringtone selection and the Alert-Info mappings, **the library does not persist the toggle or the interval.** A host application that lets users change them is responsible for storing them and passing them back in via `channels.ringer.callWaiting` when it constructs libwebphone.

There is no `<audio>` element fallback: ringing requires the AudioContext to be running. Since browsers keep it suspended until the user interacts with the page, this class registers a one-shot `click`/`touchend`/`keydown` listener on `document` and resumes the context on the first interaction anywhere in the app - see [startAudioContext()](#startaudiocontext). If a ring is nonetheless attempted before that happens, `audioContext.ringtone.play.error` is emitted rather than failing silently.

Ringtone audio reaches the selected ring output device the same way call and preview audio does, so it follows the ring output device selection automatically. There are two routes to that device and the class picks one at construction - see [Output device routing](#output-device-routing) below.

Tones are created by creating an audio buffer containing the calculated values of one or more sine wave frequencies provided as arguments at a sample rate of 8000 for the configured duration (channels.tone.duration). This audio buffer is played then destroyed.

Volume controls are provided by controling a [gain node](https://developer.mozilla.org/en-US/docs/Web/API/GainNode) associated with each audio channel. The output of each channel can be connected to a 'master' channel to provide a global volume control.

### Output device routing

An AudioContext used to have no way to select its destination device, so the only
way to honour an output device selection was to pipe it through an `<audio>`
element via a `MediaStreamAudioDestinationNode` and call `setSinkId()` on the
element. That hand-off is the source of several Chrome problems: if the context's
sample rate doesn't match the output device's it "detunes" the audio (plays
sharp), it introduces timing slips (the remote stream drifts out of sync compared
to playing in lwpCall audio elements), and despite the gain nodes multiplying by 1
it still clips audio that lwpCall audio elements don't.

`AudioContext.setSinkId()` (Chrome/Edge 110+) removes the need for the hand-off,
so this class uses it wherever it exists and falls back to the element otherwise.
Which mode is active can be read at runtime with
[getOutputSinkInfo()](#getoutputsinkinfo).

| Mode                                   | Ring output path                                                     | Device is selected on |
| -------------------------------------- | -------------------------------------------------------------------- | --------------------- |
| **context** (Chrome/Edge 110+)         | `masterGain -> context.destination`                                  | the AudioContext      |
| **element** (Firefox, Safari, older)   | `masterGain -> destinationStream -> ringoutput` element              | the element           |

Both are feature-detected, never version-sniffed - the table names browsers only
to say which route each takes today.

Context mode is preferred because it is the only one where the rates cannot
disagree. In element mode the context is created **without** a `sampleRate` hint
so it adopts the output hardware's own rate - but the rate it adopts is the
*default* device's, at construction time, while the ring output element can be
pointed at a different device, and the default itself changes when hardware is
plugged in. So element mode makes the detuning unlikely rather than impossible.
(Pinning a fixed 44100, as this previously did on Chrome, only matched hardware
that happened to run at 44100; on the 48000 that most modern devices use it
produced exactly the detuning it was meant to avoid - a ratio of 1.088, roughly
1.5 semitones sharp - and added a redundant resampling stage.) In context mode the
rate conversion happens inside the context's own render pipeline, which does it
correctly.

Neither Firefox nor Safari exhibits the Chrome detuning, so element mode is not a
compromise on the browsers that use it. Both can honour a device selection there:
`HTMLMediaElement.setSinkId()` landed in Firefox 116 and Safari 18.4.

Where `setSinkId()` exists in **neither** place, output device selection is inert -
the selection is recorded and announced, but audio plays to the system default
device. That is now Android (every browser on it, a platform limitation rather
than an engine one) and Safari before 18.4.

Two things stay on the element path in **both** modes:

- **DTMF tones** (`tonesGain -> tonesDestinationStream -> audiooutput` element).
  A context has exactly one sink, and tones deliberately go to the speaker device
  rather than the ring device. Detuning them is of no consequence - they are
  synthesised sine used as local keypress feedback, not the DTMF the far end
  hears.
- **Remote call audio**, which is rendered in lwpCall rather than in this graph
  (`call.useAudioContext` is off by default), for the timing-slip and clipping
  reasons above.
- **Secondary ring output**, when one is selected
  (`ringerGain -> secondaryRingGain -> secondaryRingDestinationStream -> ringoutput2`
  element). A context has exactly one sink and the primary ring output has
  already claimed it, so a second ring device can only be reached this way.

### Secondary ring output

`ringoutput2` is an optional second device that rings *in addition to*
`ringoutput` - the desk phone speaker plus a headset, say. It is `"none"` by
default and selecting a device for it is what turns it on; see
[mediaDevices.changeDevice("ringoutput2", deviceId)](/docs/lwpMediaDevices.md#changedevicedevicekind-deviceid).
The two are never allowed to be the same device, which would only ring one
speaker twice.

It is fed from `ringerGain`, not `masterGain`, so it carries **the ringer
channel alone** - ringing and ringtone previews, but not call audio or preview
loopback. `secondaryRingGain` stands in for the `masterGain` that path never
reaches, so the master volume still moves both ring outputs together; it sits at
`0` while no device is selected, which is how the path is switched off (a
`disconnect()` would take the primary output down with it).

Because it always needs the element hand-off, a browser without
`HTMLMediaElement.setSinkId()` cannot offer this at all - there
`mediaDevices.ringoutput2.enabled` is `false` and the path stays silent rather
than falling back to the default device and ringing the primary speaker twice.
That is Android and Safari before 18.4; note that it is *element* setSinkId this
needs, so Firefox 116+ and Safari 18.4+ get a secondary ring output even though
they have no `AudioContext.setSinkId` and run the primary in element mode.

> This has been a very helpful page to getting better understanding of the implementation details in the browsers: https://padenot.github.io/web-audio-perf

## Methods

#### startAudioContext()

For privacy and security browsers require users to interact with the document
before the AudioContext can be started. This method is automatically envoked
when audio is required (DTMF tones, ringing, ect) and resumes the context. It
will do nothing if the AudioContext is already running.

Returns a promise resolving to `true` if the context is actually running.
Callers that just want to nudge it awake can ignore the return value.

> `audioContext.started` is only emitted once the context is genuinely
> running, and each call is a fresh attempt until one succeeds. Previously it
> fired on the first call whether or not the resume worked, which meant
> anything listening for it (notably `mediaDevices._startMediaElements()`)
> ran while output was still blocked and never got a second chance.

> Note the resume promise is never awaited unguarded: while a browser is
> withholding playback pending a user gesture, Chrome leaves it *pending
> indefinitely* rather than rejecting. Internally the resume is raced against
> a short timeout and decisions are made on the context's actual state, so a
> context that never resumes can never stall ringing.

> Because of that timeout, a resume that succeeds *just* after the deadline
> is reported as a failure. So the class also listens to the AudioContext's
> own `statechange`: whenever it genuinely reaches `running`,
> `audioContext.started` is emitted (if it hasn't been already) and a ring
> that is still wanted but never became audible is started at that point.
> That, rather than the timeout, is what guarantees a call that arrives
> before the first user interaction still rings once one happens. The
> document-level gesture listeners are likewise kept until a resume is
> *confirmed* running, rather than being spent on the first gesture whether
> or not it worked.

#### isAudioContextRunning()

Whether the AudioContext is currently in the `running` state.

Return:

| Type    | Description                                  |
| ------- | --------------------------------------------- |
| boolean | `true` when the context is running           |

#### startPreviewTone()

This method will start playing the configured preview tone
(channels.preview.tone). If the tone is already playing this method will do
nothing.

#### stopPreviewTone()

This method will stop playing the configured preview tone
(channels.preview.tone). If the tone is not already playing this method will do
nothing.

#### togglePreviewTone()

If the preview tone (channels.preview.tone) is playing this will stop the tone,
otherwise it will start the tone.

#### isPreviewToneActive()

Informs the invoker of the current preview tone playing status.

Return:

| Type    | Description                                   |
| ------- | --------------------------------------------- |
| boolean | If true the preview tone is currently playing |

#### startPreviewLoopback()

Starts playing any audio from the microphone back to the output device with a
delay (channels.preview.loopback). If the loopback audio is already playing this
method will do nothing.

#### stopPreviewLoopback()

This method will stop any loopback audio (channels.preview.loopback). If the
loopback audio is not already playing this method will do nothing.

#### togglePreviewLoopback()

If the loopback preview (channels.preview.loopback) is playing this will stop
it, otherwise the loopback audio will be started.

#### isPreviewLoopbackActive()

Informs the invoker of the current preview loopback playing status.

Return:

| Type    | Description                                       |
| ------- | ------------------------------------------------- |
| boolean | If true the preview loopback is currently playing |

#### stopPreviews()

Will stop all preview audio (loopback or tones) from playing.

#### getVolume(channel, options)

Informs the invoker of the current volume for a given channel.

| Name                     | Type    | Default | Description                                                                                  |
| ------------------------ | ------- | ------- | -------------------------------------------------------------------------------------------- |
| channel                  | string  |         | The name of the channel (master, ringer, tones, remote and preview)                          |
| options.scale            | boolean | true    | When true the returned volume is multipled by the volumeMax parameter to scale to an integer |
| options.relativeToMaster | boolean | false   | When true the returned volume reflects the channel as well as the current master volume      |

Return:

| Type             | Description                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| float or integer | If the scale option is true an integer between volumeMin and volumeMax configuration properties is returned. If the scale option is false a float is returned between 0 and 1 |

#### changeVolume(channel, volume, options)

Sets the volume of the given channel.

| Name          | Type             | Default  | Description                                                                                                                                                                                                                            |
| ------------- | ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| channel       | string           |          | The name of the channel (master, ringer, tones, remote and preview)                                                                                                                                                                    |
| volume        | float or integer |          | If a float is provided it is expected to be between 0 and 1, options.scale should be false. If an integer is provided it is expected to be between the configured volumeMin and volumeMax parameters and options.scale should be true. |
| options.scale | boolean          | see note | When true the provided volume is divided by the volumeMax parameter to scale to a float                                                                                                                                                |

> options.scale defaults to true if its not provided and the volume is greater
> than 1, otherwise defaults to false.

#### playTones(...tones)

Generates and plays all provided frequencies (at the same time) for the
configured channels.tone.duration.

| Name  | Type    | Default | Description                                    |
| ----- | ------- | ------- | ---------------------------------------------- |
| tones | integer |         | The frequence of the tone to generate and play |

For example, a standard
[DTMF](https://en.wikipedia.org/wiki/Dual-tone_multi-frequency_signaling) for
the number 1 key would be:

```javascript
playTones(1209, 697);
```

#### startRinging(requestId, ringtoneId)

When ringing is required this function will start the ringing audio. The provide
request id, or null, will be pushed to an array and ringing will continue until
that array is empty. This allows multiple calls or other functions to request
ringing start and end without causing overlapping ringing tones.

| Name       | Type   | Default | Description                                                                                    |
| ---------- | ------ | ------- | ------------------------------------------------------------------------------------------------ |
| requestId  | string | null    | The reference / request id that requires ringing audio                                         |
| ringtoneId | string | null    | Ring with this ringtone instead of the selected one. Ignored if it isn't an entry in `channels.ringer.files` |

> The request id is optional, but its good practice to use the call id.

> The array of requestors is a **queue**, and the request at the front of it
> owns the ringer. A second call arriving while the first is still ringing
> does not swap the ringtone under it, whatever its own `Alert-Info` says —
> it waits, and is heard only once the calls ahead of it have called
> [stopRinging()](#stopringingrequestid). This is how a desk phone behaves:
> the second call's distinctive ringtone starts when the first is answered or
> cleared, not while it's still ringing.

> Each request's ringtone is settled **as it arrives**, not as it reaches the
> front of the queue, so a [selectRingtone()](#selectringtoneid) while a call
> waits its turn doesn't change what that call ends up ringing with — it
> takes effect from the next ring, as it does mid-ring. The
> `call.ringing.started` handler fills `ringtoneId` in from the call's
> `Alert-Info` header (see [getRingtoneForAlertInfo()](#getringtoneforalertinfoalertinfo));
> a host application calling `startRinging()` by hand gets the selected
> ringtone unless it passes one.

Ringtones play as decoded `AudioBuffer`s through the Web Audio graph
(`AudioBufferSourceNode -> envelope gain -> ringerGain -> masterGain`), which
is what allows [stopAllRinging()](#stopallringing) to fade cleanly and gives
seamless, sample-accurate looping. The envelope gain is per-ring and separate
from `ringerGain`, so [changeVolume()](#changevolumechannel-volume-options)
can move the ringer level mid-ring without disturbing a fade in progress.

> **Requires a running AudioContext.** There is no `<audio>` element
> fallback. If the context can't be resumed (the browser is still waiting on
> a user gesture) or the ringtone fails to decode, nothing plays and
> `audioContext.ringtone.play.error` is emitted with an Error saying which.
> The ring session itself is unaffected - nothing about call state changes.
> See [startAudioContext()](#startaudiocontext) for the gesture listener that
> keeps that window as small as possible.

> The bundled ringtones are all uncompressed PCM WAV (8kHz, 16-bit, mono),
> which `decodeAudioData` supports everywhere, so in practice a decode
> failure means a custom ringtone was supplied via `channels.ringer.files`.

#### stopRinging(requestId)

When ringing is no longer required, remove the request id from the array of
requestors. If the array is empty after this operation, stop all ringing audio.

| Name      | Type   | Default | Description                                            |
| --------- | ------ | ------- | ------------------------------------------------------ |
| requestId | string | null    | The reference / request id that requires ringing audio |

> If other requests are still waiting, the one now at the front of the queue
> takes the ringer over. Where it settled on a different ringtone — the usual
> case being an `alert-internal` call clearing while an `alert-external` one
> waits behind it — the ringing audio switches to that ringtone, fading the
> outgoing one out as [stopAllRinging()](#stopallringing) does rather than
> cutting it off. Removing a request that wasn't at the front changes nothing
> audible.

#### stopAllRinging()

Stops any ringing audio and resets the array of requestors.

The ringtone is faded to silence over `channels.ringer.fadeOut` seconds
(20ms by default) and the source is then stopped, rather than being cut off
outright — a hard stop lands wherever the waveform happens to be, and if
that isn't near a zero crossing it's heard as a click.

The fade is scheduled on the audio clock via `linearRampToValueAtTime`, so
the gain is interpolated **per sample by the audio thread**. This is why it
can be short enough to be imperceptible as a fade while still being clean.
Note that a stepped fade driven from a JS timer does not achieve the same
thing and is materially worse: each discrete step is its own transient, so
on a tonal signal like a ringtone a ramp of N steps produces N clicks —
zipper noise, more objectionable than the single click it replaces. Timer
resolution cannot get near what's needed, so the fade has to happen inside
the graph.

A ring cancelled before it becomes audible (stopped while the AudioContext
resume or the ringtone decode is still pending) is dropped rather than
starting afterwards.

#### startCallWaiting(requestId, ringtoneId)

The call waiting counterpart of [startRinging()](#startringingrequestid-ringtoneid): registers a call as waiting instead of ringing, and starts the beep cycle if it isn't already running. See [Call waiting tone](#call-waiting-tone).

| Name       | Type   | Default | Description                                                                                                 |
| ---------- | ------ | ------- | ----------------------------------------------------------------------------------------------------------- |
| requestId  | string | null    | The reference / request id that is waiting - use the call id                                                 |
| ringtoneId | string | null    | The ringtone this call would have rung with. Remembered, not used, for the case below                        |

`ringtoneId` is remembered rather than played: a waiting call takes the ringer over if the call it was waiting behind clears while it is still ringing, and it should then ring with the ringtone its own `Alert-Info` settled on when it arrived, not with whatever is selected by then.

Unlike the ring queue this list has no front and no owner - one beep cycle covers however many calls are waiting. A call added while the cycle is already running is beeped for immediately rather than waiting out the interval in progress; a call that is already waiting is ignored.

Beeping is subject to `channels.ringer.callWaiting.enabled`. With that off the call is still registered as waiting - so [isCallWaiting()](#iscallwaiting) is true, and the switch to a full ringtone if the established call clears still happens - it is simply presented silently.

> **Requires a running AudioContext**, like ringing, and for the same reason - there is no `<audio>` element path. If the context can't be resumed, `audioContext.callwaiting.tone.error` is emitted and the beep is skipped; the next one in the cycle tries again.

#### stopCallWaiting(requestId)

Removes a request from the waiting list, stopping the beep cycle if it was the last one. A request that isn't waiting is ignored, which is why `call.ringing.stopped` can simply call this and [stopRinging()](#stopringingrequestid) without knowing which of the two the call ended up on.

| Name      | Type   | Default | Description                                    |
| --------- | ------ | ------- | ---------------------------------------------- |
| requestId | string | null    | The reference / request id that was waiting    |

A beep already sounding when the last waiting call is answered finishes - it is a quarter of a second long and self-terminating, so there is nothing to fade. What is prevented is a beep that was still waiting on the AudioContext to resume arriving after the fact.

#### stopAllCallWaiting()

Drops every waiting call and stops the beep cycle.

Deliberately **not** part of [stopAllRinging()](#stopallringing): with a call waiting behind an established one the ring queue is normally empty, so stopping ringing must not take the beeps with it.

#### isCallWaiting()

Return:

| Type    | Description                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------- |
| boolean | True while any call is waiting, whether or not the tone itself is enabled - a call presented silently is still waiting |

#### isCallWaitingEnabled()

Return:

| Type    | Description                                                 |
| ------- | ----------------------------------------------------------- |
| boolean | The current value of `channels.ringer.callWaiting.enabled`  |

#### setCallWaitingEnabled(enabled)

Turns the call waiting tone on or off.

| Name    | Type    | Default | Description                            |
| ------- | ------- | ------- | -------------------------------------- |
| enabled | boolean |         | Whether the call waiting tone sounds   |

Takes effect immediately, including on a call already waiting: switching it on mid-call starts the beeps, switching it off silences them and leaves the call presented silently. Emits `audioContext.channel.ringer.callwaiting.enabled` and re-renders. Setting it to what it already is does nothing.

#### toggleCallWaiting()

Inverts [isCallWaitingEnabled()](#iscallwaitingenabled) via [setCallWaitingEnabled()](#setcallwaitingenabledenabled).

#### isAutoAnswerWarningEnabled()

Return:

| Type    | Description                                                        |
| ------- | ------------------------------------------------------------------ |
| boolean | The current value of `channels.ringer.autoAnswerWarning.enabled`   |

#### setAutoAnswerWarningEnabled(enabled)

Turns the auto-answer warning tone on or off.

| Name    | Type    | Default | Description                                     |
| ------- | ------- | ------- | ----------------------------------------------- |
| enabled | boolean |         | Whether the warning tone sounds before answering |

Takes effect from the next auto-answered call. With it off such a call connects immediately and silently - there is no tone, and no wait for one, so the answer goes out roughly 325ms sooner. Emits `audioContext.channel.ringer.autoanswerwarning.enabled` and re-renders. Setting it to what it already is does nothing.

This controls the tone only. Whether a call auto-answers at all is `config.call.autoAnswer.enabled` - see `libwebphone.setAutoAnswerEnabled()`.

#### toggleAutoAnswerWarning()

Inverts [isAutoAnswerWarningEnabled()](#isautoanswerwarningenabled) via [setAutoAnswerWarningEnabled()](#setautoanswerwarningenabledenabled).

#### playAutoAnswerWarning()

Plays the auto-answer warning tone - the short "beep beep" a desk phone sounds before answering an intercom or paging call by itself, so the user knows their microphone is about to open rather than discovering it afterwards. Called by lwpCall on the auto-answer path; a host application should not normally need it.

Return:

| Type              | Description                                                              |
| ----------------- | ------------------------------------------------------------------------ |
| Promise\<boolean\> | Resolves once the tone has finished, to whether it actually played       |

Resolves rather than rejects on every failure path - when the tone is disabled, when the AudioContext cannot be resumed because there has been no user gesture yet, or on an outright throw. A warning tone that could not be played must never be the reason a call goes unanswered, so the caller answers regardless; the failure is reported on `audioContext.autoanswer.warning.error` instead.

Every beep is scheduled up front on the audio clock rather than driven by a timer per beep - `setTimeout` jitter between them would be plainly audible at this spacing.

#### getCallWaitingInterval()

Return:

| Type   | Description                                                 |
| ------ | ----------------------------------------------------------- |
| number | Seconds between beeps - `channels.ringer.callWaiting.interval` |

#### setCallWaitingInterval(seconds)

Sets the interval between beeps.

| Name    | Type   | Default | Description               |
| ------- | ------ | ------- | ------------------------- |
| seconds | number |         | Seconds between beeps     |

Clamped into `[channels.ringer.callWaiting.intervalMin, channels.ringer.callWaiting.intervalMax]` (10 to 60 by default) rather than rejected, so a value straight out of a number input can be passed through; a value that isn't a number at all leaves the interval alone. Emits `audioContext.channel.ringer.callwaiting.interval` with the value actually applied, and re-renders.

Changing it while calls are waiting re-times the **next** beep from now - the cycle isn't restarted, since that would beep again on every step of a slider.

#### isCallWaitingDebug()

Return:

| Type    | Description                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------- |
| boolean | Whether the `libwebphone:callWaiting` trace is currently being logged - see [Tracing the call waiting tone](#tracing-the-call-waiting-tone) |

There is no setter: the trace belongs to debug mode, which [lwpUserAgent](lwpUserAgent.md)'s `startDebug()` / `stopDebug()` own.

#### getCallWaitingDiagnostics()

Everything that decides whether a beep is heard, as one object: the queue state (`waiting`, `toneActive`, `timerArmed`, `ringQueue`, `ringerConnected`), the calls the routing decision reads (`calls`, each with `hasSession`/`ringing`/`established`/`held`/`ended`/`primary`), and the output path the beep is scheduled onto (`output`: the AudioContext state, the call waiting gain, and the `audiooutput` element's paused/muted/volume/stream/sink).

Safe to call at any time and independent of the debug flag. Intended use is to call it at the moment something is wrong and read it back.

#### getRingtones()

Returns the list of selectable ringtones - every entry in
`channels.ringer.files`.

Return:

| Type  | Description                                          |
| ----- | ----------------------------------------------------- |
| array | `[{ id: string, name: string }, ...]`                  |

#### getSelectedRingtone()

Returns the currently configured ringtone id (`channels.ringer.selected`).

#### selectRingtone(id)

Changes which ringtone will be used the next time ringing starts.

| Name | Type   | Default | Description                                                             |
| ---- | ------ | ------- | ------------------------------------------------------------------------ |
| id   | string |         | The id of an entry in `channels.ringer.files`                          |

> If a call is currently ringing, the change does **not** interrupt it - it
> takes effect starting with the next time ringing starts. The newly selected
> ringtone is decoded immediately either way, so it plays without delay; doing
> so during an active ring is safe because the ringing source already holds
> its own decoded buffer. An active ringtone preview **is** stopped.
> Selection is not persisted by the library; the host application is
> responsible for remembering the user's choice (e.g. in its own storage)
> and re-applying it (via config or this method) on future sessions.

#### getAlertInfoMappings()

Returns the Alert-Info ringtone mappings, in the order they are matched against an incoming call - built-in keys first (see [Alert-Info ringtones](#alert-info-ringtones)).

Return:

| Type  | Description                                                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| array | `[{ key: string, ringtone: string\|null, builtin: boolean }, ...]`. A null `ringtone` means the mapping is unset and falls back to the selected ringtone; `builtin` marks the platform keys, which cannot be removed |

#### getAlertInfoRingtone(key)

Returns the ringtone id mapped to `key`, or null where the mapping is unset or doesn't exist - the two behave identically when a call arrives.

| Name | Type   | Default | Description                                                                     |
| ---- | ------ | ------- | --------------------------------------------------------------------------------- |
| key  | string |         | An Alert-Info value, with or without the surrounding `<>`, in any case          |

Return:

| Type          | Description                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| string / null | The mapped ringtone id, or null where the mapping is unset, doesn't exist, or the key itself is unusable. Use [getRingtoneForAlertInfo()](#getringtoneforalertinfoalertinfo) for what a call would actually ring with, which resolves null to the selected ringtone |

#### setAlertInfoRingtone(key, ringtoneId)

Maps an Alert-Info value to a ringtone, adding the mapping if it is new. This is how a host application adds a customer's own mapping (a door phone, for example) at runtime.

| Name       | Type   | Default | Description                                                                                        |
| ---------- | ------ | ------- | ---------------------------------------------------------------------------------------------------- |
| key        | string |         | An Alert-Info value, with or without the surrounding `<>`. Stored lowercased and unwrapped         |
| ringtoneId | string | null    | The id of an entry in `channels.ringer.files`, or null to clear the mapping back to the selected ringtone |

> Ignored if `key` is empty or the literal `__proto__` (which no plain JavaScript object can hold as an ordinary key, so the mapping could never exist), or if `ringtoneId` is given but doesn't resolve to an entry in `channels.ringer.files` - an id that will never play is a mistake, unlike an intentionally unset mapping. Clearing a mapping does **not** remove it: the built-in rows have to stay in the UI to be re-filled, and [removeAlertInfoMapping()](#removealertinfomappingkey) is how a custom one is deleted. If a call is currently ringing, the change does not interrupt it.

Return:

| Type    | Description                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| boolean | False where the call was **refused** for one of the reasons above, so a UI can report a bad input. Asking for a mapping that is already exactly that is true, not false - it changed nothing, but nothing was wrong with it |

#### removeAlertInfoMapping(key)

Removes a custom mapping entirely.

| Name | Type   | Default | Description                     |
| ---- | ------ | ------- | ---------------------------------- |
| key  | string |         | The Alert-Info value to remove  |

> Ignored for the built-in platform keys - they are fixed rows in the UI. Clear one with `setAlertInfoRingtone(key, null)` instead.

Return:

| Type    | Description                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| boolean | False where the removal was **refused** - an unusable key, or a built-in one. A key that simply isn't mapped is true: the caller asked for no mapping under it, and that is the state they get |

#### getRingtoneForAlertInfo(alertInfo)

Resolves the ringtone an inbound call carrying these `Alert-Info` header values should ring with. This is what the `call.ringing.started` handler passes to [startRinging()](#startringingrequestid-ringtoneid), and it is exposed so a host application can show which ringtone a call will use (or would have used) without starting one.

| Name      | Type  | Default | Description                                                                                                 |
| --------- | ----- | ------- | ------------------------------------------------------------------------------------------------------------- |
| alertInfo | array | `[]`    | The raw header values, as [lwpCall.getAlertInfo()](/docs/lwpCall.md#getalertinfo) returns them. A single string is accepted too |

Return:

| Type   | Description                                                                                                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| string | A ringtone id. Always something playable: an unmatched call, an unset mapping, a mapping pointing at a ringtone that no longer exists, and `channels.ringer.alertInfo.enabled` being false all resolve to `channels.ringer.selected` |

> This never throws, including when a `channels.ringer.alertInfo.matcher` does - a failure there is reported as `audioContext.channel.ringer.alertinfo.error` and resolves to the selected ringtone. Nothing about deciding a ringtone is allowed to stop a call ringing.

#### previewRingtone(id, source)

Plays a ringtone, looping, so it can be auditioned outside of an actual call,
using a playback path entirely separate from real ringing so it can never
interfere with (or be interfered with by) an actual ring. Automatically stops
after `channels.ringer.previewDuration` seconds if not stopped first.
Starting a real ring (`startRinging()`) also stops any active preview.

| Name   | Type   | Default                        | Description                                                    |
| ------ | ------ | ------------------------------- | --------------------------------------------------------------- |
| id     | string | `channels.ringer.selected`     | The id of an entry in `channels.ringer.files`                  |
| source | any    | null                            | Which control owns this preview - see [Preview ownership](#preview-ownership) |

> If the AudioContext can't be resumed (e.g. autoplay policy) or the ringtone
> fails to decode, the preview is
> automatically stopped (as if `stopRingtonePreview()` had been called) and
> `audioContext.ringtone.preview.error` is emitted, so `isRingtonePreviewActive()`
> and the render state never claim a preview is playing when it isn't.

##### Preview ownership

There is only ever **one** preview playing, but a UI usually has several
buttons that can start one - the ringtone selector, one per Alert-Info mapping
row, and whatever a host application adds. So a preview records *which control
started it*, not just which ringtone is playing, and each control asks about
its own:

```js
// each button passes a token of its own - any value, compared with ===
audioContext.toggleRingtonePreview(ringtoneId, "internal-button");

// ...and renders from the same token
button.textContent = audioContext.isRingtonePreviewActive("internal-button")
  ? "Stop"
  : "Preview";
```

Without this, two buttons set to the same ringtone would both show "Stop" while
only one of them is playing - the ringtone id can't tell them apart, and an
unset Alert-Info mapping auditions the selected ringtone, so collisions are
routine rather than a corner case.

The token can be any value (a string, a DOM element, an object) since it is
only ever compared with `===`. Three rules follow from that:

- Pass the **same** token for every press of a given button, or it will never
  recognise its own preview.
- Pass a **distinct** token per button. `null` is the built-in ringtone
  selector's token, and each Alert-Info row uses its normalised key
  (`"alert-internal"`), so avoid those unless you mean to share a button's
  identity with one of them.
- Never use `undefined` as a token. Omitting the argument is how
  [isRingtonePreviewActive()](#isringtonepreviewactivesource) is asked "is
  *anything* playing", and a method call cannot tell an omitted argument from
  an explicit `undefined` - so a token that hasn't been computed yet would
  quietly answer the wrong question. Where a token can legitimately be absent,
  compare [getRingtonePreviewSource()](#getringtonepreviewsource) instead.

Ownership only decides what a control reports and what a press does; it does
not reserve anything. Whoever starts a preview stops the one already playing,
whatever owns it.

#### stopRingtonePreview()

Stops any ringtone currently being previewed, with the same fade-out as
[stopAllRinging()](#stopallringing). The decoded buffer is released unless
something else still reaches it - it is also the selected ringtone, a ring in
progress or a call queued behind it is using it, or it is one of the prewarmed
Alert-Info mappings.

#### toggleRingtonePreview(id, source)

The one call a preview button needs. Pressing the control that started the
preview stops it; pressing a **different** one switches the preview to that
control's ringtone rather than merely stopping the first. Every preview button
in the default template is bound to this.

| Name   | Type   | Default                        | Description                                                    |
| ------ | ------ | ------------------------------- | --------------------------------------------------------------- |
| id     | string | `channels.ringer.selected`     | The id of an entry in `channels.ringer.files`                  |
| source | any    | null                            | The pressing control's token - see [Preview ownership](#preview-ownership). Pass the same value on every press of a given button |

#### isRingtonePreviewActive(source)

Whether a ringtone preview is playing - and, given a `source`, whether it is
that control's own. This is what a preview button should ask to decide between
showing "Preview" and "Stop" (see [Preview ownership](#preview-ownership)).

| Name   | Type | Default | Description                                                                                                                              |
| ------ | ---- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| source | any  |         | Omit for "is anything playing". Given a token, narrows to "is the preview playing the one this control started". `isRingtonePreviewActive(null)` asks about the ringtone selector's own preview specifically, **not** about any preview. Passing `undefined` is indistinguishable from omitting it, so never use `undefined` as a token (see [Preview ownership](#preview-ownership)) |

Return:

| Type    | Description                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------- |
| boolean | If true a ringtone preview is currently playing, and (where `source` was given) it belongs to it     |

#### getRingtonePreviewSource()

Which control owns the preview that is currently playing.

Return:

| Type | Description                                                                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| any  | The owning control's token: null for the ringtone selector, the normalised key for an Alert-Info mapping row, or whatever a host application passed. `undefined` when no preview is playing - which is how that case is told apart from the selector's null |

#### isRinging()

Whether a ring session is currently open - i.e. `startRinging()` has been
called and `stopRinging()`/`stopAllRinging()` has not yet closed it. Note
this is true from the moment ringing is requested, including while the
AudioContext resume or the ringtone decode is still pending and nothing is
audible yet.

Return:

| Type    | Description                                |
| ------- | ------------------------------------------- |
| boolean | If true a ring has been requested and not stopped |

#### getDestinationStream()

Get the output audio stream.

Returns:

| Type                                                                        | Description                           |
| --------------------------------------------------------------------------- | ------------------------------------- |
| [MediaStream](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream) | A MediaStream from the master channel |

> This stream exists in both routing modes, so a host application tapping it
> (recording, metering) works either way. In **context** mode nothing plays it -
> it is only a passive tap, and does not double up on the audio reaching the
> speakers.

#### usesContextSink()

Whether the AudioContext owns the ring output sink itself, rather than the
`ringoutput` `<audio>` element owning it. See
[Output device routing](#output-device-routing).

Return:

| Type    | Description                                          |
| ------- | ---------------------------------------------------- |
| boolean | `true` in **context** mode, `false` in element mode |

#### setRingOutputSinkId(deviceId)

Points ring output at a device. This is called by lwpMediaDevices when the ring
output device selection changes; there is no reason for a host application to
call it directly - use
[mediaDevices.changeDevice("ringoutput", deviceId)](/docs/lwpMediaDevices.md#changedevicedevicekind-deviceid)
instead, which also updates the selection the renders read.

Only meaningful in **context** mode. In element mode the sink belongs to the
`ringoutput` element and lwpMediaDevices sets it there instead, so this resolves
to `false` without doing anything.

Parameters:

| Name     | Type   | Default    | Description                                                             |
| -------- | ------ | ---------- | ----------------------------------------------------------------------- |
| deviceId | string | *required* | The device id to output to. `"default"` (or empty) means the browser default |

Return:

| Type                                | Description                                                       |
| ----------------------------------- | ----------------------------------------------------------------- |
| Promise&lt;boolean&gt;              | Resolves `true` once the sink has moved, `false` in element mode. Rejects if `setSinkId()` does |

#### getOutputSinkInfo()

Where ring output is currently going, and at what rate.

Exposed for diagnosis: a sample rate that disagrees with the output device's is
audible as detuning (see [Output device routing](#output-device-routing)) but is
otherwise invisible from a host application, which leaves that class of problem to
be guessed at. If a user reports ringing sounding sharp, log this.

Return:

| Type   | Description                                                                    |
| ------ | ------------------------------------------------------------------------------ |
| object | `{ mode, deviceId, sampleRate, secondary }` - `mode` is `"context"` or `"element"`, `deviceId` is the device ring output is going to (read from whichever of the two owns the sink) with `""` meaning the browser default, `sampleRate` is the AudioContext's rate in Hz, and `secondary` is `{ enabled, deviceId }` for the [secondary ring output](#secondary-ring-output) (always element-sinked, whichever mode the primary is in) |

#### setSecondaryRingOutputEnabled(enabled)

Turns the [secondary ring output](#secondary-ring-output) path on or off. This is
called by lwpMediaDevices from the `ringoutput2` selection and there is no reason
for a host application to call it directly - use
[mediaDevices.changeDevice("ringoutput2", deviceId)](/docs/lwpMediaDevices.md#changedevicedevicekind-deviceid)
instead, which also moves the sink and updates the selection the renders read.

Parameters:

| Name    | Type    | Default    | Description                                          |
| ------- | ------- | ---------- | ---------------------------------------------------- |
| enabled | boolean | *required* | Whether ringing is also sent to the secondary device |

#### isSecondaryRingOutputEnabled()

Return:

| Type    | Description                                                     |
| ------- | --------------------------------------------------------------- |
| boolean | `true` when ringing is mirrored to a second device               |

#### getSecondaryRingDestinationStream()

The stream feeding the secondary ring device. Unlike
[getDestinationStream()](#getdestinationstream)'s full mix this carries the ringer
channel alone, and is silent unless a secondary device is selected.

Returns:

| Type                                                                       | Description                           |
| -------------------------------------------------------------------------- | ------------------------------------- |
| [MediaStream](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream) | A MediaStream from the ringer channel |

#### updateRenders()

Re-paint / update all render targets.

## i18n

| Key           | Default (en)   | Description                                            |
| ------------- | -------------- | ------------------------------------------------------ |
| mastervolume  | Master Volume  | Used to label the master volume control element        |
| ringervolume  | Ringer Volume  | Used to label the ringing volume control element       |
| ringtonesection | Ringtones    | Used to label the section holding the ringtone selector and the Alert-Info ringtones |
| ringtone      | Ringtone       | Used to label the ringtone selection control element   |
| ringtonepreview | Preview      | Label for the ringtone preview button when idle         |
| ringtonepreviewstop | Stop    | Label for the ringtone preview button while previewing  |
| callwaitingsection | Call Waiting | Used to label the section holding the call waiting tone controls |
| callwaiting   | Call Waiting Tone | Used to label the checkbox that enables/disables the call waiting tone |
| callwaitinginterval | Call Waiting Tone Interval (seconds) | Used to label the input that sets the seconds between call waiting beeps |
| alertinfointernal | Internal Call Ringtone | Used to label the ringtone selector for the `alert-internal` Alert-Info value |
| alertinfoexternal | External Call Ringtone | Used to label the ringtone selector for the `alert-external` Alert-Info value |
| alertinfocustom | Custom Alert-Info Ringtones | Used to label the section holding any further Alert-Info mappings |
| alertinfoempty | No custom mappings yet | Shown in place of the mapping table while no custom mappings exist |
| alertinfodefault | Use selected ringtone | The option shown for a mapping that is unset, and so uses the selected ringtone |
| alertinfokey  | Alert-Info value | Names the input a new Alert-Info value is typed into (its placeholder and its accessible name), and heads the key column of the mapping table |
| alertinfoinvalid | Enter a valid Alert-Info value | Shown against that input when the Add button rejects what is in it - an empty value, or one that cannot be used as a key |
| alertinfoadd  | Add            | Label for the button that adds a new Alert-Info mapping                |
| alertinforemove | Remove       | Label for the button that removes a custom Alert-Info mapping          |
| tonesvolume   | Tones Volume   | Used to label the DTMF (tones) volume control element  |
| previewvolume | Preview Volume | Used to label the preview volume control element       |
| remotevolume  | Call Volume    | Used to label the remote (call) volume control element |

## Configuration

| Name                                | Type     | Default | Description                                                                                                                                          |
| ----------------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| channels.master.show                | boolean  | true    | Should the default template show the master volume control                                                                                           |
| channels.master.volume              | float    | 1.0     | The initial volume of the master audio, where 0 is muted and 1 is 100%                                                                               |
| channels.ringer.show                | boolean  | true    | Should the default template show the ringing volume control. The ringtone selector has its own flag (`channels.ringer.ringtones.show`) rather than this one, since the two sit in different [sections](#sections) |
| channels.ringer.volume              | float    | 1.0     | The initial volume of the ringing audio, where 0 is muted and 1 is 100%                                                                              |
| channels.ringer.connectToMaster     | boolean  | true    | Connects `ringerGain` to `masterGain`, so the ringtone's volume is also scaled by the current master volume. **Leave this on:** `masterGain` is the only route to the ring output element, so setting it false does not merely unlink the two volumes, it disconnects the ringer from the output entirely and nothing is heard. (Same is true of `channels.preview.connectToMaster`; `remote` and `tones` have their own paths.) |
| channels.ringer.files               | array    | see below | Selectable ringtones bundled with the library: `[{ id, name, dataUri }, ...]`, generated from `assets/sounds/*.wav` by `npm run ringtones:build`. Config is merged with lodash `merge`, which merges arrays by index rather than replacing them - a shorter custom `files` array supplied via config will not fully remove the bundled defaults, it merges element-by-element against them. To fully replace the list, override every index (i.e. supply an array at least as long as the default). The defaults are copied per instance, so doing this affects only the instance you pass it to |
| channels.ringer.selected            | string   | `"ring01"` (falls back to the first entry in `channels.ringer.files` if that id isn't present) | Which ringtone is currently selected, by id. Change at runtime with `selectRingtone(id)`. Validated against `channels.ringer.files` on construction and on every `selectRingtone(id)` call, so this always resolves to a real bundled file |
| channels.ringer.ringtones.show      | boolean  | true    | Should the default template show the [ringtones section](#sections) - the ringtone selector, its preview button and, subject to the flag below, the Alert-Info controls. Only relevant to a target rendering the whole template: one that names a `section` has already said which it wants |
| channels.ringer.alertInfo.show      | boolean  | true    | Should the default template show the Alert-Info ringtone controls - the two platform selectors, any custom mappings and the row for adding one. These render inside the ringtones section, below the ringtone selector, so `channels.ringer.ringtones.show` hides them along with it |
| channels.ringer.alertInfo.enabled   | boolean  | true    | Whether an inbound call's `Alert-Info` header is consulted at all. With this false every call rings with `channels.ringer.selected`, but the mappings remain readable and editable, so a host app can build its UI before switching the behaviour on |
| channels.ringer.alertInfo.mappings  | object   | `{"alert-internal": null, "alert-external": null}` | Alert-Info value -> ringtone id, or null for "use the selected ringtone". An object rather than an array so a host app's config merges key-by-key (unlike `files` above, which lodash `merge` combines by index), and so key order gives a stable match precedence. Keys are lowercased and unwrapped of `<>` on construction; a mapping pointing at an id that isn't in `channels.ringer.files` is cleared to null. Edit at runtime with [setAlertInfoRingtone()](#setalertinforingtonekey-ringtoneid) - the library does not persist them |
| channels.ringer.alertInfo.builtin   | array    | `["alert-internal", "alert-external"]` | The platform-defined keys. These always have a mapping row (added back if a config's `mappings` omits them), are always matched before any custom key, and cannot be removed - only cleared. The default template gives the two defaults their own labelled selectors; any further key added here renders in the custom list, minus its remove button |
| channels.ringer.alertInfo.matchMode | string   | token   | How a key is matched against an `Alert-Info` value. `"token"` matches the key as a whole word anywhere in the value, covering both `<alert-internal>` and URI forms like `<sip:x@pbx>;info=alert-internal`, while keeping `alert-internal` distinct from `alert-internal-2`. `"exact"` compares the whole value, after stripping the surrounding `<>` |
| channels.ringer.alertInfo.matcher   | function | null    | `(alertInfoValues, mappings) => key \| null`, replacing the matching above entirely. `alertInfoValues` arrives trimmed and lowercased, `mappings` is [getAlertInfoMappings()](#getalertinfomappings), and the returned key is normalised the same way a configured one is. A throw out of it is caught and treated as "no match" - the call rings with `channels.ringer.selected` and `audioContext.channel.ringer.alertinfo.error` is emitted, rather than the exception escaping into the ringing path |
| channels.ringer.alertInfo.prewarm   | boolean  | true    | Decode the mapped ringtones up front, rather than making the first call that needs one wait on `decodeAudioData`. Costs roughly half a megabyte per *distinct* mapped ringtone, so it stays proportional to how many are actually configured. With this off a mapped ringtone is decoded on demand and released once the ring ends |
| channels.ringer.callWaiting.show    | boolean  | true    | Should the default template show the [call waiting section](#sections) - the enable checkbox and, while enabled, the interval input                  |
| channels.ringer.callWaiting.enabled | boolean  | true    | Whether a call arriving while another is established is announced with the [call waiting tone](#call-waiting-tone). With this false that call is presented **silently** - it does not fall back to ringing over the established call. Change at runtime with [setCallWaitingEnabled()](#setcallwaitingenabledenabled) |
| channels.ringer.callWaiting.interval | integer | 30      | Seconds between call waiting beeps. Clamped into `[intervalMin, intervalMax]` on construction and on every [setCallWaitingInterval()](#setcallwaitingintervalseconds) |
| channels.ringer.callWaiting.intervalMin | integer | 10   | The shortest interval that can be set. Raise or lower it to widen the range a host application's UI offers                                            |
| channels.ringer.callWaiting.intervalMax | integer | 60   | The longest interval that can be set                                                                                                                 |
| channels.ringer.autoAnswerWarning.show | boolean | true  | Should the default template show the [auto-answer section](#sections) - the warning tone checkbox                                                     |
| channels.ringer.autoAnswerWarning.enabled | boolean | true | Whether an auto-answered call sounds the warning tone before answering. With this false it answers immediately and silently. Change at runtime with [setAutoAnswerWarningEnabled()](#setautoanswerwarningenabledenabled) |
| channels.ringer.autoAnswerWarning.count | integer | 2      | How many beeps.                                                                                    |
| channels.ringer.autoAnswerWarning.gap | float    | 0.08   | Seconds of silence between beeps                                                                                                                     |
| channels.ringer.autoAnswerWarning.duration | float | 0.12  | Seconds each beep sounds for, inclusive of its fades                                                                                                 |
| channels.ringer.autoAnswerWarning.frequency | integer | 520 | Beep frequency in Hz. Higher than the call waiting beep so the two are not mistaken for each other                                                    |
| channels.ringer.autoAnswerWarning.volume | float  | 0.4    | The level of the beep on the speaker (`audiooutput`) device, on its own gain node so it is independent of the call waiting level. Louder than that one, which has to sit under a conversation already in progress - this one is a warning that the microphone is about to open |
| channels.ringer.autoAnswerWarning.type | string  | "sine" | Oscillator type                                                                                                                                      |
| channels.ringer.autoAnswerWarning.fadeIn | float  | 0.005  | Declick ramp up, in seconds                                                                                                                          |
| channels.ringer.autoAnswerWarning.fadeOut | float | 0.01   | Declick ramp down, in seconds                                                                                                                        |
| channels.ringer.callWaiting.volume  | float    | 0.4    | The level of the beep on the speaker (`audiooutput`) device. Master volume still applies on top; the ringer volume does not, since the beep does not go to the ring output. Well below full scale because it plays into a headset someone is already holding a conversation on - for reference the DTMF feedback tones on the same device sit at 0.15, and those are not competing with anything |
| channels.ringer.callWaiting.frequency | integer | 440    | The frequency of the beep                                                                                                                            |
| channels.ringer.callWaiting.duration | float   | 0.25    | The duration, in seconds, of one beep. Raised to `fadeIn + fadeOut` if set shorter than the two fades together                                        |
| channels.ringer.callWaiting.type    | string   | sine    | The waveform to generate (sine, square, sawtooth, triangle). Anything else falls back to sine - an unknown value throws when assigned to the oscillator, and there is no fallback path for the beep |
| channels.ringer.callWaiting.fadeIn  | float    | 0.01    | Seconds the beep envelope ramps up over. A declick, as with the ringtone fades                                                                        |
| channels.ringer.callWaiting.fadeOut | float    | 0.02    | Seconds the beep envelope ramps down over                                                                                                            |
| channels.ringer.previewDuration     | integer  | 8       | Seconds `previewRingtone()` plays before auto-stopping itself                                                                                        |
| channels.ringer.fadeIn              | float    | 0.01    | Seconds the ringtone envelope ramps up over when ringing starts                                                                                      |
| channels.ringer.fadeOut             | float    | 0.02    | Seconds the ringtone envelope ramps down over when ringing stops. This is a declick, not a stylistic fade - because the ramp is interpolated per sample by the audio thread it does not need to be long to be clean, and lengthening it just makes the stop audibly slow |
| channels.tones.show                 | boolean  | true    | Should the default template show the DTMF playback tones volume control                                                                              |
| channels.tones.volume               | float    | 0.15    | The initial volume of the DTMF playback tones                                                                                                        |
| channels.tones.duration             | float    | 0.15    | Duration, in seconds, that the DTMF playback tones should be audible for                                                                             |
| channels.tones.connectToMaster      | boolean  | true    | **Currently ignored.** The DTMF tones have their own stream (`tonesGain -> tonesDestinationStream -> audiooutput` element) and never route through `masterGain`; master volume reaches them by being mirrored onto that element's `.volume` instead. Long-standing, not specific to the ringtone work |
| channels.remote.show                | boolean  | true    | Should the default template show the remote (call) volume                                                                                            |
| channels.remote.volume              | float    | 1.0     | The initial volume of any remote audio (call)                                                                                                        |
| channels.remote.connectToMaster     | boolean  | false   | Should the remote audio (calls) play through the master channel                                                                                      |
| channels.preview.show               | boolean  | true    | Should the default template show the preview volume                                                                                                  |
| channels.preview.volume             | float    | 1.0     | The initial volume of any preview audio                                                                                                              |
| channels.preview.connectToMaster    | boolean  | false   | Should the preview audio play through the master channel                                                                                             |
| channels.preview.loopback.delay     | float    | 0.5     | Duration, in seconds, to delay the microphone audio when the loopback preview is playing                                                             |
| channels.preview.tone.frequency     | integer  | 440     | The frequency of the preview tone                                                                                                                    |
| channels.preview.tone.duration      | integer  | 1.5     | The duration, in seconds, to play the preview tone                                                                                                   |
| channels.preview.tone.type          | string   | sine    | The waveform type to generate (sine, square, sawtooth, triangle)                                                                                     |
| globalKeyShortcuts                  | boolean  | true    | Should the event listeners in the 'keys' property be added to the document                                                                           |
| keys.arrowup.enabled                | boolean  | true    | If true, and globalKeyShortcuts is also true, preform keys.arrowup.action if the up arrow is pressed when the body of the document has the focus     |
| keys.arrowup.action                 | function |         | By default this callback increases the master volume by 5% (0.05)                                                                                    |
| keys.arrowdown.enabled              | boolean  | true    | If true, and globalKeyShortcuts is also true, preform keys.arrowdown.action if the down arrow is pressed when the body of the document has the focus |
| keys.arrowdown.action               | function |         | By default this callback decreases the master volume by 5% (0.05)                                                                                    |
| volumeMax                           | integer  | 100     | The maximum value when converting the volume between floats and integers                                                                             |
| volumeMin                           | integer  | 0       | The minimum value when converting the volume between floats and integers                                                                             |
| renderTargets                       | array    | []      | See [lwpRenderer](lwpRenderer.md)                                                                                                                    |

## Events

### Emitted

| Event                                 | Additional Parameters            | Description                                                            |
| ------------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| audioContext.created                  |                                  | Emitted when the class is instantiated                                 |
| audioContext.started                  |                                  | Emitted when the AudioContext is confirmed running (not merely when a resume was attempted) |
| audioContext.resume.error             | error                            | Emitted when AudioContext.resume() rejects, usually the browser refusing without a user gesture |
| audioContext.ringtone.decode.error    | error                            | Emitted when a ringtone fails to decode into an AudioBuffer - the entry is dropped so a later ring retries the decode |
| audioContext.preview.tone.started     |                                  | Emitted when the preview tones are started                             |
| audioContext.preview.tone.stopped     |                                  | Emitted when the preview tones are stopped                             |
| audioContext.preview.loopback.started |                                  | Emitted when the preview loopback audio is started                     |
| audioContext.preview.loopback.stopped |                                  | Emitted when the preview loopback audio is stopped                     |
| audioContext.channel.master.volume    | volume (integer between 0 and 1) | Emitted when the master channel volume is updated                      |
| audioContext.channel.ringer.volume    | volume (integer between 0 and 1) | Emitted when the ringer channel volume is updated                      |
| audioContext.channel.ringer.selected  | id (string)                      | Emitted when selectRingtone() changes the selected ringtone            |
| audioContext.callwaiting.started      |                                  | Emitted when the [call waiting tone](#call-waiting-tone) cycle starts - a call is waiting and the tone is enabled |
| audioContext.callwaiting.stopped      |                                  | Emitted when the cycle stops, whether because the last waiting call was answered or cleared or because the tone was disabled |
| audioContext.callwaiting.tone.played  |                                  | Emitted for each beep, as it is scheduled                              |
| audioContext.callwaiting.tone.error   | error, deviceId (string)         | Emitted when a beep cannot play because the AudioContext was not running - the same condition as `audioContext.ringtone.play.error`. The third argument is the speaker (`audiooutput`) device the beep would have played on, rather than [getOutputSinkInfo()](#getoutputsinkinfo): the ring output sink says nothing about where this tone goes. The beep is skipped and the next one in the cycle tries again |
| audioContext.channel.ringer.callwaiting.enabled | enabled (boolean)      | Emitted when setCallWaitingEnabled() turns the call waiting tone on or off. Not emitted where nothing actually changed |
| audioContext.channel.ringer.callwaiting.interval | interval (integer)    | Emitted when setCallWaitingInterval() changes the interval, carrying the value actually applied (clamped). Not emitted where nothing actually changed |
| audioContext.channel.ringer.autoanswerwarning.enabled | enabled (boolean) | Emitted when setAutoAnswerWarningEnabled() turns the auto-answer warning tone on or off. Not emitted where nothing actually changed |
| audioContext.autoanswer.warning.started | duration (float)             | Emitted as the warning tone begins, carrying how long it will run in seconds - the auto-answered call is answered when it finishes |
| audioContext.autoanswer.warning.stopped |                              | Emitted once the warning tone has finished                                                                                        |
| audioContext.autoanswer.warning.error | error (Error), sinkId (string) | Emitted when the warning tone could not be played. The call is answered anyway, without one                                       |
| audioContext.channel.ringer.alertinfo.changed | key (string), id (string or null) | Emitted when setAlertInfoRingtone() adds a mapping or changes one, including when it is cleared back to the selected ringtone (a null id). Not emitted where nothing actually changed |
| audioContext.channel.ringer.alertinfo.removed | key (string)                | Emitted when removeAlertInfoMapping() deletes a custom mapping         |
| audioContext.channel.ringer.alertinfo.error | error                        | Emitted when resolving an inbound call's Alert-Info threw - in practice a `channels.ringer.alertInfo.matcher` that failed. The call still rings, with `channels.ringer.selected`; this is how an otherwise invisible fault in a host's own matching surfaces |
| audioContext.ringtone.preview.started | id (string), source (any)        | Emitted when previewRingtone() starts playing. The second argument is the control that owns it (see [Preview ownership](#preview-ownership)), so a host application's own buttons can update from the event alone |
| audioContext.ringtone.preview.stopped | source (any)                     | Emitted when a ringtone preview stops (manually or via timeout), carrying the control that owned the preview that just ended |
| audioContext.ringtone.play.error      | error, sink info (object)        | Emitted when startRinging() cannot play: either the AudioContext was not running (typically the browser's autoplay policy, still awaiting a user gesture) or the ringtone failed to decode - the Error message says which. The ring session itself is unaffected, this is purely informational, and if the context does resume later the ring is started then (see startAudioContext()). The second argument is [getOutputSinkInfo()](#getoutputsinkinfo), included so a failure to ring is diagnosable without a second round trip |
| audioContext.sink.changed             | sink info (object)               | Emitted when ring output moves to a different device in **context** mode, carrying [getOutputSinkInfo()](#getoutputsinkinfo). Not emitted in element mode - there the device belongs to the element and `mediaDevices.ring.output.changed` is the event to watch |
| audioContext.ring.output.secondary.enabled | enabled (boolean)           | Emitted when the [secondary ring output](#secondary-ring-output) path is switched on or off, which happens when the `ringoutput2` device selection moves to or away from `"none"` |
| audioContext.sink.error               | error                            | Emitted when the safety-net sync of the ring output sink fails (see [setRingOutputSinkId()](#setringoutputsinkiddeviceid)). A sink change requested through mediaDevices reports as `mediaDevices.ring.output.error` instead |
| audioContext.ringtone.preview.error   | error                            | Emitted when previewRingtone() cannot play, for the same two reasons and with the same Error messages - the preview is automatically stopped/rolled back (see stopRingtonePreview()) so the UI doesn't show "Stop" while nothing is playing. Unlike ringing, a preview is not retried if the context resumes later |
| audioContext.channel.tones.volume     | volume (integer between 0 and 1) | Emitted when the tones channel volume is updated                       |
| audioContext.channel.remote.volume    | volume (integer between 0 and 1) | Emitted when the remote channel volume is updated                      |
| audioContext.channel.preview.volume   | volume (integer between 0 and 1) | Emitted when the preview channel volume is updated                     |
| audioContext.stream.local.changed     | volume (integer between 0 and 1) | Emitted when the stream used for the preview loopback audio is updated |
| audioContext.stream.remote.changed    | volume (integer between 0 and 1) | Emitted when the stream used for the remote audio is updated           |
| audioContext.render.section.unknown   | section (string)                 | Emitted when a render target names a [section](#sections) that does not exist. The target still renders, with the full default template - this is what says the name was not understood, rather than it being silently ignored |

### Consumed

| Event                                   | Reason                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------- |
| call.ringing.started                    | Invokes startRinging() with the call's id, and with the ringtone its `Alert-Info` header maps to (see [Alert-Info ringtones](#alert-info-ringtones)). If resolving that ringtone throws, the call still rings - with `channels.ringer.selected` - and `audioContext.channel.ringer.alertinfo.error` is emitted. Where another call is already established the call is announced with the [call waiting tone](#call-waiting-tone) instead, via startCallWaiting() |
| call.ringing.stopped                    | Invokes stopRinging() **and** stopCallWaiting() with the call's id - whichever of the two the call ended up on, the other ignores it |
| call.established                        | Re-decides ringing vs. call waiting for any call still ringing: a call answered elsewhere means one that is still ringing should drop to the beep |
| call.terminated, call.ended, call.failed | The same re-decision the other way: the established call a waiting call was waiting behind has gone, so that call takes the ringer over and rings properly |
| call.primary.remote.audio.added         | Updates the remote source stream                                          |
| call.primary.remote.mediaStream.connect | Updates the remote source stream                                          |
| dialpad.tones.play                      | Invokes playTones                                                         |
| mediaDevices.streams.started            | Updates the local source stream                                           |
| mediaDevices.streams.stopped            | Removes the local source stream                                           |
| mediaDevices.devices.loaded             | In **context** mode, applies the ring output device selection to the context's sink if it isn't already there. A safety net for ordering, not the main path: lwpMediaDevices is constructed (and starts enumerating) before this class exists, so a selection settled during that enumeration can predate the context that now owns the sink |
| mediaDevices.audio.input.changed        | Updates the local source stream                                           |
| keydown                                 | Used to detect key presses on the document for the shortcut functionality |
| audioContext.channel.master.volume      | Invokes updateRenders() to show the new value, and mirrors the volume onto the `audiooutput` media element (the DTMF tones path, which is fed by its own stream rather than through masterGain) |
| audioContext.channel.ringer.volume      | Invokes updateRenders() to show the new value. Nothing else to sync by hand - changeVolume() writes straight to `ringerGain`, and master scaling comes from `ringerGain -> masterGain` |
| audioContext.channel.tones.volume       | Invokes updateRenders() to show the new value                             |
| audioContext.channel.preview.volume     | Invokes updateRenders() to show the new value                             |
| audioContext.channel.remote.volume      | Invokes updateRenders() to show the new value                             |

## Default Template

### Sections

The default template is three sections stacked: the volume controls, the
ringtones (the ringtone selector and the Alert-Info mappings under it) and the
call waiting tone controls. A render target that wants one of them on its own
names it, instead of switching the other two off with `show` flags:

```json
{
  "audioContext": {
    "renderTargets": [
      { "root": { "elementId": "audio_mixer" }, "section": "volumes" },
      { "root": { "elementId": "ringtones" }, "section": "ringtones" },
      { "root": { "elementId": "call_waiting" }, "section": "callwaiting" }
    ]
  }
}
```

| Section       | Contains                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `volumes`     | The master, ringer, tones, preview and call volume controls, each still subject to its channel's `show` |
| `ringtones`   | The ringtone selector, its preview button and the Alert-Info controls - `channels.ringer.ringtones.show` |
| `callwaiting` | The call waiting tone checkbox and, while it is on, the interval input - `channels.ringer.callWaiting.show` |
| `autoanswerwarning` | The auto-answer warning tone checkbox - `channels.ringer.autoAnswerWarning.show`. Only the tone: whether calls auto-answer at all, and whether they open the microphone, are `config.call` settings and belong to [libwebphone](./../README.md) rather than this module |

A section target needs nothing else: the events, i18n keys and data all come
from the default render config, exactly as for a target that takes the whole
template. Omitting `section` renders all three, so existing targets are
unaffected.

Each section keeps its own `show` flags, which are what a *single* target
rendering the whole template uses to drop a part of it. The two mechanisms are
independent - use the flags to hide something, and `section` to place things in
different parts of a page.

A target carrying its own `template` ignores `section`; a `section` naming
something that doesn't exist renders the full template and emits
`audioContext.render.section.unknown`.

### Data

### HTML
