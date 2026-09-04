"use strict";

import * as JsSIP from "jssip";

import lwpUtils from "./lwpUtils";
import lwpRenderer from "./lwpRenderer";
import lwpRingtones from "./lwpRingtones";

// Namespaced logger on JsSIP's own `debug` instance - not a second copy of the
// module, so lwpUserAgent.startDebug() switches this on with the SIP trace and
// it prints in the same styled `namespace message` form. Disabled it costs a
// property read: see _callWaitingLog(), which builds nothing until it is on.
const callWaitingDebug = JsSIP.debug("libwebphone:callWaiting");

// `debug`'s browser build writes to console.debug, which Chrome files under
// the Verbose log level and hides by default - so the trace would be there and
// invisible unless the console's level filter had been widened, which is not
// something a caller should have to know. Everything else libwebphone logs
// (the event dump in lwpUserAgent) goes to console.log, so match it: same
// namespace, same styling, just a level that is actually shown.
callWaitingDebug.log = console.log.bind(console);

// The two platform-defined Alert-Info values. Named because the library refers
// to them specifically - they get their own labelled controls in the default
// template - unlike a customer's own keys, which it only ever matches.
const INTERNAL_KEY = "alert-internal";
const EXTERNAL_KEY = "alert-external";

export default class extends lwpRenderer {
  constructor(libwebphone, config = {}) {
    super(libwebphone);
    this._libwebphone = libwebphone;
    this._emit = this._libwebphone._audioContextEvent;
    this._initProperties(config);
    this._initInternationalization(config.i18n || {});
    // Before _initOutputAudio(): that builds the tones graph, and which
    // context the graph belongs on is state this sets up.
    this._initTonesAudio();
    this._initOutputAudio();
    this._initRingAudio();
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
    // Nudged alongside, not awaited: whether the phone can play audio is
    // still the shared context's answer to give, and the tones channel has
    // the element route to fall back on.
    if (this._tonesAudio && this._tonesAudio.dedicated) {
      // Reconsidered after the resume, not just started: a suspended context
      // cannot be the direct route (see _tonesRouteDirect), so waking one is
      // what puts the channel back on it.
      this._resumeContext(this._tonesAudio.context).then(() => {
        this._updateTonesRouting();
      });
    }

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

    if (channel == "master") {
      this._syncTonesMasterVolume();
    }

    if (gainNode) {
      // Ramped, not assigned: writing .value steps the gain in a single
      // sample, which clicks against anything already playing - reachable by
      // dragging a volume slider mid-ring.
      //
      // Against the node's own clock, not the shared context's: the tones
      // channel can be running on a context of its own, whose currentTime is
      // unrelated (it starts at zero when that context is created). Ramping a
      // promoted tonesGain against the shared clock would schedule the change
      // as far into its future as the two contexts' ages differ.
      const context = gainNode.context;

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

    // Taken from the node this connects to rather than from _tonesAudio
    // directly: nodes can only be connected within one context, and a
    // promotion replaces both at once (see _ensureTonesContext).
    const gainNode = this._getOutputGainNode("tones");
    const context = gainNode.context;
    const bufferSource = this._shimCreateBufferSource(context);

    bufferSource.buffer = this._toneBuffer(context, tones);
    bufferSource.connect(gainNode);

    // No cleanup timer: a buffer source ends itself at the end of its buffer
    // and is single-use either way, so the old one only ever fired long after
    // there was anything left to stop.
    bufferSource.onended = () => {
      bufferSource.disconnect();
    };

    bufferSource.start();
  }

  // The rendered tone for a set of frequencies, built once and kept.
  //
  // There are twelve keys on a dialpad and the tone for each is identical
  // every time, but this used to be re-rendered on every keypress: a
  // one-second buffer allocated and a sine evaluated per sample, on the
  // thread the UI is on. The allocation churn alone is worth avoiding on
  // something that happens as fast as someone can type.
  //
  // Keyed by everything that changes the result, so a duration change or a
  // move onto a context with a different sample rate simply builds a new one.
  _toneBuffer(context, tones) {
    const duration = this._config.channels.tones.duration;
    const sampleRate = context.sampleRate;
    const key = tones.join("+") + "@" + sampleRate + "/" + duration;

    if (this._tonesAudio.buffers[key]) {
      return this._tonesAudio.buffers[key];
    }

    const length = Math.max(1, Math.round(duration * sampleRate));

    // One channel, not one per frequency. DTMF is both tones sounding
    // together; a channel each puts one in either ear on headphones, which is
    // not what a keypad sounds like - it only summed to the right thing by
    // the accident of playing out of a single speaker.
    const buffer = this._shimCreateBuffer(context, 1, length, sampleRate);
    const channel = buffer.getChannelData(0);

    // Scaled by how many are being summed so a pair cannot run past full
    // scale and clip. How loud the channel is stays tonesGain's business.
    const amplitude = 1 / tones.length;

    // A tone that simply stops is a step to silence from wherever in the
    // cycle it happened to be, and that step is an audible click on every
    // keypress. A few milliseconds either end removes it - short enough to
    // leave the attack sounding immediate.
    const fade = Math.min(
      Math.round(this._config.channels.tones.fade * sampleRate),
      Math.floor(length / 2)
    );

    for (let i = 0; i < length; i++) {
      let sample = 0;

      for (let index = 0; index < tones.length; index++) {
        sample += Math.sin(2 * Math.PI * tones[index] * (i / sampleRate));
      }

      let envelope = 1;

      if (fade > 0) {
        if (i < fade) {
          envelope = i / fade;
        } else if (i >= length - fade) {
          envelope = (length - 1 - i) / fade;
        }
      }

      channel[i] = sample * amplitude * envelope;
    }

    this._tonesAudio.buffers[key] = buffer;

    return buffer;
  }

  // `ringtoneId` overrides the selected ringtone for this call - how an
  // Alert-Info mapping reaches the ringer (see getRingtoneForAlertInfo()).
  // A call arriving while another is already ringing queues behind it rather
  // than swapping the ringtone under it, and takes the ringer over with its
  // own ringtone once the calls ahead of it are gone - see _resettleRinging().
  startRinging(requestId = null, ringtoneId = null) {
    this.startAudioContext();

    if (this.isRingtonePreviewActive()) {
      this.stopRingtonePreview();
    }

    // Settled as the call arrives rather than as it reaches the front of the
    // queue, so a selectRingtone() while it waits its turn takes effect from
    // the next ring rather than changing what this one ends up ringing with.
    const settled =
      ringtoneId && this._findRingtone(ringtoneId)
        ? ringtoneId
        : this._config.channels.ringer.selected;

    if (!requestId) {
      this._ringerAudio.calls.push({ id: null, ringtoneId: settled });
    } else if (this._ringingCallIndex(requestId) == -1) {
      this._ringerAudio.calls.push({ id: requestId, ringtoneId: settled });
    }

    if (!this._ringerAudio.ringerConnected) {
      this._ringerAudio.ringerConnected = true;
      this._ringerAudio.activeId = this._ringerAudio.calls[0].ringtoneId;
      this._startRinging();
    }
  }

  stopRinging(requestId = null) {
    if (!requestId) {
      requestId = null;
    }

    const requestIndex = this._ringingCallIndex(requestId);

    if (requestIndex != -1) {
      this._ringerAudio.calls.splice(requestIndex, 1);
    }

    if (this._ringerAudio.calls.length == 0) {
      this.stopAllRinging();

      return;
    }

    // Still ringing for somebody else - hand the ringer to whoever is next.
    this._resettleRinging();
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

    // Cleared before pruning, so a mapped ringtone this session decoded is
    // dropped unless it's reachable in its own right (prewarmed, or selected).
    this._ringerAudio.activeId = null;
    this._pruneRingtoneBuffers();

    // Warm the next ring's buffers, picking up any mid-ring selection.
    this._ensureRingtoneBuffer(this._config.channels.ringer.selected);
    this._prewarmAlertInfoRingtones();
  }

  // The call waiting counterpart of startRinging(): the call is registered as
  // waiting instead of ringing, and a single beep is played every
  // `channels.ringer.callWaiting.interval` seconds for as long as any call is
  // waiting - not one cycle per call.
  //
  // `ringtoneId` is remembered rather than used: a waiting call takes the
  // ringer over with it if the call it was waiting behind clears while it is
  // still ringing (see _resettleCallWaiting()), and it should ring with the
  // ringtone its own Alert-Info settled on when it arrived.
  startCallWaiting(requestId = null, ringtoneId = null) {
    this.startAudioContext();

    if (this.isRingtonePreviewActive()) {
      this.stopRingtonePreview();
    }

    const settled =
      ringtoneId && this._findRingtone(ringtoneId)
        ? ringtoneId
        : this._config.channels.ringer.selected;

    if (!requestId) {
      this._ringerAudio.waiting.push({ id: null, ringtoneId: settled });
    } else if (this._waitingCallIndex(requestId) == -1) {
      this._ringerAudio.waiting.push({ id: requestId, ringtoneId: settled });
    } else {
      // Already waiting - nothing has changed, so nothing to announce.
      this._callWaitingLog("start.ignored", () => ({
        requestId,
        reason: "already waiting",
        waiting: this._ringerAudio.waiting.map((entry) => entry.id),
      }));

      return;
    }

    this._callWaitingLog("start", () => ({
      requestId,
      ringtoneId: settled,
      waiting: this._ringerAudio.waiting.map((entry) => entry.id),
      toneActive: this._ringerAudio.waitingToneActive,
      enabled: this.isCallWaitingEnabled(),
    }));

    if (this._ringerAudio.waitingToneActive) {
      // The cycle is already running for a call that was waiting before this
      // one. Announce this one as it arrives rather than leaving it to be
      // covered by a beep up to a full interval away.
      this._playCallWaitingBeep();
      this._scheduleCallWaitingBeep();

      return;
    }

    this._syncCallWaitingTone();
  }

  stopCallWaiting(requestId = null) {
    if (!requestId) {
      requestId = null;
    }

    const requestIndex = this._waitingCallIndex(requestId);

    if (requestIndex == -1) {
      return;
    }

    this._ringerAudio.waiting.splice(requestIndex, 1);

    this._callWaitingLog("stop", () => ({
      requestId,
      waiting: this._ringerAudio.waiting.map((entry) => entry.id),
    }));

    this._syncCallWaitingTone();
  }

  // Drops every waiting call. Deliberately separate from stopAllRinging():
  // with a call waiting behind an established one the ring queue is normally
  // empty, so stopping ringing must not take the beeps with it.
  stopAllCallWaiting() {
    this._ringerAudio.waiting = [];

    this._syncCallWaitingTone();
  }

  // True while any call is waiting, whether or not the tone itself is enabled
  // - a call presented silently is still waiting.
  isCallWaiting() {
    return this._ringerAudio.waiting.length > 0;
  }

  isCallWaitingEnabled() {
    return !!this._config.channels.ringer.callWaiting.enabled;
  }

  // Takes effect immediately, including on a call already waiting: switching
  // it on mid-call starts the beeps, switching it off silences them and
  // leaves the call presented silently.
  setCallWaitingEnabled(enabled) {
    enabled = !!enabled;

    if (enabled == this.isCallWaitingEnabled()) {
      return;
    }

    this._config.channels.ringer.callWaiting.enabled = enabled;

    this._syncCallWaitingTone();

    this._emit("channel.ringer.callwaiting.enabled", this, enabled);
    this.updateRenders();
  }

  toggleCallWaiting() {
    this.setCallWaitingEnabled(!this.isCallWaitingEnabled());
  }

  isAutoAnswerWarningEnabled() {
    return !!this._config.channels.ringer.autoAnswerWarning.enabled;
  }

  // Takes effect from the next auto-answered call, so a host app can offer
  // this as a setting and have it apply without a reload. With it off, an
  // auto-answered call connects immediately and silently - no warning, and
  // no wait for one.
  setAutoAnswerWarningEnabled(enabled) {
    enabled = !!enabled;

    if (enabled == this.isAutoAnswerWarningEnabled()) {
      return;
    }

    this._config.channels.ringer.autoAnswerWarning.enabled = enabled;

    this._emit("channel.ringer.autoanswerwarning.enabled", this, enabled);
    this.updateRenders();
  }

  toggleAutoAnswerWarning() {
    this.setAutoAnswerWarningEnabled(!this.isAutoAnswerWarningEnabled());
  }

  /**
   * Plays the auto-answer warning tone - the "beep beep" a desk phone
   * sounds before answering an intercom call by itself - and resolves once
   * it has finished, so the caller can answer *after* the warning rather
   * than under it.
   *
   * Resolves rather than rejects on every failure path, and resolves
   * immediately when the tone is disabled or the AudioContext can't be
   * resumed (no user gesture yet). A warning tone that couldn't be played
   * must never be the reason a call goes unanswered - the worst outcome
   * here is the pre-existing behaviour of answering without one.
   */
  playAutoAnswerWarning() {
    const config = this._config.channels.ringer.autoAnswerWarning;

    if (!config.enabled || config.count < 1) {
      return Promise.resolve(false);
    }

    this.startAudioContext();

    // As with the call waiting beep: captured once, so the context resumed
    // is the context the beeps are scheduled on even if a promotion lands
    // while the resume is settling.
    const gainNode = this._outputAudio.autoAnswerWarningGain;
    const context = gainNode.context;

    return this._resumeContext(context)
      .then((running) => {
        if (!running) {
          this._emit(
            "autoanswer.warning.error",
            this,
            new Error("AudioContext is not running"),
            this._getMediaElementSinkId("audiooutput")
          );

          return false;
        }

        // As in _playCallWaitingBeep(): the resume may be what made the
        // direct leg usable, and the routing decision is cached.
        this._updateTonesRouting();

        // Read after the resume settled, not before it - the clock has
        // moved on while it was suspended.
        const start = context.currentTime;
        const fadeIn = config.fadeIn;
        const fadeOut = config.fadeOut;
        // The fades are part of each beep, not additions to it, so a
        // duration shorter than both together would ramp down before it
        // was up.
        const duration = Math.max(config.duration, fadeIn + fadeOut);
        const step = duration + config.gap;

        for (let index = 0; index < config.count; index++) {
          // Every beep is scheduled up front on the audio clock rather
          // than driven by a timer per beep: setTimeout jitter between
          // them would be plainly audible at this spacing, and the whole
          // sequence is only a few hundred milliseconds long.
          this._scheduleAutoAnswerWarningBeep(
            gainNode,
            config,
            start + index * step,
            duration
          );
        }

        // The tail of the last beep, plus the same small margin its own
        // stop() uses so the resolve lands on real silence rather than
        // clipping the final ramp.
        const total = (config.count - 1) * step + duration + 0.005;

        this._emit("autoanswer.warning.started", this, total);

        return new Promise((resolve) => {
          setTimeout(() => {
            this._emit("autoanswer.warning.stopped", this);
            resolve(true);
          }, total * 1000);
        });
      })
      .catch((error) => {
        this._emit("autoanswer.warning.error", this, error, null);

        return false;
      });
  }

  // Takes the node to play into rather than a context, so the oscillator can
  // only ever be created on the context that node belongs to.
  _scheduleAutoAnswerWarningBeep(gainNode, config, when, duration) {
    const context = gainNode.context;
    const oscillator = this._shimCreateOscillator(context);
    const envelope = this._shimCreateGain(context);

    oscillator.type = config.type;
    oscillator.frequency.value = config.frequency;

    // Shape only - the level is `autoAnswerWarningGain`, the way every other
    // channel keeps its volume on a node of its own rather than baked into
    // the envelope.
    envelope.gain.setValueAtTime(0, when);
    envelope.gain.linearRampToValueAtTime(1, when + config.fadeIn);
    envelope.gain.setValueAtTime(1, when + duration - config.fadeOut);
    envelope.gain.linearRampToValueAtTime(0, when + duration);

    oscillator.connect(envelope);
    envelope.connect(gainNode);

    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
    };

    oscillator.start(when);
    // A small margin past the ramp so the stop lands on real silence.
    oscillator.stop(when + duration + 0.005);
  }

  getCallWaitingInterval() {
    return this._config.channels.ringer.callWaiting.interval;
  }

  // Clamped to [intervalMin, intervalMax] rather than rejected, so a value
  // straight out of a number input can be passed through. A change while
  // calls are waiting re-times the next beep from now.
  setCallWaitingInterval(seconds) {
    const callWaiting = this._config.channels.ringer.callWaiting;
    const interval = this._clampCallWaitingInterval(
      seconds,
      callWaiting.interval
    );

    if (interval == callWaiting.interval) {
      return;
    }

    callWaiting.interval = interval;

    // Only the wait to the next beep moves - restarting the cycle would beep
    // again immediately, every time the slider moved.
    if (this._ringerAudio.waitingToneActive) {
      this._scheduleCallWaitingBeep();
    }

    this._emit("channel.ringer.callwaiting.interval", this, interval);
    this.updateRenders();
  }

  // Whether the call waiting trace is being logged. Owned by debug mode (lwpUserAgent.startDebug())
  isCallWaitingDebug() {
    return !!callWaitingDebug.enabled;
  }

  // Everything that decides whether a beep is heard, in one object - the queue
  // state, the calls the routing decision reads, and the output path the beep
  // is scheduled onto. Safe to call at any time; the intended use is to call
  // it at the moment something is wrong and read it back.
  getCallWaitingDiagnostics() {
    const callList = this._libwebphone.getCallList();
    const callWaiting = this._config.channels.ringer.callWaiting;

    return {
      enabled: callWaiting.enabled,
      interval: callWaiting.interval,
      volume: callWaiting.volume,
      waiting: this._ringerAudio.waiting.map((entry) => entry.id),
      toneActive: this._ringerAudio.waitingToneActive,
      timerArmed: !!this._ringerAudio.waitingTimer,
      generation: this._ringerAudio.waitingGeneration,
      ringQueue: this._ringerAudio.calls.map((entry) => entry.id),
      ringerConnected: this._ringerAudio.ringerConnected,
      calls: callList
        ? callList.getCalls().map((call) => {
            return {
              id: call.getId(),
              hasSession: call.hasSession(),
              ringing: call.isRinging(),
              established: call.isEstablished(),
              held: call.isOnHold(),
              ended: call.isEnded(),
              primary: call.isPrimary(),
            };
          })
        : null,
      output: this._callWaitingOutputInfo(),
    };
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

  // The Alert-Info ringtone mappings, in the order they are matched against an
  // incoming call. The built-in platform keys come first, in the order they
  // are configured, so a custom mapping can never shadow one.
  getAlertInfoMappings() {
    const alertInfo = this._config.channels.ringer.alertInfo;

    return this._alertInfoKeys().map((key) => {
      return {
        key: key,
        ringtone: alertInfo.mappings[key] || null,
        builtin: this._isBuiltinAlertInfoKey(key),
      };
    });
  }

  // The ringtone mapped to a key, or null where the mapping exists but is
  // unset (meaning "whatever is selected") as well as where there is no
  // mapping at all - the two behave identically when a call arrives.
  getAlertInfoRingtone(key) {
    const mappings = this._config.channels.ringer.alertInfo.mappings;
    const normalized = this._normalizeAlertInfoKey(key);

    return (normalized && mappings[normalized]) || null;
  }

  // Maps an Alert-Info value to a ringtone, adding the mapping if it's new.
  // A null/empty ringtoneId clears it back to the selected ringtone rather
  // than removing the mapping, so a built-in row can be reset without
  // disappearing from the UI.
  //
  // Returns whether the arguments were usable, so a UI can tell a rejected
  // input from one that simply asked for what was already true - both leave
  // the mappings alone, but only one of them is the user's mistake.
  setAlertInfoRingtone(key, ringtoneId = null) {
    const alertInfo = this._config.channels.ringer.alertInfo;
    const normalized = this._normalizeAlertInfoKey(key);

    if (!normalized) {
      return false;
    }

    // Unlike an unset mapping, an id that doesn't resolve is a mistake -
    // refuse it rather than silently storing something that will never play.
    if (ringtoneId && !this._findRingtone(ringtoneId)) {
      return false;
    }

    const ringtone = ringtoneId || null;
    const existing = Object.prototype.hasOwnProperty.call(
      alertInfo.mappings,
      normalized
    );

    if (existing && alertInfo.mappings[normalized] === ringtone) {
      return true;
    }

    alertInfo.mappings[normalized] = ringtone;

    if (ringtone && alertInfo.prewarm) {
      this._ensureRingtoneBuffer(ringtone);
    }

    // Whatever this key used to point at may now be unreachable.
    this._pruneRingtoneBuffers();

    this._emit("channel.ringer.alertinfo.changed", this, normalized, ringtone);
    this.updateRenders();

    return true;
  }

  // Removes a custom mapping entirely. The built-in platform keys are fixed
  // rows - clear them with setAlertInfoRingtone(key, null) instead.
  //
  // Returns false only where the removal was refused (an unusable key, or a
  // built-in one). A key that simply isn't mapped is true: the caller asked
  // for no mapping under it and that is the state they get.
  removeAlertInfoMapping(key) {
    const alertInfo = this._config.channels.ringer.alertInfo;
    const normalized = this._normalizeAlertInfoKey(key);

    if (!normalized || this._isBuiltinAlertInfoKey(normalized)) {
      return false;
    }

    if (!Object.prototype.hasOwnProperty.call(alertInfo.mappings, normalized)) {
      return true;
    }

    delete alertInfo.mappings[normalized];

    this._pruneRingtoneBuffers();

    this._emit("channel.ringer.alertinfo.removed", this, normalized);
    this.updateRenders();

    return true;
  }

  // Which ringtone an inbound call carrying these Alert-Info header values
  // should ring with. Always resolves to something playable: an unmatched
  // call, an unset mapping and a mapping left pointing at a ringtone that no
  // longer exists all fall back to the selected ringtone.
  getRingtoneForAlertInfo(alertInfo = []) {
    const config = this._config.channels.ringer.alertInfo;
    const selected = this._config.channels.ringer.selected;

    if (!config.enabled) {
      return selected;
    }

    const key = this._matchAlertInfoKey(alertInfo);

    if (!key) {
      return selected;
    }

    const mapped = config.mappings[key];

    if (!mapped || !this._findRingtone(mapped)) {
      return selected;
    }

    return mapped;
  }

  // `source` is which control owns the preview - null for the ringtone
  // selector, an Alert-Info key for one of the mapping rows, and whatever
  // token a host application passes for a control of its own. Only the owner
  // reports itself as playing, so two controls pointing at the same ringtone
  // don't light up together. Compared with ===, so any value works as a token.
  previewRingtone(id = null, source = null) {
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
    this._ringerAudio.previewSource = source;

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

    this._emit("ringtone.preview.started", this, ringtoneId, source);
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

    // Reported with the "stopped" event below, so a host application's button
    // knows whether the preview that just ended was its own.
    const source = this._ringerAudio.previewSource;

    this._ringerAudio.previewActive = false;
    this._ringerAudio.previewId = null;
    this._ringerAudio.previewSource = null;

    this._stopRingerSource(this._ringerAudio.previewPlaying);
    this._ringerAudio.previewPlaying = null;

    // The previewed buffer is unreachable now unless it's also the selected
    // one.
    this._pruneRingtoneBuffers();

    this._emit("ringtone.preview.stopped", this, source);
    this.updateRenders();
  }

  // The one call a preview button needs: pressing the control that started
  // the preview stops it, pressing a different one switches the preview to
  // that control's ringtone rather than merely stopping the first. Pass the
  // same `source` for every press of a given button - the default of null
  // belongs to the ringtone selector.
  toggleRingtonePreview(id = null, source = null) {
    if (this.isRingtonePreviewActive(source)) {
      this.stopRingtonePreview();

      return;
    }

    this.previewRingtone(id, source);
  }

  // With no argument: whether any preview is playing. With one: whether the
  // preview playing is the one `source` started, which is what a button
  // showing "Stop" should ask - `isRingtonePreviewActive(null)` is the
  // ringtone selector's own preview, not "any".
  isRingtonePreviewActive(source = undefined) {
    if (!this._ringerAudio.previewActive) {
      return false;
    }

    return source === undefined || this._ringerAudio.previewSource === source;
  }

  // Which control owns the preview that's playing: null for the ringtone
  // selector, an Alert-Info key for a mapping row, or whatever token a host
  // application passed. undefined when nothing is playing - distinguishing
  // that from the selector's null is why this isn't simply null.
  getRingtonePreviewSource() {
    if (!this._ringerAudio.previewActive) {
      return undefined;
    }

    return this._ringerAudio.previewSource;
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

    // _outputAudio.sinkId only catches up once setSinkId resolves, so until
    // then the tones route would be decided against a stale value - see
    // _ensureTonesContext(), which holds off while this is set rather than
    // promoting onto a split that is about to close.
    this._outputAudio.sinkChanging = true;

    return Promise.resolve()
      .then(() => {
        return this._audioContext.setSinkId(sinkId);
      })
      .then(() => {
        this._outputAudio.sinkId = sinkId;

        // The tones route is chosen by comparing this against the speaker
        // element's sink, so it has to be reconsidered whenever either moves.
        this._updateTonesRouting();

        this._emit("sink.changed", this, this.getOutputSinkInfo());

        return true;
      })
      .finally(() => {
        this._outputAudio.sinkChanging = false;

        // Again with the guard lifted: the call above ran while it still
        // applied, so any promotion it needed was deferred to here. Also
        // covers the rejection path, where the first call never happened.
        this._updateTonesRouting();
      });
  }

  // Whether ringing is mirrored to a second device as well as the primary
  // ring output. lwpMediaDevices decides this from the ringoutput2 selection
  // and owns which device it lands on (the sink of the ringoutput2 element);
  // all this controls is whether anything is sent down that path.
  setSecondaryRingOutputEnabled(enabled) {
    enabled = !!enabled;

    if (!this._outputAudio.secondaryRingGain) {
      return;
    }

    if (enabled == this._outputAudio.secondaryRingEnabled) {
      return;
    }

    this._outputAudio.secondaryRingEnabled = enabled;
    this._setSecondaryRingGain(enabled ? this._secondaryRingVolume() : 0);

    this._emit("ring.output.secondary.enabled", this, enabled);
  }

  isSecondaryRingOutputEnabled() {
    return !!this._outputAudio.secondaryRingEnabled;
  }

  // The stream feeding the secondary ring device - the ringer channel alone,
  // unlike getDestinationStream()'s full mix.
  getSecondaryRingDestinationStream() {
    return this._outputAudio.secondaryRingDestinationStream.stream;
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
      // Always element-sinked, whichever mode the primary is in.
      secondary: {
        enabled: this.isSecondaryRingOutputEnabled(),
        deviceId: this._getMediaElementSinkId("ringoutput2"),
      },
      // Not ring output, but the other thing that leaves this context, and
      // the one worth checking when keypress feedback feels late: "element"
      // is the route that carries the extra buffering (see
      // _updateTonesRouting), "direct" the one that doesn't.
      tones: {
        route: this._outputAudio.tonesUsingDirect ? "direct" : "element",
        // Whether the channel has a context (and so a sink) of its own yet -
        // see _ensureTonesContext().
        dedicated: this._tonesAudio.dedicated,
        deviceId: this._tonesAudio.dedicated
          ? this._tonesAudio.sinkId
          : this._outputAudio.tonesUsingDirect
          ? this.usesContextSink()
            ? this._outputAudio.sinkId
            : ""
          : this._getMediaElementSinkId("audiooutput"),
        sampleRate: this._tonesAudio.context.sampleRate,
      },
    };
  }

  updateRenders() {
    this.render((render) => {
      render.data = this._renderData(render.data);
      return render;
    });
  }

  // A render target can name one of the default template's sections instead
  // of carrying a template of its own:
  //
  //   { root: { elementId: "call_waiting" }, section: "callwaiting" }
  //
  // and gets that section alone - no `show` flags switching the other two
  // off, which would leave every target's config describing what it is *not*.
  // The rest still comes from the default config, so the events, i18n keys
  // and data need no restating either.
  //
  // An explicit `template` wins: a target supplying its own markup has said
  // what it wants more precisely than a section name can.
  renderAddTarget(config) {
    if (config && typeof config == "object" && config.section) {
      const sections = this._renderSectionTemplates();

      if (!sections[config.section]) {
        // Announced rather than quietly falling back to the whole template,
        // which reads as the section name having been ignored.
        this._emit("render.section.unknown", this, config.section);
      } else if (!config.template) {
        config = { ...config, template: sections[config.section] };
      }
    }

    return super.renderAddTarget(config);
  }

  /** Init functions */

  _initInternationalization(config) {
    const defaults = {
      en: {
        mastervolume: "Master Volume",
        ringervolume: "Ringer Volume",
        ringtonesection: "Ringtones",
        ringtone: "Ringtone",
        ringtonepreview: "Preview",
        ringtonepreviewstop: "Stop",
        callwaitingsection: "Call Waiting",
        callwaiting: "Call Waiting Tone",
        callwaitinginterval: "Call Waiting Tone Interval (seconds)",
        autoanswerwarningsection: "Auto Answer",
        autoanswerwarning: "Auto Answer Warning Tone",
        alertinfointernal: "Internal Call Ringtone",
        alertinfoexternal: "External Call Ringtone",
        alertinfocustom: "Custom Alert-Info Ringtones",
        alertinfoempty: "No custom mappings yet",
        alertinfodefault: "Use selected ringtone",
        alertinfokey: "Alert-Info value",
        alertinfoinvalid: "Enter a valid Alert-Info value",
        alertinfoadd: "Add",
        alertinforemove: "Remove",
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
          // The section holding the ringtone selector, its preview button and
          // the Alert-Info mappings below. Gated separately from the ringer
          // channel's own `show` (the ringing volume control) so a host app
          // can render its volume mixer in one place and the ringtones in
          // another - which is what the test harness does.
          ringtones: {
            show: true,
          },
          // Per-Alert-Info ringtones: an inbound INVITE carrying a matching
          // Alert-Info header rings with its own ringtone instead of
          // `selected`. See getRingtoneForAlertInfo().
          alertInfo: {
            // Whether an incoming call's Alert-Info is consulted at all. The
            // mappings stay editable either way, so a host app can build the
            // UI before deciding to switch the behaviour on.
            enabled: true,
            show: true,
            // "token" matches the key as a whole word anywhere in the header
            // value, which covers both the bare `<alert-internal>` form and a
            // URI form like `<sip:x@pbx>;info=door-phone`. "exact" compares
            // the whole value, after stripping the surrounding <> - without
            // that it would never match a real INVITE.
            matchMode: "token",
            // Optional (alertInfoValues, mappings) => key | null, replacing
            // the matching above entirely for hosts with their own rules.
            matcher: null,
            // Decode mapped ringtones ahead of the first call that needs one,
            // rather than making that call wait on decodeAudioData. Costs
            // roughly half a megabyte of memory per *distinct* mapped
            // ringtone, so it stays proportional to how many the host has
            // actually configured.
            prewarm: true,
            // Rendered as fixed rows that can't be renamed or removed - these
            // are platform-defined, unlike whatever a customer adds.
            builtin: [INTERNAL_KEY, EXTERNAL_KEY],
            // key -> ringtone id, or null for "use the selected ringtone".
            // An object rather than an array so a host app's config merges
            // key-by-key (lodash merge would combine arrays by index - the
            // same trap documented on `files` above), and so insertion order
            // gives a stable match precedence.
            mappings: {
              [INTERNAL_KEY]: null,
              [EXTERNAL_KEY]: null,
            },
          },
          // The call waiting tone: a call arriving while another is already
          // established (in or out of hold) doesn't ring over it, it gets a
          // periodic beep instead, the way a desk phone does. Played out of
          // the speaker (`audiooutput`) rather than the ring output, since the
          // person it is for is already on a call - see
          // _playCallWaitingBeep().
          callWaiting: {
            // With this off the waiting call is presented silently: it still
            // appears in the call list and can be answered, it just makes no
            // sound. It does *not* fall back to ringing over the active call.
            enabled: true,
            show: true,
            // Seconds between beeps, clamped to [intervalMin, intervalMax] -
            // see _clampCallWaitingInterval().
            interval: 30,
            intervalMin: 10,
            intervalMax: 60,
            // The beep itself. Well below full scale: this plays into a
            // headset someone is already holding a conversation on, so it has
            // to carry over that conversation without startling them. For
            // reference the DTMF feedback tones on the same device sit at
            // 0.15, and those are not competing with anything.
            volume: 0.25,
            frequency: 440,
            duration: 0.25,
            type: "sine",
            // As with the ringtone envelope, these are declicks rather than a
            // stylistic fade - a beep that starts and stops mid-waveform
            // clicks at both ends.
            fadeIn: 0.01,
            fadeOut: 0.02,
          },
          // The auto-answer warning tone: the short "beep beep" a desk
          // phone plays *before* answering an intercom/paging call by
          // itself, so the user knows their microphone is about to open
          // rather than discovering it afterwards. Played out of the
          // speaker (`audiooutput`) for the same reason as the call
          // waiting beep - it is for the person about to be connected, not
          // an alert to the room - see playAutoAnswerWarning().
          autoAnswerWarning: {
            // With this off the call auto-answers silently and
            // immediately: no tone, and no delay waiting for one.
            enabled: true,
            show: true,
            // How many beeps, and the silence between them.
            count: 2,
            gap: 0.08,
            // Louder than the call waiting beep: that one has to sit under
            // a conversation already in progress, this one is a warning
            // that the mic is about to open and should be hard to miss.
            volume: 0.4,
            frequency: 520,
            duration: 0.12,
            type: "sine",
            // Declicks, as everywhere else here - a beep starting or
            // stopping mid-waveform clicks at both ends.
            fadeIn: 0.005,
            fadeOut: 0.01,
          },
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
          // Attack and release, in seconds. Without it a tone ends on a step
          // to silence and clicks - see _toneBuffer().
          fade: 0.005,
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

    this._normalizeRingtonesConfig();
    this._normalizeAlertInfoConfig();
    this._normalizeCallWaitingConfig();

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
    // Firefox and Safari have no AudioContext.setSinkId, so they fall back to
    // piping masterGain through a MediaStream to the ringoutput element - the
    // only way they can honour a device selection at all (and they can:
    // HTMLMediaElement.setSinkId landed in Firefox 116 and Safari 18.4).
    // Neither detunes, so the fallback costs them nothing.
    this._outputAudio.usingContextSink =
      typeof this._audioContext.setSinkId == "function";

    this._outputAudio.sinkId = "";

    // Whether a setSinkId on the shared context is still in flight, and so
    // whether `sinkId` above can be trusted - see _ensureTonesContext().
    this._outputAudio.sinkChanging = false;

    // Created in both modes: getDestinationStream() is public API a host app
    // may be tapping. In context-sink mode nothing plays it, so it is only a
    // passive tap and can't double up on what reaches the speakers.
    this._outputAudio.destinationStream =
      this._shimCreateMediaStreamDestination(this._outputAudio.context);
    this._outputAudio.masterGain.connect(this._outputAudio.destinationStream);

    // Everything on the tones channel is built by _buildTonesGraph(), because
    // it can be built again: the channel is promoted onto a context of its
    // own when the speaker and the ring output split (see
    // _ensureTonesContext), and nodes belong to the context that created
    // them.
    this._buildTonesGraph(this._outputAudio.context);

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

    // Secondary ring output. A context has exactly one sink and the ring
    // output above has already claimed it (or the ringoutput element has), so
    // a second ring device can only be reached through a second MediaStream ->
    // <audio> hand-off - regardless of which route the primary took.
    //
    // Fed from ringerGain rather than masterGain: this is "ring my other
    // speaker too", not a second copy of everything the mixer carries, so
    // call audio and preview loopback stay off it. That does mean it bypasses
    // masterGain, hence the stand-in below.
    this._outputAudio.secondaryRingGain = this._shimCreateGain(
      this._outputAudio.context
    );
    // Silent until lwpMediaDevices picks a device for it. Gated by gain rather
    // than by connect/disconnect, because a blanket disconnect() would take
    // masterGain - the primary ring output - down with it, and the targeted
    // disconnect(destination) that wouldn't is the harder call to get right
    // across implementations for no gain over a ramp.
    this._outputAudio.secondaryRingGain.gain.value = 0;
    this._outputAudio.secondaryRingEnabled = false;
    this._outputAudio.ringerGain.connect(this._outputAudio.secondaryRingGain);

    this._outputAudio.secondaryRingDestinationStream =
      this._shimCreateMediaStreamDestination(this._outputAudio.context);
    this._outputAudio.secondaryRingGain.connect(
      this._outputAudio.secondaryRingDestinationStream
    );

    if (mediaDevices) {
      // The audiooutput element is wired up in _buildTonesGraph(), with the
      // stream it carries.
      const secondaryRingerElement =
        mediaDevices.getMediaElement("ringoutput2");
      if (secondaryRingerElement) {
        secondaryRingerElement.srcObject =
          this._outputAudio.secondaryRingDestinationStream.stream;
      }
    }

    // Last: it reads the sinks both routes above have settled on.
    this._updateTonesRouting();
  }

  // Severs the previous tones graph, if there is one. A no-op on the first
  // build. Sources still running on it (an oscillator mid-beep, a tone buffer
  // mid-play) are left to end and disconnect themselves as they always would
  // - this only takes away what they were playing into, which by then reaches
  // nothing anyway. See _buildTonesGraph().
  _teardownTonesGraph() {
    [
      this._outputAudio.tonesGain,
      this._outputAudio.callWaitingGain,
      this._outputAudio.autoAnswerWarningGain,
      this._outputAudio.tonesBus,
      this._outputAudio.tonesDirectGain,
      this._outputAudio.tonesElementGain,
    ].forEach((node) => {
      if (node) {
        node.disconnect();
      }
    });
  }

  // The tones channel, built as a unit so it can be built again on a context
  // of its own - see _ensureTonesContext(). Nodes belong to the context that
  // created them, so a promotion is a rebuild, not a move.
  //
  // A rebuild takes the previous graph down with it, because by then there is
  // nothing left on it worth keeping. A rebuild only happens on a promotion,
  // and a promotion only fires while _tonesRouteDirect() is false - so the
  // old graph's direct leg is at zero by construction, and its element leg is
  // cut the moment the repoint below moves the element onto the new stream.
  // Both legs are silent either way; leaving them connected would strand a
  // MediaStreamAudioDestinationNode being fed at unity on the shared context,
  // producing a stream nothing consumes.
  _buildTonesGraph(context) {
    this._teardownTonesGraph();

    this._outputAudio.tonesGain = this._shimCreateGain(context);
    this._outputAudio.tonesGain.gain.value = this._config.channels.tones.volume;

    // Tones can reach the speaker by either of two routes, and every source
    // on this channel shares the choice - hence the bus rather than three
    // sets of connections.
    //
    // The MediaStream -> <audio> route exists because a context has one sink,
    // and these go to the speaker device rather than the ring device. But
    // that hand-off carries a buffering stage of its own, outside the
    // context's latency budget and well over the ~150ms these sounds last:
    // enough to make a keypress tone feel detached from the keypress, and it
    // grows across a session after a glitch rather than settling back.
    //
    // So it is only taken when it earns its keep - when the tones cannot
    // reach the speaker device by playing straight out of their own context.
    // See _updateTonesRouting().
    this._outputAudio.tonesDestinationStream =
      this._shimCreateMediaStreamDestination(context);

    // Repointed on every rebuild, not just the first: the element route has
    // to stay usable on whichever graph is live, because a promoted context
    // whose setSinkId later fails falls back to it.
    const mediaDevices = this._libwebphone.getMediaDevices();
    const speakerElement = mediaDevices
      ? mediaDevices.getMediaElement("audiooutput")
      : null;

    if (speakerElement) {
      speakerElement.srcObject = this._outputAudio.tonesDestinationStream.stream;
      speakerElement.volume = this._tonesMasterVolume();

      // A repoint can leave the element paused. Only on a rebuild, though:
      // at construction there has been no gesture to play it with, and
      // lwpMediaDevices' _startMediaElements() is what covers that - trying
      // here would only emit an error every startup. `dedicated` is set
      // before the rebuild, so it distinguishes the two.
      if (this._tonesAudio.dedicated && speakerElement.paused) {
        Promise.resolve()
          .then(() => {
            return speakerElement.play();
          })
          .catch((error) => {
            this._emit("tones.element.play.error", this, error);
          });
      }
    }

    this._outputAudio.tonesBus = this._shimCreateGain(context);

    // Exactly one leg is audible at a time, gated by gain rather than by
    // connect/disconnect so a route change mid-tone can be ramped instead of
    // cutting. Both start silent; _updateTonesRouting() opens one.
    this._outputAudio.tonesDirectGain = this._shimCreateGain(context);
    this._outputAudio.tonesDirectGain.gain.value = 0;
    this._outputAudio.tonesDirectGain.connect(context.destination);

    this._outputAudio.tonesElementGain = this._shimCreateGain(context);
    this._outputAudio.tonesElementGain.gain.value = 0;
    this._outputAudio.tonesElementGain.connect(
      this._outputAudio.tonesDestinationStream
    );

    this._outputAudio.tonesBus.connect(this._outputAudio.tonesDirectGain);
    this._outputAudio.tonesBus.connect(this._outputAudio.tonesElementGain);

    // Null rather than false: "no route decided yet", so the next
    // _updateTonesRouting() always applies one.
    this._outputAudio.tonesUsingDirect = null;

    this._outputAudio.tonesGain.connect(this._outputAudio.tonesBus);

    // The call waiting beep goes to the speaker, not the ring output: it
    // announces a second call to someone who is already on one, so it belongs
    // where that conversation is - see _playCallWaitingBeep(). Its own node on
    // the tones bus rather than tonesGain itself, so the DTMF feedback volume
    // (0.15 by default) doesn't scale it, or silence it outright when a user
    // turns keypress feedback down.
    this._outputAudio.callWaitingGain = this._shimCreateGain(context);
    this._outputAudio.callWaitingGain.gain.value =
      this._config.channels.ringer.callWaiting.volume;
    this._outputAudio.callWaitingGain.connect(this._outputAudio.tonesBus);

    // The auto-answer warning tone, on the same bus and for the same
    // reasons as the call waiting beep above, but on a node of its own so
    // the two levels stay independent - this one has to be heard over
    // nothing in particular, that one has to sit under a live call.
    this._outputAudio.autoAnswerWarningGain = this._shimCreateGain(context);
    this._outputAudio.autoAnswerWarningGain.gain.value =
      this._config.channels.ringer.autoAnswerWarning.volume;
    this._outputAudio.autoAnswerWarningGain.connect(this._outputAudio.tonesBus);
  }

  _initRingAudio() {
    this._ringerAudio = {};

    // The ring queue: `{ id, ringtoneId }` per call wanting the ringer, in
    // arrival order. The one at the front owns it - see _resettleRinging().
    this._ringerAudio.calls = [];

    this._ringerAudio.ringerConnected = false;

    // The calls being beeped at rather than rung for - same `{ id, ringtoneId }`
    // shape as the ring queue, because a call moves between the two as the
    // call it is waiting behind comes and goes (see _resettleCallWaiting()).
    // Unlike the ring queue this isn't ordered by ownership: one beep covers
    // however many calls are waiting.
    this._ringerAudio.waiting = [];

    // Whether the beep cycle is running. Tracks (waiting calls && the tone is
    // enabled), so a waiting call with the tone switched off is held here
    // silently and starts beeping if it is switched on mid-call.
    this._ringerAudio.waitingToneActive = false;

    this._ringerAudio.waitingTimer = null;

    // Invalidates a beep whose resume hasn't settled yet, the same way
    // `generation` does for ringing - see _playCallWaitingBeep().
    this._ringerAudio.waitingGeneration = 0;

    // Decoded AudioBuffers keyed by ringtone id (see _ensureRingtoneBuffer),
    // pruned to just what's reachable - these are expensive to hold.
    this._ringerAudio.buffers = {};

    // The source/envelope pair currently ringing.
    this._ringerAudio.playing = null;

    // The ringtone the call at the front of the queue settled on, i.e. what
    // is ringing right now - see startRinging() and _resettleRinging().
    this._ringerAudio.activeId = null;

    // Invalidates an in-flight _startRinging() whose resume/decode hasn't
    // settled yet - see stopAllRinging().
    this._ringerAudio.generation = 0;

    this._ringerAudio.previewActive = false;
    this._ringerAudio.previewId = null;
    // Which control started the preview - see previewRingtone().
    this._ringerAudio.previewSource = null;
    this._ringerAudio.previewPlaying = null;
    this._ringerAudio.previewTimer = null;
    this._ringerAudio.previewToken = 0;

    this._ensureRingtoneBuffer(this._config.channels.ringer.selected);
    this._prewarmAlertInfoRingtones();
  }

  _initTonesAudio() {
    this._tonesAudio = {};

    // Shared with everything else to begin with, and promoted to a context of
    // its own if the speaker and the ring output turn out to be different
    // devices - see _ensureTonesContext().
    this._tonesAudio.context = this._audioContext;

    this._tonesAudio.dedicated = false;

    // A promotion is asynchronous (the sink has to be accepted before the
    // channel is moved onto it), so tones during one keep using the shared
    // context rather than queueing behind it.
    this._tonesAudio.promoting = false;

    // Set when a promotion has been tried and failed, to stop every
    // subsequent keypress retrying it. Cleared when the speaker selection
    // changes, since that is the thing most likely to have been wrong.
    this._tonesAudio.promotionFailed = false;

    this._tonesAudio.sinkId = null;

    // Rendered tones, keyed by frequencies, sample rate and duration - see
    // _toneBuffer(). A dialpad's worth is a few tens of kilobytes.
    this._tonesAudio.buffers = {};
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
    // Debug only, and deliberately the *first* thing bound: a call that never
    // reaches "ringing.started" leaves nothing else in the trace, and this is
    // what separates "the call never got here" from "it was routed wrongly".
    this._libwebphone.on("call.created", (lwp, call) => {
      this._callWaitingLog("call.created", () => ({
        callId: call.getId(),
        ringing: call.isRinging(),
        direction: call.getDirection(),
        hasSession: call.hasSession(),
      }));
    });

    this._libwebphone.on("call.ringing.started", (lwp, call) => {
      // Resolved here rather than inside startRinging() so a host app calling
      // startRinging() by hand keeps the behaviour it always had.
      let ringtoneId = null;

      try {
        ringtoneId = this.getRingtoneForAlertInfo(call.getAlertInfo());
      } catch (error) {
        // Ringing matters more than ringing with the right ringtone: a throw
        // escaping here would take out every listener after this one (the
        // emit loop is synchronous) and leave the call silent. A host matcher
        // is caught closer to the throw, in _matchAlertInfoKey - this is the
        // backstop for everything else. null rings with the selected ringtone.
        this._emit("channel.ringer.alertinfo.error", this, error);
      }

      // A call arriving on top of an established one is announced with the
      // call waiting tone instead of ringing over it - see startCallWaiting().
      const shouldWait = this._shouldCallWait(call.getId());

      this._callWaitingLog("call.ringing.started", () => ({
        callId: call.getId(),
        route: shouldWait ? "callwaiting" : "ringing",
        ringtoneId,
      }));

      if (shouldWait) {
        this.startCallWaiting(call.getId(), ringtoneId);

        return;
      }

      this.startRinging(call.getId(), ringtoneId);
    });
    this._libwebphone.on("call.ringing.stopped", (lwp, call) => {
      this._callWaitingLog("call.ringing.stopped", () => ({ callId: call.getId() }));

      // Whichever of the two it ended up on - the call may have moved between
      // them while it rang, and the one it isn't on ignores it.
      this.stopRinging(call.getId());
      this.stopCallWaiting(call.getId());
    });

    // Which of the two an unanswered call belongs on depends on the calls
    // around it, so it is re-decided whenever one of those changes rather than
    // only when the call itself arrived: an established call clearing hands
    // the ringer to the call that was waiting behind it, and a call being
    // answered elsewhere drops one that is still ringing to the beep.
    ["call.established", "call.terminated", "call.ended", "call.failed"].forEach(
      (event) => {
        this._libwebphone.on(event, (lwp, call) => {
          this._callWaitingLog(event, () => ({
            callId: call ? call.getId() : null,
            waiting: this._ringerAudio.waiting.map((entry) => entry.id),
            ringQueue: this._ringerAudio.calls.map((entry) => entry.id),
          }));

          this._resettleCallWaiting();
        });
      }
    );

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

      // Also here, not just on a sink change: until the devices are
      // enumerated _tonesRouteDirect() has no groupIds to match aliases with
      // and can only compare ids, so its answer is worth revisiting once
      // they arrive.
      this._updateTonesRouting();
    });

    // Emitted once the speaker element's setSinkId has settled, so the sink
    // read here is the one actually in force - see _tonesRouteDirect().
    this._libwebphone.on("mediaDevices.audio.output.changed", () => {
      // A promotion that failed against the previous device deserves another
      // go against this one.
      this._tonesAudio.promotionFailed = false;

      this._syncTonesContextSink().then(() => {
        this._updateTonesRouting();
      });
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
      // The secondary ring output bypasses masterGain, so its stand-in for it
      // has to be moved by hand - see _secondaryRingVolume().
      if (this.isSecondaryRingOutputEnabled()) {
        this._setSecondaryRingGain(this._secondaryRingVolume());
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
        ringtonesection: "libwebphone:audioContext.ringtonesection",
        ringtone: "libwebphone:audioContext.ringtone",
        ringtonepreview: "libwebphone:audioContext.ringtonepreview",
        ringtonepreviewstop: "libwebphone:audioContext.ringtonepreviewstop",
        callwaitingsection: "libwebphone:audioContext.callwaitingsection",
        callwaiting: "libwebphone:audioContext.callwaiting",
        callwaitinginterval: "libwebphone:audioContext.callwaitinginterval",
        autoanswerwarningsection: "libwebphone:audioContext.autoanswerwarningsection",
        autoanswerwarning: "libwebphone:audioContext.autoanswerwarning",
        alertinfointernal: "libwebphone:audioContext.alertinfointernal",
        alertinfoexternal: "libwebphone:audioContext.alertinfoexternal",
        alertinfocustom: "libwebphone:audioContext.alertinfocustom",
        alertinfoempty: "libwebphone:audioContext.alertinfoempty",
        alertinfodefault: "libwebphone:audioContext.alertinfodefault",
        alertinfokey: "libwebphone:audioContext.alertinfokey",
        alertinfoinvalid: "libwebphone:audioContext.alertinfoinvalid",
        alertinfoadd: "libwebphone:audioContext.alertinfoadd",
        alertinforemove: "libwebphone:audioContext.alertinforemove",
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
              // null is this button's ownership token - see
              // previewRingtone(). A preview started from one of the
              // Alert-Info rows switches here rather than just stopping.
              this.toggleRingtonePreview();
            },
          },
        },
        callwaiting: {
          events: {
            onchange: (event) => {
              this.setCallWaitingEnabled(event.srcElement.checked);
            },
          },
        },
        autoanswerwarning: {
          events: {
            onchange: (event) => {
              this.setAutoAnswerWarningEnabled(event.srcElement.checked);
            },
          },
        },
        callwaitinginterval: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;

              this.setCallWaitingInterval(element.value);

              // Written back rather than left as typed: the interval is
              // clamped, and a value that clamped to what was already set
              // changes nothing and so re-renders nothing.
              element.value = this.getCallWaitingInterval();
            },
          },
        },
        alertinfointernal: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              // "" is the "use selected ringtone" option, which
              // setAlertInfoRingtone() reads as clearing the mapping.
              this.setAlertInfoRingtone(INTERNAL_KEY, element.value);
            },
          },
        },
        alertinfointernalpreview: {
          events: {
            onclick: () => {
              this._previewAlertInfoRingtone(INTERNAL_KEY);
            },
          },
        },
        alertinfoexternal: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              this.setAlertInfoRingtone(EXTERNAL_KEY, element.value);
            },
          },
        },
        alertinfoexternalpreview: {
          events: {
            onclick: () => {
              this._previewAlertInfoRingtone(EXTERNAL_KEY);
            },
          },
        },
        alertinfoadd: {
          events: {
            // The renderer appends the render to every handler's arguments,
            // which is how this reaches the two inputs it belongs with.
            onclick: (event, render) => {
              const keyElement = render.by_id.alertinfokey.element;
              const ringtoneElement = render.by_id.alertinforingtone.element;

              if (!keyElement || !ringtoneElement) {
                return;
              }

              // Trimmed in place, so a whitespace-only entry reads as the
              // empty value it normalises to.
              keyElement.value = keyElement.value.trim();

              // No need to clear the inputs afterwards: adding re-renders the
              // target, and a rejected key (empty, or a ringtone that doesn't
              // resolve) is better left in place for the user to correct.
              const added = this.setAlertInfoRingtone(
                keyElement.value,
                ringtoneElement.value
              );

              // Nothing happened and nothing re-rendered, so say so through
              // the input's own validity state rather than a message element
              // the host never asked for. Deliberately not the `required`
              // attribute: this template can be rendered inside a host's own
              // <form>, and an empty box here must not block that form.
              this._setAlertInfoKeyValidity(keyElement, added ? null : render);

              if (!added && typeof keyElement.reportValidity == "function") {
                keyElement.reportValidity();
              }
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
        // Inputs of the "add a mapping" row - both are read by alertinfoadd
        // above rather than acting on their own.
        alertinfokey: {
          events: {
            oninput: (event) => {
              // Drop the rejection as soon as they start correcting it. A
              // custom validity left set keeps the field :invalid, which
              // would style it as wrong while they type and, inside a host's
              // <form>, would block submitting it.
              this._setAlertInfoKeyValidity(event.srcElement, null);
            },
          },
        },
        alertinforingtone: {},
      },
      by_name: {
        // One name shared by every custom mapping row, the way lwpCallList
        // handles its call list - by_id can't address a list that grows.
        alertinfomapping: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              // The row's key travels on the element: a <select>'s value is
              // already spoken for by the ringtone it picks.
              this.setAlertInfoRingtone(
                element.getAttribute("data-alert-info"),
                element.value
              );
            },
          },
        },
        alertinfopreview: {
          events: {
            onclick: (event) => {
              this._previewAlertInfoRingtone(event.srcElement.value);
            },
          },
        },
        alertinforemove: {
          events: {
            onclick: (event) => {
              this.removeAlertInfoMapping(event.srcElement.value);
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

  // The default template is the three sections below, stacked. A render
  // target that wants one of them on its own asks for it by name rather than
  // switching the other two off - see renderAddTarget().
  _renderDefaultTemplate() {
    return `
        <div>
          ${this._renderVolumesSection()}

          ${this._renderRingtonesSection()}

          ${this._renderCallWaitingSection()}

          ${this._renderAutoAnswerWarningSection()}
        </div>
        `;
  }

  // The same sections as standalone templates, each wrapped in the root the
  // renderer writes into. Keyed by the name a render target passes as
  // `section`.
  _renderSectionTemplates() {
    return {
      volumes: `
        <div>
          ${this._renderVolumesSection()}
        </div>
        `,
      ringtones: `
        <div>
          ${this._renderRingtonesSection()}
        </div>
        `,
      callwaiting: `
        <div>
          ${this._renderCallWaitingSection()}
        </div>
        `,
      autoanswerwarning: `
        <div>
          ${this._renderAutoAnswerWarningSection()}
        </div>
        `,
    };
  }

  // One row per channel, each on its own `show` - a mixer, and nothing else.
  _renderVolumesSection() {
    return `
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
    `;
  }

  // The ringtone selector and the Alert-Info mappings belong together: they
  // pick the same thing, one by hand and one by what the INVITE carried.
  // Gated separately from the ringer volume, so a host app can render the two
  // in different places - see channels.ringer.ringtones.show.
  _renderRingtonesSection() {
    return `
          {{#data.channels.ringer.ringtones.show}}
            <fieldset>
              <legend>{{i18n.ringtonesection}}</legend>

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

              {{#data.channels.ringer.alertInfo.show}}
                {{#data.alertInfo.internal}}
                  <div>
                    <label for="{{by_id.alertinfointernal.elementId}}">
                      {{i18n.alertinfointernal}}
                    </label>
                    <select id="{{by_id.alertinfointernal.elementId}}">
                      <option value="">{{i18n.alertinfodefault}}</option>
                      {{#ringtones}}
                        <option value="{{id}}" {{#selected}}selected{{/selected}}>{{name}}</option>
                      {{/ringtones}}
                    </select>
                    <button type="button" id="{{by_id.alertinfointernalpreview.elementId}}">
                      {{#previewing}}{{i18n.ringtonepreviewstop}}{{/previewing}}
                      {{^previewing}}{{i18n.ringtonepreview}}{{/previewing}}
                    </button>
                  </div>
                {{/data.alertInfo.internal}}

                {{#data.alertInfo.external}}
                  <div>
                    <label for="{{by_id.alertinfoexternal.elementId}}">
                      {{i18n.alertinfoexternal}}
                    </label>
                    <select id="{{by_id.alertinfoexternal.elementId}}">
                      <option value="">{{i18n.alertinfodefault}}</option>
                      {{#ringtones}}
                        <option value="{{id}}" {{#selected}}selected{{/selected}}>{{name}}</option>
                      {{/ringtones}}
                    </select>
                    <button type="button" id="{{by_id.alertinfoexternalpreview.elementId}}">
                      {{#previewing}}{{i18n.ringtonepreviewstop}}{{/previewing}}
                      {{^previewing}}{{i18n.ringtonepreview}}{{/previewing}}
                    </button>
                  </div>
                {{/data.alertInfo.external}}

                <fieldset>
                  <legend>{{i18n.alertinfocustom}}</legend>

                  {{#data.alertInfo.hasCustom}}
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">{{i18n.alertinfokey}}</th>
                          <th scope="col">{{i18n.ringtone}}</th>
                          <th scope="col"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {{#data.alertInfo.custom}}
                          <tr>
                            {{! A row header, not a cell: it is what names the
                                controls beside it, so a screen reader announces
                                which mapping a Preview or Remove belongs to
                                without every button needing a label of its own. }}
                            <th scope="row">{{key}}</th>
                            <td>
                              <select name="{{by_name.alertinfomapping.elementName}}" data-alert-info="{{key}}" aria-label="{{i18n.ringtone}}">
                                <option value="">{{i18n.alertinfodefault}}</option>
                                {{#ringtones}}
                                  <option value="{{id}}" {{#selected}}selected{{/selected}}>{{name}}</option>
                                {{/ringtones}}
                              </select>
                            </td>
                            <td>
                              <button type="button" name="{{by_name.alertinfopreview.elementName}}" value="{{key}}">
                                {{#previewing}}{{i18n.ringtonepreviewstop}}{{/previewing}}
                                {{^previewing}}{{i18n.ringtonepreview}}{{/previewing}}
                              </button>
                              {{#removable}}
                                <button type="button" name="{{by_name.alertinforemove.elementName}}" value="{{key}}">
                                  {{i18n.alertinforemove}}
                                </button>
                              {{/removable}}
                            </td>
                          </tr>
                        {{/data.alertInfo.custom}}
                      </tbody>
                    </table>
                  {{/data.alertInfo.hasCustom}}

                  {{^data.alertInfo.hasCustom}}
                    <p>{{i18n.alertinfoempty}}</p>
                  {{/data.alertInfo.hasCustom}}

                  <div>
                    {{! Labelled with aria-label rather than a <label>: the row
                        is a compact toolbar, and a placeholder is not an
                        accessible name (it disappears as soon as anything is
                        typed). }}
                    <input type="text" id="{{by_id.alertinfokey.elementId}}" placeholder="{{i18n.alertinfokey}}" aria-label="{{i18n.alertinfokey}}">
                    <select id="{{by_id.alertinforingtone.elementId}}" aria-label="{{i18n.ringtone}}">
                      <option value="">{{i18n.alertinfodefault}}</option>
                      {{#data.alertInfo.ringtones}}
                        <option value="{{id}}">{{name}}</option>
                      {{/data.alertInfo.ringtones}}
                    </select>
                    <button type="button" id="{{by_id.alertinfoadd.elementId}}">
                      {{i18n.alertinfoadd}}
                    </button>
                  </div>
                </fieldset>
              {{/data.channels.ringer.alertInfo.show}}
            </fieldset>
          {{/data.channels.ringer.ringtones.show}}
    `;
  }

  // Just the tone. The other two auto-answer settings (whether it happens
  // at all, and whether it opens the microphone) live on config.call, which
  // this module does not own - see libwebphone.setAutoAnswerEnabled().
  _renderAutoAnswerWarningSection() {
    return `
          {{#data.channels.ringer.autoAnswerWarning.show}}
            <fieldset>
              <legend>{{i18n.autoanswerwarningsection}}</legend>

              <div>
                {{! Checkbox before its label, matching the call waiting
                    row below. }}
                <input type="checkbox" id="{{by_id.autoanswerwarning.elementId}}" {{#data.autoAnswerWarning.enabled}}checked{{/data.autoAnswerWarning.enabled}}>
                <label for="{{by_id.autoanswerwarning.elementId}}">
                  {{i18n.autoanswerwarning}}
                </label>
              </div>
            </fieldset>
          {{/data.channels.ringer.autoAnswerWarning.show}}
    `;
  }

  _renderCallWaitingSection() {
    return `
          {{#data.channels.ringer.callWaiting.show}}
            <fieldset>
              <legend>{{i18n.callwaitingsection}}</legend>

              <div>
                {{! Checkbox before its label, unlike the controls above: the
                    label follows the box it toggles. }}
                <input type="checkbox" id="{{by_id.callwaiting.elementId}}" {{#data.callWaiting.enabled}}checked{{/data.callWaiting.enabled}}>
                <label for="{{by_id.callwaiting.elementId}}">
                  {{i18n.callwaiting}}
                </label>
              </div>

              {{#data.callWaiting.enabled}}
                <div>
                  <label for="{{by_id.callwaitinginterval.elementId}}">
                    {{i18n.callwaitinginterval}}
                  </label>
                  <input type="number" min="{{data.callWaiting.intervalMin}}" max="{{data.callWaiting.intervalMax}}" step="1" value="{{data.callWaiting.interval}}" id="{{by_id.callwaitinginterval.elementId}}">
                </div>
              {{/data.callWaiting.enabled}}
            </fieldset>
          {{/data.channels.ringer.callWaiting.show}}
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

    // The selector's own preview, not any preview - a preview started from an
    // Alert-Info row leaves this false.
    data.ringtonePreviewActive = this.isRingtonePreviewActive(null);
    data.alertInfo = this._renderAlertInfoData();

    // Read live rather than from the cloned config the render was built with
    // (see _renderConfigData) - that is a snapshot, so a toggle or an
    // interval change wouldn't show up in it.
    const callWaiting = this._config.channels.ringer.callWaiting;

    data.callWaiting = {
      enabled: this.isCallWaitingEnabled(),
      interval: this.getCallWaitingInterval(),
      intervalMin: callWaiting.intervalMin,
      intervalMax: callWaiting.intervalMax,
      waiting: this.isCallWaiting(),
    };

    // Read live for the same reason as callWaiting above - the cloned
    // config the render was built from is a snapshot, so a toggle would not
    // show up in it.
    data.autoAnswerWarning = {
      enabled: this.isAutoAnswerWarningEnabled(),
    };

    return data;
  }

  // The two platform keys get their own labelled rows in the default template,
  // so they're split out here; everything else - including any further key a
  // host app declared built-in - falls into `custom`, where only genuinely
  // custom entries offer a remove button. Matching itself doesn't know the
  // difference (see _matchAlertInfoKey), this is presentation only.
  _renderAlertInfoData() {
    const ringtones = this.getRingtones();
    const mappings = this.getAlertInfoMappings().map((mapping) => {
      return {
        key: mapping.key,
        ringtone: mapping.ringtone,
        builtin: mapping.builtin,
        removable: !mapping.builtin,
        // Whether *this row* started the preview, not whether its ringtone
        // happens to be the one playing - rows sharing a ringtone would
        // otherwise all show themselves as playing.
        previewing: this.isRingtonePreviewActive(mapping.key),
        ringtones: ringtones.map((ringtone) => {
          return {
            id: ringtone.id,
            name: ringtone.name,
            selected: ringtone.id === mapping.ringtone,
          };
        }),
      };
    });
    const isPlatformKey = (mapping) => {
      return mapping.key === INTERNAL_KEY || mapping.key === EXTERNAL_KEY;
    };
    const custom = mappings.filter((mapping) => {
      return !isPlatformKey(mapping);
    });

    return {
      internal: mappings.find((mapping) => {
        return mapping.key === INTERNAL_KEY;
      }),
      external: mappings.find((mapping) => {
        return mapping.key === EXTERNAL_KEY;
      }),
      custom: custom,
      // The template needs a plain boolean: a section on `custom` itself
      // repeats per row, which is not what "show the table" means.
      hasCustom: custom.length > 0,
      // Nothing preselected - these are the options of the "add a mapping"
      // row, not of an existing one.
      ringtones: ringtones,
    };
  }

  /** Helper functions */

  // Resolves to whether the context is running, waiting only briefly for a
  // resume that may never come. resume() can't be awaited unguarded: while a
  // browser is withholding playback Chrome leaves the promise *pending
  // indefinitely* rather than rejecting, so awaiting it before a ring would
  // mean the phone silently never rings. Raced against a short timeout and
  // decided on the context's actual state instead.
  _resumeAudioContext(timeoutMs = 150) {
    return this._resumeContext(this._audioContext, timeoutMs);
  }

  // The same, for whichever context is asked for - the tones channel can be
  // running on one of its own (see _ensureTonesContext).
  _resumeContext(context, timeoutMs = 150) {
    if (!context) {
      return Promise.resolve(false);
    }

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
  // implement sinkId at all (anything on Android) - both mean "the default
  // device".
  _getMediaElementSinkId(deviceKind) {
    const mediaDevices = this._libwebphone.getMediaDevices();
    const element = mediaDevices
      ? mediaDevices.getMediaElement(deviceKind)
      : null;

    return (element && element.sinkId) || "";
  }

  _getRingOutputElementSinkId() {
    return this._getMediaElementSinkId("ringoutput");
  }

  // Gives the tones channel a context of its own, so that it can have a sink
  // of its own.
  //
  // A context has exactly one sink, and in context-sink mode ring output has
  // already claimed the shared one. That leaves the tones no way to reach a
  // speaker device that differs from the ring device except the MediaStream
  // -> <audio> hand-off and its buffering, which is precisely what makes a
  // keypress tone feel late. A second context sidesteps the conflict: ring
  // output keeps the sink it has, and the tones get one pointed at the
  // speaker.
  //
  // Created only when the route would otherwise be the slow one, rather than
  // at init: where the speaker and the ring output land on the same device
  // the shared context already reaches the speaker directly, and a second one
  // would be a hardware output stream held open for nothing. Most users never
  // split the two, and never create this at all.
  //
  // Called from _updateTonesRouting(), so it happens as soon as the split is
  // known - usually as the speaker is selected, which carries the user
  // activation a new context needs to start running rather than suspended.
  // Where it doesn't (a split restored from config before anyone has touched
  // the page) the context starts suspended, _tonesRouteDirect() keeps the
  // channel on the element route until startAudioContext() has woken it, and
  // the cost is one late tone rather than a silent one.
  _ensureTonesContext() {
    if (
      this._tonesAudio.dedicated ||
      this._tonesAudio.promoting ||
      this._tonesAudio.promotionFailed
    ) {
      return;
    }

    // Without AudioContext.setSinkId a second context could not be pointed at
    // the speaker either, so it would buy nothing over the element route.
    if (!this._outputAudio.usingContextSink) {
      return;
    }

    // A ring output sink change in flight has not reached _outputAudio.sinkId
    // yet, so the split that got us here may not be a real one - at startup
    // the ring device and the speaker are routinely applied a tick apart.
    // Promoting on that would open a context for the life of the page that
    // nothing ever needed. setRingOutputSinkId() re-runs the routing once it
    // settles.
    if (this._outputAudio.sinkChanging) {
      return;
    }

    let context;

    try {
      context = this._shimAudioContext();
    } catch (error) {
      this._tonesAudio.promotionFailed = true;

      this._emit("tones.context.error", this, error);

      return;
    }

    this._tonesAudio.promoting = true;

    const sinkId = this._speakerSinkId();

    // The sink is claimed before the channel is moved onto the context, not
    // after: a context that cannot be pointed at the speaker would play the
    // tones out of the wrong device, which is worse than playing them late.
    Promise.resolve()
      .then(() => {
        return this._resumeContext(context);
      })
      .then(() => {
        return context.setSinkId(sinkId);
      })
      .then(
        () => {
          this._tonesAudio.context = context;
          this._tonesAudio.sinkId = sinkId;
          this._tonesAudio.dedicated = true;

          this._buildTonesGraph(context);
          this._updateTonesRouting();

          // The sink was chosen before the resume and the setSinkId above,
          // and a speaker change landing in between is dropped by both
          // guards - _syncTonesContextSink() early-returns while `dedicated`
          // is still false, and _ensureTonesContext() while `promoting` is
          // true. So the selection is checked again here, now that neither
          // guard applies. A no-op unless it actually moved.
          this._syncTonesContextSink();

          this._emit("tones.context.created", this, sinkId);
        },
        // A rejection handler on this .then rather than a .catch after it, so
        // that it covers only the resume and the setSinkId above. A .catch
        // would also cover the handler beside it - and that one has already
        // adopted the context, so a host listener throwing out of the
        // "created" event would close the live tones context and latch
        // promotionFailed, leaving keypress tones, the call waiting beep and
        // the auto-answer warning permanently silent.
        (error) => {
          this._tonesAudio.promotionFailed = true;

          this._emit("tones.context.error", this, error);

          // Hand the output stream back rather than leaving a context open
          // that nothing is going to play through.
          if (typeof context.close == "function") {
            context.close().catch(() => {});
          }
        }
      )
      // Whatever the adoption handler above may have thrown. Reported and
      // dropped: the context is adopted and working either way, and there is
      // nothing here to undo.
      .catch((error) => {
        this._emit("tones.context.error", this, error);
      })
      .finally(() => {
        this._tonesAudio.promoting = false;
      });
  }

  // Where the speaker actually is, which is what the tones have to follow.
  // The element's sink rather than the configured preference: a selection the
  // browser refused leaves the speaker on the default device, and sending the
  // tones somewhere the rest of the speaker audio is not would be worse than
  // any delay.
  _speakerSinkId() {
    return this._normalizeSinkId(this._getMediaElementSinkId("audiooutput"));
  }

  // Keeps a promoted tones context pointed at the speaker as the selection
  // moves. On failure the channel falls back to the element route rather than
  // going on playing out of a device the speaker is no longer on.
  _syncTonesContextSink() {
    if (!this._tonesAudio.dedicated) {
      return Promise.resolve(false);
    }

    const context = this._tonesAudio.context;
    const sinkId = this._speakerSinkId();

    if (sinkId == this._tonesAudio.sinkId) {
      return Promise.resolve(true);
    }

    return Promise.resolve()
      .then(() => {
        return context.setSinkId(sinkId);
      })
      .then(() => {
        this._tonesAudio.sinkId = sinkId;

        return true;
      })
      .catch((error) => {
        // The context is still on the old device, so the direct route no
        // longer reaches the speaker - _tonesRouteDirect() reads this.
        this._tonesAudio.sinkId = null;

        this._updateTonesRouting();

        this._emit("tones.sink.error", this, error);

        return false;
      });
  }

  // Whether the tones channel can skip the MediaStream -> <audio> hand-off
  // and play straight out of the context. It can whenever both routes would
  // land on the same speaker anyway, which is the usual case - a device has
  // to have been picked for the speaker, and picked differently from where
  // context.destination already plays, before the element earns its latency.
  //
  // Compares the sinks actually in force, not the configured preferences: a
  // selection the browser refused (or never had setSinkId to apply) leaves
  // the element on the default device, and that is what has to be matched.
  //
  // The comparison goes through lwpMediaDevices rather than matching ids
  // directly, because "default", "communications" and a concrete id can all
  // name one speaker - and a ring output left on the default alias while the
  // speaker was pointed at that same device by its own id is a pairing a
  // plain id match would send down the slow route for nothing.
  _tonesRouteDirect() {
    // A promoted tones context has a sink of its own, so playing straight out
    // of it always reaches the speaker - whatever ring output has done with
    // the shared context's sink. A null sinkId means a setSinkId came unstuck
    // and the context is on some other device, which the element route has to
    // cover until the selection moves again.
    if (this._tonesAudio.dedicated) {
      return (
        this._tonesAudio.sinkId !== null &&
        this._tonesAudio.context.state === "running"
      );
    }

    // Where context.destination plays out: the device set on the context in
    // context-sink mode, the browser's default in element mode (where the
    // context's sink is never set at all and masterGain leaves by a stream).
    const contextSinkId = this.usesContextSink()
      ? this._normalizeSinkId(this._outputAudio.sinkId)
      : "";
    const elementSinkId = this._normalizeSinkId(
      this._getMediaElementSinkId("audiooutput")
    );

    if (contextSinkId == elementSinkId) {
      return true;
    }

    const mediaDevices = this._libwebphone.getMediaDevices();

    return !!(
      mediaDevices &&
      mediaDevices.isSameOutputDevice(contextSinkId, elementSinkId)
    );
  }

  // Opens whichever of the two tone routes is right for the sinks currently
  // in force and silences the other. Cheap and idempotent - called wherever
  // either sink can have moved.
  _updateTonesRouting() {
    if (!this._outputAudio || !this._outputAudio.tonesBus) {
      return;
    }

    const direct = this._tonesRouteDirect();

    // The route being the slow one is the whole reason a context of its own
    // exists, so this is where it gets created - not on a keypress, which was
    // only ever standing in for this condition.
    //
    // Above the early return below, not after it: a promotion that failed
    // against a previous device is retried from here when the selection
    // moves, and the route it would land on has not changed in the meantime.
    // _ensureTonesContext() is a no-op once one exists, is in flight, or has
    // failed against this selection, so a false route cannot spin here.
    if (!direct) {
      this._ensureTonesContext();
    }

    if (this._outputAudio.tonesUsingDirect === direct) {
      return;
    }

    this._outputAudio.tonesUsingDirect = direct;

    // The element route applies the master level itself, through the
    // element's own volume - so the direct leg has to stand in for it, or
    // changing route would change how loud keypress feedback is.
    this._setToneRouteGain(
      this._outputAudio.tonesDirectGain,
      direct ? this._tonesMasterVolume() : 0
    );
    this._setToneRouteGain(this._outputAudio.tonesElementGain, direct ? 0 : 1);

    this._emit("tones.route.changed", this, direct ? "direct" : "element");
  }

  // Ramped rather than assigned, for the same reason changeVolume() ramps: a
  // route can be switched while a tone is sounding, and a single-sample step
  // would click.
  _setToneRouteGain(gainNode, volume) {
    if (!gainNode) {
      return;
    }

    // The node's own context, not the shared one: the tones channel can be
    // running on a context of its own, and its clock is the one these ramps
    // are scheduled against.
    const context = gainNode.context;

    if (context.state == "running") {
      gainNode.gain.setTargetAtTime(volume, context.currentTime, 0.015);
    } else {
      gainNode.gain.value = volume;
    }
  }

  // The tones channel never passes through masterGain (it has a route to the
  // speaker of its own), so the master level reaches it only by being applied
  // by hand - to the element on one route, to the direct leg's gain on the
  // other. Without this a mid-session master change moves everything except
  // keypress feedback, the call waiting beep and the auto-answer warning.
  // The master level as it applies to the tones channel. The channel has its
  // own route to the speaker rather than passing through masterGain, so
  // `connectToMaster` is honoured here instead of by a connection - the same
  // stand-in _secondaryRingVolume() makes for the secondary ring output.
  _tonesMasterVolume() {
    return this._config.channels.tones.connectToMaster
      ? this._config.channels.master.volume
      : 1.0;
  }

  _syncTonesMasterVolume() {
    const volume = this._tonesMasterVolume();

    if (this._outputAudio.tonesUsingDirect) {
      this._setToneRouteGain(this._outputAudio.tonesDirectGain, volume);
    }

    const mediaDevices = this._libwebphone.getMediaDevices();
    const element = mediaDevices
      ? mediaDevices.getMediaElement("audiooutput")
      : null;

    if (element) {
      element.volume = volume;
    }
  }

  // ringerGain has already applied the ringer level, but the secondary path
  // never reaches masterGain - this stands in for it so both ring outputs
  // track the master volume together.
  _secondaryRingVolume() {
    return this._config.channels.ringer.connectToMaster
      ? this._config.channels.master.volume
      : 1.0;
  }

  _setSecondaryRingGain(volume) {
    const gainNode = this._outputAudio.secondaryRingGain;
    const context = this._audioContext;

    if (!gainNode) {
      return;
    }

    // Ramped for the same reason changeVolume() ramps - a single-sample step
    // clicks against a ring already playing, which enabling a second device
    // mid-ring would otherwise do.
    if (context.state == "running") {
      gainNode.gain.setTargetAtTime(volume, context.currentTime, 0.015);
    } else {
      gainNode.gain.value = volume;
    }
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
  // roughly half a megabyte decoded. Keep only what's reachable - selected,
  // previewing, the ring in progress and (when prewarming) the Alert-Info
  // mappings - rather than all of channels.ringer.files.
  _pruneRingtoneBuffers() {
    const alertInfo = this._config.channels.ringer.alertInfo;
    const keep = [
      this._config.channels.ringer.selected,
      this._ringerAudio.previewId,
      // A mapped ringtone decoded on demand for the current ring: without
      // this a prune mid-ring would drop the buffer that ring is using, and
      // the next one would have to decode it again.
      this._ringerAudio.activeId,
      // Same for the calls queued behind it, so taking the ringer over is a
      // buffer already in hand rather than another decode.
      ...this._ringerAudio.calls.map((entry) => {
        return entry.ringtoneId;
      }),
      // And for the calls being beeped at rather than rung for: one of those
      // takes the ringer over if the call it is waiting behind clears while
      // it is still ringing (see _resettleCallWaiting()).
      ...this._ringerAudio.waiting.map((entry) => {
        return entry.ringtoneId;
      }),
    ];

    if (alertInfo.enabled && alertInfo.prewarm) {
      keep.push(...this._alertInfoRingtoneIds());
    }

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

  // Where a call sits in the ring queue, by the id startRinging() was given.
  // Calls started without one all share the id null, so they come off the
  // queue in arrival order.
  _ringingCallIndex(requestId) {
    return this._ringerAudio.calls.findIndex((entry) => {
      return entry.id === requestId;
    });
  }

  // The ringer follows the call at the front of the queue, the way a desk
  // phone does: a second call ringing behind the first is silent until the
  // first is answered or gone, and only then is its own ringtone heard.
  // Called when the queue changes, so it's a no-op unless the front of it did.
  _resettleRinging() {
    const next = this._ringerAudio.calls[0];

    if (!next || next.ringtoneId === this._ringerAudio.activeId) {
      return;
    }

    this._ringerAudio.activeId = next.ringtoneId;

    // _startRinging() bumps the generation, so an attempt still waiting on a
    // resume or decode can't land on top of this one - but the source already
    // ringing is ours to stop.
    this._stopRingerSource(this._ringerAudio.playing);
    this._ringerAudio.playing = null;

    this._startRinging();
  }

  // Starts the ringtone once the context state and decoded buffer are both
  // known. Both are required with nothing to fall back to, so a failure of
  // either is reported rather than worked around - the statechange listener
  // in _initEventBindings() retries this if the context resumes later.
  _startRinging() {
    const generation = ++this._ringerAudio.generation;
    // Whatever the call at the front of the queue settled on - the selected
    // ringtone unless an Alert-Info mapping overrode it.
    const active =
      this._ringerAudio.activeId || this._config.channels.ringer.selected;

    Promise.all([
      this._resumeAudioContext(),
      this._ensureRingtoneBuffer(active),
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

  // `details` is a function, not an object: it is only called once the logger
  // is actually enabled, so with debug off nothing here walks a queue or reads
  // an element's state - the cost is the property read below.
  _callWaitingLog(event, details) {
    if (!callWaitingDebug.enabled) {
      return;
    }

    // One line per event, details as an object so the console renders it
    // expandable rather than as a wall of text.
    callWaitingDebug(event, details ? details() : "");
  }

  // Where the beep actually goes, and whether anything is in a state to play
  // it. The beep is scheduled onto the AudioContext graph but only becomes
  // audible through the `audiooutput` element, so a paused or re-pointed
  // element is silence that the scheduling side cannot see.
  _callWaitingOutputInfo() {
    const mediaDevices = this._libwebphone.getMediaDevices();
    const element = mediaDevices
      ? mediaDevices.getMediaElement("audiooutput")
      : null;

    const info = {
      contextState: this._audioContext.state,
      gainConnected: !!this._outputAudio.callWaitingGain,
      gain: this._outputAudio.callWaitingGain
        ? this._outputAudio.callWaitingGain.gain.value
        : null,
      masterVolume: this._config.channels.master.volume,
      // On the "direct" route the beep bypasses the element entirely, so the
      // element details below say nothing about whether it is audible.
      route: this._outputAudio.tonesUsingDirect ? "direct" : "element",
    };

    if (!element) {
      info.element = null;

      return info;
    }

    info.element = {
      paused: element.paused,
      muted: element.muted,
      volume: element.volume,
      readyState: element.readyState,
      hasStream: !!element.srcObject,
      // The beep is only audible if this is still the tones stream the
      // context created - anything else means something re-pointed it.
      isTonesStream: !!(
        element.srcObject &&
        this._outputAudio.tonesDestinationStream &&
        element.srcObject.id == this._outputAudio.tonesDestinationStream.stream.id
      ),
      sinkId: element.sinkId,
    };

    return info;
  }

  // The call waiting counterpart of _ringingCallIndex(). The waiting list has
  // no front to own anything, so this is only ever an identity lookup.
  _waitingCallIndex(requestId) {
    return this._ringerAudio.waiting.findIndex((entry) => {
      return entry.id === requestId;
    });
  }

  // Whether a call should be beeped at rather than rung for: true when some
  // *other* call is already established. Held counts - a held call is still a
  // call in progress, and ringing over the top of one is exactly what the
  // call waiting tone replaces. A call that has ended but hasn't left the
  // call list yet doesn't, so the order the terminated handlers run in can't
  // leave a waiting call beeping at a call that is already gone.
  _shouldCallWait(callId) {
    const callList = this._libwebphone.getCallList();

    if (!callList) {
      this._callWaitingLog("shouldWait", () => ({
        callId,
        result: false,
        reason: "no call list",
      }));

      return false;
    }

    const others = callList.getCalls().filter((call) => {
      return call.getId() !== callId;
    });

    // The decision itself is this line; everything below only describes it.
    const result = others.some((call) => {
      return call.isEstablished() && !call.isEnded();
    });

    this._callWaitingLog("shouldWait", () => ({
      callId,
      result,
      blockedBy: others
        .filter((call) => {
          return call.isEstablished() && !call.isEnded();
        })
        .map((call) => call.getId()),
      // Every call the decision was taken against, so a wrong answer names
      // the call that caused it.
      others: others.map((call) => {
        return {
          id: call.getId(),
          hasSession: call.hasSession(),
          established: call.isEstablished(),
          ended: call.isEnded(),
          ringing: call.isRinging(),
        };
      }),
    }));

    return result;
  }

  // Re-routes calls between ringing and waiting after the calls around them
  // change - an established call clearing, or one being answered while
  // something else is still ringing. Both directions are needed: the call the
  // beeps were protecting can go away (the waiting call should then ring
  // properly), and a call can become established while another is ringing
  // (that one should drop to the beep).
  _resettleCallWaiting() {
    const callList = this._libwebphone.getCallList();

    if (!callList) {
      return;
    }

    // Only entries that are a call still ringing are re-routed. A host
    // application driving startRinging() itself - with no id, or an id of its
    // own - keeps exactly what it asked for, and a call already on its way out
    // is left for the `ringing.stopped` that is about to remove it.
    const isRingingCall = (entry) => {
      const call = entry.id ? callList.getCall(entry.id) : null;

      return !!call && call.isRinging() && !call.isEnded();
    };

    // Snapshots: the moves below mutate both lists.
    const ringing = this._ringerAudio.calls.filter(isRingingCall);
    const waiting = this._ringerAudio.waiting.filter(isRingingCall);

    ringing.forEach((entry) => {
      if (this._shouldCallWait(entry.id)) {
        this._callWaitingLog("resettle", () => ({ callId: entry.id, to: "waiting" }));
        this.stopRinging(entry.id);
        this.startCallWaiting(entry.id, entry.ringtoneId);
      }
    });

    waiting.forEach((entry) => {
      if (!this._shouldCallWait(entry.id)) {
        this._callWaitingLog("resettle", () => ({ callId: entry.id, to: "ringing" }));
        this.stopCallWaiting(entry.id);
        this.startRinging(entry.id, entry.ringtoneId);
      }
    });
  }

  // The single owner of whether the beep cycle is running: everything that can
  // change the answer (a call arriving or leaving, the toggle) just calls
  // this. One cycle covers however many calls are waiting.
  _syncCallWaitingTone() {
    const shouldPlay = this.isCallWaitingEnabled() && this.isCallWaiting();

    if (shouldPlay == this._ringerAudio.waitingToneActive) {
      this._callWaitingLog("sync.unchanged", () => ({
        toneActive: this._ringerAudio.waitingToneActive,
        timerArmed: !!this._ringerAudio.waitingTimer,
        waiting: this._ringerAudio.waiting.map((entry) => entry.id),
      }));

      return;
    }

    this._ringerAudio.waitingToneActive = shouldPlay;

    this._callWaitingLog(shouldPlay ? "cycle.start" : "cycle.stop", () => ({
      waiting: this._ringerAudio.waiting.map((entry) => entry.id),
      interval: this.getCallWaitingInterval(),
      enabled: this.isCallWaitingEnabled(),
    }));

    if (shouldPlay) {
      this._emit("callwaiting.started", this);

      // Beep as the call arrives and then every interval, rather than making
      // the first notification wait a full interval.
      this._playCallWaitingBeep();
      this._scheduleCallWaitingBeep();

      return;
    }

    // Drops a beep whose resume hasn't settled yet, so one can't sound after
    // the last waiting call is answered or cleared.
    this._ringerAudio.waitingGeneration++;

    clearTimeout(this._ringerAudio.waitingTimer);
    this._ringerAudio.waitingTimer = null;

    this._emit("callwaiting.stopped", this);
  }

  // A re-armed timeout rather than an interval, so a mid-call
  // setCallWaitingInterval() applies to the very next beep.
  _scheduleCallWaitingBeep() {
    clearTimeout(this._ringerAudio.waitingTimer);

    const interval = this.getCallWaitingInterval();

    this._callWaitingLog("beep.scheduled", () => ({ inSeconds: interval }));

    this._ringerAudio.waitingTimer = setTimeout(() => {
      this._ringerAudio.waitingTimer = null;

      if (!this._ringerAudio.waitingToneActive) {
        this._callWaitingLog("beep.timer.stale", () => ({
          reason: "cycle no longer active",
          waiting: this._ringerAudio.waiting.map((entry) => entry.id),
        }));

        return;
      }

      this._playCallWaitingBeep();
      this._scheduleCallWaitingBeep();
    }, interval * 1000);
  }

  // One beep, generated rather than decoded - it is a single tone, so there is
  // nothing to load and nothing to keep warm. It plays out of the **speaker**
  // (the `audiooutput` device, where call audio is), not the ring output or
  // the secondary ringer: the person it is for is already on a call, wearing
  // the headset, and a beep on the ring device would be aimed at a room they
  // are not listening to. See _initOutputAudio() for the node it connects to.
  //
  // Self-terminating, so nothing needs stopping - a beep already sounding when
  // the call is answered finishes, a fraction of a second later.
  _playCallWaitingBeep() {
    const generation = ++this._ringerAudio.waitingGeneration;

    // Captured once, before the resume, and used for both: resuming one
    // context and scheduling on another would let a promotion landing during
    // the resume put the beep on a context that was never woken. The node
    // held here stays connected either way - a promotion leaves the previous
    // graph in place rather than tearing it down.
    const gainNode = this._outputAudio.callWaitingGain;
    const context = gainNode.context;

    this._resumeContext(context).then((running) => {
      // The cycle was stopped, or another beep started, while we waited.
      if (this._ringerAudio.waitingGeneration !== generation) {
        this._callWaitingLog("beep.dropped", () => ({
          reason: "superseded while resuming",
          generation,
          current: this._ringerAudio.waitingGeneration,
        }));

        return;
      }

      if (!running) {
        // As with ringing, there is no fallback path - report it rather than
        // failing silently. The next beep tries again.
        this._callWaitingLog("beep.failed", () => ({
          reason: "AudioContext is not running",
          output: this._callWaitingOutputInfo(),
        }));

        // The speaker device rather than getOutputSinkInfo(): the beep plays
        // out of the `audiooutput` element, so the ring output sink says
        // nothing about where it would have been heard.
        this._emit(
          "callwaiting.tone.error",
          this,
          new Error("AudioContext is not running"),
          this._getMediaElementSinkId("audiooutput")
        );

        return;
      }

      // The resume may have been what made the direct leg usable: a
      // suspended context cannot be the direct route, so the cached decision
      // can be one step behind here the same way it is in
      // startAudioContext().
      this._updateTonesRouting();

      const config = this._config.channels.ringer.callWaiting;
      // Read after the resume settled, not before it - the clock has moved on.
      const now = context.currentTime;
      const fadeIn = config.fadeIn;
      const fadeOut = config.fadeOut;
      // The fades are part of the beep, not additions to it, so a duration
      // shorter than both of them together would ramp down before it was up.
      const duration = Math.max(config.duration, fadeIn + fadeOut);

      const oscillator = this._shimCreateOscillator(context);
      const envelope = this._shimCreateGain(context);

      oscillator.type = config.type;
      oscillator.frequency.value = config.frequency;

      // Shape only - the level is `callWaitingGain`, the way every other
      // channel keeps its volume on a node of its own rather than baked into
      // the envelope.
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(1, now + fadeIn);
      envelope.gain.setValueAtTime(1, now + duration - fadeOut);
      envelope.gain.linearRampToValueAtTime(0, now + duration);

      oscillator.connect(envelope);
      envelope.connect(gainNode);

      oscillator.onended = () => {
        oscillator.disconnect();
        envelope.disconnect();
      };

      oscillator.start(now);
      // A small margin past the ramp so the stop lands on real silence.
      oscillator.stop(now + duration + 0.005);

      // Logged with the output state, not just "played": everything above can
      // succeed and still be inaudible if the element carrying the tones
      // stream is paused, muted or pointed somewhere else.
      this._callWaitingLog("beep.played", () => ({
        frequency: config.frequency,
        duration,
        waiting: this._ringerAudio.waiting.map((entry) => entry.id),
        output: this._callWaitingOutputInfo(),
      }));

      this._emit("callwaiting.tone.played", this);
    });
  }

  // Brings whatever survived the config merge into a shape the beep can be
  // built from without throwing - an unknown oscillator type or a NaN
  // frequency would take out the tone entirely, and there is no fallback.
  // The ringtones section's own gate. Unlike `alertInfo` and `callWaiting`
  // below, an unusable value falls back to *shown* rather than hidden: those
  // two carry behaviour, so refusing to enable what couldn't be parsed is the
  // safe answer, whereas this is only a display gate whose default is true -
  // and hiding it would take the ringtone selector, the preview button and
  // the Alert-Info mappings with it, silently. Same reasoning as `selected`
  // in _initProperties(): a bad value falls back to the default, it doesn't
  // switch the feature off.
  _normalizeRingtonesConfig() {
    const ringer = this._config.channels.ringer;

    // As with `files` and `alertInfo`: lwpUtils.merge overwrites with an
    // explicit null, and the template reads `ringtones.show` through it.
    if (!ringer.ringtones || typeof ringer.ringtones != "object") {
      ringer.ringtones = { show: true };
    }

    // An object carrying no `show` of its own means the default too, not
    // hidden - the same fallback as above, reached by a host replacing the
    // subtree with a partial object rather than with a bad value.
    ringer.ringtones.show =
      ringer.ringtones.show === undefined ? true : !!ringer.ringtones.show;
  }

  _normalizeCallWaitingConfig() {
    const ringer = this._config.channels.ringer;

    // As with `files` and `alertInfo`: lwpUtils.merge overwrites with an
    // explicit null, and everything below assumes an object.
    if (!ringer.callWaiting || typeof ringer.callWaiting != "object") {
      ringer.callWaiting = { enabled: false, show: false };
    }

    const callWaiting = ringer.callWaiting;
    const number = (value, fallback, min = 0) => {
      value = Number(value);

      return isFinite(value) && value >= min ? value : fallback;
    };

    callWaiting.enabled = !!callWaiting.enabled;
    callWaiting.show = !!callWaiting.show;

    // The bounds first - the interval is clamped against them.
    callWaiting.intervalMin = number(callWaiting.intervalMin, 10, 1);
    callWaiting.intervalMax = Math.max(
      number(callWaiting.intervalMax, 60, 1),
      callWaiting.intervalMin
    );
    callWaiting.interval = this._clampCallWaitingInterval(
      callWaiting.interval,
      30
    );

    callWaiting.volume = Math.min(number(callWaiting.volume, 0.25), 1);
    callWaiting.frequency = number(callWaiting.frequency, 440, 1);
    callWaiting.duration = number(callWaiting.duration, 0.25, 0.01);
    callWaiting.fadeIn = number(callWaiting.fadeIn, 0.01);
    callWaiting.fadeOut = number(callWaiting.fadeOut, 0.02);

    if (
      !["sine", "square", "sawtooth", "triangle"].includes(callWaiting.type)
    ) {
      callWaiting.type = "sine";
    }
  }

  // Always returns a usable interval: an unusable value falls back, and the
  // result is clamped into [intervalMin, intervalMax] rather than rejected.
  _clampCallWaitingInterval(seconds, fallback) {
    const callWaiting = this._config.channels.ringer.callWaiting;

    let value = Number(seconds);

    if (!isFinite(value)) {
      value = Number(fallback);
    }

    if (!isFinite(value)) {
      value = callWaiting.intervalMin;
    }

    return Math.min(
      Math.max(value, callWaiting.intervalMin),
      callWaiting.intervalMax
    );
  }

  _findRingtone(id) {
    return this._config.channels.ringer.files.find((file) => {
      return file.id === id;
    });
  }

  // Brings whatever survived the config merge into the shape the rest of the
  // class assumes: every built-in key present (so it always has a UI row),
  // every key normalized, and no mapping left pointing at a ringtone that
  // isn't in `files`. Runs before _ringerAudio exists, so it can't decode
  // anything - prewarming happens in _initRingAudio().
  _normalizeAlertInfoConfig() {
    const ringer = this._config.channels.ringer;

    // As with `files` above: lwpUtils.merge overwrites with an explicit null.
    if (!ringer.alertInfo || typeof ringer.alertInfo != "object") {
      ringer.alertInfo = { enabled: false, show: false };
    }

    const alertInfo = ringer.alertInfo;

    if (!Array.isArray(alertInfo.builtin)) {
      alertInfo.builtin = [];
    }

    if (!alertInfo.mappings || typeof alertInfo.mappings != "object") {
      alertInfo.mappings = {};
    }

    alertInfo.builtin = alertInfo.builtin
      .map((key) => {
        return this._normalizeAlertInfoKey(key);
      })
      .filter((key, index, keys) => {
        return key && keys.indexOf(key) === index;
      });

    // Rebuilt rather than edited in place: object key order is the match
    // precedence, and seeding the built-ins first is what stops a customer's
    // own mapping from being consulted before a platform one.
    const mappings = {};

    alertInfo.builtin.forEach((key) => {
      mappings[key] = null;
    });

    Object.keys(alertInfo.mappings).forEach((key) => {
      const normalized = this._normalizeAlertInfoKey(key);

      if (!normalized) {
        return;
      }

      const ringtone = alertInfo.mappings[key];

      mappings[normalized] =
        ringtone && this._findRingtone(ringtone) ? ringtone : null;
    });

    alertInfo.mappings = mappings;
  }

  // Every mapped key, built-ins first. Object key order already reflects that
  // (see _normalizeAlertInfoConfig), but this doesn't depend on it - a host
  // app writing straight to _config shouldn't be able to reorder matching.
  _alertInfoKeys() {
    const alertInfo = this._config.channels.ringer.alertInfo;
    const keys = Object.keys(alertInfo.mappings);
    const builtin = alertInfo.builtin.filter((key) => {
      return keys.includes(key);
    });

    return builtin.concat(
      keys.filter((key) => {
        return !builtin.includes(key);
      })
    );
  }

  // Keys are stored stripped of the <> a SIP header wraps them in, so a
  // customer typing `alert-internal` and one pasting `<alert-internal>` out of
  // a packet capture end up with the same mapping.
  _normalizeAlertInfoKey(key) {
    if (typeof key != "string") {
      return null;
    }

    let normalized = key.trim().toLowerCase();

    if (normalized.startsWith("<") && normalized.endsWith(">")) {
      normalized = normalized.slice(1, -1).trim();
    }

    // Assigning this key on a plain object is ignored by the engine, so the
    // mapping would silently never exist - refuse it the way an empty key is
    // refused. Other exotic names (constructor, prototype) are ordinary own
    // properties and work; nothing here ever tests a key with `in`.
    if (normalized === "__proto__") {
      return null;
    }

    return normalized || null;
  }

  _isBuiltinAlertInfoKey(key) {
    const normalized = this._normalizeAlertInfoKey(key);

    return (
      !!normalized &&
      this._config.channels.ringer.alertInfo.builtin.includes(normalized)
    );
  }

  // Marks the add row's key input as rejected, or clears it with a null
  // `render`. The message goes on the input itself so the browser presents
  // it: the template has no message element to write into, and adding one
  // would impose a layout on the host. A render whose i18n omits the key
  // (a host supplying its own) simply gets no message, never a broken one.
  _setAlertInfoKeyValidity(element, render) {
    if (!element || typeof element.setCustomValidity != "function") {
      return;
    }

    const key = render ? (render.i18n || {}).alertinfoinvalid : null;
    const translator = this._libwebphone.i18nTranslator();

    element.setCustomValidity(
      key && typeof translator == "function" ? translator(key) : ""
    );
  }

  // The distinct ringtones the mappings point at - what prewarming decodes and
  // what buffer pruning has to spare.
  _alertInfoRingtoneIds() {
    const mappings = this._config.channels.ringer.alertInfo.mappings;

    return Object.keys(mappings)
      .map((key) => {
        return mappings[key];
      })
      .filter((id, index, ids) => {
        return id && ids.indexOf(id) === index;
      });
  }

  // Auditions what a call matching this key would actually ring with, which
  // for an unset mapping is the selected ringtone. The key doubles as the
  // row's ownership token, so each row's button tracks its own preview.
  _previewAlertInfoRingtone(key) {
    const normalized = this._normalizeAlertInfoKey(key);

    if (!normalized) {
      return;
    }

    this.toggleRingtonePreview(
      this.getAlertInfoRingtone(normalized) ||
        this._config.channels.ringer.selected,
      normalized
    );
  }

  _prewarmAlertInfoRingtones() {
    const alertInfo = this._config.channels.ringer.alertInfo;

    if (!alertInfo.enabled || !alertInfo.prewarm) {
      return;
    }

    this._alertInfoRingtoneIds().forEach((id) => {
      this._ensureRingtoneBuffer(id);
    });
  }

  // The mapped key an inbound call's Alert-Info header value(s) match, or null.
  _matchAlertInfoKey(alertInfo) {
    const config = this._config.channels.ringer.alertInfo;
    const values = (Array.isArray(alertInfo) ? alertInfo : [alertInfo])
      .filter((value) => {
        return typeof value == "string" && value.trim();
      })
      .map((value) => {
        return value.trim().toLowerCase();
      });

    if (values.length == 0) {
      return null;
    }

    if (typeof config.matcher == "function") {
      // A host's matcher is arbitrary code, and getRingtoneForAlertInfo() is
      // documented never to fail - a throw means "no key matched", which rings
      // with the selected ringtone, rather than taking the ring down with it.
      try {
        return this._normalizeAlertInfoKey(
          config.matcher(values, this.getAlertInfoMappings())
        );
      } catch (error) {
        this._emit("channel.ringer.alertinfo.error", this, error);

        return null;
      }
    }

    // Mapping order decides, not header order: a call carrying two Alert-Info
    // headers rings with the first mapping that matches either of them.
    const matched = this._alertInfoKeys().find((key) => {
      return values.some((value) => {
        return this._alertInfoValueMatches(value, key);
      });
    });

    return matched || null;
  }

  // `value` arrives trimmed and lowercased from _matchAlertInfoKey().
  _alertInfoValueMatches(value, key) {
    if (this._config.channels.ringer.alertInfo.matchMode == "exact") {
      // Stripped the same way the key was, so a bare `alert-internal` mapping
      // still matches the `<alert-internal>` an INVITE actually carries -
      // otherwise exact mode would match nothing in the real world.
      return this._normalizeAlertInfoKey(value) === key;
    }

    // Token: the key as a whole word anywhere in the value, which covers both
    // `<alert-internal>` and a URI form like `<sip:x@pbx>;info=door-phone`.
    // Hyphens and underscores count as part of a word rather than as
    // boundaries, so `alert-internal` doesn't match `alert-internal-2`.
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    return new RegExp("(^|[^a-z0-9_-])" + escaped + "([^a-z0-9_-]|$)").test(
      value
    );
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
