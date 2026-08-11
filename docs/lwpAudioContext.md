# lwpAudioContext

> NOTE! It is not expected that an instance of this class be created outside of the libwebphone interals. To access this instance use the libwebphone instance method `getAudioContext()`. If you are unfamiliar with the structure of libwebphone its highly recommended you [start here](/README.md).

The libwebphone audio context class contains all the functionality related to the browsers [AudioContext](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext). This is used to play ringing audio, generate DTMF tones, and provide volume controls.

Ringing audio is a bundled WAV ringtone (see `channels.ringer.files`, selected via `selectRingtone()`), decoded once into an `AudioBuffer` and played through the AudioContext graph as a looping `AudioBufferSourceNode` for the duration of the ring. Routing it through the graph is what makes a click-free stop possible: the fade is scheduled on the audio clock and interpolated per sample by the audio thread, which no JS-timer-driven fade on an `<audio>` element can match. Looping is likewise sample-accurate, so there is no seam. Nothing oscillates in the background between rings - the source node is created per ring and discarded after it stops.

Only the currently selected ringtone (plus whatever is being previewed) is kept decoded; `decodeAudioData` resamples to the context's rate, so holding all of `channels.ringer.files` decoded would cost several megabytes.

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
compromise on the browsers that use it. Note that Safari implements `setSinkId()`
on neither the AudioContext nor the media element, so there output device
selection is inert and audio plays to the system default device.

Two things stay on the element path in **both** modes:

- **DTMF tones** (`tonesGain -> tonesDestinationStream -> audiooutput` element).
  A context has exactly one sink, and tones deliberately go to the speaker device
  rather than the ring device. Detuning them is of no consequence - they are
  synthesised sine used as local keypress feedback, not the DTMF the far end
  hears.
- **Remote call audio**, which is rendered in lwpCall rather than in this graph
  (`call.useAudioContext` is off by default), for the timing-slip and clipping
  reasons above.

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

#### startRinging(requestId)

When ringing is required this function will start the ringing audio. The provide
request id, or null, will be pushed to an array and ringing will continue until
that array is empty. This allows multiple calls or other functions to request
ringing start and end without causing overlapping ringing tones.

| Name      | Type   | Default | Description                                            |
| --------- | ------ | ------- | ------------------------------------------------------ |
| requestId | string | null    | The reference / request id that requires ringing audio |

> The request id is optional, but its good practice to use the call id.

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

#### previewRingtone(id)

Plays a ringtone, looping, so it can be auditioned outside of an actual call,
using a playback path entirely separate from real ringing so it can never
interfere with (or be interfered with by) an actual ring. Automatically stops
after `channels.ringer.previewDuration` seconds if not stopped first.
Starting a real ring (`startRinging()`) also stops any active preview.

| Name | Type   | Default                        | Description                                                    |
| ---- | ------ | ------------------------------- | --------------------------------------------------------------- |
| id   | string | `channels.ringer.selected`     | The id of an entry in `channels.ringer.files`                  |

> If the AudioContext can't be resumed (e.g. autoplay policy) or the ringtone
> fails to decode, the preview is
> automatically stopped (as if `stopRingtonePreview()` had been called) and
> `audioContext.ringtone.preview.error` is emitted, so `isRingtonePreviewActive()`
> and the render state never claim a preview is playing when it isn't.

#### stopRingtonePreview()

Stops any ringtone currently being previewed, with the same fade-out as
[stopAllRinging()](#stopallringing). The decoded buffer is released unless
the previewed ringtone is also the selected one.

#### toggleRingtonePreview(id)

If a preview is active, stops it; otherwise starts previewing `id` (see
`previewRingtone`).

#### isRingtonePreviewActive()

Return:

| Type    | Description                                    |
| ------- | ----------------------------------------------- |
| boolean | If true a ringtone preview is currently playing |

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
| object | `{ mode, deviceId, sampleRate }` - `mode` is `"context"` or `"element"`, `deviceId` is the device ring output is going to (read from whichever of the two owns the sink) with `""` meaning the browser default, and `sampleRate` is the AudioContext's rate in Hz |

#### updateRenders()

Re-paint / update all render targets.

## i18n

| Key           | Default (en)   | Description                                            |
| ------------- | -------------- | ------------------------------------------------------ |
| mastervolume  | Master Volume  | Used to label the master volume control element        |
| ringervolume  | Ringer Volume  | Used to label the ringing volume control element       |
| ringtone      | Ringtone       | Used to label the ringtone selection control element   |
| ringtonepreview | Preview      | Label for the ringtone preview button when idle         |
| ringtonepreviewstop | Stop    | Label for the ringtone preview button while previewing  |
| tonesvolume   | Tones Volume   | Used to label the DTMF (tones) volume control element  |
| previewvolume | Preview Volume | Used to label the preview volume control element       |
| remotevolume  | Call Volume    | Used to label the remote (call) volume control element |

## Configuration

| Name                                | Type     | Default | Description                                                                                                                                          |
| ----------------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| channels.master.show                | boolean  | true    | Should the default template show the master volume control                                                                                           |
| channels.master.volume              | float    | 1.0     | The initial volume of the master audio, where 0 is muted and 1 is 100%                                                                               |
| channels.ringer.show                | boolean  | true    | Should the default template show the ringer controls - the ringing volume control, the ringtone selector and the ringtone preview button             |
| channels.ringer.volume              | float    | 1.0     | The initial volume of the ringing audio, where 0 is muted and 1 is 100%                                                                              |
| channels.ringer.connectToMaster     | boolean  | true    | Connects `ringerGain` to `masterGain`, so the ringtone's volume is also scaled by the current master volume. **Leave this on:** `masterGain` is the only route to the ring output element, so setting it false does not merely unlink the two volumes, it disconnects the ringer from the output entirely and nothing is heard. (Same is true of `channels.preview.connectToMaster`; `remote` and `tones` have their own paths.) |
| channels.ringer.files               | array    | see below | Selectable ringtones bundled with the library: `[{ id, name, dataUri }, ...]`, generated from `assets/sounds/*.wav` by `npm run ringtones:build`. Config is merged with lodash `merge`, which merges arrays by index rather than replacing them - a shorter custom `files` array supplied via config will not fully remove the bundled defaults, it merges element-by-element against them. To fully replace the list, override every index (i.e. supply an array at least as long as the default). The defaults are copied per instance, so doing this affects only the instance you pass it to |
| channels.ringer.selected            | string   | `"ring01"` (falls back to the first entry in `channels.ringer.files` if that id isn't present) | Which ringtone is currently selected, by id. Change at runtime with `selectRingtone(id)`. Validated against `channels.ringer.files` on construction and on every `selectRingtone(id)` call, so this always resolves to a real bundled file |
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
| audioContext.ringtone.preview.started | id (string)                      | Emitted when previewRingtone() starts playing                          |
| audioContext.ringtone.preview.stopped |                                  | Emitted when a ringtone preview stops (manually or via timeout)        |
| audioContext.ringtone.play.error      | error, sink info (object)        | Emitted when startRinging() cannot play: either the AudioContext was not running (typically the browser's autoplay policy, still awaiting a user gesture) or the ringtone failed to decode - the Error message says which. The ring session itself is unaffected, this is purely informational, and if the context does resume later the ring is started then (see startAudioContext()). The second argument is [getOutputSinkInfo()](#getoutputsinkinfo), included so a failure to ring is diagnosable without a second round trip |
| audioContext.sink.changed             | sink info (object)               | Emitted when ring output moves to a different device in **context** mode, carrying [getOutputSinkInfo()](#getoutputsinkinfo). Not emitted in element mode - there the device belongs to the element and `mediaDevices.ring.output.changed` is the event to watch |
| audioContext.sink.error               | error                            | Emitted when the safety-net sync of the ring output sink fails (see [setRingOutputSinkId()](#setringoutputsinkiddeviceid)). A sink change requested through mediaDevices reports as `mediaDevices.ring.output.error` instead |
| audioContext.ringtone.preview.error   | error                            | Emitted when previewRingtone() cannot play, for the same two reasons and with the same Error messages - the preview is automatically stopped/rolled back (see stopRingtonePreview()) so the UI doesn't show "Stop" while nothing is playing. Unlike ringing, a preview is not retried if the context resumes later |
| audioContext.channel.tones.volume     | volume (integer between 0 and 1) | Emitted when the tones channel volume is updated                       |
| audioContext.channel.remote.volume    | volume (integer between 0 and 1) | Emitted when the remote channel volume is updated                      |
| audioContext.channel.preview.volume   | volume (integer between 0 and 1) | Emitted when the preview channel volume is updated                     |
| audioContext.stream.local.changed     | volume (integer between 0 and 1) | Emitted when the stream used for the preview loopback audio is updated |
| audioContext.stream.remote.changed    | volume (integer between 0 and 1) | Emitted when the stream used for the remote audio is updated           |

### Consumed

| Event                                   | Reason                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------- |
| call.ringing.started                    | Invokes startRinging() with the call's id                                 |
| call.ringing.stopped                    | Invokes stopRinging() with the call's id                                  |
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

### Data

### HTML
