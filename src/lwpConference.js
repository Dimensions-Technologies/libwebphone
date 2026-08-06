"use strict";

import lwpUtils from "./lwpUtils";

/**
 * Local (browser-mixed) ad-hoc conferencing - merges the current primary
 * call with one or more held calls, up to maxParticipants (counting the
 * local user), mixing audio in WebAudio the way a desk phone mixes
 * multiple legs in its own DSP. There is no server-side bridge and no SDP
 * renegotiation: each leg's outbound sender track is swapped in-place for
 * a mixed track built from the local mic plus every other leg's remote
 * audio.
 */
export default class {
  constructor(libwebphone, config = {}) {
    this._libwebphone = libwebphone;
    this._emit = this._libwebphone._conferenceEvent;
    this._initProperties(config);
    this._initEventBindings();
    this._emit("created", this);
    return this;
  }

  isActive() {
    return this._active;
  }

  isOnHold() {
    if (!this.isActive()) {
      return false;
    }

    return this._legs.every((call) => call.isOnHold());
  }

  isMuted() {
    return this.isActive() && this._muted;
  }

  /**
   * A fresh GUID generated when a conference starts, shared by every leg
   * for that conference's lifetime (including legs added later via
   * addToConference()) - null when no conference is active. Also surfaced
   * on each member [lwpCall](lwpCall.md) via getConferenceId()/summary(),
   * so a consumer can group calls belonging to the same conference without
   * needing to ask this class which calls are its legs.
   */
  getConferenceId() {
    return this._conferenceId;
  }

  /**
   * Every call currently in the conference, including the focused
   * ("primary") one. Returned as a copy - safe for a consumer's own UI
   * (e.g. a participant count) but not for mutating conference state.
   */
  getLegs() {
    return this._legs.slice();
  }

  isLeg(call) {
    return this.isActive() && !!call && this._legs.includes(call);
  }

  /**
   * Whether `call` is currently eligible to be merged/added via
   * addToConference() - established, not already a member, and either on
   * hold (the original "sitting in the background" case) or, while
   * growing an already-active conference, the current primary/active call
   * itself (e.g. freshly connected and being talked to directly, never
   * parked on hold) - never both at once, since only one call can ever be
   * "the current active primary" at a time, so this doesn't introduce
   * ambiguity into _findAddCandidates()/canMerge(). Also requires being
   * under maxParticipants when growing. When no conference is active yet,
   * the candidate must be a *different*, held call than the primary (the
   * primary can't be merged with itself), and the primary must be valid,
   * established, and non-conference.
   */
  canAdd(call) {
    if (
      !call ||
      !call.hasSession() ||
      !call.isEstablished() ||
      call.isInConference()
    ) {
      return false;
    }

    if (this.isActive()) {
      if (this._legs.includes(call)) {
        return false;
      }

      const callList = this._libwebphone.getCallList();
      const isCurrentPrimary = !!callList && callList.getCall() === call;

      if (!call.isOnHold() && !isCurrentPrimary) {
        return false;
      }

      return this._legs.length < this._config.maxParticipants - 1;
    }

    if (!call.isOnHold()) {
      return false;
    }

    // Starting a conference always begins with exactly 2 legs (this call
    // plus the primary) - if maxParticipants is configured too low to even
    // fit that (counting the local user, so < 3), there's no valid way to
    // start one at all. Mirrors the grow-path's own cap check above.
    if (this._config.maxParticipants < 3) {
      return false;
    }

    const callList = this._libwebphone.getCallList();
    const primaryCall = callList ? callList.getCall() : null;

    if (!primaryCall || call === primaryCall) {
      return false;
    }

    return (
      primaryCall.hasSession() &&
      primaryCall.isEstablished() &&
      !primaryCall.isInConference()
    );
  }

  hold() {
    if (!this.isActive() || this.isOnHold()) {
      return;
    }

    // Real SIP hold on every leg, same as any other call. It never touches
    // sender tracks, _conferenceActive, or the mix graph - those stay wired
    // exactly as they are, now just mixing silence since no far end is
    // transmitting while held. unhold() resumes with no rebuild.
    this._legs.forEach((call) => call.hold());

    this._emit("hold", this);
  }

  unhold() {
    if (!this.isActive() || !this.isOnHold()) {
      return;
    }

    this._legs.forEach((call) => call.unhold());

    this._emit("unhold", this);
  }

  /**
   * Changes which leg is flagged as the primary call. If focus is
   * returning from outside the conference (see lwpCallList.switchCall() -
   * switching away holds the whole conference, matching how switching
   * away from any ordinary active call has always held it), this also
   * resumes the whole conference as part of switching back to it, the same
   * way promoting any other held call has always auto-resumed it. Returns
   * true if a switch actually happened.
   */
  switchLeg(callId) {
    if (!this.isActive()) {
      return false;
    }

    const newPrimary = this._legs.find((call) => call.getId() === callId);

    if (!newPrimary || newPrimary.isPrimary()) {
      return false;
    }

    // Finds whoever is *actually* currently primary right now, rather than
    // trusting this._primaryCall - focus can have left the conference
    // entirely (e.g. the user switched to the "New Call" placeholder to
    // dial a new number; see lwpCallList.switchCall()), in which case
    // this._primaryCall is stale by design until focus returns to a leg.
    const callList = this._libwebphone.getCallList();
    const previousPrimary = callList
      ? callList.getCalls().find((call) => call.isPrimary())
      : null;

    // Re-uses _clearPrimary()/_setPrimary() purely for their flag-flip and
    // promoted/demoted events (which everything else already listens to -
    // lwpCallList, lwpCallControl, etc. - so they refresh for free).
    // previousPrimary only skips its normal hold side effect if it is
    // ALSO currently a conference leg (switching focus between two legs
    // that are both already live) - if focus had moved to a non-conference
    // call (the placeholder, or any ordinary call), that call gets its
    // normal demotion instead, exactly as if this had been a plain,
    // non-conference switchCall().
    if (previousPrimary) {
      if (previousPrimary.isInConference()) {
        previousPrimary._clearPrimary(false, false);
      } else {
        previousPrimary._clearPrimary();
      }
    }

    if (this.isOnHold()) {
      // Focus is returning to a held conference (e.g. after "New Call"
      // held it to switch focus away) - resume every leg as part of
      // switching back, rather than leaving it silently held.
      this.unhold();
    }

    newPrimary._setPrimary(false, false);

    this._primaryCall = newPrimary;

    this._emit("leg.switched", this, newPrimary, previousPrimary);

    return true;
  }

  /**
   * Mutes the currently-focused leg entirely: every other party stops
   * hearing them, and so do you. A real desk phone has a single incoming
   * decode path per leg, so muting a participant silences it everywhere at
   * once - there's no way to keep listening privately while cutting them
   * off from everyone else, and this mirrors that. They can still hear
   * everyone else; only their own contribution is silenced.
   */
  muteCaller() {
    if (!this.isActive()) {
      return;
    }

    const call = this._primaryCall;
    const leg = this._findGraphLeg(call);

    if (!leg || leg.muted) {
      return;
    }

    this._otherGraphLegs(call).forEach((other) => {
      leg.srcRemote.disconnect(other.dest);
    });

    const remoteAudio = call.getRemoteAudio();
    if (remoteAudio) {
      remoteAudio.muted = true;
    }

    leg.muted = true;

    this._emit("caller.muted", this, call);
  }

  unmuteCaller() {
    if (!this.isActive()) {
      return;
    }

    const call = this._primaryCall;
    const leg = this._findGraphLeg(call);

    if (!leg || !leg.muted) {
      return;
    }

    this._otherGraphLegs(call).forEach((other) => {
      leg.srcRemote.connect(other.dest);
    });

    const remoteAudio = call.getRemoteAudio();
    if (remoteAudio) {
      remoteAudio.muted = false;
    }

    leg.muted = false;

    this._emit("caller.unmuted", this, call);
  }

  /**
   * @param {lwpCall} [call] - Defaults to whichever leg is currently
   * primary/focused, matching muteCaller()/unmuteCaller(). Pass an explicit
   * call to check any leg regardless of focus (e.g. for a call-list display
   * showing every leg at once).
   */
  isCallerMuted(call = null) {
    if (!this.isActive()) {
      return false;
    }

    const leg = this._findGraphLeg(call || this._primaryCall);

    return leg ? leg.muted : false;
  }

  /**
   * True when there is exactly one call eligible to merge/add right now -
   * the zero-ambiguity convenience case merge() acts on. With more than
   * one eligible call, this is false; use addToConference(callId) via the
   * call list to pick which one explicitly instead of guessing.
   */
  canMerge() {
    return this._findAddCandidates().length === 1;
  }

  /**
   * Convenience wrapper for the single-candidate case - merges the primary
   * call with the one eligible held call (starting a conference), or adds
   * the one eligible held call to an already-active conference. No-ops if
   * canMerge() is false.
   */
  merge() {
    const candidates = this._findAddCandidates();

    if (candidates.length !== 1) {
      return;
    }

    this.addToConference(candidates[0].getId());
  }

  /**
   * Unified start-or-grow entry point: merges `callId` with the current
   * primary if no conference is active yet, or adds it to the
   * already-active conference otherwise. No-ops if canAdd(callId) is
   * false (not eligible, already a member, or at maxParticipants).
   */
  addToConference(callId) {
    const callList = this._libwebphone.getCallList();
    if (!callList) {
      return;
    }

    const call = callList.getCall(callId);

    if (!this.canAdd(call)) {
      return;
    }

    if (this.isActive()) {
      this._growConference(call);
    } else {
      this._startConference(callList.getCall(), call);
    }
  }

  /**
   * Terminates every leg of the active conference (a real SIP hangup on
   * each), rather than split()'s "return everyone to an ordinary held
   * call." Conference bookkeeping is torn down first, exactly like
   * split() does and for the same reason: each leg's own call.ended
   * event finds isInConference() already false, so _handleLegEnded()
   * no-ops for it instead of trying to reassign focus and "continue the
   * conference" once per leg as they hang up one after another.
   */
  endConference(reason = "user") {
    if (!this.isActive()) {
      return;
    }

    const legs = this._legs;

    // Flip state first - see split()/_startConference() for why.
    legs.forEach((call) => {
      call._conferenceActive = false;
      call._conferenceId = null;
      this._restoreCallerAudio(call);
    });
    this._active = false;

    this._teardownGraph();

    const mediaDevices = this._libwebphone.getMediaDevices();
    if (mediaDevices) {
      mediaDevices.stopStreams(this._micRequestId);
    }

    this._legs = [];
    this._primaryCall = null;
    this._originalTracks = new Map();
    this._muted = false;
    this._conferenceId = null;

    // No original-track restoration here (unlike split()) - these calls
    // are ending, not surviving as ordinary calls, so there's nothing to
    // hand a restored track back to.
    legs.forEach((call) => {
      if (call.hasSession()) {
        call.hangup();
      }
    });

    this._emit("ended", this, reason);
  }

  split(reason = "user") {
    if (!this.isActive()) {
      return;
    }

    const legs = this._legs;
    const primaryCall = this._primaryCall;

    // Flip state first - see _startConference() for why.
    legs.forEach((call) => {
      call._conferenceActive = false;
      call._conferenceId = null;
    });
    this._active = false;

    // Mirrors a desk phone's Split: you don't stay actively connected to
    // any party, every leg goes back to an ordinary held state. There is
    // deliberately no shortcut back into this same conference from here -
    // canAdd()/canMerge() require an unheld primary, so re-merging means
    // manually unholding one call first, the same as building a conference
    // fresh.
    legs.forEach((call) => {
      if (!call.hasSession()) {
        return;
      }

      const originalTrack = this._originalTracks.get(call);
      if (originalTrack) {
        call.replaceSenderTrack(originalTrack, false);
      }

      // Only the currently-focused leg skips _disconnectStreams() here. It
      // stays isPrimary()===true, and its Hold/Unhold button calls
      // hold()/unhold() directly rather than going through _setPrimary() -
      // the only place that resumes paused media elements via
      // _connectStreams()'s element.play(). Pausing this call's elements
      // here would leave them paused with no code path to resume them on a
      // bare unhold(), producing one-way audio. Every other leg is only
      // ever reachable again via switchLeg() (which calls _setPrimary(),
      // and so does resume them), so they're safe to pause normally here.
      if (call !== primaryCall) {
        call._disconnectStreams();
      }

      call.hold();

      this._restoreCallerAudio(call);
    });

    this._teardownGraph();

    const mediaDevices = this._libwebphone.getMediaDevices();
    if (mediaDevices) {
      mediaDevices.stopStreams(this._micRequestId);
    }

    this._legs = [];
    this._primaryCall = null;
    this._originalTracks = new Map();
    this._muted = false;
    this._conferenceId = null;

    this._emit("split", this, reason);
  }

  /** Init functions */

  _initProperties(config) {
    const defaults = {
      micRequestId: "conference",
      maxParticipants: 5,
    };
    this._config = lwpUtils.merge(defaults, config);

    this._micRequestId = this._config.micRequestId;
    this._active = false;
    this._legs = [];
    this._primaryCall = null;
    this._originalTracks = new Map();
    this._graph = null;
    this._muted = false;
    this._conferenceId = null;
  }

  _initEventBindings() {
    this._libwebphone.on(
      "mediaDevices.audio.input.changed",
      (lwp, mediaDevices, newTrack) => {
        if (this.isActive() && newTrack) {
          this._reconnectMic(newTrack.track);
        }
      }
    );

    this._libwebphone.on("call.conference.mute.changed", (lwp, call, muted) => {
      if (!this.isActive() || !this._graph) {
        return;
      }
      // Mute is a conference-wide concept (one shared mic gain node), so
      // its state lives here rather than on whichever lwpCall happened to
      // have mute()/unmute() called on it - which leg is "focused" can
      // change mid-conference via switchLeg().
      this._muted = muted;
      this._graph.micGain.gain.value = muted ? 0 : 1;
    });

    this._libwebphone.on("call.ended", (lwp, call) => {
      this._handleLegEnded(call);
    });
    this._libwebphone.on("call.failed", (lwp, call) => {
      this._handleLegEnded(call);
    });
  }

  /** Helper functions */

  _findAddCandidates() {
    const callList = this._libwebphone.getCallList();
    if (!callList) {
      return [];
    }

    return callList.getCalls().filter((call) => this.canAdd(call));
  }

  _currentAudioTrack(call) {
    const peerConnection = call.getPeerConnection();
    if (!peerConnection) {
      return null;
    }

    const sender = peerConnection.getSenders().find((sender) => {
      return sender.track && sender.track.kind === "audio";
    });

    return sender ? sender.track : null;
  }

  _startConference(primaryCall, heldCall) {
    const audioContext = this._libwebphone.getAudioContext();
    const mediaDevices = this._libwebphone.getMediaDevices();
    const callList = this._libwebphone.getCallList();

    audioContext.startAudioContext();

    const primaryTrack = this._currentAudioTrack(primaryCall);
    const heldTrack = this._currentAudioTrack(heldCall);
    const primaryRemoteStream = primaryCall.getRemoteAudio().srcObject;
    const heldRemoteStream = heldCall.getRemoteAudio().srcObject;

    if (!primaryTrack || !heldTrack || !primaryRemoteStream || !heldRemoteStream) {
      console.warn(
        "[lwpConference] addToConference(): missing audio track/stream",
        {
          hasPrimaryTrack: !!primaryTrack,
          hasHeldTrack: !!heldTrack,
          hasPrimaryRemoteStream: !!primaryRemoteStream,
          hasHeldRemoteStream: !!heldRemoteStream,
        }
      );
      this._emit("failed", this, "missing-audio-track");
      return;
    }

    mediaDevices.startStreams(this._micRequestId).then((micStream) => {
      const micTrack = micStream.getAudioTracks()[0];

      if (!micTrack) {
        console.warn("[lwpConference] addToConference(): no microphone track available");
        this._emit("failed", this, "no-microphone");
        return;
      }

      // canAdd() was already checked before the async startStreams() call
      // above; re-check that nothing changed while we were waiting on it
      // (call ended, user already merged another way, etc).
      if (!this.canAdd(heldCall) || callList.getCall() !== primaryCall) {
        console.warn("[lwpConference] addToConference(): state changed while acquiring microphone; aborting");
        mediaDevices.stopStreams(this._micRequestId);
        this._emit("failed", this, "state-changed");
        return;
      }

      const context = audioContext.getContext();

      this._graph = this._createGraphBase(context, micTrack);
      this._legs = [];
      this._primaryCall = primaryCall;

      // Flip state before touching hold/streams so every isInConference()
      // guard downstream (in lwpCall) sees the correct value for the whole
      // transition, not a half-updated one.
      this._conferenceId = lwpUtils.uuid();
      primaryCall._conferenceActive = true;
      primaryCall._conferenceId = this._conferenceId;
      heldCall._conferenceActive = true;
      heldCall._conferenceId = this._conferenceId;
      this._active = true;

      this._originalTracks.set(primaryCall, primaryTrack);
      this._originalTracks.set(heldCall, heldTrack);

      const primaryDest = this._addLegToGraph(primaryCall, primaryRemoteStream);
      const heldDest = this._addLegToGraph(heldCall, heldRemoteStream);

      this._legs.push(primaryCall, heldCall);

      primaryCall.replaceSenderTrack(
        primaryDest.stream.getAudioTracks()[0],
        false
      );
      heldCall.replaceSenderTrack(heldDest.stream.getAudioTracks()[0], false);

      if (primaryCall.isOnHold()) {
        // Re-merging after a split leaves the primary itself held too -
        // bring it back exactly the way its own Unhold button already
        // does. Its elements were never paused by split() (see the note
        // there), so a bare unhold() is enough; no _connectStreams() call
        // needed here the way heldCall needs one below.
        primaryCall.unhold();
      }

      heldCall._connectStreams();
      heldCall.unhold();

      this._emit("started", this, primaryCall, heldCall);
    }).catch((error) => {
      console.warn("[lwpConference] addToConference(): unexpected error, aborting", error);
      this._emit("failed", this, "error");
    });
  }

  // Growing an already-live conference needs no microphone re-acquisition
  // (the shared mic tap is already running) and no renegotiation on any
  // existing leg - see _addLegToGraph()'s comment - so unlike
  // _startConference() this is fully synchronous.
  _growConference(call) {
    const track = this._currentAudioTrack(call);
    const remoteStream = call.getRemoteAudio().srcObject;

    if (!track || !remoteStream) {
      console.warn(
        "[lwpConference] addToConference(): missing audio track/stream for new leg",
        { hasTrack: !!track, hasRemoteStream: !!remoteStream }
      );
      this._emit("failed", this, "missing-audio-track");
      return;
    }

    this._originalTracks.set(call, track);

    const dest = this._addLegToGraph(call, remoteStream);

    call._conferenceActive = true;
    call._conferenceId = this._conferenceId;

    call.replaceSenderTrack(dest.stream.getAudioTracks()[0], false);

    if (this.isOnHold()) {
      // Adding a leg to a held conference wouldn't accomplish anything by
      // itself - the new leg would be wired in but every existing leg
      // would still be silent. Resume them as part of growing, the same
      // way switchLeg() auto-resumes the whole conference on refocus.
      this.unhold();
    }

    call._connectStreams();
    call.unhold();

    this._legs.push(call);

    if (call.isPrimary()) {
      // The added call may already be the real current focus (the
      // "current active call" eligibility path in canAdd()) - keep our
      // own tracked focus in sync rather than leaving it pointing at
      // whichever leg was focused before, which hold()/muteCaller()/etc.
      // would otherwise wrongly keep targeting.
      this._primaryCall = call;
    }

    this._emit("leg.added", this, call);
  }

  _findGraphLeg(call) {
    if (!this._graph || !call) {
      return null;
    }

    return this._graph.legs.get(call) || null;
  }

  _otherGraphLegs(call) {
    if (!this._graph) {
      return [];
    }

    const others = [];

    this._graph.legs.forEach((legInfo, legCall) => {
      if (legCall !== call) {
        others.push(legInfo);
      }
    });

    return others;
  }

  _restoreCallerAudio(call) {
    if (!call) {
      return;
    }

    const remoteAudio = call.getRemoteAudio();
    if (remoteAudio) {
      remoteAudio.muted = false;
    }
  }

  _createGraphBase(context, micTrack) {
    const micGain = context.createGain();
    const micSource = context.createMediaStreamSource(
      new MediaStream([micTrack])
    );
    micSource.connect(micGain);

    return {
      context,
      micGain,
      micSource,
      legs: new Map(),
    };
  }

  // Wires a new leg into the graph: its own destination (what becomes its
  // sender track) hears the mic plus every other leg already in the
  // conference, and every leg already in the conference starts hearing the
  // new leg too. No replaceSenderTrack() call is needed for any EXISTING
  // leg here - MediaStreamAudioDestinationNode.stream's track identity
  // never changes after creation, so connecting a new source into an
  // already-live destination just makes it start summing into whatever
  // that leg's sender is already carrying. Only the new leg's own
  // destination is returned, for the caller to set as its first sender
  // track.
  _addLegToGraph(call, remoteStream) {
    const context = this._graph.context;
    const srcRemote = context.createMediaStreamSource(remoteStream);
    const dest = context.createMediaStreamDestination();

    this._graph.micGain.connect(dest);

    this._graph.legs.forEach((existingLeg) => {
      existingLeg.srcRemote.connect(dest);
      srcRemote.connect(existingLeg.dest);
    });

    this._graph.legs.set(call, { srcRemote, dest, muted: false });

    return dest;
  }

  // The inverse of _addLegToGraph(): disconnecting and dropping just this
  // leg's nodes is sufficient. Every other leg's destination simply sums
  // one fewer input from now on - nothing about their own nodes changes.
  _removeLegFromGraph(call) {
    if (!this._graph) {
      return;
    }

    const leg = this._graph.legs.get(call);
    if (!leg) {
      return;
    }

    leg.srcRemote.disconnect();
    leg.dest.disconnect();

    this._graph.legs.delete(call);
  }

  _reconnectMic(track) {
    if (!this._graph) {
      return;
    }

    this._graph.micSource.disconnect();

    const micSource = this._graph.context.createMediaStreamSource(
      new MediaStream([track])
    );
    micSource.connect(this._graph.micGain);

    this._graph.micSource = micSource;
  }

  _teardownGraph() {
    if (!this._graph) {
      return;
    }

    this._graph.micSource.disconnect();
    this._graph.micGain.disconnect();

    this._graph.legs.forEach((leg) => {
      leg.srcRemote.disconnect();
      leg.dest.disconnect();
    });

    this._graph = null;
  }

  _handleLegEnded(call) {
    if (!this.isActive() || !this._legs.includes(call)) {
      return;
    }

    // Real focus (call.isPrimary()) can differ from our own tracked
    // this._primaryCall if the user had switched away from the conference
    // entirely (e.g. to the "New Call" placeholder to dial a new number)
    // without disturbing it - see switchLeg()'s equivalent lookup.
    const wasReallyPrimary = call.isPrimary();

    this._removeLegFromGraph(call);
    this._legs = this._legs.filter((leg) => leg !== call);
    this._originalTracks.delete(call);
    call._conferenceActive = false;
    call._conferenceId = null;

    if (this._legs.length <= 1) {
      // Down to (at most) one remaining leg - fully collapse back to a
      // normal, non-conference call, same as when the other party hangs up
      // in a plain 2-leg conference.
      const survivor = this._legs[0];

      if (survivor) {
        survivor._conferenceActive = false;
        survivor._conferenceId = null;

        const survivorOriginalTrack = this._originalTracks.get(survivor);
        if (survivorOriginalTrack && survivor.hasSession()) {
          survivor.replaceSenderTrack(survivorOriginalTrack, false);
        }

        this._restoreCallerAudio(survivor);
      }

      this._active = false;
      this._teardownGraph();

      const mediaDevices = this._libwebphone.getMediaDevices();
      if (mediaDevices) {
        mediaDevices.stopStreams(this._micRequestId);
      }

      this._legs = [];
      this._primaryCall = null;
      this._originalTracks = new Map();
      this._muted = false;
      this._conferenceId = null;

      this._emit("split", this, "leg-ended");
      return;
    }

    // The conference continues with the remaining legs. Internal
    // bookkeeping always ends up pointing at a real remaining leg...
    if (call === this._primaryCall) {
      this._primaryCall = this._legs[0];
    }

    if (wasReallyPrimary) {
      // ...but UI focus is only actually pulled back to the conference if
      // the ended leg really was the one focused. If focus had already
      // moved elsewhere (mid-dial via the placeholder, or an unrelated
      // call), leave it there rather than yanking the user back into the
      // conference because a leg they weren't even looking at hung up.
      const newPrimary = this._primaryCall;

      newPrimary._setPrimary(false, false);

      this._emit("leg.switched", this, newPrimary, call);
    }

    this._emit("leg.removed", this, call);
  }
}
