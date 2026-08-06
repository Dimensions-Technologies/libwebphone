"use strict";

import lwpUtils from "./lwpUtils";
import lwpRenderer from "./lwpRenderer";
import lwpCall from "./lwpCall";

export default class extends lwpRenderer {
  constructor(libwebphone, config = {}) {
    super(libwebphone);
    this._libwebphone = libwebphone;
    this._emit = this._libwebphone._callListEvent;
    this._initProperties(config);
    this._initInternationalization(config.i18n || {});
    this._initEventBindings();
    this._initRenderTargets();
    this._emit("created", this);
    return this;
  }

  getCalls() {
    return this._calls;
  }

  getCall(callId = null) {
    return this._calls.find((call) => {
      if (callId) {
        return call.getId() == callId;
      } else {
        return call.isPrimary() && call.hasSession();
      }
    });
  }

  addCall(newCall) {
    const conference = this._libwebphone.getConference();
    const currentPrimary = this._calls.find((call) => call.isPrimary());

    if (
      conference &&
      conference.isActive() &&
      currentPrimary &&
      currentPrimary.isInConference()
    ) {
      // A conference leg occupies "primary" for the duration of the merge;
      // ordinary call arrival must not promote a new call out from under it
      // while focus is still actually on the conference. Once focus has
      // already moved away (e.g. to the "New Call" placeholder, which also
      // holds the conference - see switchCall()), a call arriving or being
      // placed falls through to the normal promotion rules below, exactly
      // as if no conference were active at all - this is what lets you
      // click "New Call" during an active conference, dial out, and have
      // the new call correctly become primary and connect normally.
      this._calls.push(newCall);
      this._emit("calls.added", this, newCall);
      return;
    }

    const previousCall = this.getCall();

    if (previousCall && !previousCall.isOnHold()) {
      this._calls.push(newCall);
      this._emit("calls.added", this, newCall);
    } else {
      this._calls.map((call) => {
        if (call.isPrimary) {
          call._clearPrimary();
        }
      });

      this._calls.push(newCall);
      this._emit("calls.added", this, newCall);

      newCall._setPrimary();
      this._emit("calls.changed", this, newCall, previousCall);
    }
  }

  switchCall(callId) {
    const conference = this._libwebphone.getConference();
    // Finds whoever is actually primary right now, not just whoever has a
    // session - unlike getCall(), this also finds the session-less "New
    // Call" placeholder when it's the current selection, which matters for
    // the self-click guard just below.
    const previousCall = this._calls.find((call) => call.isPrimary());
    const targetCall = this.getCall(callId);

    if (!targetCall) {
      return;
    }

    if (previousCall && previousCall.getId() === callId) {
      // Already the primary call - the default template's <label> wraps
      // its entire detail block (not just its name), so clicking anywhere
      // in an established call's own details re-triggers this. Without
      // this guard, _clearPrimary()/_setPrimary() below would still run on
      // the same call: a real hold() immediately followed by unhold(), two
      // back-to-back re-INVITEs on the same dialog for no actual change.
      return;
    }

    if (conference && conference.isActive()) {
      // Every call in the list is reachable via this same click, so clicks
      // during an active conference are dispatched on what the target
      // actually is:
      // - already a member of the conference -> switch focus to it
      // - an eligible held call not yet a member -> add it (up to
      //   maxParticipants)
      // - anything else (the "New Call" placeholder, or a call that isn't
      //   held/established, or the conference is at the cap) -> falls
      //   through to the plain switch below, which is conference-aware on
      //   both sides
      if (conference.isLeg(targetCall)) {
        if (conference.switchLeg(callId)) {
          this._emit("calls.changed", this, this.getCall(), previousCall);
        }
        return;
      }

      if (conference.canAdd(targetCall)) {
        conference.addToConference(callId);
        return;
      }
    }

    // Plain focus switch - also covers the "New Call" placeholder and any
    // ordinary call, conference active or not. Switching away from an
    // active call has always held it; a conference is just a multi-party
    // call from this perspective, so switching away from one of its legs
    // holds the whole conference (every leg, via conference.hold()) rather
    // than just the one you happened to be focused on - the other
    // party/parties would otherwise be left live and audible to each
    // other while you dial something else. Switching back to a leg
    // resumes the whole conference again automatically - see
    // switchLeg()'s own isOnHold()/unhold() handling above. A
    // non-conference call keeps its normal per-call behavior (auto-hold if
    // established, resume paused elements on return) unchanged.
    if (previousCall) {
      if (previousCall.isInConference()) {
        conference.hold();
        previousCall._clearPrimary(false, false);
      } else {
        previousCall._clearPrimary();
      }
    }

    targetCall._setPrimary();

    if (targetCall.hasSession()) {
      this._emit("calls.changed", this, targetCall, previousCall);
    } else {
      this._emit("calls.changed", this, null, previousCall);
    }
  }

  removeCall(terminatedCall) {
    const terminatedId = terminatedCall.getId();

    this._calls = this._calls.filter((call) => {
      return call.getId() != terminatedId;
    });
    this._emit("calls.removed", this, terminatedCall);

    if (terminatedCall.isPrimary()) {
      const withSession = this._calls.find((call) => {
        return call.hasSession();
      });

      if (withSession) {
        withSession._setPrimary(false);
        this._emit("calls.changed", this, withSession, terminatedCall);
      } else {
        if (this._calls.length > 0) {
          this._calls[0]._setPrimary();
          this._emit("calls.changed", this, null, terminatedCall);
        }
      }

      terminatedCall._clearPrimary(false);
    }
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
        new: "New Call",
      },
    };
    const resourceBundles = lwpUtils.merge(
      defaults,
      config.resourceBundles || {}
    );
    this._libwebphone.i18nAddResourceBundles("callList", resourceBundles);
  }

  _initProperties(config) {
    const defaults = {
      renderTargets: [],
    };
    this._config = lwpUtils.merge(defaults, config);

    const newCall = new lwpCall(this._libwebphone);
    newCall._setPrimary();
    this._calls = [newCall];
  }

  _initEventBindings() {
    this._libwebphone.on("call.created", (lwp, call) => {
      this.addCall(call);
    });
    this._libwebphone.on("call.terminated", (lwp, call) => {
      this.removeCall(call);
    });

    this._libwebphone.on("calllist.calls.added", () => {
      this.updateRenders();
    });
    this._libwebphone.on("callList.calls.changed", () => {
      this.updateRenders();
    });

    /** TODO: make all these call.pimary.* when we don't need the debugging info */
    this._libwebphone.on("call.promoted", () => {
      this.updateRenders();
    });

    this._libwebphone.on("call.progress", () => {
      this.updateRenders();
    });
    this._libwebphone.on("call.established", () => {
      this.updateRenders();
    });

    this._libwebphone.on("call.hold", () => {
      this.updateRenders();
    });
    this._libwebphone.on("call.unhold", () => {
      this.updateRenders();
    });
    this._libwebphone.on("call.muted", () => {
      this.updateRenders();
    });
    this._libwebphone.on("call.unmuted", () => {
      this.updateRenders();
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
    this._libwebphone.on("conference.leg.switched", () => {
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
    this._libwebphone.on("call.transfer.collecting", () => {
      this.updateRenders();
    });
    this._libwebphone.on("call.transfer.complete", () => {
      this.updateRenders();
    });

    this._libwebphone.on("call.ended", () => {
      this.updateRenders();
    });
    this._libwebphone.on("call.failed", () => {
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
        new: "libwebphone:callList.new",
      },
      data: lwpUtils.merge({}, this._config, this._renderData()),
      by_name: {
        calls: {
          events: {
            onclick: (event) => {
              const element = event.srcElement;
              const callid = element.value;
              this.switchCall(callid);
            },
          },
        },
      },
    };
  }

  _renderDefaultTemplate() {
    return `
      {{#data.calls}}

      {{^hasSession}}
        {{#primary}}
          <input type="radio" id="{{by_name.calls.elementName}}{{callId}}" name="{{by_name.calls.elementName}}" value="{{callId}}" checked="checked">
          <label for="{{by_name.calls.elementName}}{{callId}}">{{i18n.new}}</label>
        {{/primary}}

        {{^primary}}
          <input type="radio" id="{{by_name.calls.elementName}}{{callId}}" name="{{by_name.calls.elementName}}" value="{{callId}}">
          <label for="{{by_name.calls.elementName}}{{callId}}">{{i18n.new}}</label>
        {{/primary}}
      {{/hasSession}}

      {{#hasSession}}
        {{#primary}}
        <input type="radio" id="{{by_name.calls.elementName}}{{callId}}"  name="{{by_name.calls.elementName}}" value="{{callId}}" checked="checked">
        {{/primary}}

        {{^primary}}
        <input type="radio" id="{{by_name.calls.elementName}}{{callId}}"  name="{{by_name.calls.elementName}}" value="{{callId}}">
        {{/primary}}

        <label for="{{by_name.calls.elementName}}{{callId}}">{{remoteIdentity}}
          <ul>
            <li>call id: {{callId}}</li>
            <li>primary: {{primary}}</li>
            <li>progress: {{progress}}</li>
            <li>established: {{established}}</li>
            <li>held: {{held}}</li>
            <li>inConference: {{inConference}}</li>
            <li>conferenceId: {{conferenceId}}</li>
            <li>audio muted: {{isAudioMuted}}</li>
            <li>caller muted: {{callerMuted}}</li>
            <li>inTransfer: {{inTransfer}}</li>
            <li>ended: {{ended}}</li>
            <li>direction: {{direction}}</li>
          </ul>
        </label>
      {{/hasSession}}
      {{/data.calls}}


    `;
  }

  _renderData(data = {}) {
    const conference = this._libwebphone.getConference();

    data.calls = this.getCalls().map((call) => {
      const summary = call.summary();
      summary.callerMuted = conference ? conference.isCallerMuted(call) : false;
      return summary;
    });

    data.primary = this.getCall();

    return data;
  }

  /** Helper functions */
}
