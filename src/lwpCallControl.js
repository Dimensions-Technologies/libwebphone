"use strict";

import lwpUtils from "./lwpUtils";
import lwpRenderer from "./lwpRenderer";

export default class extends lwpRenderer {
  constructor(libwebphone, config = {}) {
    super(libwebphone);
    this._libwebphone = libwebphone;
    this._emit = this._libwebphone._callControlEvent;
    this._initProperties(config);
    this._initInternationalization(config.i18n || {});
    this._initEventBindings();
    this._initRenderTargets();
    this._emit("created", this);
    return this;
  }

  redial() {
    const userAgent = this._libwebphone.getUserAgent();
    if (userAgent) {
      userAgent.redial();
    }
  }

  cancel() {
    const currentCall = this._getCall();
    if (currentCall) {
      currentCall.cancel();
    }
  }

  hangup() {
    const currentCall = this._getCall();
    if (currentCall) {
      currentCall.hangup();
    }
  }

  hold() {
    const currentCall = this._getCall();
    if (currentCall) {
      currentCall.hold();
    }
  }

  unhold() {
    const currentCall = this._getCall();
    if (currentCall) {
      currentCall.unhold();
    }
  }

  holdConference() {
    const conference = this._libwebphone.getConference();
    if (conference) {
      conference.hold();
    }
  }

  unholdConference() {
    const conference = this._libwebphone.getConference();
    if (conference) {
      conference.unhold();
    }
  }

  mute() {
    const currentCall = this._getCall();
    if (currentCall) {
      currentCall.mute({ audio: true });
    }
  }

  unmute() {
    const currentCall = this._getCall();
    if (currentCall) {
      currentCall.unmute({ audio: true });
    }
  }

  muteCaller() {
    const currentCall = this._getCall();
    if (currentCall && currentCall.isInConference()) {
      const conference = this._libwebphone.getConference();
      if (conference) {
        conference.muteCaller();
      }
    }
  }

  unmuteCaller() {
    const currentCall = this._getCall();
    if (currentCall && currentCall.isInConference()) {
      const conference = this._libwebphone.getConference();
      if (conference) {
        conference.unmuteCaller();
      }
    }
  }

  muteVideo() {
    const currentCall = this._getCall();
    if (currentCall) {
      currentCall.mute({ video: true });
    }
  }

  unmuteVideo() {
    const currentCall = this._getCall();
    if (currentCall) {
      currentCall.unmute({ video: true });
    }
  }

  transfer() {
    const currentCall = this._getCall();
    if (currentCall) {
      currentCall.transfer();
    }
  }

  /**
   * Three-state action driving the primary call through an attended
   * transfer, one click at a time - no manual switch to lwpCallList's
   * "New Call" placeholder required in between:
   *   1. Established call, nothing pending yet -> hold it and mark it as
   *      the transfer origin (lwpCall.attendedTransferStart()). From this
   *      point lwpDialpad routes typed digits into its target buffer
   *      instead of DTMF-ing the (held) call, exactly as it already does
   *      mid-blind-transfer.
   *   2. Pending, no consultation call yet -> place one to whatever's been
   *      typed into the dialpad; lwpCallList.addCall() auto-promotes it to
   *      primary since the origin call is held, so it becomes the new
   *      "current call" for this same button without the user switching
   *      focus themselves. Clicked with nothing typed, this instead cancels
   *      back to state 1 (unholds, clears pending) - the same
   *      empty-target-means-abort convention transfer() uses.
   *   3. Consultation call established, exactly one held/pending call
   *      besides it -> complete the transfer via lwpCall.attendedTransfer().
   */
  transferAttended() {
    const currentCall = this._getCall();
    if (!currentCall) {
      return;
    }

    const target = this._findAttendedTransferTarget(currentCall);

    if (target) {
      target.attendedTransfer(currentCall);
    } else if (currentCall.isAttendedTransferPending()) {
      this._placeAttendedTransferCall(currentCall);
    } else {
      currentCall.attendedTransferStart();
    }
  }

  /**
   * Downgrades an in-progress attended transfer to a blind one - the
   * primary call is expected to be the consultation call placed by
   * transferAttended() (ringing or already established, doesn't matter),
   * and its origin call REFERs directly to whoever's being consulted
   * without waiting on/needing them to actually pick up. No-ops if the
   * primary call isn't a pending attended transfer's consultation call.
   */
  transferAttendedToBlind() {
    const currentCall = this._getCall();
    if (!currentCall) {
      return;
    }

    const origin = currentCall._attendedTransferOrigin;

    if (origin && origin.isAttendedTransferPending()) {
      origin.transferToBlind(currentCall);
    }
  }

  conference() {
    const conference = this._libwebphone.getConference();
    if (conference) {
      conference.merge();
    }
  }

  split() {
    const conference = this._libwebphone.getConference();
    if (conference) {
      conference.split();
    }
  }

  endConference() {
    const conference = this._libwebphone.getConference();
    if (conference) {
      conference.endConference();
    }
  }

  answer() {
    const currentCall = this._getCall();
    if (currentCall) {
      currentCall.answer();
    }
  }

  updateRenders(call = null) {
    let callSummary = null;
    const callList = this._libwebphone.getCallList();

    if (!call && callList) {
      this._call = callList.getCall();
    } else {
      this._call = call;
    }

    if (this._call) {
      callSummary = this._call.summary();
    }

    this.render((render) => {
      render.data = this._renderData(render.data, callSummary);
      return render;
    });
  }

  /** Init functions */

  _initInternationalization(config) {
    const defaults = {
      en: {
        answer: "Anwser",
        redial: "Redial",
        cancel: "Cancel",
        hangup: "Hang Up",
        hold: "Hold",
        unhold: "Resume",
        mute: "Mute Audio",
        unmute: "Unmute Audio",
        mutecaller: "Mute Caller",
        unmutecaller: "Unmute Caller",
        muteVideo: "Mute Video",
        unmuteVideo: "Unmute Video",
        transferblind: "Blind Transfer",
        transferattended: "Attended Transfer",
        transferattendedcall: "Call",
        transferattendedasblind: "Complete as Blind Transfer",
        transfercomplete: "Transfer (complete)",
        conference: "Conference",
        addtoconference: "Add to Conference",
        split: "Split",
        endconference: "End Conference",
        holdconference: "Hold Conference",
        unholdconference: "Resume Conference",
      },
    };
    const resourceBundles = lwpUtils.merge(
      defaults,
      config.resourceBundles || {}
    );
    this._libwebphone.i18nAddResourceBundles("callControl", resourceBundles);
  }

  _initProperties(config) {
    const defaults = {
      renderTargets: [],
    };
    this._config = lwpUtils.merge(defaults, config);
  }

  _initEventBindings() {
    this._libwebphone.on("call.promoted", (lwp, call) => {
      this.updateRenders(call);
    });

    this._libwebphone.on("call.primary.progress", (lwp, call) => {
      this.updateRenders(call);
    });
    this._libwebphone.on("call.primary.established", (lwp, call) => {
      this.updateRenders(call);
    });

    this._libwebphone.on("call.primary.hold", (lwp, call) => {
      this.updateRenders(call);
    });
    this._libwebphone.on("call.primary.unhold", (lwp, call) => {
      this.updateRenders(call);
    });
    this._libwebphone.on("call.primary.muted", (lwp, call) => {
      this.updateRenders(call);
    });
    this._libwebphone.on("call.primary.unmuted", (lwp, call) => {
      this.updateRenders(call);
    });

    this._libwebphone.on("call.primary.transfer.collecting", (lwp, call) => {
      this.updateRenders(call);
    });
    this._libwebphone.on("call.primary.transfer.complete", (lwp, call) => {
      this.updateRenders(call);
    });
    this._libwebphone.on(
      "call.primary.transfer.attended.collecting",
      (lwp, call) => {
        this.updateRenders(call);
      }
    );
    this._libwebphone.on(
      "call.primary.transfer.attended.cancelled",
      (lwp, call) => {
        this.updateRenders(call);
      }
    );

    this._libwebphone.on("call.primary.terminated", () => {
      this.updateRenders();
    });

    // If the consultation call placed for a pending attended transfer ends
    // (cancelled, rejected, hung up, or failed to connect) before the
    // transfer completes, abandon the transfer on its origin call too,
    // rather than leaving it stuck pending indefinitely - see
    // _placeAttendedTransferCall() for where this link is set.
    this._libwebphone.on("call.terminated", (lwp, call) => {
      const origin = call._attendedTransferOrigin;

      if (origin && origin.isAttendedTransferPending()) {
        origin.attendedTransferCancel();
      }
    });

    this._libwebphone.on("conference.started", () => {
      this.updateRenders();
    });
    this._libwebphone.on("conference.split", () => {
      this.updateRenders();
    });
    this._libwebphone.on("conference.ended", () => {
      this.updateRenders();
    });
    this._libwebphone.on("conference.failed", () => {
      this.updateRenders();
    });
    this._libwebphone.on("conference.hold", () => {
      this.updateRenders();
    });
    this._libwebphone.on("conference.unhold", () => {
      this.updateRenders();
    });
    this._libwebphone.on("conference.caller.muted", () => {
      this.updateRenders();
    });
    this._libwebphone.on("conference.caller.unmuted", () => {
      this.updateRenders();
    });
    this._libwebphone.on("conference.leg.added", () => {
      this.updateRenders();
    });
    this._libwebphone.on("conference.leg.removed", () => {
      this.updateRenders();
    });

    this._libwebphone.on("userAgent.call.failed", () => {
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
        answer: "libwebphone:callControl.answer",
        redial: "libwebphone:callControl.redial",
        cancel: "libwebphone:callControl.cancel",
        hangup: "libwebphone:callControl.hangup",
        hold: "libwebphone:callControl.hold",
        unhold: "libwebphone:callControl.unhold",
        mute: "libwebphone:callControl.mute",
        unmute: "libwebphone:callControl.unmute",
        mutecaller: "libwebphone:callControl.mutecaller",
        unmutecaller: "libwebphone:callControl.unmutecaller",
        muteVideo: "libwebphone:callControl.muteVideo",
        unmuteVideo: "libwebphone:callControl.unmuteVideo",
        transfercomplete: "libwebphone:callControl.transfercomplete",
        transferblind: "libwebphone:callControl.transferblind",
        transferattended: "libwebphone:callControl.transferattended",
        transferattendedcall: "libwebphone:callControl.transferattendedcall",
        transferattendedasblind: "libwebphone:callControl.transferattendedasblind",
        conference: "libwebphone:callControl.conference",
        addtoconference: "libwebphone:callControl.addtoconference",
        split: "libwebphone:callControl.split",
        endconference: "libwebphone:callControl.endconference",
        holdconference: "libwebphone:callControl.holdconference",
        unholdconference: "libwebphone:callControl.unholdconference",
      },
      data: lwpUtils.merge({}, this._config, this._renderData()),
      by_id: {
        redial: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.redial();
            },
          },
        },
        cancel: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.cancel();
            },
          },
        },
        hangup: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.hangup();
            },
          },
        },
        hold: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.hold();
            },
          },
        },
        unhold: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.unhold();
            },
          },
        },
        mute: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.mute();
            },
          },
        },
        unmute: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.unmute();
            },
          },
        },
        mutecaller: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.muteCaller();
            },
          },
        },
        unmutecaller: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.unmuteCaller();
            },
          },
        },
        muteVideo: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.muteVideo();
            },
          },
        },
        unmuteVideo: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.unmuteVideo();
            },
          },
        },
        transfer: {
          events: {
            onclick: () => {
              this.transfer();
            },
          },
        },
        transferattended: {
          events: {
            onclick: () => {
              this.transferAttended();
            },
          },
        },
        transferattendedasblind: {
          events: {
            onclick: () => {
              this.transferAttendedToBlind();
            },
          },
        },
        conference: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.conference();
            },
          },
        },
        split: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.split();
            },
          },
        },
        endconference: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.endConference();
            },
          },
        },
        holdconference: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.holdConference();
            },
          },
        },
        unholdconference: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.unholdConference();
            },
          },
        },
        answer: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              element.disabled = true;
              this.answer();
            },
          },
        },
      },
    };
  }

  _renderDefaultTemplate() {
    return `
    <div>
      {{^data.call.hasSession}}
      {{#data.redial}}
        <button id="{{by_id.redial.elementId}}">
          {{i18n.redial}} ({{data.redial}})
        </button>
      {{/data.redial}}
      {{/data.call.hasSession}}

      {{#data.call.hasSession}}
        {{#data.call.progress}}
          <button id="{{by_id.cancel.elementId}}">
            {{i18n.cancel}}
          </button>
        {{/data.call.progress}}

        {{#data.attendedTransferConsulting}}
          <button id="{{by_id.transferattendedasblind.elementId}}">
            {{i18n.transferattendedasblind}}
          </button>
        {{/data.attendedTransferConsulting}}

        {{#data.call.established}}
          <button id="{{by_id.hangup.elementId}}">
            {{i18n.hangup}}
          </button>

          {{^data.call.held}}
            <button id="{{by_id.hold.elementId}}">
              {{i18n.hold}}
            </button>
          {{/data.call.held}}

          {{#data.call.held}}
            <button id="{{by_id.unhold.elementId}}">
              {{i18n.unhold}}
            </button>
          {{/data.call.held}}

          {{^data.call.isAudioMuted}}
            <button id="{{by_id.mute.elementId}}">
              {{i18n.mute}}
            </button>
          {{/data.call.isAudioMuted}}

          {{#data.call.isAudioMuted}}
            <button id="{{by_id.unmute.elementId}}">
              {{i18n.unmute}}
            </button>
          {{/data.call.isAudioMuted}}

          {{#data.call.inConference}}
            {{^data.callerMuted}}
              <button id="{{by_id.mutecaller.elementId}}">
                {{i18n.mutecaller}}
              </button>
            {{/data.callerMuted}}

            {{#data.callerMuted}}
              <button id="{{by_id.unmutecaller.elementId}}">
                {{i18n.unmutecaller}}
              </button>
            {{/data.callerMuted}}
          {{/data.call.inConference}}

          {{^data.call.isVideoMuted}}
            <button id="{{by_id.muteVideo.elementId}}">
              {{i18n.muteVideo}}
            </button>
          {{/data.call.isVideoMuted}}
          
          {{#data.call.isVideoMuted}}
             <button id="{{by_id.unmuteVideo.elementId}}">
               {{i18n.unmuteVideo}}
            </button>
          {{/data.call.isVideoMuted}}

          {{^data.call.inConference}}
            <button id="{{by_id.transfer.elementId}}">
              {{^data.call.inTransfer}}
                {{i18n.transferblind}}
              {{/data.call.inTransfer}}

              {{#data.call.inTransfer}}
                {{i18n.transfercomplete}}
              {{/data.call.inTransfer}}
            </button>

            <button id="{{by_id.transferattended.elementId}}">
              {{#data.attendedTransferReady}}
                {{i18n.transfercomplete}}
              {{/data.attendedTransferReady}}

              {{^data.attendedTransferReady}}
                {{#data.attendedTransferPending}}
                  {{i18n.transferattendedcall}}
                {{/data.attendedTransferPending}}

                {{^data.attendedTransferPending}}
                  {{i18n.transferattended}}
                {{/data.attendedTransferPending}}
              {{/data.attendedTransferReady}}
            </button>
          {{/data.call.inConference}}

          {{#data.canConference}}
            <button id="{{by_id.conference.elementId}}">
              {{#data.conferenceActive}}
                {{i18n.addtoconference}}
              {{/data.conferenceActive}}

              {{^data.conferenceActive}}
                {{i18n.conference}}
              {{/data.conferenceActive}}
            </button>
          {{/data.canConference}}

          {{#data.call.inConference}}
            <button id="{{by_id.split.elementId}}">
              {{i18n.split}}
            </button>

            <button id="{{by_id.endconference.elementId}}">
              {{i18n.endconference}}
            </button>

            {{^data.conferenceOnHold}}
              <button id="{{by_id.holdconference.elementId}}">
                {{i18n.holdconference}}
              </button>
            {{/data.conferenceOnHold}}

            {{#data.conferenceOnHold}}
              <button id="{{by_id.unholdconference.elementId}}">
                {{i18n.unholdconference}}
              </button>
            {{/data.conferenceOnHold}}
          {{/data.call.inConference}}
        {{/data.call.established}}

        {{#data.call.terminating}}
        {{#data.call.progress}}
          <button id="{{by_id.answer.elementId}}">
            {{i18n.answer}}
          </button>
        {{/data.call.progress}}
        {{/data.call.terminating}}
      {{/data.call.hasSession}}
    </div>
    `;
  }

  _renderData(data = {}, callSummary = null) {
    const userAgent = this._libwebphone.getUserAgent();
    const conference = this._libwebphone.getConference();

    if (userAgent) {
      data.redial = userAgent.getRedial();
    } else {
      data.redial = null;
    }

    data.call = callSummary;

    data.attendedTransferReady = this._call
      ? !!this._findAttendedTransferTarget(this._call)
      : false;

    data.attendedTransferPending = this._call
      ? this._call.isAttendedTransferPending()
      : false;

    data.attendedTransferConsulting = !!(
      this._call &&
      this._call._attendedTransferOrigin &&
      this._call._attendedTransferOrigin.isAttendedTransferPending()
    );

    data.canConference = conference ? conference.canMerge() : false;

    data.conferenceActive = conference ? conference.isActive() : false;

    data.conferenceOnHold = conference ? conference.isOnHold() : false;

    data.callerMuted = conference ? conference.isCallerMuted() : false;

    return data;
  }

  /** Helper functions */

  _getCall() {
    return this._call;
  }

  /**
   * The single call eligible to be bridged to `currentCall` to complete an
   * attended transfer - established, held, not in a conference, and not
   * `currentCall` itself. Mirrors lwpConference._findAddCandidates()'s
   * single-candidate convenience rule: with zero or more than one eligible
   * call, returns null rather than guessing. Also requires `currentCall`
   * itself to already be an established, non-conference consultation call -
   * while it's still ringing there's no confirmed dialog yet for a REFER's
   * Replaces header to reference, so completion isn't offered until it's
   * actually been answered.
   */
  _findAttendedTransferTarget(currentCall) {
    const callList = this._libwebphone.getCallList();
    if (
      !callList ||
      !currentCall.hasSession() ||
      !currentCall.isEstablished() ||
      currentCall.isInConference()
    ) {
      return null;
    }

    const candidates = callList.getCalls().filter((call) => {
      return (
        call !== currentCall &&
        call.hasSession() &&
        call.isEstablished() &&
        call.isOnHold() &&
        !call.isInConference()
      );
    });

    return candidates.length === 1 ? candidates[0] : null;
  }

  /**
   * Places the consultation call for a pending attended transfer, using
   * whatever's currently typed into lwpDialpad (which, per
   * lwpDialpad.dial(), has been collecting rather than sending DTMF ever
   * since attendedTransferStart() marked originCall pending). Mirrors
   * lwpCall.transfer()'s own "no target means abort" convention - with
   * nothing typed, cancels back to originCall's pre-transfer state instead
   * of silently no-oping.
   */
  _placeAttendedTransferCall(originCall) {
    const dialpad = this._libwebphone.getDialpad();
    const userAgent = this._libwebphone.getUserAgent();
    const target = dialpad ? dialpad.getTarget(true) : null;

    if (!target || !userAgent) {
      originCall.attendedTransferCancel();
      return;
    }

    // Links the call userAgent.call() is about to create back to
    // originCall, purely so the "call.terminated" binding in
    // _initEventBindings() can recognise it later as this transfer's
    // consultation call (and not some unrelated call) if it ends before
    // the transfer completes, and so transferAttendedToBlind() can find
    // its way back to originCall. lwpCallList's own "call.created" binding
    // (registered well before this one) promotes the new call to primary -
    // and renders it - before this listener's turn even runs, so the very
    // first render can't yet show the "Complete as Blind Transfer" button;
    // re-render explicitly right after linking to catch it up immediately
    // rather than leaving it to whatever unrelated event happens next.
    this._libwebphone.once("call.created", (lwp, consultCall) => {
      consultCall._attendedTransferOrigin = originCall;
      this.updateRenders(consultCall);
    });

    userAgent.call(target);
  }
}
