"use strict";

import * as JsSIP from "jssip";
import JsSIPSubscriber from "jssip/lib/Subscriber";
import lwpUtils from "./lwpUtils";
import lwpRenderer from "./lwpRenderer";

export default class extends lwpRenderer {
  constructor(libwebphone, config = {}) {
    super(libwebphone);
    this._libwebphone = libwebphone;
    this._emit = this._libwebphone._blfEvent;
    this._initProperties(config);
    this._initInternationalization(config.i18n || {});
    this._initEventBindings();
    this._initRenderTargets();
    this._emit("created", this);
    return this;
  }

  getKeys() {
    return this._keys;
  }

  getKey(id) {
    return this._keys.find((key) => key.id === id);
  }

  subscribeAll() {
    this._keys.forEach((key) => {
      this._subscribe(key);
    });
  }

  unsubscribeAll() {
    this._keys.forEach((key) => {
      this._unsubscribe(key);
    });
  }

  addKey(id, name = null, eventType = "dialog", acceptType = "application/dialog-info+xml") {
    if (this.getKey(id)) {
      return this.getKey(id);
    }

    const key = {
      id,
      name: name || id,
      eventType,
      acceptType,
      status: "idle",
      subscriber: null,
      lastNotify: null,
      timeoutHandle: null,
    };

    this._keys.push(key);
    this._emit("key.added", this, key);
    this.updateRenders();

    const userAgent = this._libwebphone.getUserAgent();
    if (userAgent && userAgent.isRegistered()) {
      this._subscribe(key);
    }

    return key;
  }

  removeKey(id) {
    const key = this.getKey(id);
    if (!key) {
      return;
    }

    this._unsubscribe(key);
    this._keys = this._keys.filter((k) => k.id !== id);
    this._emit("key.removed", this, key);
    this.updateRenders();
  }

  subscribe(id) {
    const key = this.getKey(id);
    if (key) {
      this._subscribe(key);
    }
  }

  unsubscribe(id) {
    const key = this.getKey(id);
    if (key) {
      this._unsubscribe(key);
    }
  }

  updateRenders() {
    this.render((render) => {
      render.data = this._renderData(render.data);
      return render;
    });
  }

  /** Init functions */

  _initProperties(config) {
    const defaults = {
      keys: [],
      subscribe_expires: 3600,
      resubscribe_delay: 1000,
      notify_timeout: 60000,
      renderTargets: [],
    };
    this._config = lwpUtils.merge(defaults, config);

    this._keys = this._config.keys.map((key) => {
      return lwpUtils.merge(
        {
          id: null,
          name: null,
          eventType: "dialog",
          acceptType: "application/dialog-info+xml",
          status: "idle",
          subscriber: null,
          lastNotify: null,
          timeoutHandle: null,
        },
        key
      );
    });
  }

  _initInternationalization(config) {
    const defaults = {
      en: {
        idle: "Idle",
        ringing: "Ringing",
        incall: "In Call",
        unknown: "Unknown",
      },
    };
    const resourceBundles = lwpUtils.merge(
      defaults,
      config.resourceBundles || {}
    );
    this._libwebphone.i18nAddResourceBundles("blf", resourceBundles);
  }

  _initEventBindings() {
    this._libwebphone.on("userAgent.registration.registered", () => {
      this.subscribeAll();
    });
    this._libwebphone.on("userAgent.registration.unregistered", () => {
      this.unsubscribeAll();
    });
    this._libwebphone.on("userAgent.disconnected", () => {
      this.unsubscribeAll();
    });
    this._libwebphone.on("userAgent.stopped", () => {
      this.unsubscribeAll();
    });
  }

  _initRenderTargets() {
    this._config.renderTargets.map((renderTarget) => {
      return this.renderAddTarget(renderTarget);
    });
  }

  _subscribe(key) {
    this._unsubscribe(key);

    const userAgent = this._libwebphone.getUserAgent();
    if (!userAgent || !userAgent.isRegistered()) {
      return;
    }

    const jsSipUA = userAgent.getAgent();
    if (!jsSipUA) {
      return;
    }

    const realm = userAgent._config.authentication.realm;
    const username = userAgent._config.authentication.username;
    const target = `sip:${key.id}@${realm}`;

    console.log(`BLF [${key.id}]: Subscribing to ${key.eventType} at ${target}`);

    const subscriber = new JsSIPSubscriber(jsSipUA, target, key.eventType, key.acceptType, {
      expires: this._config.subscribe_expires,
      extraHeaders: [
        "Accept-Language: en",
        `Contact: <sip:${username}@${realm};transport=ws>`,
      ],
    });

    subscriber.on("notify", (is_final, request, body, content_type) => {
      key.lastNotify = new Date();

      console.log(`BLF [${key.id}]: NOTIFY received at`, key.lastNotify.toISOString());
      console.log(`BLF [${key.id}]: Content-Type:`, content_type);
      console.log(`BLF [${key.id}]: Is final:`, is_final);
      console.log(`BLF [${key.id}]: Body:`, body);

      if (content_type && content_type.indexOf(key.acceptType) !== -1 && body) {
        console.log(`BLF [${key.id}]: Parsing as ${key.eventType}`);
        if (key.eventType === "dialog") {
          this._parseDialogInfo(key, body);
        } else if (key.eventType === "presence") {
          this._parsePresenceInfo(key, body);
        }
      } else {
        console.warn(`BLF [${key.id}]: Content-Type mismatch or empty body. Expected: ${key.acceptType}, Got: ${content_type}`);
      }

      // is_final is handled by the terminated event below
    });

    subscriber.on("active", () => {
      console.log(`BLF [${key.id}]: Subscription active`);
    });

    subscriber.on("pending", () => {
      console.log(`BLF [${key.id}]: Subscription pending`);
    });

    subscriber.on("terminated", (code, reason) => {
      // Guard: if key.subscriber no longer points to this subscriber,
      // termination was intentional (e.g. from _clearSubscriber) — do not resubscribe.
      if (key.subscriber !== subscriber) {
        return;
      }
      console.warn(`BLF [${key.id}]: Subscription terminated by server, code=${code} reason=${reason}, resubscribing in ${this._config.resubscribe_delay}ms`);
      key.subscriber = null;
      this._updateKeyStatus(key, "idle");
      setTimeout(() => this._subscribe(key), this._config.resubscribe_delay);
    });

    subscriber.subscribe();
    key.subscriber = subscriber;

    this._scheduleNotifyTimeout(key);
    this._emit("key.subscribed", this, key);
  }

  _unsubscribe(key) {
    this._clearNotifyTimeout(key);
    this._clearSubscriber(key);
    this._updateKeyStatus(key, "idle");
    this._emit("key.unsubscribed", this, key);
  }

  _clearSubscriber(key) {
    if (key.subscriber) {
      const sub = key.subscriber;
      key.subscriber = null; // null first so terminated handler ignores this
      try {
        sub.terminate();
      } catch (e) {
        // Subscriber may already be terminated
      }
    }
  }

  _scheduleNotifyTimeout(key) {
    this._clearNotifyTimeout(key);
    key.timeoutHandle = setTimeout(() => {
      if (
        key.lastNotify &&
        new Date() - key.lastNotify > this._config.notify_timeout
      ) {
        this._subscribe(key);
      } else {
        this._scheduleNotifyTimeout(key);
      }
    }, this._config.notify_timeout);
  }

  _clearNotifyTimeout(key) {
    if (key.timeoutHandle) {
      clearTimeout(key.timeoutHandle);
      key.timeoutHandle = null;
    }
  }

  _parseDialogInfo(key, body) {
    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(body, "application/xml");
      const dialog = xmlDoc.getElementsByTagName("dialog")[0];

      if (dialog) {
        const stateEl = dialog.getElementsByTagName("state")[0];
        const state = stateEl ? stateEl.textContent.toLowerCase() : "unknown";

        switch (state) {
          case "trying":
          case "early":
            this._updateKeyStatus(key, "ringing");
            break;
          case "confirmed":
            this._updateKeyStatus(key, "incall");
            break;
          case "terminated":
            this._updateKeyStatus(key, "idle");
            break;
          default:
            this._updateKeyStatus(key, "unknown");
        }
      } else {
        this._updateKeyStatus(key, "unknown");
      }
    } catch (e) {
      this._updateKeyStatus(key, "unknown");
    }
  }

  _parsePresenceInfo(key, body) {
    try {
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(body, "application/xml");
      const basicEl = xmlDoc.getElementsByTagName("basic")[0];
      const status = basicEl ? basicEl.textContent.toLowerCase() : "unknown";

      if (status === "open") {
        this._updateKeyStatus(key, "idle");
      } else if (status === "closed") {
        this._updateKeyStatus(key, "incall");
      } else {
        this._updateKeyStatus(key, "unknown");
      }
    } catch (e) {
      this._updateKeyStatus(key, "unknown");
    }
  }

  _updateKeyStatus(key, status) {
    if (key.status === status) {
      return;
    }

    key.status = status;
    this._emit("key.status.updated", this, key);
    this._emit(`key.status.${status}`, this, key);
    this.updateRenders();
  }

  /** Render Helpers */

  _renderDefaultConfig() {
    return {
      template: this._renderDefaultTemplate(),
      i18n: {
        idle: "libwebphone:blf.idle",
        ringing: "libwebphone:blf.ringing",
        incall: "libwebphone:blf.incall",
        unknown: "libwebphone:blf.unknown",
      },
      data: this._renderData(),
      by_id: {},
    };
  }

  _renderData(data = {}) {
    return lwpUtils.merge(data, {
      keys: this._keys.map((key) => ({
        id: key.id,
        name: key.name,
        status: key.status,
        isIdle: key.status === "idle",
        isRinging: key.status === "ringing",
        isInCall: key.status === "incall",
        isUnknown: key.status === "unknown",
      })),
    });
  }

  _renderDefaultTemplate() {
    return `
    <div>
      {{#data.keys}}
      <div class="lwp-blf-key lwp-blf-{{status}}">
        <span class="lwp-blf-name">{{name}}</span>
        <span class="lwp-blf-status">
          {{#isIdle}}{{i18n.idle}}{{/isIdle}}
          {{#isRinging}}{{i18n.ringing}}{{/isRinging}}
          {{#isInCall}}{{i18n.incall}}{{/isInCall}}
          {{#isUnknown}}{{i18n.unknown}}{{/isUnknown}}
        </span>
      </div>
      {{/data.keys}}
    </div>`;
  }
}
