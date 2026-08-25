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
            callInfo: null,
            subscriber: null,
            lastNotify: null,
            timeoutHandle: null,
            resubscribeAttempts: 0,
            resubscribeTimeoutHandle: null,
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
            subscribe_expires: 1800,
            resubscribe_delay: 1000,
            max_resubscribe_delay: 60000,
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
                    callInfo: null,
                    subscriber: null,
                    lastNotify: null,
                    timeoutHandle: null,
                    resubscribeAttempts: 0,
                    resubscribeTimeoutHandle: null,
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
        // Internal teardown only: no "key.unsubscribed" event and no forced status
        // change here. This used to call the public _unsubscribe(), which fired a
        // phantom "key.unsubscribed" (and idle flap) on every rebuild — including
        // registration refreshes and the watchdog below re-arming a healthy key.
        this._clearNotifyTimeout(key);
        this._clearResubscribeTimeout(key);
        this._clearSubscriber(key);
        key.lastNotify = null;

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
            key.resubscribeAttempts = 0; // any NOTIFY proves the subscription is alive; forgive past failures

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
            // Exponential backoff, capped: a server that keeps rejecting this
            // subscription (or a key that will never resolve) settles into an
            // infrequent retry instead of hammering the server once a second
            // forever. Any NOTIFY (see above) resets the attempt count.
            const delay = Math.min(
                this._config.resubscribe_delay * Math.pow(2, key.resubscribeAttempts),
                this._config.max_resubscribe_delay
            );
            key.resubscribeAttempts++;
            console.warn(`BLF [${key.id}]: Subscription terminated by server, code=${code} reason=${reason}, resubscribing in ${delay}ms (attempt ${key.resubscribeAttempts})`);
            key.subscriber = null;
            this._clearNotifyTimeout(key); // avoid racing the confirm-timeout below into a second resubscribe
            this._updateKeyStatus(key, "unknown"); // lost the subscription; we no longer know the real state
            key.resubscribeTimeoutHandle = setTimeout(() => this._subscribe(key), delay);
        });

        // Assign before calling subscribe(): if subscribe() fails synchronously
        // (e.g. no transport) it fires "terminated" before this line would otherwise
        // run, and the terminated handler's identity guard needs key.subscriber to
        // already point at this subscriber to recognize it as a real failure worth
        // resubscribing, rather than silently discarding it as a zombie.
        key.subscriber = subscriber;
        subscriber.subscribe();

        this._scheduleNotifyTimeout(key);
        this._emit("key.subscribed", this, key);
    }

    _unsubscribe(key) {
        this._clearNotifyTimeout(key);
        this._clearResubscribeTimeout(key);
        this._clearSubscriber(key);
        // "idle" would claim we know the extension is free; we've just lost visibility
        // into it entirely, so "unknown" is the honest status (a WS drop shouldn't turn
        // every lamp green).
        this._updateKeyStatus(key, "unknown");
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
        // One-shot confirmation deadline, not a recurring keepalive check. RFC 6665
        // does not require a notifier to keep sending NOTIFYs for state that hasn't
        // changed, so an idle extension going quiet after its first NOTIFY is normal,
        // not a dead subscription — rebuilding it every notify_timeout was the churn.
        // The one real failure mode this needs to catch is a SUBSCRIBE that never gets
        // its initial NOTIFY at all; once that first NOTIFY lands, ongoing health is
        // covered by JsSIP's own refresh-before-expiry SUBSCRIBEs and the "terminated"
        // handler above.
        this._clearNotifyTimeout(key);
        key.timeoutHandle = setTimeout(() => {
            key.timeoutHandle = null;
            if (!key.lastNotify) {
                console.warn(`BLF [${key.id}]: No NOTIFY received within ${this._config.notify_timeout}ms of subscribing; treating subscription as dead and resubscribing`);
                this._subscribe(key);
            }
        }, this._config.notify_timeout);
    }

    _clearNotifyTimeout(key) {
        if (key.timeoutHandle) {
            clearTimeout(key.timeoutHandle);
            key.timeoutHandle = null;
        }
    }

    _clearResubscribeTimeout(key) {
        // Cancels a pending backoff retry so a removed/torn-down key can't
        // resurrect a subscription after it was told to stop.
        if (key.resubscribeTimeoutHandle) {
            clearTimeout(key.resubscribeTimeoutHandle);
            key.resubscribeTimeoutHandle = null;
        }
    }

    _parseDialogInfo(key, body) {
        // Helper: namespace-safe element lookup (handles default xmlns on dialog-info documents)
        const getEls = (node, localName) => node.getElementsByTagNameNS("*", localName);
        const getEl = (node, localName) => getEls(node, localName)[0] || null;

        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(body, "application/xml");

            const dialogInfoEl = getEl(xmlDoc, "dialog-info");
            if (!dialogInfoEl) {
                this._updateKeyInfo(key, "unknown", null);
                return;
            }

            const infoState = dialogInfoEl.getAttribute("state") || "full";

            // "full" replaces all known dialog state; reset call info first
            if (infoState === "full") {
                key.callInfo = null;
            }

            const dialogs = getEls(xmlDoc, "dialog");

            if (!dialogs.length) {
                // No dialogs in a "full" document means the extension is idle
                this._updateKeyInfo(key, "idle", null);
                return;
            }

            // Priority: confirmed (incall=3) > early/trying (ringing=2) > unknown (1) > terminated (idle=0)
            const statusPriority = { incall: 3, ringing: 2, unknown: 1, idle: 0 };
            let bestStatus = "idle";
            let bestCallInfo = null;

            for (let i = 0; i < dialogs.length; i++) {
                const dialog = dialogs[i];
                const stateEl = getEl(dialog, "state");
                const dialogState = stateEl ? stateEl.textContent.toLowerCase() : "unknown";

                let status;
                switch (dialogState) {
                    case "trying":
                    case "early":
                        status = "ringing";
                        break;
                    case "confirmed":
                        status = "incall";
                        break;
                    case "terminated":
                        status = "idle";
                        break;
                    default:
                        status = "unknown";
                }

                if ((statusPriority[status] !== undefined ? statusPriority[status] : 0) > (statusPriority[bestStatus] !== undefined ? statusPriority[bestStatus] : 0)) {
                    bestStatus = status;

                    const localEl = getEl(dialog, "local");
                    const remoteEl = getEl(dialog, "remote");
                    const localIdentityEl = localEl ? getEl(localEl, "identity") : null;
                    const remoteIdentityEl = remoteEl ? getEl(remoteEl, "identity") : null;
                    const localTargetEl = localEl ? getEl(localEl, "target") : null;
                    const remoteTargetEl = remoteEl ? getEl(remoteEl, "target") : null;

                    bestCallInfo = {
                        direction: dialog.getAttribute("direction"),
                        dialogId: dialog.getAttribute("id"),
                        callId: dialog.getAttribute("call-id"),
                        localTag: dialog.getAttribute("local-tag"),
                        remoteTag: dialog.getAttribute("remote-tag"),
                        dialogState,
                        localDisplay: localIdentityEl ? localIdentityEl.getAttribute("display") : null,
                        localIdentity: localIdentityEl ? localIdentityEl.textContent : null,
                        localTargetUri: localTargetEl ? localTargetEl.getAttribute("uri") : null,
                        remoteDisplay: remoteIdentityEl ? remoteIdentityEl.getAttribute("display") : null,
                        remoteIdentity: remoteIdentityEl ? remoteIdentityEl.textContent : null,
                        remoteTargetUri: remoteTargetEl ? remoteTargetEl.getAttribute("uri") : null,
                    };
                }
            }

            this._updateKeyInfo(key, bestStatus, bestCallInfo);
        } catch (e) {
            console.error(`BLF [${key.id}]: Error parsing dialog-info`, e);
            this._updateKeyInfo(key, "unknown", null);
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

    _updateKeyInfo(key, status, callInfo) {
        const statusChanged = key.status !== status;
        const callInfoChanged =
            JSON.stringify(key.callInfo) !== JSON.stringify(callInfo);

        if (!statusChanged && !callInfoChanged) {
            return;
        }

        key.status = status;
        key.callInfo = callInfo;

        console.log(`BLF [${key.id}]: status=${status} callInfo=${JSON.stringify(callInfo)}`);

        if (statusChanged) {
            this._emit("key.status.updated", this, key);
            this._emit(`key.status.${status}`, this, key);
        }
        if (callInfoChanged) {
            this._emit("key.callinfo.updated", this, key);
        }

        this.updateRenders();
    }

    _updateKeyStatus(key, status) {
        if (key.status === status) {
            return;
        }

        key.status = status;
        key.callInfo = null;
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
        data.keys = this._keys.map((key) => ({
            id: key.id,
            name: key.name,
            status: key.status,
            isIdle: key.status === "idle",
            isRinging: key.status === "ringing",
            isInCall: key.status === "incall",
            isUnknown: key.status === "unknown",
            callInfo: key.callInfo
                ? {
                    direction: key.callInfo.direction,
                    dialogState: key.callInfo.dialogState,
                    localDisplay: key.callInfo.localDisplay,
                    localIdentity: key.callInfo.localIdentity,
                    remoteDisplay: key.callInfo.remoteDisplay,
                    remoteIdentity: key.callInfo.remoteIdentity,
                }
                : null,
        }));

        return data;
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
        {{#callInfo}}
        <span class="lwp-blf-caller">
          {{remoteDisplay}}{{^remoteDisplay}}{{remoteIdentity}}{{/remoteDisplay}}
        </span>
        {{/callInfo}}
      </div>
      {{/data.keys}}
    </div>`;
    }
}
