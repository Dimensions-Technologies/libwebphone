"use strict";

import { assign as _assign, merge as _merge } from "lodash";

export default class {
  static uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (
      c
    ) {
      var r = (Math.random() * 16) | 0,
        v = c == "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  static assign(...args) {
    return _assign(...args);
  }

  static merge(...args) {
    return _merge(...args);
  }

  static randomElementId() {
    return "lwp" + Math.random().toString(36).substr(2, 9);
  }

  static mediaElementEvents() {
    return [
      "abort",
      "canplay",
      "canplaythrough",
      "durationchange",
      "emptied",
      "ended",
      "error",
      "loadeddata",
      "loadedmetadata",
      "loadstart",
      "pause",
      "play",
      "playing",
      //"progress",
      "ratechange",
      "seeked",
      "seeking",
      "stalled",
      "suspend",
      "timeupdate",
      "volumechange",
      "waiting",
    ];
  }

  static trackParameters(mediaStream, track) {
    if (!mediaStream || !track) {
      return;
    }

    if (typeof track.getCapabilities != "function") {
      track.getCapabilities = () => {};
    }

    return {
      trackKind: track.kind,
      selected: track.readyState == "live",
      deviceKind: this.trackKindtoDeviceKind(track.kind),
      settings: track.getSettings(),
      constraints: track.getConstraints(),
      capabilities: track.getCapabilities(),
      track: track,
      mediaStream: mediaStream,
    };
  }

  static trackKindtoDeviceKind(trackKind) {
    switch (trackKind) {
      case "audio":
        return "audioinput";
      case "video":
        return "videoinput";
    }
  }

  static trackKinds() {
    return ["audio", "video"];
  }

  // Mutes a playing media element, then pauses it `delayMs` later. pause()
  // cuts the waveform wherever it happens to be, which clicks unless that's
  // near a zero crossing; muting first gives the element time to render
  // near-silent audio before the cut. Best-effort - the margin has to exceed
  // however much audio is already buffered ahead, which JS can't observe.
  //
  // Muted rather than volume = 0 so it can't collide with anything else
  // writing volume during the window (lwpCall.changeVolume()).
  //
  // Safe to call again before a previous call finishes - the token
  // invalidates any pending pause, so a stale one can't land on playback
  // that's since moved on.
  static declickPause(element, delayMs = 50) {
    if (!element || element.paused) {
      return;
    }

    element._lwpDeclickToken = (element._lwpDeclickToken || 0) + 1;
    const token = element._lwpDeclickToken;

    element._lwpDeclickPending = true;
    element.muted = true;

    setTimeout(() => {
      if (element._lwpDeclickToken !== token) {
        return;
      }

      element.pause();
      element.muted = false;
      element._lwpDeclickPending = false;
    }, delayMs);
  }

  // Invalidates any pending declickPause() (e.g. the element is about to be
  // reused) and unmutes immediately rather than leaving it silent until the
  // pending pause would have landed.
  static cancelDeclickPause(element) {
    if (!element) {
      return;
    }

    element._lwpDeclickToken = (element._lwpDeclickToken || 0) + 1;

    // Only unmute a mute we're responsible for, not one a host app set.
    if (element._lwpDeclickPending) {
      element._lwpDeclickPending = false;
      element.muted = false;
    }
  }

  // Decodes a `data:` URI's base64 payload into an ArrayBuffer for
  // decodeAudioData(). Not fetch(dataUri).arrayBuffer(), which is shorter but
  // can be blocked by a host application's `connect-src` CSP; atob() can't.
  static dataUriToArrayBuffer(dataUri) {
    const base64 = String(dataUri).split(",")[1];

    if (!base64) {
      throw new Error("lwpUtils.dataUriToArrayBuffer: not a data URI");
    }

    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes.buffer;
  }

  static isChrome() {
    const isChromium = window.chrome;
    const winNav = window.navigator;
    const vendorName = winNav.vendor;
    const isOpera = typeof window.opr !== "undefined";
    const isIEedge = winNav.userAgent.indexOf("Edge") > -1;
    const isIOSChrome = winNav.userAgent.match("CriOS");

    return (
      isIOSChrome ||
      (isChromium !== null &&
        typeof isChromium !== "undefined" &&
        vendorName === "Google Inc." &&
        isOpera === false &&
        isIEedge === false)
    );
  }
}
