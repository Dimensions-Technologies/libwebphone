# Kazoo Webphone library v2.0

The goal of this library is to turn the browser in a softphone, using the correct protocol depending on the browser used by the client. On supported browsers, the goal is to allow calls using WebRTC, ~~and to fall back on the RTMP
protocol if WebRTC is not supported by the browser.~~

The default export of [libwebphone.js](src/libwebphone.js) is a class that provides all access to the libraries functionality for an instance of a specific configuration.

The library provides multiple ways to interact with it. The quick start example configuration will render the default templates with the default behaviors. However, a developer can:

- Change the behavour via configuration alone (very extensive options)
- Render multiple and different but syncronized templates for any component
- Fully customize any/all component template(s)
- Use static HTML elements with event handlers to trigger appropriate libwebphone methods.
  - For example, the following onClick action for an HTML element representing the number 1 button on a dialpad `webphone.getDialpad().dial('1');`.
- Complete programatic actions.
  - For example, an onClick action for a "Contact 2600Hz" button `webphone.getUserAgent().call('+14158867900');`
- Purely event driven user experiences
- Change the internationalization via configuration
- Replace the internationalization engine
- Minimize the build or remove functionality by disabling unused classes
- Multiple instances of libwebphone on the same page, with different configurations
- A mix of any of these patterns!!!

## Quick Start

1. Clone the repo

```bash
      $ git clone https://github.com/2600hz/libwebphone.git
      $ cd libwebphone
```

2. Optionally, switch to a different branch.

```bash
      $ git checkout <branch|tag>
```

> New work is done on features branches which are named or reference a ticket (such as `git checkout videoCanvas` or `git checkout LWP-42`). Versions are developed on branches with the pattern `major.minor` (such as `git checkout 2.0`) and stable releases are available as tags with the pattern `major.minor.patch` (such as `git checkout 2.0.0`). The master branch represents the latest-greatest development work, but might be unstable.

3. Install the dependencies

```bash
      $ npm install
```

4. Copy the example configuration and fill in your own SIP details:

```bash
      $ cp config.example.json config.json
```

Edit `config.json` and set at least `userAgent.transport.sockets` (your SIP
server's websocket URL) and `userAgent.authentication.username`/`password`/
`realm`. `index.html` loads this file at runtime.

> NOTE: `config.json` is gitignored - it's expected to hold real credentials and should never be committed. `config.example.json` is the template that _is_ committed, so keep it free of real values if you add new options to it.

> NOTE: `username`, `password` and `realm` can also be left blank in `config.json` and entered via the lwpUserAgent default form in the browser instead (they'd need to be typed in before starting the user agent each time). However, `transport.sockets` must point at a real SIP server or the library will fail to start.

5. Start a continuous process that will build the library, rebuild if any source files are changed as well as a webserver to serve the artifacts. Once started it will print a URL to the screen that can be visted, only by the computer it was started on, in the browser to create an example / developer instance of the library.

```bash
      $ npm run dev
```

> NOTE: By default the webserver will be running at [http://localhost:8080/](http://localhost:8080/).

## Publishing

1. Build the library

```bash
      $ npm run build
```

2. Include the libwebphone build artifact on your website

```
         <script src="dist/libwebphone.js" type="text/javascript"></script>
```

3. Create an instance, providing a configuration object with all the minimal parameters for the features you require. A "simple kitchen sink" example might look like:

```
         <script type="text/javascript">
            var config = {
            dialpad: {
               renderTargets: ["dialpad"],
            },
            callList: {
               renderTargets: ["call_list"],
            },
            callControl: {
               renderTargets: ["call_control"],
            },
            mediaDevices: {
               renderTargets: ["media_devices"],
            },
            audioContext: {
               renderTargets: ["audio_context"],
            },
            userAgent: {
               transport: {
                  sockets: ["wss://sip.websocket.server"],
               },
               authentication: {
                  username: "sip-username",
                  password: "sip-password",
                  realm: "sip-realm",
               },
            },
            }; //End ofConfig

            var webphone = new libwebphone(config);
            webphone.getUserAgent().start();
         </script>
```

When using jwt authentication we just need to have jwt token in authentication section.
If jwt token is used, username and password will be ignored.

```
   authentication: {
      jwt: "jwt_token"
   },

```

> This assumes the HTML body will contain empty elements with the IDs "dialpad", "call_list", "call_control", "media_devices", "audio_context" and "user_agent" where the corresponding default elements should be generated by libwebphone.

## NPM Scripts

#### npm run dev

Build and automatically rebuild if any of the source files are changed. In addition, it starts a webpack-dev-server to serve the build artifacts for ease of development.

#### npm run watch

Build and automatically rebuild if any of the source files are changed.

#### npm run stats

Creates a 'stats.json' file on the root of the project detailing statistics regarding the webpack artifact for use by tools such as [webpack-visualizer](https://chrisbateman.github.io/webpack-visualizer/).

#### npm run build

Build and minimize the library for a production deployment.

#### npm run lint

Analyze the source code for programming and style issues.

#### npm run ringtones:build

Regenerates `src/lwpRingtones.js` from every `.wav` file in `assets/sounds/`, base64-encoding each one into the committed module consumed by `lwpAudioContext` (see [lwpAudioContext - Configuration](docs/lwpAudioContext.md#configuration)). Run this after adding, removing, or replacing files in `assets/sounds/`. See [Ringtones](#ringtones) below for the format new files need to follow.

## Ringtones

Ringtone files live in `assets/sounds/` and are bundled directly into the library at build time - `npm run ringtones:build` reads every `.wav` file there and inlines it as a base64 `data:` URI into `src/lwpRingtones.js`, so a ringtone plays with zero network requests and works identically whether libwebphone is loaded as `dist/libwebphone.js` or imported from source. This also means file size matters directly: every byte in `assets/sounds/` ends up duplicated (base64 is ~33% larger) in the shipped JS bundle. The 12 bundled ringtones currently total ~422KB of WAV, which is ~564KB of `src/lwpRingtones.js`.

The filename becomes the ringtone's id and display name automatically (`marimba-cascade.wav` - id `marimba-cascade`, name "Marimba Cascade"), so name files descriptively. A trailing digit run is split off and stripped of leading zeros, so the bundled `ring01.wav` - id `ring01`, name "Ring 1".

### Bundled ringtones (ring01-ring12)

| File | Duration | Pattern | Descriptive name |
| ---- | -------- | ------- | ----------------- |
| ring01.wav | 3.4s | 18 pulses, steady ~444Hz | Rapid Pulse (Original) |
| ring02.wav | 2.4s | 8 pulses, steady ~444Hz, smoother tone | Slow Pulse |
| ring03.wav | 2.0s | 2 notes, low-to-high leap (211-615Hz) | Classic Ring 1|
| ring04.wav | 2.0s | 2 notes, wider leap (195-800Hz) | Classic Ring 2 |
| ring05.wav | 2.0s | 11 pulses, steady ~471Hz, brighter tone | Classic Ring 3 |
| ring06.wav | 2.0s | 3 notes, sweeps 250-1000-250Hz | Sweep Rise |
| ring07.wav | 2.0s | 1 sustained tone, ~400Hz | Warble Alert |
| ring08.wav | 2.3s | 6 pulses, jumping 667/444/889Hz | Triple Chime |
| ring09.wav | 2.4s | 8 pulses, jumping 444/889/667Hz | Melodic Pulse |
| ring10.wav | 1.8s | 5 pulses, ascending run 533-1143Hz | Ascending Run |
| ring11.wav | 2.3s | 6 pulses, bouncing 444-667Hz | Bouncing Trill |
| ring12.wav | 2.4s | 1 pulse, noisy/non-tonal, low wandering pitch | X |

### Adding new ringtones

New files must be **just the loop content** - a single cycle, not the melody repeated or padded out to a fixed longer duration. Padding a short melody out to e.g. 10-12 seconds of repeated audio at full quality multiplies the file size for no audible benefit, since the app already loops the file continuously for the duration of the ring (as a looping `AudioBufferSourceNode`, which loops sample-accurately - a clean single cycle has no seam).

Target format for a new ringtone file:

- **Format:** WAV, PCM, 16-bit, mono, 8000Hz sample rate
- **Duration:** 1.5-4 seconds of actual audio content - exactly one loop cycle
- **Loop-ability:** clean start/end so the loop has no click or gap at the seam (a short ~10-15ms fade in/out helps)
- **Levels:** peak amplitude around 0.7-0.85 of full scale (leave headroom, don't clip) - final volume is scaled by the app at playback time
- **Content:** fully original synthesized audio - not derived from, based on, or an imitation of any real product's ringtone, and not containing any recognizable melody from an existing song

At these settings a typical file lands in roughly the 20-70KB range. If a ringtone specifically needs stereo movement (e.g. left/right panning or echo effects), use stereo at 11025Hz instead - this roughly doubles the file size for the same duration, so only use it when the effect actually requires it.

After adding, removing, or replacing files in `assets/sounds/`, run `npm run ringtones:build` to regenerate `src/lwpRingtones.js`.

## Components

The phone funtionality is implemented by classes that encapsulated the logic for a particular component, those are:

- [lwpUserAgent](docs/lwpUserAgent.md) : Provides all features for managing connecting and maintaining the SIP connection over websockets.
- [lwpMediaDevices](docs/lwpMediaDevices.md) : Provides all features for discovering and selecting the media device (microphone, camera and audio output destination)
- [lwpAudioContext](docs/lwpAudioContext.md) : Provides audio generation (ringing, DTMF playback, ect) as well as audio routing / mixing options
- [lwpCallList](docs/lwpCallList.md) : Provides a list of all active calls and allowes the user to switch between them
- [lwpConference](docs/lwpConference.md) : Provides local, browser-mixed ad-hoc conferencing for up to `maxParticipants` calls - merge, grow, hold, mute and split, with no server-side bridge or SDP renegotiation
- [lwpDialpad](docs/lwpDialpad.md) : Provides all features for collecting the target (dialed number) for new calls, transfers and in call DTMF
- [lwpCallControl](docs/lwpCallControl.md) : Provides all call control features such as hold, mute, transfer, redial, ect
- [lwpBLF](docs/lwpBLF.md) : Provides Busy Lamp Field monitoring - subscribes to other extensions' SIP dialog/presence state to track idle/ringing/in-call status

Each of these clases can be disabled via configuration (or modified build) if the provided functionality is not required or desired.

Internally, all calls are represented as an instance of the [lwpCall](docs/lwpCall.md) class.

Rendering is preformed by [lwpRenderer](docs/lwpRenderer.md). Generally, this can be ignored and simply provide the components with a `renderTarget` that is an array of HTML element ids on the document. The library will use a default template and configuration to create the necessary elements in each of the provided elements, but much more advanced options are available for extensive customizations.

> NOTE! Each of these classes is not expected to be created outside of the main libwebphone instance and are accessable using methods of the main instance or by consuming events.

## Methods

#### getCallControl()

Returns:

| Type                                             | Description                                                |
| ------------------------------------------------ | ---------------------------------------------------------- |
| null or [lwpCallControl](docs/lwpCallControl.md) | Provides access to the lwpCallControl instance if enabled. |

#### getCallList()

Returns:

| Type                                       | Description                                             |
| ------------------------------------------ | ------------------------------------------------------- |
| null or [lwpCallList](docs/lwpCallList.md) | Provides access to the lwpCallList instance if enabled. |

#### getDialpad()

Returns:

| Type                                     | Description                                            |
| ---------------------------------------- | ------------------------------------------------------ |
| null or [lwpDialpad](docs/lwpDialpad.md) | Provides access to the lwpDialpad instance if enabled. |

#### getUserAgent()

Returns:

| Type                                         | Description                                              |
| -------------------------------------------- | -------------------------------------------------------- |
| null or [lwpUserAgent](docs/lwpUserAgent.md) | Provides access to the lwpUserAgent instance if enabled. |

#### getMediaDevices()

Returns:

| Type                                               | Description                                                 |
| -------------------------------------------------- | ----------------------------------------------------------- |
| null or [lwpMediaDevices](docs/lwpMediaDevices.md) | Provides access to the lwpMediaDevices instance if enabled. |

#### getAudioContext()

Returns:

| Type                                               | Description                                                 |
| -------------------------------------------------- | ----------------------------------------------------------- |
| null or [lwpAudioContext](docs/lwpAudioContext.md) | Provides access to the lwpAudioContext instance if enabled. |

#### geti18n()

Provides direct access to the current i18n library or i18n instance.

Returns:

| Type                                | Description         |
| ----------------------------------- | ------------------- |
| [i18next](https://www.i18next.com/) | The i18next library |

#### i18nAddResourceBundles(className, resources)

Addes language resources namespaced to the provided module name.

| Name      | Type   | Description                                                                                                                       |
| --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| className | string | The name of the class, used to namespace the resources                                                                            |
| resources | object | A dictionary with keys representing the language name and values that are themselfs dictionaries of keys to the translated string |

Example resources object:

```javascript
{
   "en":{
      "answer":"Anwser",
      "redial":"Redial",
      "cancel":"Cancel",
      "hangup":"Hang Up",
      "hold":"Hold",
      "unhold":"Resume",
      "mute":"Mute",
      "unmute":"Unmute"
   },
   "fr":{
      "answer":"Répondre",
      "redial":"Recomposer",
      "cancel":"Annuler",
      "hangup":"Raccrocher",
      "hold":"Attente",
      "unhold":"Reprendre",
      "mute":"Muter",
      "unmute":"Rétablir"
   }
}
```

#### i18nAddResourceBundle(className, language, resource)

Addes language resources namespaced to the provided module name.

| Name      | Type   | Description                                            |
| --------- | ------ | ------------------------------------------------------ |
| className | string | The name of the class, used to namespace the resources |
| language  | string | The name of the lanuage                                |
| resource  | object | A dictionary of keys to the translated string          |

Example resource object (in this case `language` would be "en"):

```javascript
{
   "answer":"Anwser",
   "redial":"Redial",
   "cancel":"Cancel",
   "hangup":"Hang Up",
   "hold":"Hold",
   "unhold":"Resume",
   "mute":"Mute",
   "unmute":"Unmute"
}
```

#### i18nTranslator()

Provides a function, when ready, that given a i18n key returns the translated string from the loaded language bundles.

Returns:

| Type          | Description                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| function(key) | From the i18next documentation "You can specify either one key as a String or multiple keys as an Array of String. The first one that resolves will be returned." |

## i18n

Internationalization of the built in templates, or optionally utilized by custom templates, are loaded with language 'bundles' by each class instance during startup. These bundles are loaded with a namespace for that class. The default library used is [i18next](https://www.i18next.com/) but it is hoped that then implementation is generic enough to allow replacment with a prefered library or an existing on an a website.

For details of what translations are currently available see the individual class documentation "i18n" section.

## Configuration

| Name         | Type   | Default | Description                                                                |
| ------------ | ------ | ------- | -------------------------------------------------------------------------- |
| userAgent    | object | {}      | See [lwpUserAgent configuration](docs/lwpUserAgent.md#configuration)       |
| mediaDevices | object | {}      | See [lwpMediaDevices configuration](docs/lwpMediaDevices.md#configuration) |
| audioContext | object | {}      | See [lwpAudioContext configuration](docs/lwpAudioContext.md#configuration) |
| callList     | object | {}      | See [lwpCallList configuration](docs/lwpCallList.md#configuration)         |
| dialpad      | object | {}      | See [lwpDialpad configuration](docs/lwpDialpad.md#configuration)           |
| callControl  | object | {}      | See [lwpCallControl configuration](docs/lwpCallControl.md#configuration)   |
| call         | object | {}      | See [lwpCall configuration](docs/lwpCall.md#configuration)                 |
| conference   | object | {}      | See [lwpConference configuration](docs/lwpConference.md#configuration)     |
| blf          | object | {}      | See [lwpBLF configuration](docs/lwpBLF.md#configuration)                   |
| codecPreferences | object | {} | Restricts/reorders which codecs are offered in outbound call SDP - not namespaced under `call`, see [lwpCall - Codec Preferences](docs/lwpCall.md#codec-preferences) |

## Events

All events produced by libwebphone are emitted with a minimum of two parameters. The first is always the instance of libwebphone and the second is the instance of the class producing the event. For example, the first two parameters of the event "mediaDevices.created" are the libwebphone instance and the lwpMediaDevices instance. Further, all events are in dot notation beginning with the emitting class "name". In the above example, "mediaDevices.created" was emitted by lwpMediaDevices.

Some events provide more parameters and are detailed on the corresponding documents as "Additional Parameters". This column is a comma sepearted list of arguments that are present after the libwebphone and producing class instance parameters.

At any given time only one instance of a call (lwpCall) will be the primary (current user selected call). When the primary lwpCall instance emits events they will be published with the normal prefix "call." as well as with "call.primary.".

Further, all events are emitted using [EventEmitter2](https://github.com/EventEmitter2/EventEmitter2) which according to their documentation:

> In addition to having a better benchmark performance than EventEmitter and being browser-compatible, it also extends the interface of EventEmitter with many additional non-breaking features.

Some of these additional features include events when listeners are added / removed, wildcard bindings and functions such as `waitFor(event, timeout)` or `onAny(listener)`. See the documentation for EventEmitter2 for details.

### Emitted

| Event                 | Additional Parameters        | Description                                              |
| --------------------- | ---------------------------- | -------------------------------------------------------- |
| created               |                              | Emitted when all required classes have been instantiated |
| language.bundle.added | language (string), bundle () | Emitted when a new language bundle is added              |
| language.changed      | translator (function)        | Emitted when the translator function is ready or changed |

## Todo

- Standardize and cleanup i18n keys
- Add 'remeber me' feature to lwpUserAgent form
- Add entry of websocket to lwpUserAgent form
- Standardize default templates and add default CSS classes
- lwpVideoCanvas : Nearly complete class to render and control video aspects of calls
- Support multiple instances of lwpUserAgent to provide "multi-line" functionality.
- lwpPreviews : All the functionality around "early" previews of device selections and testing
- lwpKazoo : Base class for all classes interacting with Kazoo as well as maintaining Kazoo websocket connections
- lwpKazooDevices : Select a device to use in lwpUserAgent from a filtered list of available devices as well as optional create when missing
- lwpKazooParked: Maintains a list of all parked calls, allow rapid retrieval / parking as well as annotate parked calls
- lwpKazooConferences : Maintains a list of confernences, current conference status, rapid conference access
- lwpKazooConferenceControls : In conference controls (similar to lwpCallControls but specific to Kazoo conferences)
- lwpKazooVoicemails : Provides MWI, rapid voicemail access and rapid voicemail message callback
- lwpKazooUsers : Create a filtered list of Kazoo users and presence status as well as quick dial options
- lwpKazooCDRs : Used to list and rapidly redial previous calls

## Contact

If you have any question or remark about the library or its documentation, feel free to come talk to us on IRC #2600hz on FreeNode.
