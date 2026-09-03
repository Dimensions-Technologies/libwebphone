"use strict";

import lwpUtils from "./lwpUtils";
import prettyMilliseconds from "pretty-ms";

export default class {
  constructor(libwebphone, session = null) {
    this._libwebphone = libwebphone;
    this._id = session
      ? session.data.lwpStreamId || lwpUtils.uuid()
      : lwpUtils.uuid();
    this._emit = this._libwebphone._callEvent;
    this._session = session;
    this._initProperties();
    this._initEventBindings();

    // Accept codecPreferences from config or session data
    this._codecPreferences = (session && session.data && session.data.codecPreferences)
      || (this._libwebphone._config && this._libwebphone._config.codecPreferences)
      || { audio: [], video: [] };

    // Attach SDP munging handler if session is present
    if (session && typeof session.on === 'function') {
      session.on('sdp', (e) => {
        if (e.originator !== 'local') return;
        const prefs = this._codecPreferences || {};
        ['audio', 'video'].forEach(kind => {
          if (Array.isArray(prefs[kind]) && prefs[kind].length) {
            e.sdp = filterCodecsInSDP(e.sdp, kind, prefs[kind]);
          }
        });
      });
    }

    const callList = this._libwebphone.getCallList();
    if (!callList) {
      this._setPrimary();
    }

    this._emit("created", this);

    if (session) {
      this._timeUpdate();
    }

    if (this._autoAnswer) {
      // Emitted before answering so a host app can tell an auto-answered
      // call apart from a user-answered one - "answered" alone looks
      // identical to a button click - and log or render it accordingly.
      this._emit("autoanswer", this);
      this._takeFocusForAutoAnswer();
      this._warnThenAutoAnswer();
    }

    function filterCodecsInSDP(sdp, kind, allowed) {
      // allowed: array of codec names or full keys, e.g. ['opus/48000/2']
      // kind: 'audio' or 'video'
      // Returns munged SDP string
      const wantFull = allowed.map(s => String(s).toLowerCase());
      const wantName = allowed.map(s => String(s).split('/')[0].toLowerCase());
      // Find m-line
      const mLineRegex = new RegExp('(m=' + kind + ' \\d+ [A-Z/]+ )([0-9 ]+)\\r?\\n([\\s\\S]*?)(?=\\r?\\nm=|$)', 'gi');
        return sdp.replace(mLineRegex, (whole, pre, pts, body) => {
      // Map PT -> codec name/full
      const ptToName = {}, ptToFull = {};
      body.replace(/a=rtpmap:(\d+)\s+([A-Za-z0-9-]+)\/(\d+)(?:\/(\d+))?/g,
            (_, pt, name, rate, ch) => {
        const full = (name + '/' + rate + (ch ? ('/' + ch) : '')).toLowerCase();
        ptToName[pt] = name.toLowerCase();
        ptToFull[pt] = full;
            });
      // Map PT -> fmtp parameters, needed to resolve the association a wrapper
      // payload type (rtx, red) declares on the codec it carries.
      const ptToFmtp = {};
      body.replace(/a=fmtp:(\d+)[ \t]+(.*)/g, (_, pt, params) => {
        ptToFmtp[pt] = params;
            });
      const list = pts.trim().split(/\s+/);
      // Ancillaries always kept at end
      function isAnc(pt) {
            const n = ptToName[pt] || '';
            return /^(telephone-event|cn|rtx|red|ulpfec)$/i.test(n);
      }
      // Keep ONLY preferred payloads (by full key or by name), plus ancillaries
      const keptPreferred = [], keptAnc = [];
      for (let i = 0; i < list.length; i++) {
            const pt = list[i];
            const full = ptToFull[pt];
            const name = ptToName[pt];
            if (isAnc(pt)) { keptAnc.push(pt); continue; }
            if (!full && !name) continue;
            const fullRank = wantFull.indexOf(full);
            const nameRank = wantName.indexOf(name);
            if (fullRank !== -1 || nameRank !== -1) {
        // Rank by position in the configured list, preferring an exact
        // "name/rate/channels" match over a bare name match, so the offer
        // follows the documented preference order rather than the order the
        // browser happened to generate.
        keptPreferred.push({ pt: pt, rank: fullRank !== -1 ? fullRank : nameRank });
            }
      }
      if (!keptPreferred.length) return whole; // fallback: keep original
      // Stable sort (guaranteed by the language), so payload types matching the
      // same preference entry keep the browser's relative order.
      keptPreferred.sort((a, b) => a.rank - b.rank);
      const orderedPreferred = keptPreferred.map(entry => entry.pt);

      // An ancillary is not a codec choice, but rtx and red are wrappers: rtx
      // retransmits another payload type ("apt=<pt>") and red encapsulates the
      // payload types listed in its fmtp ("<pt>/<pt>"). Keeping one after its
      // target has been filtered out leaves the reference dangling, which makes
      // the offer self-inconsistent and can be rejected by strict far ends.
      // telephone-event, cn and ulpfec declare no association, so they always stay.
      const survives = {};
      orderedPreferred.forEach(pt => { survives[pt] = true; });
      const isRtx = pt => /^rtx$/i.test(ptToName[pt] || '');
      const referencedPts = pt => {
        const params = ptToFmtp[pt] || '';
        const apt = params.match(/(?:^|;)\s*apt\s*=\s*(\d+)/i);
        if (apt) {
          return [apt[1]];
        }
        // Only parse the "<pt>/<pt>" form for red itself - other ancillaries use
        // fmtp for unrelated values (telephone-event carries an event range).
        if (/^red$/i.test(ptToName[pt] || '')) {
          const carried = params.trim().match(/^\d+(?:\/\d+)*$/);
          if (carried) {
            return carried[0].split('/');
          }
        }
        return [];
      };
      const ancKeep = {};
      const resolveAnc = pt => {
        if (referencedPts(pt).every(ref => survives[ref])) {
          ancKeep[pt] = true;
          survives[pt] = true;
        }
      };
      // red before rtx, since an rtx payload type may be associated with red.
      keptAnc.filter(pt => !isRtx(pt)).forEach(resolveAnc);
      keptAnc.filter(isRtx).forEach(resolveAnc);
      const newPts = orderedPreferred.concat(keptAnc.filter(pt => ancKeep[pt]));
      // Filter attribute lines to only the kept PTs
      const keep = {};
      for (let k = 0; k < newPts.length; k++) keep[newPts[k]] = true;
            const filteredBody = body.split(/\r?\n/).filter(line => {
            // NB: only rtpmap/fmtp/rtcp-fb are keyed by payload type. The
            // number after "a=extmap:" is an RTP header-extension ID from a
            // different namespace, so extmap lines must never be filtered
            // against the kept payload types.
            const m = line.match(/^a=(rtpmap|fmtp|rtcp-fb):(\d+)/);
            if (!m) return true;
            return !!keep[m[2]];
      }).join("\r\n");
      return pre + newPts.join(' ') + "\r\n" + filteredBody;
        });
    }
  }

  _shouldAutoAnswer() {
    const autoAnswer = this._config.autoAnswer || {};

    if (!autoAnswer.enabled) {
      return false;
    }

    if (this.getDirection() != "terminating") {
      return false;
    }

    if (autoAnswer.onlyWhenIdle && this._hasOtherEstablishedCall()) {
      return false;
    }

    const answerAfterZero = /(^|[;,<\s])answer-after\s*=\s*"?0"?\s*($|[;,>])/i;
    const alertAutoAnswer = /(^|[;,<\s])info\s*=\s*"?alert-autoanswer"?\s*($|[;,>])/i;

    const matches = (values, patterns) =>
      values.some((value) => patterns.some((pattern) => pattern.test(value)));

    return (
      matches(this.getCallInfo(), [answerAfterZero]) ||
      matches(this.getAlertInfo(), [answerAfterZero, alertAutoAnswer])
    );
  }

  _hasOtherEstablishedCall() {
    const callList = this._libwebphone.getCallList();

    if (!callList) {
      return false;
    }

    return callList
      .getCalls()
      .some((call) => call !== this && call.isEstablished());
  }

  _warnThenAutoAnswer() {
    const answerIfStillAnswerable = () => {
      if (!this.isInProgress() || this.isEnded()) {
        this._emit("autoanswer.abandoned", this);

        return;
      }

      this.answer();
    };

    const audioContext = this._libwebphone.getAudioContext();
    let warning = null;

    if (audioContext) {
      try {
        warning = audioContext.playAutoAnswerWarning();
      } catch (error) {
        this._emit("error", this, error);
      }
    }

    if (!warning) {
      answerIfStillAnswerable();

      return;
    }

    Promise.resolve(warning)
      .catch((error) => {
        this._emit("error", this, error);
      })
      .then(answerIfStillAnswerable);
  }

  /**
   * Mirrors what a desk phone does when an intercom/paging call answers
   * itself: whatever you were talking to goes on hold first, and the
   * auto-answered call takes over as the active call.
   *
   * Both halves are needed. Without the hold, the previous call is left
   * live - the user's mic feeds both far ends and the page plays mixed
   * over the conversation. Without the promotion the auto-answered call
   * would answer with its own media elements still disconnected (only
   * _setPrimary() connects them), i.e. audible to the caller but not to
   * the user - lwpCallList.addCall() deliberately does not promote a new
   * call over an active one, since an ordinary call merely ringing in the
   * background must not steal focus.
   */
  _takeFocusForAutoAnswer() {
    const callList = this._libwebphone.getCallList();

    if (!callList) {
      return;
    }

    const conference = this._libwebphone.getConference();

    if (conference && conference.isActive()) {
      // Held as a unit rather than leg by leg, the same way switching
      // focus away from a conference does - the other parties would
      // otherwise be left live and audible to each other. No-ops if focus
      // had already moved away from it, which holds it too.
      conference.hold();
    }

    callList.getCalls().forEach((call) => {
      // Conference legs are covered by conference.hold() above; holding
      // them individually here would only fight it.
      if (call === this || call.isInConference()) {
        return;
      }

      if (call.isEstablished() && !call.isOnHold()) {
        call.hold();
      }
    });

    // Everything answerable is already held by now, so the demotion this
    // triggers re-holds nothing; it runs for the stream disconnect and the
    // promoted/demoted events every other module renders from.
    callList.switchCall(this.getId());
  }

  getId() {
    return this._id;
  }

  hasSession() {
    return this._session != null;
  }

  hasPeerConnection() {
    const session = this._getSession();

    return session && session.connection;
  }

  getPeerConnection() {
    if (this.hasPeerConnection()) {
      return this._getSession().connection;
    }
  }

  isPrimary() {
    return this._primary;
  }

  isInConference() {
    return this._conferenceActive;
  }

  /**
   * The active conference's GUID (shared by every call currently in the
   * same conference, including ones added later), or null when this call
   * isn't in one. See lwpConference.getConferenceId().
   */
  getConferenceId() {
    return this._conferenceId;
  }

  getRemoteAudio() {
    return this._streams.remote.elements.audio;
  }

  getRemoteVideo() {
    return this._streams.remote.elements.video;
  }

  getLocalAudio() {
    return this._streams.local.elements.audio;
  }

  getLocalVideo() {
    return this._streams.local.elements.video;
  }

  isInProgress() {
    if (this.hasSession()) {
      return this._getSession().isInProgress();
    }

    return false;
  }

  isEstablished() {
    if (this.hasSession()) {
      return this._getSession().isEstablished();
    }

    return false;
  }

  isEnded() {
    if (this.hasSession()) {
      return this._getSession().isEnded();
    }

    return false;
  }

  /**
   * Whether this call is alerting the user - not merely "inbound and not
   * yet established". An auto-answered call is about to answer itself, so
   * it never alerts: no ringtone (this gates the "ringing.started" emit in
   * _initProperties(), and lwpAudioContext's own ringer-queue
   * reconciliation), and no ringing overlay on the video canvas, which
   * gates on this too. Suppressing the event alone would have left the
   * bell flashing until the call connected.
   */
  isRinging() {
    return (
      this.getDirection() == "terminating" &&
      !this.isEstablished() &&
      !this._autoAnswer
    );
  }

  isInTransfer() {
    return this._inTransfer;
  }

  /**
   * True from the moment attendedTransferStart() marks this call as the
   * origin of an in-progress attended transfer until either
   * attendedTransfer() completes it or attendedTransferCancel() aborts it -
   * deliberately NOT cleared by losing primary (see attendedTransferStart()),
   * since the expected next step (the consultation call being placed and
   * taking over primary) does exactly that.
   */
  isAttendedTransferPending() {
    return this._attendedTransferPending;
  }

  getDirection() {
    if (this.hasSession()) {
      if (this._getSession().direction == "incoming") {
        return "terminating";
      } else {
        return "originating";
      }
    }

    return "originating";
  }

  /**
   * The raw Alert-Info header value(s) from the INVITE, in the order they
   * appeared - `["<alert-internal>"]` for a call the platform marked as
   * internal. Empty for an outbound call, or an inbound one without the
   * header.
   *
   * JsSIP has no grammar rule for Alert-Info, so it is stored unparsed
   * (Parser.js falls through to addHeader()) and comes back exactly as it was
   * on the wire, brackets and all. lwpAudioContext matches these against its
   * configured ringtone mappings - see getRingtoneForAlertInfo().
   */
  getAlertInfo() {
    const session = this._getSession();
    const request = session ? session._request : null;

    if (!request) {
      return [];
    }

    // Both JsSIP request shapes implement this - OutgoingRequest for a call we
    // placed, IncomingMessage for one we received - so the check is only
    // against _request being something else entirely.
    if (typeof request.getHeaders != "function") {
      return [];
    }

    return request.getHeaders("Alert-Info");
  }

  /**
   * The raw Call-Info header value(s) from the INVITE, in the order they
   * appeared. Same shape and same caveats as getAlertInfo() - empty for an
   * outbound call, or an inbound one without the header.
   */
  getCallInfo() {
    const session = this._getSession();
    const request = session ? session._request : null;

    if (!request || typeof request.getHeaders != "function") {
      return [];
    }

    return request.getHeaders("Call-Info");
  }

  localIdentity(details = false) {
    const session = this._getSession();
    if (session) {
      if (details) {
        return session.local_identity;
      }
      const display_name = session.local_identity.display_name;
      const uri_user = session.local_identity.uri.user;

      if (display_name && display_name != uri_user) {
        return display_name + " (" + uri_user + ")";
      } else {
        return uri_user;
      }
    }
  }

  remoteIdentity(details = false) {
    const session = this._getSession();
    if (session) {
      if (details) {
        return session.remote_identity;
      }
      const display_name = session.remote_identity.display_name;
      const uri_user = session.remote_identity.uri.user;

      if (display_name && display_name != uri_user) {
        return display_name + " (" + uri_user + ")";
      } else {
        return uri_user;
      }
    }
  }

  remoteIdentityOverride(details = false) {
    if (!this._remoteIdentityOverride) {
      return null;
    }
    if (details) {
      return this._remoteIdentityOverride;
    }

    return this._remoteIdentityOverride.uri_user;
  }

  remoteURIUser() {
    const session = this._getSession();
    if (session) {
      return session._dialog._remote_uri.user;
    }
  }

  terminate() {
    if (this.hasSession()) {
      if (this.isEstablished()) {
        this.hangup();
      } else {
        this.cancel();
      }
    }
  }

  cancel() {
    if (this.hasSession()) {
      this._getSession().terminate();
    }
  }

  hangup() {
    if (this.hasSession()) {
      this._getSession().terminate();
    }
  }

  hold() {
    if (this.hasSession()) {
      this._getSession().hold();
    }
  }

  isOnHold(details = false) {
    let status = { local: false, remote: false };

    if (this.hasSession()) {
      status = this._getSession().isOnHold();
    }

    if (details) {
      return status;
    } else {
      return status.local || status.remote;
    }
  }

  unhold() {
    if (this.hasSession()) {
      this._getSession().unhold();
    }
  }

  _setAudioSenderActive(active) {
    // Stops/resumes outbound RTP encoding without renegotiating SDP.
    // Without this, JsSIP's hold only changes SDP direction; the encoder keeps
    // running and the platform's jitter buffer accumulates audio for the
    // duration of the hold, producing a persistent delay on unhold.
    const peerConnection = this.getPeerConnection();
    if (!peerConnection) return;

    peerConnection.getSenders().forEach((sender) => {
      if (!sender.track || sender.track.kind !== "audio") return;
      try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) {
          params.encodings = [{}];
        }
        params.encodings.forEach((enc) => {
          enc.active = active;
        });
        sender.setParameters(params).catch((e) => {
          this._emit("error", this, e);
        });
      } catch (e) {
        this._emit("error", this, e);
      }
    });
  }

  /**
   * @param {{audio: boolean, video: boolean}} options - The channels you want to mute
   */
  mute(options = { audio: true, video: true }) {
    if (this.hasSession()) {
      if (this.isInConference() && options.audio) {
        // The sender's audio track is a shared conference mix, not our mic -
        // toggling it (or JsSIP's own track.enabled mute) would silence us
        // for every other party at once. lwpConference owns the actual gain
        // node AND the mute state itself (not this call) - mute is a
        // conference-wide concept (one shared mic), and which lwpCall is
        // "primary"/focused can change mid-conference via switchLeg(), so
        // the state can't live on a single call instance without going
        // stale for the other leg. We just mirror the normal muted event so
        // existing UI keeps working unchanged.
        this._emit("conference.mute.changed", this, true);
        this._emit("muted", this, { audio: true, video: false });
        if (options.video) {
          this._getSession().mute({ video: true });
        }
      } else {
        this._getSession().mute(options);
      }
    }
  }

  /**
   * @param {{audio: boolean, video: boolean}} options - The channels you want to unmute
   */
  unmute(options = { audio: true, video: true }) {
    if (this.hasSession()) {
      if (this.isInConference() && options.audio) {
        this._emit("conference.mute.changed", this, false);
        this._emit("unmuted", this, { audio: true, video: false });
        if (options.video) {
          this._getSession().unmute({ video: true });
        }
      } else {
        this._getSession().unmute(options);
      }
    }
  }

  isMuted(details = false) {
    let status = { audio: false, video: false };

    if (this.hasSession()) {
      status = this._getSession().isMuted();

      if (this.isInConference()) {
        const conference = this._libwebphone.getConference();
        status.audio = conference ? conference.isMuted() : false;
      }
    }

    if (details) {
      return status;
    } else {
      return status.audio || status.video;
    }
  }

  transfer(target = null, autoHold = true) {
    if (this.hasSession()) {
      if (this.isInTransfer() || target) {
        const dialpad = this._libwebphone.getDialpad();

        this._inTransfer = false;

        if (!target && dialpad) {
          target = dialpad.getTarget(true);
        }

        if (target) {
          // A 2xx response to the REFER itself only means the request was
          // accepted for processing - it says nothing about whether the
          // transfer target actually answered. That's only known once the
          // far end sends a NOTIFY as the referred-to call progresses,
          // which is what the returned subscriber surfaces. Previously
          // this return value was discarded entirely, so nothing ever
          // found out whether a blind transfer actually succeeded - the
          // original call just sat there regardless of the outcome.
          const referSubscriber = this._getSession().refer(target);

          referSubscriber.on("accepted", () => {
            // The referred-to call was answered - this leg's job is done,
            // the same way a desk phone releases itself once a blind
            // transfer connects.
            this._emit("transfer.confirmed", this, target);
            this.hangup();
          });

          referSubscriber.on("failed", () => {
            if (autoHold) {
              this.unhold();
            }
            this._emit("transfer.failed", this, target);
          });

          referSubscriber.on("requestFailed", () => {
            if (autoHold) {
              this.unhold();
            }
            this._emit("transfer.failed", this, target);
          });

          this._emit("transfer.started", this, target);
        } else {
          if (autoHold) {
            this.unhold();
          }

          this._emit("transfer.failed", this, target);
        }
        this._emit("transfer.complete", this, target);
      } else {
        this._inTransfer = true;

        if (autoHold) {
          this.hold();
        }

        this._emit("transfer.collecting", this);
      }
    }
  }

  /**
   * Marks this call as the origin of an attended transfer and holds it, so
   * the consultation call can be placed and dialed without first switching
   * the call list's focus to the session-less "New Call" placeholder -
   * lwpDialpad.dial() checks isAttendedTransferPending() the same way it
   * already does isInTransfer() for blind transfer(), and routes digits
   * typed while this call is still focused into its own target buffer
   * instead of sending them as DTMF into this (held, silent) call. No-ops
   * if there's no session, this is already in a conference, or a transfer
   * is already pending.
   */
  attendedTransferStart(autoHold = true) {
    if (
      !this.hasSession() ||
      this.isInConference() ||
      this.isAttendedTransferPending()
    ) {
      return false;
    }

    this._attendedTransferPending = true;

    if (autoHold) {
      this.hold();
    }

    this._emit("transfer.attended.collecting", this);

    return true;
  }

  /**
   * Aborts an attendedTransferStart() still waiting on a consultation call
   * (e.g. the user changed their mind before dialing one), unholding this
   * call again. No-ops once a consultation call already exists - at that
   * point completing or abandoning the transfer is the consultation call's
   * own hangup()/attendedTransfer() to decide, not this one's.
   */
  attendedTransferCancel(autoUnhold = true) {
    if (!this.isAttendedTransferPending()) {
      return false;
    }

    this._attendedTransferPending = false;

    if (autoUnhold) {
      this.unhold();
    }

    this._emit("transfer.attended.cancelled", this);

    return true;
  }

  /**
   * Completes an attended (consultative) transfer: bridges this call
   * (typically the original, held party) directly to targetCall (typically
   * the established consultation call) via a REFER carrying a Replaces
   * header for targetCall's dialog - RFC 3891 - rather than the plain
   * REFER blind transfer() uses. Once the referred party reaches
   * targetCall's far end and that dialog is actually replaced, both legs
   * on our side are superfluous and are hung up locally, mirroring how
   * transfer() releases itself once a blind transfer connects.
   */
  attendedTransfer(targetCall) {
    if (!this.hasSession() || !targetCall || !targetCall.hasSession()) {
      return false;
    }

    const target = targetCall.remoteIdentity(true).uri.toString();
    const referSubscriber = this._getSession().refer(target, {
      replaces: targetCall._getSession(),
    });

    if (!referSubscriber) {
      this._emit("transfer.failed", this, targetCall);
      return false;
    }

    referSubscriber.on("accepted", () => {
      // Both legs are about to be hung up below, but clear this explicitly
      // rather than relying on that - lwpCallControl's own cleanup (see its
      // "call.terminated" binding) checks isAttendedTransferPending() to
      // tell a completed transfer apart from a consultation call that died
      // before completing, and both hangups here race that same check.
      this._attendedTransferPending = false;

      this._emit("transfer.confirmed", this, targetCall);
      this.hangup();
      targetCall.hangup();
    });

    referSubscriber.on("failed", () => {
      this._emit("transfer.failed", this, targetCall);
    });

    referSubscriber.on("requestFailed", () => {
      this._emit("transfer.failed", this, targetCall);
    });

    this._emit("transfer.started", this, targetCall);

    return true;
  }

  /**
   * Downgrades a still-in-progress attended transfer to a blind one:
   * REFERs this call (the origin) directly to consultCall's target, the
   * same plain REFER transfer(target) always sends - no Replaces, and no
   * need for consultCall to have been answered first. Useful when whoever
   * was being consulted doesn't actually need to be spoken to. consultCall
   * is no longer needed either way (whether still ringing or already
   * answered) and is terminated as part of this.
   */
  transferToBlind(consultCall) {
    if (!this.hasSession() || !consultCall || !consultCall.hasSession()) {
      return false;
    }

    const target = consultCall.remoteIdentity(true).uri.toString();

    this.transfer(target);

    this._attendedTransferPending = false;
    consultCall._attendedTransferOrigin = null;
    consultCall.terminate();

    return true;
  }

  answer() {
    if (this.hasSession()) {
      const mediaDevices = this._libwebphone.getMediaDevices();

      if (mediaDevices) {
        mediaDevices.startStreams(this.getId()).then((streams) => {
          // Re-checked rather than trusted from when answer() was called.
          // startStreams() bottoms out in getUserMedia(), which on the first
          // call of a page is a permission prompt of unbounded duration, and
          // the caller can give up while it sits open - JsSIP's answer()
          // throws InvalidStateError on a session that is no longer waiting
          // for one, and that throw lands inside this .then where only the
          // catch below would ever see it.
          if (!this.isInProgress() || this.isEnded()) {
            this._emit("answer.abandoned", this);

            return;
          }

          const hasTracks = streams && streams.getTracks().length > 0;

          if (!hasTracks) {
            // Our own media pipeline, including its own recovery attempt in
            // _ensureMediaStream(), could not produce any usable media. Do
            // not answer with an empty stream - JsSIP would treat it as real
            // and silently connect with no audio in either direction. Do not
            // omit it and let JsSIP's own independent getUserMedia() take
            // over either - if that succeeded, the resulting stream would
            // live outside our own tracking (_startedStreams /
            // _mediaStreamPromise), silently breaking mute and device
            // switching for the rest of the call. Reject the call cleanly
            // instead - this sends a proper SIP rejection to the caller and
            // fires our normal "failed" event chain.
            // The SIP-level termination cause below will report as
            // "Rejected" (JsSIP hardcodes that for terminating a
            // not-yet-answered session), not the more specific
            // "User Denied Media Access" - _noUsableMedia flags this for the
            // "failed" binding below, which rewrites the cause on the event
            // we emit so listeners can tell this apart from a real decline.
            console.warn("[lwpCall] answer(): no usable media available (cause: User Denied Media Access) for call " + this.getId() + "; rejecting the call (SIP termination cause will report as: Rejected)");
            this._noUsableMedia = true;
            this._getSession().terminate({ status_code: 480, reason_phrase: "No Media Available" });
            return;
          }

          this._getSession().answer({ mediaStream: streams });
          this._emit("answered", this);
        }).catch((error) => {
          // Nothing was watching this promise before. A user clicking
          // "answer" at least sees their click do nothing; an auto-answered
          // call fails completely silently - no ringtone (it is suppressed
          // deliberately), no answer, no error - and the caller just hears
          // ringback until the INVITE times out. The window is widest
          // exactly where auto-answer lives: startStreams() bottoms out in
          // getUserMedia(), so on the first call of a page this is a
          // permission prompt of unbounded duration, and session.answer()
          // itself throws InvalidStateError if the caller gave up while it
          // was open.
          console.warn("[lwpCall] answer() failed for call " + this.getId(), error);
          this._emit("error", this, error);

          // Rejected rather than left hanging. Without this the session sits
          // un-answered until the INVITE times out, and the caller hears
          // ringback the whole time with no idea anything went wrong - the
          // mic prompt was denied, dismissed, or never seen. A clean
          // rejection at least tells them, immediately.
          //
          // Guarded because the commonest way to get here is the caller
          // having already given up: terminating a session that has ended
          // is not what "reject" means, and would emit a "rejected" for a
          // call nobody rejected.
          if (this.isInProgress() && !this.isEnded()) {
            this._noUsableMedia = true;
            this.reject();
          }
        });
      } else {
        this._getSession().answer({});
        this._emit("answered", this);
      }
    }
  }

  reject() {
    if (this.hasSession()) {
      this._getSession().terminate();
      this._emit("rejected", this);
    }
  }

  renegotiate() {
    if (this.hasSession() && !this.isOnHold()) {
      this._getSession().renegotiate();
      this._updateStreams();
      this._emit("renegotiated", this);
    }
  }

  sendDTMF(signal, options) {
    if (this.hasSession()) {
      this._getSession().sendDTMF(signal, options);
      this._emit("send.dtmf", this, signal, options);
    }
  }

  changeVolume(volume = null, kind = null) {
    if (volume === null && this._libwebphone.getAudioContext()) {
      volume = this._libwebphone
        .getAudioContext()
        .getVolume("remote", { scale: false, relativeToMaster: true });
    }

    if (!volume && volume !== 0) {
      return;
    }

    if (volume < 0) {
      volume = 0;
    }

    if (volume > 1) {
      volume = 1;
    }

    if (kind) {
      const element = this._streams.remote.elements[kind];
      if (element) {
        element.volume = volume;
      }
    } else {
      Object.keys(this._streams.remote.elements).forEach((kind) => {
        const element = this._streams.remote.elements[kind];
        if (element) {
          element.volume = volume;
        }
      });
    }
  }

  replaceSenderTrack(newTrack, renegotiate = true) {
    const peerConnection = this.getPeerConnection();
    if (!peerConnection) {
      return;
    }

    if (
      peerConnection.signalingState == "closed" ||
      peerConnection.connectionState == "closed"
    ) {
      return;
    }

    const senders = peerConnection.getSenders();
    const sender = senders.find((sender) => {
      const track = sender.track;
      if (track) {
        return track.kind == newTrack.kind;
      }
    });

    if (sender) {
      sender.replaceTrack(newTrack).then(() => {
        if (renegotiate) {
          this.renegotiate();
        }
      });
    } else {
      peerConnection.addTrack(newTrack);
      if (renegotiate) {
        this.renegotiate();
      }
    }
  }

  removeSenderTrack(kind) {
    const peerConnection = this.getPeerConnection();
    if (!peerConnection) {
      return;
    }

    if (
      peerConnection.signalingState == "closed" ||
      peerConnection.connectionState == "closed"
    ) {
      return;
    }

    const senders = peerConnection.getSenders();
    const sender = senders.find((sender) => {
      const track = sender.track;
      if (track) {
        return track.kind == kind;
      }
    });

    if (sender) {
      peerConnection.removeTrack(sender);
      this.renegotiate();
    }
  }

  summary() {
    const direction = this.getDirection();
    const { audio: isAudioMuted, video: isVideoMuted } = this.isMuted(true);

    return {
      callId: this.getId(),
      hasSession: this.hasSession(),
      progress: this.isInProgress(),
      established: this.isEstablished(),
      ended: this.isEnded(),
      held: this.isOnHold(),
      isAudioMuted,
      isVideoMuted,
      primary: this.isPrimary(),
      inConference: this.isInConference(),
      conferenceId: this.getConferenceId(),
      inTransfer: this.isInTransfer(),
      direction: direction,
      terminating: direction == "terminating",
      originating: direction == "originating",
      alertInfo: this.getAlertInfo(),
      localIdentity: this.localIdentity(),
      remoteIdentity: this.remoteIdentity(),
      remoteIdentityOverride: this.remoteIdentityOverride(),
    };
  }

  /** Init functions */

  _initMediaElement(elementKind, deviceKind) {
    const element = document.createElement(elementKind);

    if (elementKind === "video") {
      try {
        element.setAttribute('webkit-playsinline', 'webkit-playsinline');
        element.setAttribute('playsinline', 'playsinline');
      } catch (error) {
        this._emit("error", this, error);
      }
    }

    if (this.hasSession() && element.setSinkId !== undefined) {
      const preferedDevice = this._libwebphone
        .getMediaDevices()
        .getPreferedDevice(deviceKind);

      if (preferedDevice) {
        // Both branches are needed: setSinkId throws synchronously where it
        // isn't implemented, and rejects asynchronously for a device it can't
        // use - a try/catch alone leaves the latter unhandled.
        try {
          element.setSinkId(preferedDevice.id).catch((error) => {
            this._emit("error", this, error);
          });
        } catch (error) {
          this._emit("error", this, error);
        }
      }
    }

    return element;
  }

  _initProperties() {
    this._primary = false;

    this._inTransfer = false;

    this._attendedTransferPending = false;

    this._conferenceActive = false;

    this._conferenceId = null;

    this._remoteIdentityOverride = null;

    this._muteHint = false;

    // Set right before we self-terminate a not-yet-answered session because
    // our own media pipeline couldn't produce a usable stream (see answer()).
    // JsSIP hardcodes the SIP-level failure cause to "Rejected" for that
    // termination - identical to a real user decline - so this flag is the
    // only way the "failed" binding below can tell them apart and report the
    // real cause instead.
    this._noUsableMedia = false;

    this._config = this._libwebphone._config.call;

    // Decided once, here, and read everywhere else - never re-derived.
    // Auto-answer needs two coordinated behaviours (answer the call, and
    // don't alert for it) at sites far apart in this file, and when each
    // evaluated _shouldAutoAnswer() independently they drifted: #31022
    // removed both, and its follow-up restored only the answering half,
    // leaving auto-answered calls ringing right up until they connected.
    // Must stay above the isRinging() check at the end of this method.
    this._autoAnswer = this._shouldAutoAnswer();

    this._streams = {
      remote: {
        mediaStream: new MediaStream(),
        kinds: {
          audio: false,
          video: false,
        },
        elements: {
          audio: this._initMediaElement("audio", "audiooutput"),
          // "audiooutput", not "videoinput": the only thing _initMediaElement
          // does with the device kind is setSinkId(), which wants an audio
          // output. Passing a camera id rejects with NotFoundError.
          video: this._initMediaElement("video", "audiooutput"),
        },
      },
      local: {
        mediaStream: new MediaStream(),
        kinds: {
          audio: false,
          video: false,
        },
        elements: {
          audio: this._initMediaElement("audio", "audiooutput"),
          // "audiooutput", not "videoinput": the only thing _initMediaElement
          // does with the device kind is setSinkId(), which wants an audio
          // output. Passing a camera id rejects with NotFoundError.
          video: this._initMediaElement("video", "audiooutput"),
        },
      },
    };

    Object.keys(this._streams).forEach((type) => {
      Object.keys(this._streams[type].elements).forEach((kind) => {
        const element = this._streams[type].elements[kind];

        lwpUtils.mediaElementEvents().forEach((eventName) => {
          element.addEventListener(eventName, (event) => {
            this._emit(
              type + "." + kind + "." + eventName,
              this,
              element,
              event
            );
          });
        });

        if (this._config.useAudioContext) {
          element.muted = true;
        } else {
          // NOTE: don't mute the remote audio by default
          element.muted = !(type == "remote" && kind == "audio");
        }
        element.preload = "none";

        this._emit(type + "." + kind + ".element", this, element);
      });
    });

    if (this.isRinging()) {
      this._emit("ringing.started", this);
    }
  }

  _initEventBindings() {
    this._libwebphoneEventBindings = [];
    this._documentEventBindings = [];

    const bind = (event, handler) => {
      this._libwebphoneEventBindings.push({ event, handler });
      this._libwebphone.on(event, handler);
    };

    const bindDocument = (event, handler) => {
      this._documentEventBindings.push({ event, handler });
      document.addEventListener(event, handler);
    };

    bind(
      "mediaDevices.audio.input.changed",
      (lwp, mediaDevices, newTrack) => {
        // While in a conference the sender carries the mixed output, not a
        // direct mic track - lwpConference owns reconnecting the mic tap on
        // this same event, so replacing the sender here would fight it.
        if (this.hasSession() && !this.isInConference()) {
          if (newTrack) {
            this.replaceSenderTrack(newTrack.track);
          } else {
            this.removeSenderTrack("audio");
          }
        }
      }
    );
    bind(
      "mediaDevices.video.input.changed",
      (lwp, mediaDevices, newTrack) => {
        if (this.hasSession() && newTrack) {
          this.replaceSenderTrack(newTrack.track);
        }
      }
    );
    bind(
      "mediaDevices.audio.output.changed",
      (lwp, mediaDevices, preferedDevice) => {
        Object.keys(this._streams.remote.elements).forEach((kind) => {
          const element = this._streams.remote.elements[kind];
          if (element && element.setSinkId !== undefined) {
            // As in _initMediaElement(): catch both the synchronous throw and
            // the rejection.
            try {
              element.setSinkId(preferedDevice.id).catch((error) => {
                this._emit("error", this, error);
              });
            } catch (error) {
              this._emit("error", this, error);
            }
          }
        });
      }
    );

    bind("audioContext.channel.master.volume", () => {
      this.changeVolume();
    });
    bind("audioContext.channel.remote.volume", () => {
      this.changeVolume();
    });

    if (this.hasPeerConnection()) {
      const peerConnection = this.getPeerConnection();
      this._emit("peerconnection", this, peerConnection);
      peerConnection.addEventListener("track", (...event) => {
        this._emit("peerconnection.add.track", this, ...event);
        this._updateStreams();
      });
      peerConnection.addEventListener("removestream", (...event) => {
        this._emit("peerconnection.remove.track", this, ...event);
        this._updateStreams();
      });
    }
    if (this.hasSession()) {
      this._getSession().on("progress", (...event) => {
        this._emit("progress", this, ...event);
      });
      this._getSession().on("connecting", () => {
        // Mute video and audio after the local media stream is added into RTCSession
        //
        // Muted here rather than after answering, for the same reason
        // startWithAudioMuted is: this runs as the local stream is attached
        // to the session, so the microphone is closed before any RTP has
        // left. Muting once the call was established would leak however
        // long that took.
        const autoAnswerMuted =
          this._autoAnswer && (this._config.autoAnswer || {}).muteMicrophone;

        this._getSession().mute({
          audio: this._config.startWithAudioMuted || !!autoAnswerMuted,
          video: this._config.startWithVideoMuted,
        });
      });
      this._getSession().on("confirmed", (...event) => {
        this._answerTime = new Date();
        this._emit("ringing.stopped", this);
        this._emit("established", this, ...event);
      });
      this._getSession().on("newDTMF", (...event) => {
        this._emit("receive.dtmf", this, ...event);
      });
      this._getSession().on("newInfo", (...event) => {
        this._emit("receive.info", this, ...event);
      });
      this._getSession().on("hold", (event) => {
        this._emit("hold", this, event);
        if (event.originator === "local") {
          this._setAudioSenderActive(false);
        }
      });
      this._getSession().on("unhold", (event) => {
        this._emit("unhold", this, event);
        if (event.originator === "local") {
          this._updateStreams();
          this._setAudioSenderActive(true);
        }
      });
      this._getSession().on("update", (event) => {
        console.log("[lwpCall:update] SIP UPDATE received", event.request);
        const paiHeaders = event.request && event.request.headers["P-Asserted-Identity"];
        const rawPai = paiHeaders && paiHeaders[0] && paiHeaders[0].raw;
        console.log("[lwpCall:update] P-Asserted-Identity raw value:", rawPai);
        if (rawPai) {
          const match = rawPai.match(/^"?([^"<]*?)"?\s*<sip:([^@>]+)@/i);
          if (match) {
            const display_name = match[1].trim() || null;
            const uri_user = match[2];
            console.log("[lwpCall:update] P-Asserted-Identity parsed", { display_name, uri_user });
            this._remoteIdentityOverride = { display_name, uri_user };
            this._emit("remoteIdentity.updated", this);
          } else {
            console.log("[lwpCall:update] P-Asserted-Identity could not be parsed:", rawPai);
          }
        } else {
          console.log("[lwpCall:update] SIP UPDATE has no P-Asserted-Identity header");
        }
      });
      this._getSession().on("muted", (...event) => {
        this._emit("muted", this, ...event);
      });
      this._getSession().on("unmuted", (...event) => {
        this._emit("unmuted", this, ...event);
      });
      this._getSession().on("ended", (...event) => {
        this._destroyCall();
        this._emit("ended", this, ...event);
      });
      this._getSession().on("failed", (...event) => {
        this._destroyCall();
        if (this._noUsableMedia && event[0]) {
          // Rewrite the generic "Rejected" cause JsSIP always reports for
          // this termination into the specific reason a listener actually
          // needs, so it isn't indistinguishable from a real user decline.
          event[0] = { ...event[0], cause: "User Denied Media Access" };
        }
        this._emit("failed", this, ...event);
      });
      this._getSession().on("peerconnection", (...data) => {
        const peerConnection = data[0].peerconnection;
        this._emit("peerconnection", this, peerConnection);
        peerConnection.addEventListener("track", (...event) => {
          this._emit("peerconnection.add.track", this, ...event);
          this._updateStreams();
        });
        peerConnection.addEventListener("remotestream", (...event) => {
          this._emit("peerconnection.remove.track", this, ...event);
          this._updateStreams();
        });
      });

      if (this._config.globalKeyShortcuts) {
        bindDocument("keydown", (event) => {
          if (
            event.target != document.body ||
            event.repeat ||
            !this.isPrimary()
          ) {
            return;
          }

          switch (event.key) {
            case " ":
              if (this._config.keys["spacebar"].enabled) {
                this._config.keys["spacebar"].action(event, this);
              }
              break;
          }
        });
        bindDocument("keyup", (event) => {
          if (
            event.target != document.body ||
            event.repeat ||
            !this.isPrimary()
          ) {
            return;
          }

          switch (event.key) {
            case " ":
              if (this._config.keys["spacebar"].enabled) {
                this._config.keys["spacebar"].action(event, this);
              }
              break;
          }
        });
      }
    }
  }

  /** Helper functions */
  _timeUpdate() {
    if (this._answerTime) {
      const duration = new Date() - this._answerTime;
      const options = {
        secondsDecimalDigits: 0,
      };

      this._emit(
        "timeupdate",
        this,
        this._answerTime,
        duration,
        prettyMilliseconds(Math.ceil(duration / 1000) * 1000, options)
      );
    }

    if (this.hasSession()) {
      setTimeout(() => {
        this._timeUpdate();
      }, 100);
    }
  }

  _destroyCall() {
    this._emit("terminated", this);

    if (this.isPrimary()) {
      this._clearPrimary(false);
    }

    this._destroyStreams();

    this._destroyEventBindings();

    this._session = null;
  }

  _destroyEventBindings() {
    (this._libwebphoneEventBindings || []).forEach(({ event, handler }) => {
      this._libwebphone.off(event, handler);
    });
    this._libwebphoneEventBindings = [];

    (this._documentEventBindings || []).forEach(({ event, handler }) => {
      document.removeEventListener(event, handler);
    });
    this._documentEventBindings = [];
  }

  _getSession() {
    return this._session;
  }

  _setPrimary(resume = true, connectStreams = true) {
    if (this.isPrimary()) {
      return;
    }

    if (resume && this.isEstablished() && this.isOnHold()) {
      this.unhold();
    }

    this._emit("promoted", this);

    this._primary = true;

    if (connectStreams) {
      this._connectStreams();
    }
  }

  _clearPrimary(pause = true, disconnectStreams = true) {
    if (!this.isPrimary()) {
      return;
    }

    if (pause && this.isInConference()) {
      // Ordinary call-list traffic (a new call arriving, switching calls)
      // must not hold/disconnect a leg that's live in a conference. The
      // call's own session-ended cleanup path passes pause=false and is
      // unaffected by this guard - as does lwpConference.switchLeg(),
      // which also passes pause=false since it deliberately re-uses this
      // method purely for its flag-flip + promoted/demoted events.
      return;
    }

    if (this.isInTransfer()) {
      this._inTransfer = false;

      this._emit("transfer.failed", this);
    }

    this._primary = false;

    if (pause && this.isEstablished() && !this.isOnHold()) {
      this.hold();
    }

    if (disconnectStreams) {
      this._disconnectStreams();
    }

    this._emit("demoted", this);
  }

  _updateStreams() {
    Object.keys(this._streams).forEach((type) => {
      const peerConnection = this.getPeerConnection();
      const mediaStream = this._streams[type].mediaStream;
      if (peerConnection) {
        const peerTracks = [];
        switch (type) {
          case "remote":
            peerConnection.getReceivers().forEach((peer) => {
              if (peer.track) {
                peerTracks.push(peer.track);
              }
            });
            break;
          case "local":
            peerConnection.getSenders().forEach((peer) => {
              const track = peer.track;
              if (track) {
                // In conference mode this sender carries the shared mix
                // output; mute is enforced upstream on the mic gain node,
                // not by toggling this track (which would silence everyone).
                if (!this.isInConference()) {
                  track.enabled = !this.isMuted(true)[track.kind];
                }
                peerTracks.push(track);
              }
            });
            break;
        }
        this._syncTracks(mediaStream, peerTracks, type);
      }

      Object.keys(this._streams[type].elements).forEach((kind) => {
        const element = this._streams[type].elements[kind];
        if (element) {
          const track = mediaStream.getTracks().find((track) => {
            return track.kind == kind;
          });

          if (track) {
            this._streams[type].kinds[kind] = true;
            if (!element.srcObject || element.srcObject.id != mediaStream.id) {
              // A declickPause() still winding down from an earlier
              // disconnect must not pause the stream we're attaching.
              lwpUtils.cancelDeclickPause(element);
              element.srcObject = mediaStream;
            }
          } else {
            this._streams[type].kinds[kind] = false;
            element.srcObject = null;
          }
        }
      });
    });
  }

  _syncTracks(mediaStream, peerTracks, type) {
    const peerIds = peerTracks.map((track) => {
      return track.id;
    });
    const currentIds = mediaStream.getTracks().map((track) => {
      return track.id;
    });
    const addIds = peerIds.filter((peerId) => {
      return !currentIds.includes(peerId);
    });
    const removeIds = currentIds.filter((currentId) => {
      return !peerIds.includes(currentId);
    });
    mediaStream.getTracks().forEach((track) => {
      if (removeIds.includes(track.id)) {
        mediaStream.removeTrack(track);
        this._emit(
          type + "." + track.kind + ".removed",
          this,
          lwpUtils.trackParameters(mediaStream, track)
        );
      }
    });
    peerTracks.forEach((track) => {
      if (addIds.includes(track.id)) {
        mediaStream.addTrack(track);
        this._emit(
          type + "." + track.kind + ".added",
          this,
          lwpUtils.trackParameters(mediaStream, track)
        );
      }
    });
  }

  _connectStreams() {
    Object.keys(this._streams).forEach((type) => {
      const mediaStream = this._streams[type].mediaStream;
      this._emit(type + ".mediaStream.connect", this, mediaStream);
    });

    if (!this.hasSession()) {
      return;
    }

    const peerConnection = this.getPeerConnection();
    if (peerConnection && !this.isInConference()) {
      peerConnection.getSenders().forEach((peer) => {
        if (peer.track) {
          peer.track.enabled = true;
        }
      });
    }

    Object.keys(this._streams).forEach((type) => {
      Object.keys(this._streams[type].elements).forEach((kind) => {
        const element = this._streams[type].elements[kind];
        if (element) {
          // Outside the paused check, not inside it: mid-declick the element
          // is still *playing* (muted, pause pending), so a demote->promote
          // landing in that window would take neither branch and the pending
          // pause would then silence audio that should be running.
          lwpUtils.cancelDeclickPause(element);
        }

        if (element && element.paused) {
          element.play().catch(() => {
            /*
             * We are catching any play interuptions
             * because we get a "placeholder" remote video
             * track in the mediaStream for ALL calls but
             * it never gets data so the play never starts
             * and if we then pause there is a nasty looking
             * but ignorable error...
             *
             * https://developers.google.com/web/updates/2017/06/play-request-was-interrupted
             *
             */
          });
        }
        this._emit(type + "." + kind + ".connect", this, element);
      });
    });
  }

  _disconnectStreams() {
    Object.keys(this._streams).forEach((type) => {
      const mediaStream = this._streams[type].mediaStream;
      this._emit(type + ".mediaStream.disconnect", this, mediaStream);
    });

    if (!this.hasSession()) {
      return;
    }

    const peerConnection = this.getPeerConnection();
    if (peerConnection && !this.isInConference()) {
      peerConnection.getSenders().forEach((peer) => {
        if (peer.track) {
          peer.track.enabled = false;
        }
      });
    }

    Object.keys(this._streams).forEach((type) => {
      Object.keys(this._streams[type].elements).forEach((kind) => {
        const element = this._streams[type].elements[kind];
        if (element && !element.paused) {
          if (kind == "audio" && !element.muted) {
            // Only unmuted audio is actually producing sound, so only it can
            // click when cut mid-waveform. Video and muted elements pause
            // immediately, as before.
            lwpUtils.declickPause(element);
          } else {
            element.pause();
          }
        }
        this._emit(type + "." + kind + ".disconnect", this, element);
      });
    });
  }

  _destroyStreams() {
    this._emit("ringing.stopped", this);

    const peerConnection = this.getPeerConnection();
    if (peerConnection) {
      peerConnection.getSenders().forEach((peer) => {
        if (peer.track) {
          peer.track.stop();
        }
      });
    }
  }
}
