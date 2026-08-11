"use strict";

import lwpUtils from "./lwpUtils";
import lwpRenderer from "./lwpRenderer";
import lwpRingtones from "./lwpRingtones";

export default class extends lwpRenderer {
  constructor(libwebphone, config = {}) {
    super(libwebphone);
    this._libwebphone = libwebphone;
    this._emit = this._libwebphone._audioContextEvent;
    this._initProperties(config);
    this._initInternationalization(config.i18n || {});
    this._initOutputAudio();
    this._initRingAudio();
    this._initTonesAudio();
    this._initPreviewAudio();
    this._initRemoteAudio();
    this._initEventBindings();
    this._initRenderTargets();
    this._emit("created", this);
    return this;
  }

  // Resolves to whether the context is actually running; callers that just
  // want to nudge it awake can ignore the return value.
  startAudioContext() {
    return this._resumeAudioContext().then((running) => {
      // Only announce "started" once audio can genuinely play - _started is a
      // one-shot latch, so a listener that ran while output was still blocked
      // (mediaDevices._startMediaElements()) would never get a second chance.
      // Gating it here makes every call a fresh attempt until one succeeds.
      if (running && !this._started) {
        this._started = true;

        this._emit("started", this);
      }

      return running;
    });
  }

  isAudioContextRunning() {
    return this._audioContext.state === "running";
  }

  startPreviewTone() {
    if (this.isPreviewToneActive()) {
      return;
    }

    this.startAudioContext();

    this._previewAudio.toneActive = true;
    this._previewAudio.oscillatorNode = this._shimCreateOscillator(
      this._previewAudio.context
    );
    this._previewAudio.oscillatorNode.frequency.value =
      this._config.channels.preview.tone.frequency;
    this._previewAudio.oscillatorNode.type =
      this._config.channels.preview.tone.type;
    this._previewAudio.oscillatorNode.connect(
      this._getOutputGainNode("preview")
    );
    this._previewAudio.oscillatorNode.start();

    this._emit("preview.tone.started", this);
  }

  stopPreviewTone() {
    if (!this.isPreviewToneActive()) {
      return;
    }

    this._previewAudio.toneActive = false;
    this._previewAudio.oscillatorNode.stop();
    this._previewAudio.oscillatorNode.disconnect();
    this._previewAudio.oscillatorNode = null;

    this._emit("preview.tone.stopped", this);
  }

  togglePreviewTone() {
    if (this.isPreviewToneActive()) {
      this.stopPreviewTone();
    } else {
      this.startPreviewTone();
    }
  }

  isPreviewToneActive() {
    return this._previewAudio.toneActive;
  }

  startPreviewLoopback() {
    if (this.isPreviewLoopbackActive()) {
      return;
    }

    this.startAudioContext();

    this._previewAudio.loopbackActive = true;
    this._previewAudio.loopbackDelayNode.connect(
      this._getOutputGainNode("preview")
    );

    this._emit("preview.loopback.started", this);
  }

  stopPreviewLoopback() {
    if (!this.isPreviewLoopbackActive()) {
      return;
    }

    this._previewAudio.loopbackActive = false;
    this._previewAudio.loopbackDelayNode.disconnect();

    this._emit("preview.loopback.stopped", this);
  }

  togglePreviewLoopback() {
    if (this.isPreviewLoopbackActive()) {
      this.stopPreviewLoopback();
    } else {
      this.startPreviewLoopback();
    }
  }

  isPreviewLoopbackActive() {
    return this._previewAudio.loopbackActive;
  }

  stopPreviews() {
    this.stopPreviewTone();
    this.stopPreviewLoopback();
  }

  getVolume(channel, options = { scale: true, relativeToMaster: false }) {
    let volume = 0;

    if (this._config.channels[channel]) {
      volume = this._config.channels[channel].volume;
    }

    if (options.relativeToMaster) {
      volume *= this._config.channels.master.volume;
    }

    if (options.scale) {
      volume *= this._config.volumeMax;
    }

    return volume;
  }

  changeVolume(channel, volume, options = {}) {
    const gainNode = this._getOutputGainNode(channel);

    this.startAudioContext();

    if (!Object.prototype.hasOwnProperty.call(options, "scale")) {
      if (volume > 1) {
        options.scale = true;
      } else {
        options.scale = false;
      }
    }

    if (options.scale) {
      volume = volume / this._config.volumeMax;
    }

    if (volume < 0) {
      volume = 0;
    }

    if (volume > 1) {
      volume = 1;
    }

    if (this._config.channels[channel]) {
      this._config.channels[channel].volume = volume;
      this._emit("channel." + channel + ".volume", this, volume);
    }

    if (gainNode) {
      // Ramped, not assigned: writing .value steps the gain in a single
      // sample, which clicks against anything already playing - reachable by
      // dragging a volume slider mid-ring.
      const context = this._audioContext;

      if (context.state == "running") {
        gainNode.gain.setTargetAtTime(volume, context.currentTime, 0.015);
      } else {
        // A suspended clock is frozen, so a ramp would never advance - and
        // nothing is audible to click anyway.
        gainNode.gain.value = volume;
      }
    }
  }

  playTones(...tones) {
    if (!tones.length) {
      return;
    }

    this.startAudioContext();

    const duration = this._config.channels.tones.duration;
    const sampleRate = this._tonesAudio.context.sampleRate;
    const buffer = this._shimCreateBuffer(
      this._tonesAudio.context,
      tones.length,
      sampleRate,
      sampleRate
    );

    for (let index = 0; index < tones.length; index++) {
      const channel = buffer.getChannelData(index);
      for (let i = 0; i < duration * sampleRate; i++) {
        channel[i] = Math.sin(2 * Math.PI * tones[index] * (i / sampleRate));
      }
    }

    const bufferSource = this._shimCreateBufferSource(this._tonesAudio.context);
    bufferSource.buffer = buffer;
    bufferSource.connect(this._getOutputGainNode("tones"));
    bufferSource.start();

    setTimeout(() => {
      bufferSource.disconnect();
      bufferSource.stop();
    }, (duration + 0.5) * 1000);
  }

  startRinging(requestId = null) {
    this.startAudioContext();

    if (this.isRingtonePreviewActive()) {
      this.stopRingtonePreview();
    }

    if (!requestId) {
      this._ringerAudio.calls.push(null);
    } else if (!this._ringerAudio.calls.includes(requestId)) {
      this._ringerAudio.calls.push(requestId);
    }

    // Read once per ring session, so a selectRingtone() during a ring takes
    // effect from the next one rather than swapping mid-ring.
    if (!this._ringerAudio.ringerConnected) {
      this._ringerAudio.ringerConnected = true;
      this._startRinging();
    }
  }

  stopRinging(requestId = null) {
    if (!requestId) {
      requestId = null;
    }

    const requestIndex = this._ringerAudio.calls.indexOf(requestId);

    if (requestIndex != -1) {
      this._ringerAudio.calls.splice(requestIndex, 1);
    }

    if (this._ringerAudio.calls.length == 0) {
      this.stopAllRinging();
    }
  }

  stopAllRinging() {
    this._ringerAudio.calls = [];

    // Invalidates any _startRinging() still awaiting a resume/decode, so a
    // ring cancelled before it becomes audible can't start afterwards.
    this._ringerAudio.generation++;

    if (this._ringerAudio.ringerConnected) {
      this._ringerAudio.ringerConnected = false;

      this._stopRingerSource(this._ringerAudio.playing);
      this._ringerAudio.playing = null;
    }

    // Warm the next ring's buffer, picking up any mid-ring selection.
    this._ensureRingtoneBuffer(this._config.channels.ringer.selected);
  }

  getRingtones() {
    return this._config.channels.ringer.files.map((file) => {
      return { id: file.id, name: file.name };
    });
  }

  getSelectedRingtone() {
    return this._config.channels.ringer.selected;
  }

  selectRingtone(id) {
    if (!this._findRingtone(id)) {
      return;
    }

    if (this.isRingtonePreviewActive()) {
      this.stopRingtonePreview();
    }

    this._config.channels.ringer.selected = id;

    // Decode ahead so an incoming call rings without waiting on
    // decodeAudioData. Safe mid-ring - the ringing source holds its own
    // buffer, so this only warms the cache for the next one.
    this._ensureRingtoneBuffer(id);

    this._emit("channel.ringer.selected", this, id);
    this.updateRenders();
  }

  previewRingtone(id = null) {
    const ringtoneId = id || this._config.channels.ringer.selected;
    const ringtone = this._findRingtone(ringtoneId);

    if (!ringtone) {
      // Validated before touching any existing preview - a bad id shouldn't
      // kill what's already playing.
      return;
    }

    if (this.isRingtonePreviewActive()) {
      this.stopRingtonePreview();
    }

    this.startAudioContext();

    // Guards the async start below against a stale attempt - another preview,
    // or a stop, landing before the resume/decode settles.
    this._ringerAudio.previewToken = (this._ringerAudio.previewToken || 0) + 1;
    const previewToken = this._ringerAudio.previewToken;

    this._ringerAudio.previewActive = true;
    this._ringerAudio.previewId = ringtoneId;

    Promise.all([
      this._resumeAudioContext(),
      this._ensureRingtoneBuffer(ringtoneId),
    ]).then(([running, buffer]) => {
      if (this._ringerAudio.previewToken !== previewToken) {
        return;
      }

      if (running && buffer) {
        this._ringerAudio.previewPlaying = this._createRingerSource(buffer);

        return;
      }

      // Roll back, so the toggle doesn't show "Stop" with nothing playing.
      this.stopRingtonePreview();
      this._emit(
        "ringtone.preview.error",
        this,
        new Error(
          running
            ? "ringtone could not be decoded"
            : "AudioContext is not running"
        )
      );
    });

    // So a forgotten preview never loops indefinitely in the background.
    this._ringerAudio.previewTimer = setTimeout(() => {
      this.stopRingtonePreview();
    }, this._config.channels.ringer.previewDuration * 1000);

    this._emit("ringtone.preview.started", this, ringtoneId);
    this.updateRenders();
  }

  stopRingtonePreview() {
    if (!this.isRingtonePreviewActive()) {
      return;
    }

    // Invalidate any pending start - see previewRingtone().
    this._ringerAudio.previewToken = (this._ringerAudio.previewToken || 0) + 1;

    if (this._ringerAudio.previewTimer) {
      clearTimeout(this._ringerAudio.previewTimer);
      this._ringerAudio.previewTimer = null;
    }

    this._ringerAudio.previewActive = false;
    this._ringerAudio.previewId = null;

    this._stopRingerSource(this._ringerAudio.previewPlaying);
    this._ringerAudio.previewPlaying = null;

    // The previewed buffer is unreachable now unless it's also the selected
    // one.
    this._pruneRingtoneBuffers();

    this._emit("ringtone.preview.stopped", this);
    this.updateRenders();
  }

  toggleRingtonePreview(id = null) {
    if (this.isRingtonePreviewActive()) {
      this.stopRingtonePreview();
    } else {
      this.previewRingtone(id);
    }
  }

  isRingtonePreviewActive() {
    return !!this._ringerAudio.previewActive;
  }

  // True from the moment startRinging() is called, including while the resume
  // or decode is still pending and nothing is audible yet.
  isRinging() {
    return !!this._ringerAudio.ringerConnected;
  }

  getDestinationStream() {
    return this._outputAudio.destinationStream.stream;
  }

  getContext() {
    return this._audioContext;
  }

  // Whether the context owns the ring output sink rather than the ringoutput
  // element - see _initOutputAudio(). lwpMediaDevices uses this to pick which
  // of the two to call setSinkId on.
  usesContextSink() {
    return !!this._outputAudio.usingContextSink;
  }

  // Points ring output at a device. In element mode the sink belongs to the
  // ringoutput element, so this is a no-op.
  setRingOutputSinkId(deviceId) {
    if (!this.usesContextSink()) {
      return Promise.resolve(false);
    }

    const sinkId = this._normalizeSinkId(deviceId);

    return Promise.resolve()
      .then(() => {
        return this._audioContext.setSinkId(sinkId);
      })
      .then(() => {
        this._outputAudio.sinkId = sinkId;

        this._emit("sink.changed", this, this.getOutputSinkInfo());

        return true;
      });
  }

  // Where ring output is going, and at what rate. Exposed for diagnosis: a
  // rate that disagrees with the device's is audible as detuning (see
  // _shimAudioContext) but otherwise invisible to a host application.
  getOutputSinkInfo() {
    return {
      mode: this.usesContextSink() ? "context" : "element",
      // In element mode the sink belongs to the element, so read it there -
      // _outputAudio.sinkId only ever tracks the context's own.
      deviceId: this.usesContextSink()
        ? this._outputAudio.sinkId
        : this._getRingOutputElementSinkId(),
      sampleRate: this._audioContext.sampleRate,
    };
  }

  updateRenders() {
    this.render((render) => {
      render.data = this._renderData(render.data);
      return render;
    });
  }

  /** Init functions */

  _initInternationalization(config) {
    const defaults = {
      en: {
        mastervolume: "Master Volume",
        ringervolume: "Ringer Volume",
        ringtone: "Ringtone",
        ringtonepreview: "Preview",
        ringtonepreviewstop: "Stop",
        tonesvolume: "Tones Volume",
        previewvolume: "Preview Volume",
        remotevolume: "Call Volume",
      },
    };
    const resourceBundles = lwpUtils.merge(
      defaults,
      config.resourceBundles || {}
    );
    this._libwebphone.i18nAddResourceBundles("audioContext", resourceBundles);
  }

  _initProperties(config) {
    const defaults = {
      channels: {
        master: {
          show: true,
          volume: 1.0,
        },
        ringer: {
          // Copied, never the imported array itself: lwpUtils.merge() mutates
          // its first argument, so a host supplying channels.ringer.files
          // would corrupt the shared module array for every later instance.
          // Entries are flat, so a shallow copy of each is enough.
          files: lwpRingtones.map((file) => {
            return { ...file };
          }),
          // Validated against `files` after the config merge below, in case a
          // host app passes a bad id.
          selected: lwpRingtones.find((file) => file.id === "ring01")
            ? "ring01"
            : lwpRingtones.length > 0
            ? lwpRingtones[0].id
            : null,
          // How long previewRingtone() plays before auto-stopping itself
          previewDuration: 8,
          // Seconds. These avoid the click a hard start/stop makes
          // mid-waveform, not a stylistic fade - keep them imperceptible.
          // Interpolated per sample by the audio thread, so 20ms is genuinely
          // smooth and doesn't need to be longer to be clean.
          fadeIn: 0.01,
          fadeOut: 0.02,
          show: true,
          volume: 1.0,
          connectToMaster: true,
        },
        tones: {
          duration: 0.15,
          show: true,
          volume: 0.15,
          connectToMaster: true,
        },
        remote: {
          show: true,
          volume: 1.0,
          connectToMaster: false,
        },
        preview: {
          loopback: {
            delay: 0.5,
          },
          tone: {
            frequency: 440,
            duration: 1.5,
            type: "sine",
          },
          show: true,
          volume: 1.0,
          connectToMaster: true,
        },
      },
      globalKeyShortcuts: true,
      keys: {
        arrowup: {
          enabled: true,
          action: () => {
            this.changeVolume(
              "master",
              this._config.channels.master.volume + 0.05,
              { scale: false }
            );
          },
        },
        arrowdown: {
          enabled: true,
          action: () => {
            this.changeVolume(
              "master",
              this._config.channels.master.volume - 0.05,
              { scale: false }
            );
          },
        },
      },
      renderTargets: [],
      volumeMax: 100,
      volumeMin: 0,
    };
    this._config = lwpUtils.merge(defaults, config);

    // lwpUtils.merge overwrites with an explicit `null` (unlike `undefined`,
    // which it skips), and _findRingtone() assumes an array.
    if (!Array.isArray(this._config.channels.ringer.files)) {
      this._config.channels.ringer.files = [];
    }

    // Guarantee a valid ringtone is always selected, even if a host app
    // passed a bad/stale id directly via config.
    if (!this._findRingtone(this._config.channels.ringer.selected)) {
      this._config.channels.ringer.selected =
        this._config.channels.ringer.files.length > 0
          ? this._config.channels.ringer.files[0].id
          : null;
    }

    this._audioContext = this._shimAudioContext();
  }

  _initOutputAudio() {
    const mediaDevices = this._libwebphone.getMediaDevices();

    this._outputAudio = {};

    this._outputAudio.context = this._audioContext;

    this._outputAudio.masterGain = this._shimCreateGain(
      this._outputAudio.context
    );
    this._outputAudio.masterGain.gain.value =
      this._config.channels.master.volume;

    // Every ring plays through this node as a decoded AudioBuffer - there is
    // no <audio> element path for ringing.
    this._outputAudio.ringerGain = this._shimCreateGain(
      this._outputAudio.context
    );
    this._outputAudio.ringerGain.gain.value =
      this._config.channels.ringer.volume;
    if (this._config.channels.ringer.connectToMaster) {
      this._outputAudio.ringerGain.connect(this._outputAudio.masterGain);
    }

    this._outputAudio.tonesGain = this._shimCreateGain(
      this._outputAudio.context
    );
    this._outputAudio.tonesGain.gain.value = this._config.channels.tones.volume;

    this._outputAudio.remoteGain = this._shimCreateGain(
      this._outputAudio.context
    );
    this._outputAudio.remoteGain.gain.value =
      this._config.channels.remote.volume;
    if (
      this._config.channels.remote.connectToMaster &&
      this._libwebphone._config.call.useAudioContext
    ) {
      this._outputAudio.remoteGain.connect(this._outputAudio.masterGain);
    }

    this._outputAudio.previewGain = this._shimCreateGain(
      this._outputAudio.context
    );
    this._outputAudio.previewGain.gain.value =
      this._config.channels.preview.volume;
    if (this._config.channels.preview.connectToMaster) {
      this._outputAudio.previewGain.connect(this._outputAudio.masterGain);
    }

    // Ringer, preview, remote -> masterGain -> ring output, by one of two
    // routes.
    //
    // Where AudioContext.setSinkId exists (Chrome/Edge 110+) masterGain goes
    // straight to context.destination and lwpMediaDevices sets the device on
    // the *context*. Preferred: it drops the MediaStream -> <audio> hand-off,
    // and with it the detuning that hand-off causes when the context's sample
    // rate and the device's disagree (see _shimAudioContext).
    //
    // Firefox and Safari fall back to piping masterGain through a MediaStream
    // to the ringoutput element, the only way they can honour a device
    // selection at all. Neither detunes, so the fallback costs them nothing.
    this._outputAudio.usingContextSink =
      typeof this._audioContext.setSinkId == "function";

    this._outputAudio.sinkId = "";

    // Created in both modes: getDestinationStream() is public API a host app
    // may be tapping. In context-sink mode nothing plays it, so it is only a
    // passive tap and can't double up on what reaches the speakers.
    this._outputAudio.destinationStream =
      this._shimCreateMediaStreamDestination(this._outputAudio.context);
    this._outputAudio.masterGain.connect(this._outputAudio.destinationStream);

    // Tones get their own stream to the audiooutput element (speaker), like
    // call audio, and stay there in both modes: a context has one sink, and
    // these go to the speaker device rather than the ring device. Detuning
    // synthesised keypress feedback is of no consequence.
    this._outputAudio.tonesDestinationStream =
      this._shimCreateMediaStreamDestination(this._outputAudio.context);
    this._outputAudio.tonesGain.connect(
      this._outputAudio.tonesDestinationStream
    );

    const ringerElement = mediaDevices
      ? mediaDevices.getMediaElement("ringoutput")
      : null;

    if (this._outputAudio.usingContextSink) {
      this._outputAudio.masterGain.connect(
        this._outputAudio.context.destination
      );
      this._outputAudio.usingAudioElement = false;
    } else if (ringerElement) {
      ringerElement.srcObject = this._outputAudio.destinationStream.stream;
      this._outputAudio.usingAudioElement = true;
    } else {
      this._outputAudio.masterGain.connect(
        this._outputAudio.context.destination
      );
      this._outputAudio.usingAudioElement = false;
    }

    if (mediaDevices) {
      const speakerElement = mediaDevices.getMediaElement("audiooutput");
      if (speakerElement) {
        speakerElement.srcObject =
          this._outputAudio.tonesDestinationStream.stream;
        speakerElement.volume = this._config.channels.master.volume;
      }
    }
  }

  _initRingAudio() {
    this._ringerAudio = {};

    this._ringerAudio.calls = [];

    this._ringerAudio.ringerConnected = false;

    // Decoded AudioBuffers keyed by ringtone id (see _ensureRingtoneBuffer),
    // pruned to just what's reachable - these are expensive to hold.
    this._ringerAudio.buffers = {};

    // The source/envelope pair currently ringing.
    this._ringerAudio.playing = null;

    // Invalidates an in-flight _startRinging() whose resume/decode hasn't
    // settled yet - see stopAllRinging().
    this._ringerAudio.generation = 0;

    this._ringerAudio.previewActive = false;
    this._ringerAudio.previewId = null;
    this._ringerAudio.previewPlaying = null;
    this._ringerAudio.previewTimer = null;
    this._ringerAudio.previewToken = 0;

    this._ensureRingtoneBuffer(this._config.channels.ringer.selected);
  }

  _initTonesAudio() {
    this._tonesAudio = {};

    this._tonesAudio.context = this._audioContext;
  }

  _initRemoteAudio() {
    this._remoteAudio = {};

    this._remoteAudio.context = this._audioContext;

    this._remoteAudio.sourceStream = null;
  }

  _initPreviewAudio() {
    this._previewAudio = {};

    this._previewAudio.context = this._audioContext;

    this._previewAudio.sourceStream = null;

    this._previewAudio.toneActive = false;

    // Not created here: made fresh (and discarded) per startPreviewTone() /
    // stopPreviewTone() so nothing oscillates in the background while the
    // preview tone isn't playing.
    this._previewAudio.oscillatorNode = null;

    this._previewAudio.loopbackActive = false;

    this._previewAudio.loopbackDelayNode = this._shimCreateDelay(
      this._previewAudio.context,
      this._config.channels.preview.loopback.delay + 1.5
    );
    this._previewAudio.loopbackDelayNode.delayTime.value =
      this._config.channels.preview.loopback.delay;
  }

  _initEventBindings() {
    this._libwebphone.on("call.ringing.started", (lwp, call) => {
      this.startRinging(call.getId());
    });
    this._libwebphone.on("call.ringing.stopped", (lwp, call) => {
      this.stopRinging(call.getId());
    });

    this._libwebphone.on(
      "call.primary.remote.audio.added",
      (lwp, call, track) => {
        this._createRemoteSourceStream(track.mediaStream);
      }
    );

    this._libwebphone.on(
      "call.primary.remote.mediaStream.connect",
      (lwp, call, mediaStream) => {
        this._createRemoteSourceStream(mediaStream);
      }
    );

    this._libwebphone.on("dialpad.tones.play", (lwp, dialpad, tones) => {
      this.playTones.apply(this, tones);
    });

    this._libwebphone.on(
      "mediaDevices.streams.started",
      (lwp, mediaDevices, mediaStream) => {
        this._createLocalSourceStream(mediaStream);
      }
    );
    this._libwebphone.on("mediaDevices.devices.loaded", () => {
      this._syncRingOutputSink();
    });

    this._libwebphone.on("mediaDevices.streams.stopped", () => {
      this._connectLocalSourceStream();
    });
    this._libwebphone.on(
      "mediaDevices.audio.input.changed",
      (lwp, mediaDevices, track) => {
        this._createLocalSourceStream(track.mediaStream);
      }
    );

    if (this._config.globalKeyShortcuts) {
      document.addEventListener("keydown", (event) => {
        if (event.target != document.body) {
          return;
        }

        switch (event.key) {
          case "ArrowUp":
            if (this._config.keys["arrowup"].enabled) {
              this._config.keys["arrowup"].action(event, this);
            }
            break;
          case "ArrowDown":
            if (this._config.keys["arrowdown"].enabled) {
              this._config.keys["arrowdown"].action(event, this);
            }
            break;
        }
      });
    }

    // Browsers keep the context suspended until the user interacts, and with
    // no <audio> fallback for ringing an inbound call before any interaction
    // would simply be silent. So claim the first interaction anywhere in the
    // document rather than waiting on this class's own entry points.
    //
    // Capture phase so a handler that stops propagation can't hide the
    // gesture. Deliberately not `{once: true}`: a gesture only gets us as far
    // as *attempting* the resume, which can still fail (see
    // _resumeAudioContext), so these stay until one is confirmed running.
    const gestureEvents = ["click", "touchend", "keydown"];
    const onGesture = () => {
      this.startAudioContext().then((running) => {
        if (!running) {
          return;
        }

        gestureEvents.forEach((eventName) => {
          document.removeEventListener(eventName, onGesture, {
            capture: true,
          });
        });
      });
    };

    gestureEvents.forEach((eventName) => {
      document.addEventListener(eventName, onGesture, { capture: true });
    });

    // Last line of defence for the resume race: _resumeAudioContext() can
    // only wait briefly, so a resume completing just after that deadline
    // leaves _startRinging() having already given up, and the call would stay
    // silent for its whole duration. Pick anything still wanted back up when
    // the context genuinely reaches "running".
    this._onAudioContextStateChange = () => {
      if (this._audioContext.state !== "running") {
        return;
      }

      if (!this._started) {
        this._started = true;

        this._emit("started", this);
      }

      // Ring session still open but nothing playing - the earlier attempt
      // gave up before the context was ready.
      if (this._ringerAudio.ringerConnected && !this._ringerAudio.playing) {
        this._startRinging();
      }

      // A preview that reported "not running" rolled itself back, so there's
      // nothing to resume - only ringing recovers here.
    };

    if (typeof this._audioContext.addEventListener == "function") {
      this._audioContext.addEventListener(
        "statechange",
        this._onAudioContextStateChange
      );
    } else {
      // Pre-EventTarget AudioContext implementations only expose the handler
      // property.
      this._audioContext.onstatechange = this._onAudioContextStateChange;
    }

    this._libwebphone.on("audioContext.channel.master.volume", (lwp, audioContext, volume) => {
      const mediaDevices = this._libwebphone.getMediaDevices();
      if (mediaDevices) {
        const speakerElement = mediaDevices.getMediaElement("audiooutput");
        if (speakerElement) {
          speakerElement.volume = volume;
        }
      }
      this.updateRenders();
    });
    this._libwebphone.on("audioContext.channel.ringer.volume", () => {
      // Nothing to sync by hand: changeVolume() writes straight to ringerGain,
      // and master scaling comes free from ringerGain -> masterGain.
      this.updateRenders();
    });
    this._libwebphone.on("audioContext.channel.tones.volume", () => {
      this.updateRenders();
    });
    this._libwebphone.on("audioContext.channel.preview.volume", () => {
      this.updateRenders();
    });
    this._libwebphone.on("audioContext.channel.remote.volume", () => {
      this.updateRenders();
    });
  }

  _initRenderTargets() {
    this._config.renderTargets.map((renderTarget) => {
      return this.renderAddTarget(renderTarget);
    });
  }

  /** Render Helpers */

  _renderDefaultConfig() {
    return {
      template: this._renderDefaultTemplate(),
      i18n: {
        mastervolume: "libwebphone:audioContext.mastervolume",
        ringervolume: "libwebphone:audioContext.ringervolume",
        ringtone: "libwebphone:audioContext.ringtone",
        ringtonepreview: "libwebphone:audioContext.ringtonepreview",
        ringtonepreviewstop: "libwebphone:audioContext.ringtonepreviewstop",
        tonesvolume: "libwebphone:audioContext.tonesvolume",
        previewvolume: "libwebphone:audioContext.previewvolume",
        remotevolume: "libwebphone:audioContext.remotevolume",
      },
      by_id: {
        mastervolume: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              this.changeVolume("master", element.value);
            },
          },
        },
        ringervolume: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              this.changeVolume("ringer", element.value);
            },
          },
        },
        ringtone: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              if (element.options) {
                const ringtoneId = element.options[element.selectedIndex].value;
                this.selectRingtone(ringtoneId);
              }
            },
          },
        },
        ringtonepreview: {
          events: {
            onclick: () => {
              this.toggleRingtonePreview();
            },
          },
        },
        tonesvolume: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              this.changeVolume("tones", element.value);
            },
          },
        },
        previewvolume: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              this.changeVolume("preview", element.value);
            },
          },
        },
        remotevolume: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              this.changeVolume("remote", element.value);
            },
          },
        },
      },
      data: this._renderConfigData(),
    };
  }

  // Deep-clones config for the template, excluding channels.ringer.files
  // (base64 audio) from the clone itself rather than stripping it afterward:
  // the template only reads the lightweight data.ringtones list, so cloning
  // hundreds of KB of audio per render target would be pure waste.
  _renderConfigData() {
    // Computed first, while `files` is still intact - getRingtones() (via
    // _renderData -> data.ringtones) needs the real list.
    const renderData = this._renderData();
    const ringtoneFiles = this._config.channels.ringer.files;

    this._config.channels.ringer.files = [];

    // finally, so a throw out of merge() can't leave the config permanently
    // stripped of its ringtones.
    try {
      return lwpUtils.merge({}, this._config, renderData);
    } finally {
      this._config.channels.ringer.files = ringtoneFiles;
    }
  }

  _renderDefaultTemplate() {
    return `
        <div>
          {{#data.channels.master.show}}
            <div>
              <label for="{{by_id.mastervolume.elementId}}">
                {{i18n.mastervolume}}
              </label>
              <input type="range" min="{{data.volume.min}}" max="{{data.volume.max}}" value="{{data.volumes.master}}" id="{{by_id.mastervolume.elementId}}">
            </div>
          {{/data.channels.master.show}}

          {{#data.channels.ringer.show}}
            <div>
              <label for="{{by_id.ringervolume.elementId}}">
                {{i18n.ringervolume}}
              </label>
              <input type="range" min="{{data.volume.min}}" max="{{data.volume.max}}" value="{{data.volumes.ringer}}" id="{{by_id.ringervolume.elementId}}">
            </div>
          {{/data.channels.ringer.show}}

          {{#data.channels.tones.show}}
            <div>
              <label for="{{by_id.tonesvolume.elementId}}">
                {{i18n.tonesvolume}}
              </label>
              <input type="range" min="{{data.volume.min}}" max="{{data.volume.max}}" value="{{data.volumes.tones}}" id="{{by_id.tonesvolume.elementId}}">
            </div>
          {{/data.channels.tones.show}}

          {{#data.channels.preview.show}}
            <div>
              <label for="{{by_id.previewvolume.elementId}}">
                {{i18n.previewvolume}}
              </label>
              <input type="range" min="{{data.volume.min}}" max="{{data.volume.max}}" value="{{data.volumes.preview}}" id="{{by_id.previewvolume.elementId}}">
            </div>
          {{/data.channels.preview.show}}          

          {{#data.channels.remote.show}}
            <div>
              <label for="{{by_id.remotevolume.elementId}}">
                {{i18n.remotevolume}}
              </label>
              <input type="range" min="{{data.volume.min}}" max="{{data.volume.max}}" value="{{data.volumes.remote}}" id="{{by_id.remotevolume.elementId}}">
            </div>
          {{/data.channels.remote.show}}

          {{#data.channels.ringer.show}}
            <div>
              <label for="{{by_id.ringtone.elementId}}">
                {{i18n.ringtone}}
              </label>
              <select id="{{by_id.ringtone.elementId}}">
                {{#data.ringtones}}
                  <option value="{{id}}" {{#selected}}selected{{/selected}}>{{name}}</option>
                {{/data.ringtones}}
              </select>
              <button type="button" id="{{by_id.ringtonepreview.elementId}}">
                {{#data.ringtonePreviewActive}}{{i18n.ringtonepreviewstop}}{{/data.ringtonePreviewActive}}
                {{^data.ringtonePreviewActive}}{{i18n.ringtonepreview}}{{/data.ringtonePreviewActive}}
              </button>
            </div>
          {{/data.channels.ringer.show}}

        </div>
        `;
  }

  _renderData(data = { volumes: {}, volume: {} }) {
    Object.keys(this._config.channels).forEach((channel) => {
      data.volumes[channel] =
        this._config.channels[channel].volume * this._config.volumeMax;
    });

    data.volume.max = this._config.volumeMax;
    data.volume.min = this._config.volumeMin;

    data.ringtones = this.getRingtones().map((ringtone) => {
      return {
        id: ringtone.id,
        name: ringtone.name,
        selected: ringtone.id === this._config.channels.ringer.selected,
      };
    });

    data.ringtonePreviewActive = this.isRingtonePreviewActive();

    return data;
  }

  /** Helper functions */

  // Resolves to whether the context is running, waiting only briefly for a
  // resume that may never come. resume() can't be awaited unguarded: while a
  // browser is withholding playback Chrome leaves the promise *pending
  // indefinitely* rather than rejecting, so awaiting it before a ring would
  // mean the phone silently never rings. Raced against a short timeout and
  // decided on the context's actual state instead.
  _resumeAudioContext(timeoutMs = 150) {
    const context = this._audioContext;

    if (context.state === "running") {
      return Promise.resolve(true);
    }

    let resumed;

    try {
      resumed = context.resume().catch((error) => {
        this._emit("resume.error", this, error);
      });
    } catch (error) {
      // Missing entirely on some very old implementations. Report and let the
      // caller fall back rather than throwing out of "start ringing".
      this._emit("resume.error", this, error);

      return Promise.resolve(context.state === "running");
    }
    const timedOut = new Promise((resolve) => {
      setTimeout(resolve, timeoutMs);
    });

    return Promise.race([resumed, timedOut]).then(() => {
      return context.state === "running";
    });
  }

  // "default" is this library's own id for "whatever the browser considers
  // default"; setSinkId() spells that as the empty string.
  _normalizeSinkId(deviceId) {
    return !deviceId || deviceId == "default" ? "" : deviceId;
  }

  // Empty string where there is no element, or where the browser doesn't
  // implement sinkId at all (Safari) - both mean "the default device".
  _getRingOutputElementSinkId() {
    const mediaDevices = this._libwebphone.getMediaDevices();
    const element = mediaDevices
      ? mediaDevices.getMediaElement("ringoutput")
      : null;

    return (element && element.sinkId) || "";
  }

  // Ordering safety net, not the main path: lwpMediaDevices starts
  // enumerating before this class exists, so a selection settled during that
  // enumeration can predate the context that now owns the sink. Afterwards
  // lwpMediaDevices._changeRingOutputDevice() drives it directly.
  _syncRingOutputSink() {
    if (!this.usesContextSink()) {
      return;
    }

    const mediaDevices = this._libwebphone.getMediaDevices();

    if (!mediaDevices) {
      return;
    }

    const preferedDevice = mediaDevices.getPreferedDevice("ringoutput");

    if (
      !preferedDevice ||
      this._normalizeSinkId(preferedDevice.id) == this._outputAudio.sinkId
    ) {
      return;
    }

    this.setRingOutputSinkId(preferedDevice.id).catch((error) => {
      this._emit("sink.error", this, error);
    });
  }

  // Decodes a ringtone to an AudioBuffer, memoised per id. Resolves to null
  // rather than rejecting, so callers can simply fall back.
  _ensureRingtoneBuffer(id) {
    if (!id) {
      return Promise.resolve(null);
    }

    if (this._ringerAudio.buffers[id]) {
      return this._ringerAudio.buffers[id];
    }

    const ringtone = this._findRingtone(id);

    if (!ringtone) {
      return Promise.resolve(null);
    }

    const decoding = Promise.resolve()
      .then(() => {
        return lwpUtils.dataUriToArrayBuffer(ringtone.dataUri);
      })
      .then((arrayBuffer) => {
        return this._shimDecodeAudioData(this._audioContext, arrayBuffer);
      })
      .catch((error) => {
        // Drop the failed entry so a later ring retries, rather than one
        // transient failure making this ringtone unplayable for the session.
        delete this._ringerAudio.buffers[id];

        this._emit("ringtone.decode.error", this, error);

        return null;
      });

    this._ringerAudio.buffers[id] = decoding;
    this._pruneRingtoneBuffers();

    return decoding;
  }

  // decodeAudioData resamples to the context's rate, so a 3s ringtone costs
  // roughly half a megabyte decoded. Keep only what's reachable - selected
  // plus previewing - rather than all of channels.ringer.files.
  _pruneRingtoneBuffers() {
    const keep = [
      this._config.channels.ringer.selected,
      this._ringerAudio.previewId,
    ];

    Object.keys(this._ringerAudio.buffers).forEach((id) => {
      if (!keep.includes(id)) {
        delete this._ringerAudio.buffers[id];
      }
    });
  }

  // Buffer sources are single-use, so one pair per ring/preview. The envelope
  // is separate from ringerGain so changeVolume() can move the channel level
  // mid-ring without fighting an in-flight fade, and the fade needn't know
  // what that level is.
  _createRingerSource(buffer) {
    const context = this._audioContext;
    const now = context.currentTime;
    const envelope = this._shimCreateGain(context);
    const source = this._shimCreateBufferSource(context);

    source.buffer = buffer;
    // Sample-accurate looping - no seam, unlike an <audio> element's loop.
    source.loop = true;

    // The bundled files begin on silence so this isn't strictly required, but
    // it costs nothing and covers whatever a host supplies.
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(
      1,
      now + this._config.channels.ringer.fadeIn
    );

    source.connect(envelope);
    envelope.connect(this._getOutputGainNode("ringer"));
    source.start(now);

    return { source, envelope };
  }

  // The declick. Ramp and stop are both scheduled on the audio clock, so the
  // gain is interpolated per sample by the audio thread - immune to the timer
  // granularity and background-tab throttling that defeat any setTimeout fade
  // on an <audio> element's .volume.
  _stopRingerSource(playing) {
    if (!playing) {
      return;
    }

    const { source, envelope } = playing;
    const context = this._audioContext;

    const disconnect = () => {
      source.disconnect();
      envelope.disconnect();
    };

    // A suspended clock is frozen, so the ramp would never complete and
    // onended never fire - tear down now rather than leak the nodes. Nothing
    // is audible either way.
    if (context.state !== "running") {
      try {
        source.stop();
      } catch (error) {
        // Already stopped, or never started.
      }

      disconnect();

      return;
    }

    const now = context.currentTime;
    const fadeOut = this._config.channels.ringer.fadeOut;
    // Read before cancelling: cancelScheduledValues() removes the in-flight
    // ramp's end event, after which the value can read back as the last
    // scheduled one rather than where the ramp actually got to. Only matters
    // when a ring is stopped during its own fade-in (answered within
    // milliseconds), which is exactly when getting it wrong would click.
    const currentGain = envelope.gain.value;

    envelope.gain.cancelScheduledValues(now);
    // Pin it before ramping, so the fade starts from where the gain actually
    // is rather than jumping first.
    envelope.gain.setValueAtTime(currentGain, now);
    envelope.gain.linearRampToValueAtTime(0, now + fadeOut);

    source.onended = disconnect;
    // A small margin past the ramp so the stop lands on real silence.
    source.stop(now + fadeOut + 0.005);
  }

  // Starts the ringtone once the context state and decoded buffer are both
  // known. Both are required with nothing to fall back to, so a failure of
  // either is reported rather than worked around - the statechange listener
  // in _initEventBindings() retries this if the context resumes later.
  _startRinging() {
    const generation = ++this._ringerAudio.generation;
    const selected = this._config.channels.ringer.selected;

    Promise.all([
      this._resumeAudioContext(),
      this._ensureRingtoneBuffer(selected),
    ]).then(([running, buffer]) => {
      // stopAllRinging(), or a subsequent ring, landed while we were waiting.
      if (this._ringerAudio.generation !== generation) {
        return;
      }

      if (running && buffer) {
        this._ringerAudio.playing = this._createRingerSource(buffer);

        return;
      }

      // Nothing to fall back to - report why rather than failing silently.
      // Realistically the context hasn't been allowed to resume yet; the
      // gesture listener in _initEventBindings() minimises that window.
      this._emit(
        "ringtone.play.error",
        this,
        new Error(
          running
            ? "ringtone could not be decoded"
            : "AudioContext is not running"
        ),
        this.getOutputSinkInfo()
      );
    });
  }

  _findRingtone(id) {
    return this._config.channels.ringer.files.find((file) => {
      return file.id === id;
    });
  }

  _createLocalMediaStreamSource(mediaStream) {
    return this._shimCreateMediaStreamSource(
      this._previewAudio.context,
      mediaStream
    );
  }

  _createRemoteMediaStreamSource(mediaStream) {
    return this._shimCreateMediaStreamSource(
      this._remoteAudio.context,
      mediaStream
    );
  }

  _connectLocalSourceStream(sourceStream = null) {
    const previousSourceStream = this._previewAudio.sourceStream;

    if (previousSourceStream) {
      previousSourceStream.disconnect();
      this._previewAudio.sourceStream = null;
    }

    if (sourceStream) {
      this.startAudioContext();
      this._previewAudio.sourceStream = sourceStream;
      this._previewAudio.sourceStream.connect(
        this._previewAudio.loopbackDelayNode
      );
    }

    this._emit(
      "stream.local.changed",
      this,
      sourceStream,
      previousSourceStream
    );
  }

  _createLocalSourceStream(mediaStream) {
    const audioTrack = mediaStream.getTracks().find((track) => {
      return track.kind == "audio";
    });

    if (!audioTrack) {
      return this._connectLocalSourceStream();
    }

    this._connectLocalSourceStream(
      this._createLocalMediaStreamSource(mediaStream)
    );
  }

  _connectRemoteSourceStream(sourceStream = null) {
    const previousSourceStream = this._remoteAudio.sourceStream;

    if (previousSourceStream) {
      previousSourceStream.disconnect();
      this._remoteAudio.sourceStream = null;
    }

    if (sourceStream) {
      this.startAudioContext();
      this._remoteAudio.sourceStream = sourceStream;
      this._remoteAudio.sourceStream.connect(this._getOutputGainNode("remote"));
    }

    this._emit(
      "stream.remote.changed",
      this,
      sourceStream,
      previousSourceStream
    );
  }

  _createRemoteSourceStream(mediaStream) {
    const audioTrack = mediaStream.getTracks().find((track) => {
      return track.kind == "audio";
    });

    if (!audioTrack) {
      return this._connectRemoteSourceStream();
    }

    this._connectRemoteSourceStream(
      this._createRemoteMediaStreamSource(mediaStream)
    );
  }

  _getOutputGainNode(channel) {
    switch (channel) {
      case "master":
        return this._outputAudio.masterGain;
      case "ringer":
        return this._outputAudio.ringerGain;
      case "tones":
        return this._outputAudio.tonesGain;
      case "preview":
        return this._outputAudio.previewGain;
      case "remote":
        return this._outputAudio.remoteGain;
    }
  }

  /** Shims */

  _shimCreateBuffer(context, ...args) {
    return (context.createBuffer || context.webkitCreateBuffer).apply(
      context,
      args
    );
  }

  _shimCreateBufferSource(context, ...args) {
    return (
      context.createBufferSource || context.webkitCreateBufferSource
    ).apply(context, args);
  }

  // decodeAudioData has two signatures: the modern one returns a promise, the
  // legacy (older Safari/webkit) one returns undefined and reports via
  // callbacks. Passing callbacks *and* checking the return value covers both
  // without sniffing the browser.
  _shimDecodeAudioData(context, arrayBuffer) {
    return new Promise((resolve, reject) => {
      let decoding;

      try {
        decoding = context.decodeAudioData(arrayBuffer, resolve, reject);
      } catch (error) {
        reject(error);

        return;
      }

      if (decoding && typeof decoding.then == "function") {
        decoding.then(resolve, reject);
      }
    });
  }

  _shimCreateDelay(context, ...args) {
    return (context.createDelay || context.webkitCreateDelay).apply(
      context,
      args
    );
  }

  _shimCreateGain(context, ...args) {
    return (context.createGain || context.webkitCreateGain).apply(
      context,
      args
    );
  }

  _shimCreateOscillator(context, ...args) {
    return (context.createOscillator || context.webkitCreateOscillator).apply(
      context,
      args
    );
  }

  _shimCreateMediaStreamDestination(context, ...args) {
    return (
      context.createMediaStreamDestination ||
      context.webkitCreateMediaStreamDestination
    ).apply(context, args);
  }

  _shimCreateMediaStreamSource(context, ...args) {
    return (
      context.createMediaStreamSource || context.webkitCreateMediaStreamSource
    ).apply(context, args);
  }

  // No sampleRate is requested, deliberately.
  //
  // Where the context can't own its sink (see _initOutputAudio) audio reaches
  // the speakers through an <audio> element fed by a
  // MediaStreamAudioDestinationNode, and Chrome detunes that hand-off when the
  // context's rate doesn't match the device's - heard as playback drifting
  // sharp. This used to pin Chrome to 44100, which only helps on hardware
  // actually running at 44100; on the 48000 most modern devices use it
  // *caused* the mismatch it was meant to prevent (a ratio of 1.088, about
  // 1.5 semitones sharp) and added a pointless resampling stage. Omitting the
  // hint makes the context adopt the hardware's own rate instead.
  //
  // That is still only a probability fix on that path: the rate adopted is the
  // *default* device's, at construction time, while ring output can be pointed
  // elsewhere (and the default can change when hardware is plugged in). Hence
  // context-sink mode, where the two can't disagree.
  _shimAudioContext() {
    return new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive",
    });
  }
}
