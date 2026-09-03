"use strict";

import * as JsSIP from "jssip";

import lwpUtils from "./lwpUtils";
import lwpRenderer from "./lwpRenderer";
import { Mutex } from "async-mutex";
// eslint-disable-next-line no-unused-vars
import adapter from "webrtc-adapter";

// Namespaced logger on JsSIP's own `debug` instance, the same arrangement
// lwpAudioContext uses for "libwebphone:callWaiting" - so lwpUserAgent's
// existing debug toggle switches this on alongside the SIP trace rather than
// needing a setting of its own, and the two interleave in the order things
// actually happened.
const mediaDevicesDebug = JsSIP.debug("libwebphone:mediaDevices");

// `debug`'s browser build writes to console.debug, which Chrome files under
// Verbose and hides by default. Match what the rest of libwebphone logs.
mediaDevicesDebug.log = console.log.bind(console);

export default class extends lwpRenderer {
  constructor(libwebphone, config = {}) {
    super(libwebphone);
    this._libwebphone = libwebphone;
    this._emit = this._libwebphone._mediaDevicesEvent;
    this._initProperties(config);
    this._initInternationalization(config.i18n || {});
    this._initInputStreams();
    this._initAvailableDevices();
    this._initEventBindings();
    this._initRenderTargets();
    this._emit("created", this);
    return this;
  }

  // Best-effort diagnostic snapshot of device/track state, logged before
  // every answer attempt. Deliberately fire-and-forget and fully isolated
  // in its own try/catch - a failure or slowness here must never delay or
  // break the actual call flow. Not awaited by the caller on purpose.
  _logMediaSnapshot(context) {
    // Gated, and gated first. Device and track labels are user-identifying
    // strings ("<name>'s AirPods"), this runs on every call, dial, loopback
    // preview and conference add, and error-reporting SDKs routinely capture
    // console output as breadcrumbs - so unconditional logging sends those
    // labels somewhere nobody chose to send them. Disabled it costs one
    // property read and builds nothing.
    if (!mediaDevicesDebug.enabled) {
      return;
    }

    try {
      const devices = {};
      Object.keys(this._availableDevices || {}).forEach((kind) => {
        devices[kind] = (this._availableDevices[kind] || []).map((d) => ({
          id: d.id,
          label: d.label,
          selected: d.selected,
          connected: d.connected,
        }));
      });
      mediaDevicesDebug("device snapshot (" + context + ")", devices);

      Promise.resolve(this._mediaStreamPromise)
        .then((mediaStream) => {
          const tracks = mediaStream
            ? mediaStream.getTracks().map((track) => ({
                kind: track.kind,
                label: track.label,
                readyState: track.readyState,
                enabled: track.enabled,
                muted: track.muted,
              }))
            : null;
          mediaDevicesDebug("current stream snapshot (" + context + ")", tracks);
        })
        .catch((error) => {
          mediaDevicesDebug("current stream snapshot (" + context + ") - promise rejected", error);
        });
    } catch (error) {
      console.warn("[lwpMediaDevices] _logMediaSnapshot failed (non-fatal, does not affect the call)", error);
    }
  }

  startStreams(requestId = null) {
    this._logMediaSnapshot("startStreams");
    this._startMediaElements();

    if (this._inputActive) {
      // recover: this branch has no acquisition of its own - it clones the
      // shared stream straight into a call stream - so if that stream has
      // no live tracks nothing else will go and get them, and the call
      // would connect with silent audio. This is the path WI35397 wedged
      // on.
      return this._ensureMediaStream(null, true).then((mediaStream) => {
        // The same contract as the acquisition branch below: startStreams()
        // either resolves media a call can actually use, or it rejects.
        // Resolving an empty stream here would let lwpUserAgent.call(),
        // which has no track check of its own, dial out and connect
        // silently mute - no error, no event, the user only finding out
        // from the far end.
        if (
          !mediaStream.getTracks().some((track) => track.readyState == "live")
        ) {
          throw new Error("no usable input media available");
        }

        return this._createCallStream(mediaStream, requestId);
      });
    }

    return this._startInputStreams().then((mediaStream) => {
      this._inputActive = true;

      this._emit("streams.started", this, mediaStream);

      return this._createCallStream(mediaStream, requestId);
    });
  }

  stopStreams(requestId = null) {
    if (!requestId) {
      requestId = null;
    }

    const requestIndex = this._startedStreams.findIndex((request) => {
      return request.id == requestId;
    });

    if (requestIndex != -1) {
      this._startedStreams.splice(requestIndex, 1).forEach((request) => {
        if (request.mediaStream) {
          request.mediaStream.getTracks().forEach((track) => {
            track.enabled = false;
            track.stop();
          });
        }
      });
    }

    if (this._startedStreams.length == 0) {
      this.stopAllStreams();
    }
  }

  stopAllStreams() {
    this._startedStreams.forEach((request) => {
      if (request.mediaStream) {
        request.mediaStream.getTracks().forEach((track) => {
          track.enabled = false;
          track.stop();
        });
      }
    });
    this._startedStreams = [];

    return this._readMediaStream().then((mediaStream) => {
      const tracks = mediaStream ? mediaStream.getTracks() : [];

      // Cleared before anything below can return early. _inputActive is
      // what startStreams() trusts to decide it already holds usable
      // media, and that branch clones the shared stream without ever
      // calling getUserMedia - so a teardown that returns with the flag
      // still set leaves every later call cloning a stream with no tracks,
      // for the life of the page, however available the microphone
      // becomes. That was WI35397: the phone went permanently dead after a
      // single transient acquisition failure and only a reload recovered
      // it. Whatever else this method decides it has nothing to do, it
      // must always leave the flag false.
      this._inputActive = false;

      // Nothing to stop/clean up if we never had a real stream, or it's
      // already empty (e.g. a prior dispose already ran) - do not attempt
      // recovery here, that would acquire media just to immediately tear
      // it down again, and do not emit a second streams.stopped for a
      // teardown that stopped nothing.
      if (tracks.length === 0) {
        return;
      }

      tracks.forEach((track) => {
        this._removeTrack(mediaStream, track, false);
      });

      this._emit("streams.stopped", this);

      // Dispose the shared stream outright rather than leaving
      // _mediaStreamPromise pointing at this now-empty MediaStream object.
      // Resolve to a fresh, empty MediaStream - not null. _muteInput/
      // _unmuteInput/_toggleMuteInput and the device-switch refresh logic
      // all read _mediaStreamPromise directly and call .getTracks() on it
      // with no null guard, so it must always resolve to a real object.
      // An empty stream is enough: _startInputStreams() already forces a
      // brand-new getUserMedia() call whenever the current stream has no
      // live tracks, so the next call still acquires media fresh. The
      // recovery logic in _ensureMediaStream() stays in place as a
      // fallback for cases this doesn't cover, such as losing a track
      // mid-call while another call is still active.
      this._mediaStreamPromise = Promise.resolve(new MediaStream());
    });
  }

  mute(deviceKind = null) {
    switch (deviceKind) {
      case "audiooutput":
        return this._muteOutput(deviceKind);
      default:
        return this._muteInput(deviceKind);
    }
  }

  unmute(deviceKind = null) {
    switch (deviceKind) {
      case "audiooutput":
        return this._unmuteOutput(deviceKind);
      default:
        return this._unmuteInput(deviceKind);
    }
  }

  toggleMute(deviceKind = null) {
    switch (deviceKind) {
      case "audiooutput":
        return this._toggleMuteOutput(deviceKind);
      default:
        return this._toggleMuteInput(deviceKind);
    }
  }

  /**
   * Start Screen Capture.
   * Screen Capture acts as a new videoinput device,
   * meaning that if you switch calls when screensharing
   * the new call will also be screensharing if video is unmuted.
   * @param {DisplayMediaStreamConstraints} [options] The source for screen capture.
   * @param {boolean} [useDisplayMedia] Use mediaDevices.getDisplayMedia over mediaDevices.getUserMedia
   */
  async startScreenCapture(options = {}, useDisplayMedia = true) {
    try {
      this._captureStream = useDisplayMedia
        ? await navigator.mediaDevices.getDisplayMedia(options)
        : await navigator.mediaDevices.getUserMedia(options);

      this._addScreenCaptureEventListeners();
      this._emit("screenCapture.started", this, this._captureStream);

      this._mediaStreamPromise.then((mediaStream) => {
        this._captureStream.getVideoTracks().forEach((track) => {
          const trackInformation = lwpUtils.trackParameters(mediaStream, track);
          this._emit("video.input.changed", this, trackInformation);
        });
      });
    } catch (error) {
      this._emit("screenCapture.error", this, error);
    }
  }

  /**
   * Stops Screen Capture and enables previously selected videoinput
   */
  stopScreenCapture() {
    if (!this._captureStream) {
      return;
    }

    const currentVideoDevice = this._availableDevices.videoinput.find(
      (device) => device.selected === true
    );

    this._captureStream.getTracks().forEach((track) => track.stop());
    this._captureStream = null;
    this.changeDevice("videoinput", currentVideoDevice.id);
    this._emit("screenCapture.stopped", this);
  }

  getMediaElement(deviceKind) {
    if (
      this._config[deviceKind] &&
      this._config[deviceKind].mediaElement.element
    ) {
      return this._config[deviceKind].mediaElement.element;
    }
  }

  getPreferedDevice(deviceKind) {
    return this._availableDevices[deviceKind].find((device) => {
      return device.selected;
    });
  }

  async changeDevice(deviceKind, deviceId) {
    const preferedDevice = this._findAvailableDevice(deviceKind, deviceId);

    if (!preferedDevice || !preferedDevice.connected) {
      // TODO: create a meaningful return/error
      return Promise.reject();
    }

    // The secondary ring output exists to add a *second* device: pointing it
    // at the primary's would only play the ringtone twice into one speaker.
    // The default template already filters that device out of the list, so
    // this is the guard for a host app calling in directly.
    if (
      deviceKind == "ringoutput2" &&
      this._isPrimaryRingDevice(preferedDevice)
    ) {
      const error = new Error(
        "the secondary ring output cannot be the primary ring output device"
      );

      this._emit("ring.output.secondary.error", this, error);

      return Promise.reject(error);
    }

    const release = await this._changeStreamMutex.acquire();
    this._preferDevice(preferedDevice);

    // finally(), not then(): a rejection would otherwise hold the mutex
    // forever, deadlocking every subsequent device change.
    switch (deviceKind) {
      case "ringoutput":
        return this._changeRingOutputDevice(preferedDevice).finally(release);
      case "ringoutput2":
        return this._changeSecondaryRingOutputDevice(preferedDevice).finally(
          release
        );
      case "audiooutput":
        return this._changeOutputDevice(preferedDevice).finally(release);
      default:
        return this._changeInputDevice(preferedDevice).finally(release);
    }
  }

  async refreshAvailableDevices() {
    return this._shimEnumerateDevices()
      .then(async (devices) => {
        const release = await this._changeStreamMutex.acquire();
        const alteredTrackKinds = [];
        const alteredOutputDevices = [];

        // NOTE: assume all devices are disconnected then transition
        //  each back to connected if enumerated
        this._forEachAvailableDevice((availableDevice) => {
          if (availableDevice.id != "none") {
            availableDevice.connected = false;
          }
        });

        this._importInputDevices(devices);
        this._sortAvailableDevices();

        Object.keys(this._availableDevices).forEach((deviceKind) => {
          const selectedDevice = this._availableDevices[deviceKind].find(
            (availableDevice) => {
              return availableDevice.selected;
            }
          );
          const preferedDevice = this._availableDevices[deviceKind].find(
            (availableDevice) => {
              return availableDevice.connected && availableDevice.id != "none";
            }
          );
          // The secondary ring output is opt-in and defaults to none, so it
          // never promotes itself onto a newly connected device the way the
          // other kinds do - it only ever falls back to none when whatever it
          // was using goes away.
          const isSecondaryRing = deviceKind === "ringoutput2";
          const replacementDevice = isSecondaryRing
            ? this._findAvailableDevice(deviceKind, "none")
            : preferedDevice;
          const switchToPrefered =
            !isSecondaryRing &&
            selectedDevice &&
            preferedDevice &&
            selectedDevice.preference < preferedDevice.preference;
          const selectedDeviceDisconnected =
            selectedDevice && !selectedDevice.connected;

          if (switchToPrefered || selectedDeviceDisconnected) {
            selectedDevice.selected = false;
            alteredTrackKinds.push(selectedDevice.trackKind);

            if (replacementDevice) {
              replacementDevice.selected = true;
              if (
                ["audiooutput", "ringoutput", "ringoutput2"].includes(
                  deviceKind
                )
              ) {
                alteredOutputDevices.push({
                  deviceKind,
                  device: replacementDevice,
                });
              }
            }
          }
        });

        return this._mediaStreamPromise.then((mediaStream) => {
          const constraints = this._createConstraints();
          const alteredConstraints = {};

          mediaStream.getTracks().forEach((track) => {
            const trackParameters = lwpUtils.trackParameters(
              mediaStream,
              track
            );
            const deviceKind = lwpUtils.trackKindtoDeviceKind(track.kind);
            const selectedDevice = this._availableDevices[deviceKind].find(
              (availableDevice) => {
                return availableDevice.selected;
              }
            );

            if (selectedDevice) {
              const differentId =
                selectedDevice.id != trackParameters.settings.deviceId;
              const differentLabel = selectedDevice.label != track.label;
              if (differentId || differentLabel) {
                alteredTrackKinds.push(track.kind);
                this._removeTrack(mediaStream, track);
              }
            } else if (track.readyState != "live") {
              alteredTrackKinds.push(track.kind);
              this._removeTrack(mediaStream, track);
            }
          });

          alteredTrackKinds.forEach((trackKind) => {
            if (constraints[trackKind]) {
              alteredConstraints[trackKind] = constraints[trackKind];
            }
          });

          release();

          return this._startInputStreams(alteredConstraints).then(() => {
            return this._mediaStreamPromise;
          }).then((mediaStream) => {
            ["audio", "video"].forEach((trackKind) => {
              if (alteredConstraints[trackKind]) {
                const newTrack = mediaStream.getTracks().find(
                  (t) => t.kind === trackKind && t.readyState === "live"
                );
                if (newTrack) {
                  this._emit(
                    trackKind + ".input.changed",
                    this,
                    lwpUtils.trackParameters(mediaStream, newTrack),
                    null
                  );
                }
              }
            });

            // Before the applications below, not after: a primary promoted
            // onto whatever the secondary is using has to give the secondary
            // somewhere else to go, and the selections are already settled -
            // resolving it here keeps it from racing an in-flight change.
            this._enforceDistinctRingOutputs();

            alteredOutputDevices.forEach(({ deviceKind, device }) => {
              if (deviceKind === "ringoutput") {
                this._changeRingOutputDevice(device);
              } else if (deviceKind === "ringoutput2") {
                this._changeSecondaryRingOutputDevice(device);
              } else {
                this._changeOutputDevice(device);
              }
            });
          });
        });
      })
      .then(() => {
        this._sortAvailableDevices();
        this._emit("devices.refreshed", this, this._availableDevices);
        this.updateRenders();
      });
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
        none: "None",
        screenCapture: "Screen Capture",
        ringoutput: "Ringing Device",
        ringoutput2: "Secondary Ringing Device",
        audiooutput: "Speaker",
        audioinput: "Microphone",
        videoinput: "Camera",
        loading: "Finding media devices...",
      },
    };
    const resourceBundles = lwpUtils.merge(
      defaults,
      config.resourceBundles || {}
    );
    this._libwebphone.i18nAddResourceBundles("mediaDevices", resourceBundles);
  }

  _initProperties(config) {
    const defaults = {
      ringoutput: {
        enabled: "sinkId" in HTMLMediaElement.prototype,
        show: true,
        preferedDeviceIds: [],
        mediaElement: {
          create: true,
          elementId: null,
          element: null,
          initParameters: {
            muted: false,
          },
        },
      },
      // An optional second device to ring in parallel with `ringoutput`, off
      // ("none") unless a device is chosen for it. Always element-sinked: an
      // AudioContext has one sink and the primary ring output already owns it,
      // so a browser without HTMLMediaElement.setSinkId cannot offer this at
      // all - hence the same `enabled` test as the other output kinds.
      ringoutput2: {
        enabled: "sinkId" in HTMLMediaElement.prototype,
        show: true,
        preferedDeviceIds: [],
        mediaElement: {
          create: true,
          elementId: null,
          element: null,
          initParameters: {
            muted: false,
          },
        },
      },
      audiooutput: {
        enabled: "sinkId" in HTMLMediaElement.prototype,
        show: true,
        preferedDeviceIds: [],
        mediaElement: {
          create: true,
          elementId: null,
          element: null,
          initParameters: {
            muted: false,
          },
        },
      },
      audioinput: {
        enabled: true,
        show: true,
        preferedDeviceIds: [],
        mediaElement: {
          create: false,
          elementId: null,
          element: null,
          initParameters: {
            muted: true,
          },
        },
      },
      videoinput: {
        enabled: true,
        show: true,
        constraints: {},
        preferedDeviceIds: [],
        screenCapture: false,
        mediaElement: {
          create: false,
          elementId: null,
          element: null,
          initParameters: {
            muted: true,
          },
        },
      },
      renderTargets: [],
      detectDeviceChanges: true,
      manageMediaElements: true,
    };
    this._config = lwpUtils.merge(defaults, config);

    this._loaded = false;

    this._changeStreamMutex = new Mutex();

    this._recoveryPromise = null;

    this._inputActive = false;

    this._startedStreams = [];

    this._availableDevices = {};

    this._captureStream = null;

    this._deviceKinds().forEach((deviceKind) => {
      if (
        !this._config[deviceKind].mediaElement.element &&
        this._config[deviceKind].mediaElement.elementId
      ) {
        this._config[deviceKind].mediaElement.element = document.getElementById(
          this._config[deviceKind].mediaElement.elementId
        );
      }

      if (
        !this._config[deviceKind].mediaElement.element &&
        this._config[deviceKind].mediaElement.create &&
        this._config[deviceKind].enabled
      ) {
        if (
          ["audiooutput", "ringoutput", "ringoutput2"].includes(deviceKind)
        ) {
          this._config[deviceKind].mediaElement.element = new Audio();
        } else {
          this._config[deviceKind].mediaElement.element =
            document.createElement(this._deviceKindtoTrackKind(deviceKind));
        }
      }

      if (this._config[deviceKind].mediaElement.element) {
        lwpUtils.mediaElementEvents().forEach((eventName) => {
          this._config[deviceKind].mediaElement.element.addEventListener(
            eventName,
            (event) => {
              this._emit(
                this._deviceKindtoEventKind(deviceKind) + "." + eventName,
                this,
                this._config[deviceKind].mediaElement.element,
                event
              );
            }
          );
        });

        this._config[deviceKind].mediaElement.element.preload = "none";

        if (this._config.manageMediaElements) {
          Object.keys(
            this._config[deviceKind].mediaElement.initParameters
          ).forEach((parameterName) => {
            this._config[deviceKind].mediaElement.element[parameterName] =
              this._config[deviceKind].mediaElement.initParameters[
                parameterName
              ];
          });
        }
      }

      if (this._config[deviceKind].mediaElement.element) {
        this._emit(
          this._deviceKindtoEventKind(deviceKind) + ".element",
          this,
          this._config[deviceKind].mediaElement.element
        );
      }

      this._availableDevices[deviceKind] = [];

      this._config[deviceKind].show =
        this._config[deviceKind].enabled && this._config[deviceKind].show;
    });

    // Seeded before enumeration so it sorts first and is what
    // _initAvailableDevices() settles on: the secondary ring output is off
    // unless a device is deliberately chosen for it.
    this._availableDevices.ringoutput2 = [
      this._deviceParameters({
        deviceId: "none",
        label: "libwebphone:mediaDevices.none",
        kind: "ringoutput2",
        displayOrder: 0,
      }),
    ];

    this._availableDevices.videoinput = [
      this._deviceParameters({
        deviceId: "none",
        label: "libwebphone:mediaDevices.none",
        kind: "videoinput",
        displayOrder: 0,
      }),
      // Add screenCapture device if screenCapture is enabled in config
      ...(this._config.videoinput.screenCapture
        ? [
            this._deviceParameters({
              deviceId: "screenCapture",
              label: "libwebphone:mediaDevices.screenCapture",
              kind: "videoinput",
              displayOrder: 1,
            }),
          ]
        : []),
    ];
  }

  _initInputStreams() {
    const constraints = {
      audio: this._config["audioinput"].enabled,
      video: this._config["videoinput"].enabled,
    };

    if (
      constraints.audio &&
      this._config.audioinput.preferedDeviceIds.length > 0
    ) {
      if (this._config.audioinput.preferedDeviceIds.includes("none")) {
        constraints.audio = false;
      } else {
        constraints.audio = {};
        constraints.audio.deviceId = this._config.audioinput.preferedDeviceIds;
      }
    }

    if (
      constraints.video &&
      this._config.videoinput.preferedDeviceIds.length > 0
    ) {
      if (this._config.videoinput.preferedDeviceIds.includes("none")) {
        constraints.video = false;
      } else {
        constraints.video = {};
        constraints.video.deviceId = this._config.videoinput.preferedDeviceIds;
      }
    }

    this._mediaStreamPromise = this._shimGetUserMedia(constraints)
      .then((mediaStream) => {
        this._updateMediaElements(mediaStream);
        return mediaStream;
      })
      .catch((error) => {
        this._emit("getUserMedia.error", this, error);
        if (constraints.video && constraints.audio) {
          delete constraints.video;
          return this._shimGetUserMedia(constraints).then((mediaStream) => {
            this._updateMediaElements(mediaStream);
            return mediaStream;
          });
        }
        return new MediaStream();
      });

    return this._mediaStreamPromise;
  }

  _initAvailableDevices() {
    this._mediaStreamPromise.then((mediaStream) => {
      this._shimEnumerateDevices().then((devices) => {
        this._importInputDevices(devices);
        mediaStream.getTracks().forEach((track) => {
          this._addTrack(mediaStream, track);
          this._removeTrack(mediaStream, track, false);
        });

        this._sortAvailableDevices();

        Object.keys(this._availableDevices).forEach((deviceKind) => {
          let selectedDevice = (
            this._config[deviceKind].preferedDeviceIds || []
          )
            .map((preferedDeviceId) => {
              return this._findAvailableDevice(deviceKind, preferedDeviceId);
            })
            .find((availableDevice) => {
              return availableDevice && availableDevice.connected;
            });

          if (selectedDevice) {
            this._availableDevices[deviceKind].forEach((availableDevice) => {
              availableDevice.selected =
                availableDevice.id == selectedDevice.id;
            });
          }

          if (!selectedDevice) {
            selectedDevice = this._availableDevices[deviceKind].find(
              (availableDevice) => {
                return availableDevice.selected;
              }
            );
          }

          if (!selectedDevice) {
            selectedDevice = this._availableDevices[deviceKind][0];

            if (selectedDevice) {
              selectedDevice.selected = true;
            }
          }
        });

        // Before anything is applied, not after: a configured
        // ringoutput2.preferedDeviceIds can name the device the primary
        // settled on, and resolving that first means the loop below applies
        // the corrected selection rather than racing it.
        this._enforceDistinctRingOutputs();

        ["ringoutput", "ringoutput2", "audiooutput"].forEach((deviceKind) => {
          const selectedDevice = this._availableDevices[deviceKind].find(
            (availableDevice) => {
              return availableDevice.selected;
            }
          );

          if (selectedDevice && !this._isOutputAudible(deviceKind)) {
            if (deviceKind == "ringoutput") {
              this._changeRingOutputDevice(selectedDevice);
            } else if (deviceKind == "ringoutput2") {
              this._changeSecondaryRingOutputDevice(selectedDevice);
            } else {
              this._changeOutputDevice(selectedDevice);
            }
          }
        });

        this._applyInputDeviceSelection(mediaStream);

        this._loaded = true;
        this._emit("devices.loaded", this, this._availableDevices);
        this.updateRenders();
      });
    });
  }

  _initEventBindings() {
    this._libwebphone.on("call.terminated", (lwp, call) => {
      this.stopStreams(call.getId());
    });

    if (this._config.detectDeviceChanges) {
      navigator.mediaDevices.addEventListener("devicechange", () => {
        this.refreshAvailableDevices();
      });
    }

    this._libwebphone.on("audioContext.preview.loopback.started", () => {
      // Caught because startStreams() now rejects when no media could be
      // acquired; nothing awaits this one, so without it a failed loopback
      // preview would surface only as an unhandled rejection. The host has
      // already had getUserMedia.error for the underlying cause.
      this.startStreams("loopbackPreview").catch((error) => {
        console.warn("[lwpMediaDevices] loopback preview could not start", error);
      });
    });
    this._libwebphone.on("audioContext.preview.loopback.stopped", () => {
      this.stopStreams("loopbackPreview");
    });
    this._libwebphone.on("audioContext.started", () => {
      this._startMediaElements();
    });

    this._libwebphone.on("mediaDevices.streams.started", () => {
      this.updateRenders();
    });
    this._libwebphone.on("mediaDevices.streams.stop", () => {
      this.updateRenders();
    });
    this._libwebphone.on("mediaDevices.ring.output.changed", () => {
      // Re-renders the secondary selector too: which device it may offer
      // depends on what the primary just took.
      this.updateRenders();
    });
    this._libwebphone.on("mediaDevices.ring.output.secondary.changed", () => {
      this.updateRenders();
    });
    this._libwebphone.on("mediaDevices.audio.output.changed", () => {
      this.updateRenders();
    });
    this._libwebphone.on("mediaDevices.audio.input.changed", () => {
      this.updateRenders();
    });
    this._libwebphone.on("mediaDevices.video.input.changed", () => {
      this.updateRenders();
    });
    this._libwebphone.on("mediaDevices.getUserMedia.error", () => {
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
        none: "libwebphone:mediaDevices.none",
        screenCapture: "libwebphone:mediaDevices.screenCapture",
        ringoutput: "libwebphone:mediaDevices.ringoutput",
        ringoutput2: "libwebphone:mediaDevices.ringoutput2",
        audiooutput: "libwebphone:mediaDevices.audiooutput",
        audioinput: "libwebphone:mediaDevices.audioinput",
        videoinput: "libwebphone:mediaDevices.videoinput",
        loading: "libwebphone:mediaDevices.loading",
      },
      by_id: {
        ringoutput: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              if (element.options) {
                const deviceId = element.options[element.selectedIndex].value;
                this.changeDevice("ringoutput", deviceId);
              }
            },
          },
        },
        ringoutput2: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              if (element.options) {
                const deviceId = element.options[element.selectedIndex].value;
                // Caught, unlike the other kinds: changeDevice() rejects a
                // secondary that duplicates the primary, and the re-render
                // puts the selector back to what is actually in use.
                this.changeDevice("ringoutput2", deviceId).catch(() => {
                  this.updateRenders();
                });
              }
            },
          },
        },
        audiooutput: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              if (element.options) {
                const deviceId = element.options[element.selectedIndex].value;
                this.changeDevice("audiooutput", deviceId);
              }
            },
          },
        },
        audioinput: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              if (element.options) {
                const deviceId = element.options[element.selectedIndex].value;
                this.changeDevice("audioinput", deviceId);
              }
            },
          },
        },
        videoinput: {
          events: {
            onchange: (event) => {
              const element = event.srcElement;
              if (element.options) {
                const deviceId = element.options[element.selectedIndex].value;
                this.changeDevice("videoinput", deviceId);
              }
            },
          },
        },
      },
      data: lwpUtils.merge({}, this._config, this._renderData()),
    };
  }

  _renderDefaultTemplate() {
    // TODO: render advanced settings from capabilities
    return `
        <div>
          {{#data.loaded}}
            {{#data.ringoutput.show}}
              <div>
                <label for="{{by_id.ringoutput.elementId}}">
                  {{i18n.ringoutput}}
                </label>
                <select id="{{by_id.ringoutput.elementId}}">
                  {{#data.ringoutput.devices}}
                    {{#connected}}
                      <option value="{{id}}" {{#selected}}selected{{/selected}}>{{name}}</option>
                    {{/connected}}
                  {{/data.ringoutput.devices}}
                </select>
              </div>
            {{/data.ringoutput.show}}

            {{#data.ringoutput2.show}}
              <div>
                <label for="{{by_id.ringoutput2.elementId}}">
                  {{i18n.ringoutput2}}
                </label>
                <select id="{{by_id.ringoutput2.elementId}}">
                  {{#data.ringoutput2.devices}}
                    {{#connected}}
                      <option value="{{id}}" {{#selected}}selected{{/selected}}>{{#isNone}}{{i18n.none}}{{/isNone}}{{^isNone}}{{name}}{{/isNone}}</option>
                    {{/connected}}
                  {{/data.ringoutput2.devices}}
                </select>
              </div>
            {{/data.ringoutput2.show}}

            {{#data.audiooutput.show}}
              <div>
                <label for="{{by_id.audiooutput.elementId}}">
                  {{i18n.audiooutput}}
                </label>
                <select id="{{by_id.audiooutput.elementId}}">
                  {{#data.audiooutput.devices}}
                    {{#connected}}
                      <option value="{{id}}" {{#selected}}selected{{/selected}}>{{name}}</option>
                    {{/connected}}
                  {{/data.audiooutput.devices}}
                </select>
              </div>
            {{/data.audiooutput.show}}

            {{#data.audioinput.show}}
              <div>
                <label for="{{by_id.audioinput.elementId}}">
                  {{i18n.audioinput}}
                </label>
                <select id="{{by_id.audioinput.elementId}}">
                  {{#data.audioinput.devices}}
                    {{#connected}}
                      <option value="{{id}}" {{#selected}}selected{{/selected}}>{{name}}</option>
                    {{/connected}}    
                  {{/data.audioinput.devices}}
                </select> 
              </div>
            {{/data.audioinput.show}}

            {{#data.videoinput.show}}          
              <div>
                <label for="{{by_id.videoinput.elementId}}">
                  {{i18n.videoinput}}
                </label>                
                <select id="{{by_id.videoinput.elementId}}">
                  {{#data.videoinput.devices}}
                      {{#connected}}
                        <option value="{{id}}" {{#selected}}selected{{/selected}}>{{name}}</option>
                      {{/connected}}
                  {{/data.videoinput.devices}}
                </select>
              </div>
            {{/data.videoinput.show}}
          {{/data.loaded}}

          {{^data.loaded}}
            <div style="margin: 50px 5px;">
              <div class="spinner">
                <div class="bounce1"></div>
                <div class="bounce2"></div>
                <div class="bounce3"></div>
              </div>
              <div style="text-align: center;">{{i18n.loading}}</div>
            </div>
          {{/data.loaded}}
        </div>
        `;
  }

  _renderData(data = {}) {
    data.loaded = this._loaded;

    Object.keys(this._availableDevices).forEach((deviceKind) => {
      const devices = this._availableDevices[deviceKind].slice(0);
      devices.sort((a, b) => {
        return (a.displayOrder || 0) - (b.displayOrder || 0);
      });
      if (!data[deviceKind]) {
        data[deviceKind] = {};
      }
      data[deviceKind].devices = devices;
    });

    // The two ring outputs must be distinct devices, so whatever the primary
    // is using is not offered as a secondary at all. Copies rather than the
    // live device objects: `isNone` is presentation only, telling the template
    // to swap in the translated "None" label for the placeholder entry.
    data.ringoutput2.devices = data.ringoutput2.devices
      .filter((device) => {
        return !this._isPrimaryRingDevice(device);
      })
      .map((device) => {
        return Object.assign({}, device, { isNone: device.id == "none" });
      });

    return data;
  }

  /** Helper functions */

  // Called once the sink has actually moved (or immediately, where there is no
  // sink to move): the renders and getPreferedDevice() read this selection, so
  // it must not run ahead of a setSinkId() that then fails.
  _markOutputDeviceSelected(deviceKind, preferedDevice, eventName) {
    this._availableDevices[deviceKind].forEach((availableDevice) => {
      availableDevice.selected = availableDevice.id == preferedDevice.id;
    });

    if (this._config[deviceKind].enabled) {
      this._emit(eventName, this, preferedDevice);
    }
  }

  async _changeRingOutputDevice(preferedDevice) {
    const audioContext = this._libwebphone.getAudioContext();
    const element = this._config.ringoutput.mediaElement.element;
    let moveSink = null;

    if (audioContext && audioContext.usesContextSink()) {
      // The context owns the sink, not the element - see
      // lwpAudioContext._initOutputAudio().
      moveSink = () => {
        return audioContext.setRingOutputSinkId(preferedDevice.id);
      };
    } else if (element && element.setSinkId !== undefined) {
      // Guarded rather than assumed: element setSinkId is absent on every
      // browser on Android, and calling a missing one throws out of this
      // async method. Feature-detected, not version-sniffed - Safari picked
      // it up in 18.4, so the set of browsers without it keeps shrinking.
      moveSink = () => {
        return element.setSinkId(preferedDevice.id);
      };
    }

    if (!moveSink) {
      this._markOutputDeviceSelected(
        "ringoutput",
        preferedDevice,
        "ring.output.changed"
      );
      this._enforceDistinctRingOutputs();

      return;
    }

    return Promise.resolve()
      .then(moveSink)
      .then(() => {
        this._markOutputDeviceSelected(
          "ringoutput",
          preferedDevice,
          "ring.output.changed"
        );
        this._enforceDistinctRingOutputs();
      })
      .catch((error) => {
        this._emit("ring.output.error", this, error);
      });
  }

  // The secondary ring output can only ever be an element sink: an
  // AudioContext has exactly one sink and the primary ring output already owns
  // it (see lwpAudioContext._initOutputAudio), so this second device is
  // reached through its own MediaStream -> <audio> hand-off. lwpAudioContext
  // owns whether anything is fed down that path; this owns where it lands.
  async _changeSecondaryRingOutputDevice(preferedDevice) {
    const audioContext = this._libwebphone.getAudioContext();
    const element = this._config.ringoutput2.mediaElement.element;
    // Without a movable sink the secondary would land on the default device -
    // most likely the primary's, ringing it twice. Better to stay silent.
    const enabled =
      preferedDevice.id != "none" &&
      this._config.ringoutput2.enabled &&
      !!element &&
      element.setSinkId !== undefined;

    const finish = () => {
      if (audioContext) {
        audioContext.setSecondaryRingOutputEnabled(enabled);
      }

      if (enabled) {
        this._playMediaElement("ringoutput2");
      } else if (
        this._config.manageMediaElements &&
        element &&
        !element.paused
      ) {
        element.pause();
      }

      this._markOutputDeviceSelected(
        "ringoutput2",
        preferedDevice,
        "ring.output.secondary.changed"
      );
    };

    if (!enabled) {
      finish();

      return;
    }

    return Promise.resolve()
      .then(() => {
        return element.setSinkId(preferedDevice.id);
      })
      .then(finish)
      .catch((error) => {
        this._emit("ring.output.secondary.error", this, error);
      });
  }

  // Whether a ringoutput2 device would land on the speaker the primary ring
  // output is already using. Not just an id comparison: browsers expose
  // aliases ("default", "communications") for the same physical output, and
  // those carry the concrete device's groupId - without that check the
  // secondary could ring the primary's speaker under a different id. Empty
  // groupIds, which some permission states produce, never match.
  _isPrimaryRingDevice(device) {
    const primaryRingDevice = this.getPreferedDevice("ringoutput");

    if (!device || device.id == "none" || !primaryRingDevice) {
      return false;
    }

    if (device.id == primaryRingDevice.id) {
      return true;
    }

    return !!(
      device.groupId &&
      primaryRingDevice.groupId &&
      device.groupId == primaryRingDevice.groupId
    );
  }

  _isSecondaryRingOutputSelected() {
    const selectedDevice = this.getPreferedDevice("ringoutput2");

    return !!(selectedDevice && selectedDevice.id != "none");
  }

  // Ringing the same speaker twice is never what was asked for, so where the
  // primary ring output has moved onto the secondary's device the secondary
  // gives way and switches itself off.
  _enforceDistinctRingOutputs() {
    const selectedDevice = this.getPreferedDevice("ringoutput2");

    if (!this._isPrimaryRingDevice(selectedDevice)) {
      return;
    }

    const noneDevice = this._findAvailableDevice("ringoutput2", "none");

    if (!noneDevice) {
      return;
    }

    // Not through changeDevice(): this runs from inside the device-change
    // mutex, which is not reentrant.
    this._preferDevice(noneDevice);

    return this._changeSecondaryRingOutputDevice(noneDevice);
  }

  async _applyInputDeviceSelection(mediaStream) {
    if (!mediaStream) {
      return;
    }

    const liveTracks = mediaStream.getTracks().filter((track) => {
      return track.readyState == "live";
    });

    for (const track of liveTracks) {
      const deviceKind = lwpUtils.trackKindtoDeviceKind(track.kind);
      const selectedDevice = this.getPreferedDevice(deviceKind);
      const trackParameters = lwpUtils.trackParameters(mediaStream, track);

      if (
        !selectedDevice ||
        !selectedDevice.connected ||
        !trackParameters ||
        trackParameters.settings.deviceId == selectedDevice.id
      ) {
        continue;
      }

      const release = await this._changeStreamMutex.acquire();

      // finally(), not then(): a rejection would otherwise hold the mutex
      // forever, deadlocking every subsequent device change.
      await Promise.resolve(this._changeInputDevice(selectedDevice))
        .catch((error) => {
          console.warn(
            "[lwpMediaDevices] could not move the live " +
              track.kind +
              " track onto the configured device",
            error
          );
        })
        .finally(release);
    }
  }

  _isOutputAudible(deviceKind) {
    const audioContext = this._libwebphone.getAudioContext();

    if (!audioContext) {
      return false;
    }

    // The audiooutput element carries only the DTMF tones stream, whose
    // sounds are ~150ms transients - not worth deferring a sink change for.
    if (deviceKind != "ringoutput" && deviceKind != "ringoutput2") {
      return false;
    }

    // Everything through masterGain lands on the ring output, whether that's
    // the element or the context's own sink - both are audible to move.
    return (
      audioContext.isRinging() ||
      audioContext.isRingtonePreviewActive() ||
      audioContext.isPreviewToneActive() ||
      audioContext.isPreviewLoopbackActive()
    );
  }

  async _changeOutputDevice(preferedDevice) {
    const element = this._config.audiooutput.mediaElement.element;

    // No context-sink branch: the tones stream stays on the element path in
    // every mode (a context has one sink, and this is the speaker device
    // rather than the ring one). Same setSinkId guard as above.
    if (!element || element.setSinkId === undefined) {
      this._markOutputDeviceSelected(
        preferedDevice.deviceKind,
        preferedDevice,
        "audio.output.changed"
      );

      return;
    }

    return Promise.resolve()
      .then(() => {
        return element.setSinkId(preferedDevice.id);
      })
      .then(() => {
        this._markOutputDeviceSelected(
          preferedDevice.deviceKind,
          preferedDevice,
          "audio.output.changed"
        );
      })
      .catch((error) => {
        this._emit("audio.output.error", this, error);
      });
  }

  _muteInput(deviceKind = null) {
    return this._mediaStreamPromise.then((mediaStream) => {
      const trackKind = this._deviceKindtoTrackKind(deviceKind);

      mediaStream.getTracks().forEach((track) => {
        if (!trackKind || track.kind == trackKind) {
          const trackParameters = lwpUtils.trackParameters(mediaStream, track);

          track.enabled = false;

          this._emit(track.kind + ".input.muted", this, trackParameters);
        }
      });

      return mediaStream;
    });
  }

  _unmuteInput(deviceKind = null) {
    return this._mediaStreamPromise.then((mediaStream) => {
      const trackKind = this._deviceKindtoTrackKind(deviceKind);

      mediaStream.getTracks().forEach((track) => {
        if (!trackKind || track.kind == trackKind) {
          const trackParameters = lwpUtils.trackParameters(mediaStream, track);

          track.enabled = true;

          this._emit(track.kind + ".input.unmuted", this, trackParameters);
        }
      });

      return mediaStream;
    });
  }

  _toggleMuteInput(deviceKind = null) {
    return this._mediaStreamPromise.then((mediaStream) => {
      const trackKind = this._deviceKindtoTrackKind(deviceKind);

      mediaStream.getTracks().forEach((track) => {
        if (!trackKind || track.kind == trackKind) {
          const trackParameters = lwpUtils.trackParameters(mediaStream, track);

          track.enabled = !track.enabled;

          if (track.enabled) {
            this._emit(track.kind + ".input.unmuted", this, trackParameters);
          } else {
            this._emit(track.kind + ".input.muted", this, trackParameters);
          }
        }
      });

      return mediaStream;
    });
  }

  _changeInputDevice(preferedDevice) {
    return this._ensureMediaStream().then((mediaStream) => {

      let mutedInputs = [];

      const trackKind = preferedDevice.trackKind;
      const trackConstraints =
        this._createConstraints(preferedDevice)[trackKind];
      const previousTrack = mediaStream.getTracks().find((track) => {
        return track.kind == preferedDevice.trackKind;
      });
      const previousTrackParameters = lwpUtils.trackParameters(
        mediaStream,
        previousTrack
      );

      if (trackKind === "video" && preferedDevice.id === "screenCapture") {
        return this.startScreenCapture();
      }

      if (this._captureStream) {
        this.stopScreenCapture();
      }

      if (previousTrack) {
        mutedInputs = previousTrack.enabled ? [] : [previousTrack.kind];
        this._removeTrack(mediaStream, previousTrack);
      }

      if (trackKind === "video" && preferedDevice.id === "none") {
        // Disable video for all streams, do not replace track or media stream
        this._startedStreams.forEach((request) => {
          if (request.mediaStream) {
            request.mediaStream.getVideoTracks().forEach((track) => {
              track.enabled = false;
            });
          }
        });

        this._availableDevices[preferedDevice.deviceKind].forEach(
          (availableDevice) => {
            if (availableDevice.id === "none") {
              availableDevice.selected = true;
            } else {
              availableDevice.selected = false;
            }
          }
        );

        this._emit(
          trackKind + ".input.changed",
          this,
          null,
          previousTrackParameters
        );

        return;
      }

      if (trackConstraints) {
        const constraints = {};
        constraints[trackKind] = trackConstraints;
        return this._startInputStreams(constraints, mutedInputs).then(() => {
          const newTrack = mediaStream.getTracks().find((track) => {
            return track.kind == trackKind && track.readyState == "live";
          });

          if (this._startedStreams.length == 0) {
            this.stopAllStreams();
          }

          if (newTrack) {
            this._emit(
              trackKind + ".input.changed",
              this,
              lwpUtils.trackParameters(mediaStream, newTrack),
              previousTrackParameters
            );
          }
        });
      }
    });
  }

  // A rejected _mediaStreamPromise is otherwise permanent.
  // _initInputStreams() assigns the field once and never reassigns it on
  // failure, so denying the permission prompt at page load (both kinds
  // requested, then the audio-only retry denied too) leaves every reader of
  // the field - mute, device switching, every call - waiting on that same
  // rejection for the life of the page, with no way back short of a reload.
  // Every read goes through here so the poison is replaced rather than
  // merely read past, and the replacement is handed onward so whoever fills
  // it is filling the object the field actually points at.
  _readMediaStream() {
    return this._mediaStreamPromise.catch((error) => {
      console.warn("[lwpMediaDevices] _mediaStreamPromise was left rejected; clearing it", error);

      const replacement = new MediaStream();

      this._mediaStreamPromise = Promise.resolve(replacement);

      return replacement;
    });
  }

  // getUserMedia() is all-or-nothing across kinds, so a single unavailable
  // camera fails a combined request outright and takes a perfectly good
  // microphone down with it. Both other acquisition sites already drop
  // video and retry; this exists so the recovery path in
  // _ensureMediaStream() has the same ladder rather than giving up on an
  // audio call because of a webcam.
  //
  // Only the final failure emits getUserMedia.error - the intermediate one
  // is recoverable and reporting it would surface an error to the host for
  // a request that then succeeded. _initInputStreams() and
  // _startInputStreams() still carry their own copies of this ladder,
  // wrapped in different post-processing (_updateMediaElements vs
  // _addTrack); they should be migrated onto this helper rather than a
  // fourth copy being written.
  _acquireWithVideoFallback(constraints) {
    return this._shimGetUserMedia(constraints).catch((error) => {
      if (!constraints.video || !constraints.audio) {
        throw error;
      }

      const audioOnly = Object.assign({}, constraints);
      delete audioOnly.video;

      console.warn("[lwpMediaDevices] combined audio+video acquisition failed; retrying audio only", error);

      return this._shimGetUserMedia(audioOnly);
    });
  }

  // _mediaStreamPromise is set exactly once, in _initInputStreams(), and is
  // never reassigned afterwards even if a later recovery attempt succeeds -
  // every reader (mute, device switching, subsequent calls) shares this one
  // field. If it ever resolves without a usable MediaStream, every consumer
  // must recover through here so the recovered stream is written back to
  // _mediaStreamPromise itself, not just handed to the one caller that
  // happened to trigger the recovery. Returning a fabricated empty
  // MediaStream without persisting a real recovery back to the shared
  // promise is what causes mute/device-switching to silently stop working
  // for the rest of the session - do not reintroduce that.
  //
  // recover is opt-in because an empty shared stream is the normal resting
  // state between calls: stopAllStreams() stops and removes every track
  // when the last call ends. Only a caller with no acquisition logic of its
  // own needs this function to go and get media - startStreams()'s
  // _inputActive branch, which clones straight from whatever comes back.
  // _startInputStreams() and _changeInputDevice() both acquire what they
  // need themselves, so for them an empty stream is a container to fill,
  // not a fault to report.
  _ensureMediaStream(constraints = null, recover = false) {
    return this._readMediaStream().then((mediaStream) => {
      // Liveness, not truthiness. An emptied or ended MediaStream is still
      // a truthy object, so testing the reference alone answered "yes, we
      // have media" for a stream carrying nothing - short-circuiting the
      // recovery below, which is the entire point of this function, into
      // unreachable code. Callers want a stream they can clone working
      // tracks from, so that is what the guard has to ask.
      const hasLiveTracks =
        mediaStream &&
        mediaStream.getTracks().some((track) => track.readyState == "live");

      // Always a real object, never null: _muteInput/_unmuteInput/
      // _toggleMuteInput and the device-switch refresh logic all read
      // _mediaStreamPromise directly and call .getTracks() with no guard.
      if (hasLiveTracks || !recover) {
        return mediaStream || new MediaStream();
      }

      // An empty object is truthy, so `constraints || _createConstraints()`
      // treated {} as a usable constraint set and handed it to
      // getUserMedia, which rejects with a TypeError rather than a media
      // error. refreshAvailableDevices() reaches _startInputStreams({}),
      // which forwards it here, so fall back to _createConstraints() on an
      // empty set rather than only on a missing one.
      const effectiveConstraints =
        constraints && Object.keys(constraints).length
          ? constraints
          : this._createConstraints();

      // Nothing was asked for, so there is nothing to recover. This is a
      // real configuration, not a failure: audioinput selected as "none"
      // with videoinput disabled makes _createConstraints() legitimately
      // return {}. Attempting recovery there would report a misleading
      // getUserMedia.error on every single call. Such a deployment still
      // cannot take calls - lwpCall's hasTracks check cannot tell "no
      // input configured" from "acquisition failed" - but that is a
      // separate, parked issue and not something to compound with a
      // spurious error. (Recovery only became reachable with the liveness
      // guard above, so none of this could fire before.)
      if (Object.keys(effectiveConstraints).length == 0) {
        return mediaStream || new MediaStream();
      }

      if (this._recoveryPromise) {
        // Shared rather than duplicated. Nothing serialises this function,
        // so two consumers entering recovery at once - a devicechange
        // refresh alongside an incoming call, or two calls in the same tick
        // - would each issue their own getUserMedia, and the loser's stream
        // would be dropped without stop(), leaving the operating system's
        // microphone indicator lit on an orphaned capture.
        //
        // Deliberately not _changeStreamMutex: refreshAvailableDevices()
        // and the device-reconcile loop both hold that lock across calls
        // that reach here, and async-mutex is not reentrant - acquiring it
        // would deadlock rather than serialise.
        return this._recoveryPromise;
      }

      console.warn("[lwpMediaDevices] _mediaStreamPromise resolved without live tracks; attempting recovery");
      this._emit("mediaStreamPromise.recovering", this);

      this._recoveryPromise = this._acquireWithVideoFallback(effectiveConstraints)
        .then((recoveredMediaStream) => {
          // Registered through _addTrack rather than merely handed back:
          // that is what marks the device selected in _availableDevices and
          // fires <kind>.input.started, so the device pickers reflect what
          // is actually live instead of whatever was selected before the
          // failure. Recovery only became reachable with the liveness guard
          // above, so this path had never run before.
          recoveredMediaStream.getTracks().forEach((track) => {
            this._addTrack(recoveredMediaStream, track);
          });

          this._updateMediaElements(recoveredMediaStream);
          // Persist the recovery so every other reader of _mediaStreamPromise
          // (not just this call) sees the real stream from now on.
          this._mediaStreamPromise = Promise.resolve(recoveredMediaStream);
          this._emit("mediaStreamPromise.recovered", this);
          return recoveredMediaStream;
        })
        .catch((error) => {
          this._emit("getUserMedia.error", this, error);
          console.warn("[lwpMediaDevices] recovery attempt also failed; no usable media is available", error);
          // Deliberately do NOT persist an empty MediaStream into
          // _mediaStreamPromise - leave it broken so the next attempt tries
          // again, rather than permanently caching a dead stream.
          return new MediaStream();
        })
        // finally(), not then(): the slot has to clear on the failure path
        // too, or one failed recovery would pin every later attempt to its
        // result for the life of the page.
        .finally(() => {
          this._recoveryPromise = null;
        });

      return this._recoveryPromise;
    });
  }

  _startInputStreams(constraints = null) {
    if (!constraints) {
      constraints = this._createConstraints();
    }

    return this._ensureMediaStream(constraints).then((mediaStream) => {
      mediaStream.getTracks().forEach((track) => {
        if (track.readyState == "live") {
          delete constraints[track.kind];
        } else {
          this._removeTrack(mediaStream, track);
        }
      });

      if (Object.keys(constraints).length == 0) {
        return Promise.resolve(mediaStream);
      }

      return this._shimGetUserMedia(constraints)
        .then((otherMediaStream) => {
          otherMediaStream.getTracks().forEach((track) => {
            this._addTrack(mediaStream, track);
          });

          return mediaStream;
        })
        .then((mediaStream) => {
          this._updateMediaElements(mediaStream);
          return mediaStream;
        })
        .catch((error) => {
          this._emit("getUserMedia.error", this, error);
          if (constraints.video && constraints.audio) {
            delete constraints.video;
            return this._shimGetUserMedia(constraints)
              .then((otherMediaStream) => {
                otherMediaStream.getTracks().forEach((track) => {
                  this._addTrack(mediaStream, track);
                });

                return mediaStream;
              })
              .then((mediaStream) => {
                this._updateMediaElements(mediaStream);
                return mediaStream;
              });
          }

          // Propagated rather than swallowed. Resolving here hands
          // startStreams() a stream with nothing in it, which it then
          // caches as active media (_inputActive = true) - so the failure
          // is recorded as a success and no later call retries
          // getUserMedia. All three startStreams() consumers
          // (lwpCall.answer(), lwpUserAgent.call(),
          // lwpConference.addToConference()) have catch handlers that
          // surface this to the host; getUserMedia.error was already
          // emitted above.
          //
          // Only when nothing usable survives: a partial acquisition (say
          // a live camera and a dead microphone) still resolves, which is
          // the behaviour it has always had. That case connects a call
          // with no microphone and is a separate gap - lwpCall's
          // hasTracks check counts tracks of any kind.
          if (!mediaStream.getTracks().some((track) => track.readyState == "live")) {
            throw error;
          }

          return mediaStream;
        });
    })
    .then((mediaStream) => {
      // One owner of the field. _ensureMediaStream() can hand back a
      // stream it did not persist - its recovery-failed path returns a
      // throwaway - and this function then populates that object with
      // real tracks, leaving the call working while _mediaStreamPromise
      // still resolves the old empty stream, so mute and device
      // switching silently stop working for the rest of the session.
      // Writing back here means the field always resolves whatever
      // stream actually holds the tracks, whichever route produced it.
      this._mediaStreamPromise = Promise.resolve(mediaStream);

      return mediaStream;
    });
  }

  _updateMediaElements(mediaStream) {
    lwpUtils.trackKinds().forEach((trackKind) => {
      const deviceKind = lwpUtils.trackKindtoDeviceKind(trackKind);
      const element = this._config[deviceKind].mediaElement.element;
      const track = mediaStream.getTracks().find((track) => {
        return track.kind == trackKind;
      });

      if (track) {
        if (
          element &&
          (!element.srcObject || element.srcObject.id != mediaStream.id)
        ) {
          element.srcObject = mediaStream;
        }

        if (this._config.manageMediaElements && element && element.paused) {
          // TODO: without the interaction history of my dev site, can we still
          //  issue a play this early?
          element.play().catch(() => {});
        }
      } else {
        if (this._config.manageMediaElements && element && !element.paused) {
          element.pause();
        }

        if (element) {
          element.srcObject = null;
        }
      }
    });
  }

  _createConstraints(...preferedDevices) {
    let preferedAudioDevice = this._availableDevices["audioinput"].find(
      (availableAudioDevice) => {
        return availableAudioDevice.selected && availableAudioDevice.connected;
      }
    );
    let preferedVideoDevice = this._availableDevices["videoinput"].find(
      (availableVideoDevice) => {
        return availableVideoDevice.selected && availableVideoDevice.connected;
      }
    );

    const constraints = {
      audio: this._config.audioinput.constraints || {},
      video: this._config.videoinput.constraints || {},
    };

    preferedDevices.forEach((preferedDevice) => {
      switch (preferedDevice.deviceKind) {
        case "audioinput":
          preferedAudioDevice = preferedDevice;
          break;
        case "videoinput":
          preferedVideoDevice = preferedDevice;
          break;
      }
    });

    if (preferedAudioDevice) {
      const preferedAudioConstraints = preferedAudioDevice.constraints || {};
      preferedAudioConstraints.deviceId = {};
      preferedAudioConstraints.deviceId.exact = preferedAudioDevice.id;
      constraints.audio = lwpUtils.merge(
        constraints.audio,
        preferedAudioConstraints
      );
    }

    if (preferedVideoDevice) {
      const preferedVideoConstraints = preferedVideoDevice.constraints || {};
      preferedVideoConstraints.deviceId = {};
      preferedVideoConstraints.deviceId.exact = preferedVideoDevice.id;
      constraints.video = lwpUtils.merge(
        constraints.video,
        preferedVideoConstraints
      );
    }

    if (
      !this._config.audioinput.enabled ||
      (constraints.audio &&
        constraints.audio.deviceId &&
        constraints.audio.deviceId.exact == "none")
    ) {
      delete constraints.audio;
    }

    if (
      !this._config.videoinput.enabled ||
      (constraints.video &&
        constraints.video.deviceId &&
        constraints.video.deviceId.exact == "none")
    ) {
      delete constraints.video;
    }

    return constraints;
  }

  _preferDevice(preferedDevice, options = { sort: true, updateConfig: true }) {
    const maxPreference = this._availableDevices[
      preferedDevice.deviceKind
    ].reduce((max, availableDevice) => {
      if (
        (availableDevice.preference || 0) > max &&
        availableDevice.id != preferedDevice.id
      ) {
        return availableDevice.preference;
      }
      return max;
    }, 0);

    preferedDevice.preference = maxPreference + 1;

    if (options.sort) {
      this._sortAvailableDevices();
    }

    if (options.updateConfig && preferedDevice.id != "none") {
      const deviceKind = preferedDevice.deviceKind;
      const insertIndex = this._config[deviceKind].preferedDeviceIds.findIndex(
        (deviceId) => {
          const device = this._findAvailableDevice(deviceKind, deviceId);
          return deviceId != preferedDevice.id && device && device.connected;
        }
      );
      const removeIndex = this._config[deviceKind].preferedDeviceIds.indexOf(
        preferedDevice.id
      );

      if (removeIndex > -1) {
        this._config[deviceKind].preferedDeviceIds.splice(removeIndex, 1);
      }

      if (insertIndex == -1) {
        this._config[deviceKind].preferedDeviceIds.push(preferedDevice.id);
      } else {
        this._config[deviceKind].preferedDeviceIds.splice(
          insertIndex,
          0,
          preferedDevice.id
        );
      }
    }
  }

  _addScreenCaptureEventListeners() {
    this._captureStream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        this.stopScreenCapture();
      });
    });
  }

  _playMediaElement(deviceKind) {
    const element = this._config[deviceKind].mediaElement.element;

    if (!this._config.manageMediaElements || !element || !element.paused) {
      return;
    }

    element.play().catch((error) => {
      this._emit(
        this._deviceKindtoEventKind(deviceKind) + ".play.error",
        this,
        element,
        error
      );
    });
  }

  _startMediaElements() {
    if (this._config.manageMediaElements) {
      const audioContext = this._libwebphone.getAudioContext();
      const contextOwnsRingSink = !!(
        audioContext && audioContext.usesContextSink()
      );

      this._deviceKinds().forEach((deviceKind) => {
        // Nothing is attached to the ringoutput element in context-sink mode,
        // so there is nothing here to play.
        if (deviceKind == "ringoutput" && contextOwnsRingSink) {
          return;
        }

        // The secondary ring output is deliberately silent until a device is
        // chosen for it - playing it here would undo that.
        if (
          deviceKind == "ringoutput2" &&
          !this._isSecondaryRingOutputSelected()
        ) {
          return;
        }

        this._playMediaElement(deviceKind);
      });
    }
  }

  _createCallStream(mediaStream, requestId) {
    if (!mediaStream) {
      // Defensive only: both callers now guarantee a real MediaStream, and
      // startStreams() rejects rather than passing one through with no live
      // tracks. Deliberately emits nothing - the "recovered" event this used
      // to fire said the opposite of what happened (an empty stream was
      // fabricated, nothing was recovered) and carried a payload the other
      // emitter of that event does not have.
      console.warn("[lwpMediaDevices] _createCallStream: received an undefined mediaStream; substituting an empty one");
      mediaStream = new MediaStream();
    }

    const newMediaStream = new MediaStream();

    /**
     * We need to clone the tracks here because
     * lwpCall will toggle track.enabled to mute
     * the call and if multiple calls share the
     * same track umuting the call you are on
     * unmutes you for all calls (possibly making
     * for a bad day...)
     *
     */
    mediaStream.getTracks().forEach((track) => {
      newMediaStream.addTrack(track.clone());
    });

    if (!requestId) {
      this._startedStreams.push({ id: null, mediaStream: newMediaStream });
    } else if (
      !this._startedStreams.find((request) => {
        return request.id == requestId;
      })
    ) {
      this._startedStreams.push({
        id: requestId,
        mediaStream: newMediaStream,
      });
    }

    return newMediaStream;
  }

  /** MediaStream Helpers */

  _addTrack(mediaStream, track) {
    const trackParameters = lwpUtils.trackParameters(mediaStream, track);

    mediaStream.addTrack(track);

    this._availableDevices[trackParameters.deviceKind].forEach(
      (availableDevice) => {
        if (availableDevice.id == trackParameters.settings.deviceId) {
          Object.assign(availableDevice, trackParameters, { selected: true });
        } else {
          availableDevice.selected = false;
        }
      }
    );

    this._emit(track.kind + ".input.started", this, trackParameters);

    if (track.enabled) {
      this._emit(track.kind + ".input.unmuted", this, trackParameters);
    } else {
      this._emit(track.kind + ".input.muted", this, trackParameters);
    }
  }

  _removeTrack(mediaStream, track, updateSelected = true) {
    const trackParameters = lwpUtils.trackParameters(mediaStream, track);

    track.enabled = false;
    track.stop();

    mediaStream.removeTrack(track);

    if (updateSelected) {
      this._availableDevices[trackParameters.deviceKind].forEach(
        (availableDevice) => {
          if (availableDevice.id == trackParameters.settings.deviceId) {
            Object.assign(availableDevice, trackParameters, {
              selected: false,
            });
          } else if (availableDevice.id == "none") {
            availableDevice.selected = true;
          } else {
            availableDevice.selected = false;
          }
        }
      );
    }

    this._emit(track.kind + ".input.stopped", this, trackParameters);
  }

  /** Device Helpers */

  _findAvailableDevice(deviceKind, deviceId) {
    return this._availableDevices[deviceKind].find((availableDevice) => {
      return availableDevice.id == deviceId;
    });
  }

  _forEachAvailableDevice(callbackfn) {
    Object.keys(this._availableDevices).forEach((deviceKind) => {
      this._availableDevices[deviceKind].forEach(callbackfn);
    });
  }

  _sortAvailableDevices() {
    Object.keys(this._availableDevices).forEach((deviceKind) => {
      this._availableDevices[deviceKind].sort((a, b) => {
        return (b.preference || 0) - (a.preference || 0);
      });
    });
  }

  _importInputDevices(devices) {
    devices.forEach((device) => {
      if (!device.deviceId || 0 === device.deviceId.length) {
        return;
      }

      const enumeratedDevice = this._deviceParameters(device);
      const availableDevice = this._findAvailableDevice(
        device.kind,
        device.deviceId
      );

      if (availableDevice) {
        Object.assign(availableDevice, enumeratedDevice);
      } else {
        if (!this._availableDevices[device.kind]) {
          this._availableDevices[device.kind] = [];
        }

        enumeratedDevice.displayOrder =
          this._availableDevices[device.kind].length;

        const preferedDeviceIds =
          this._config[device.kind].preferedDeviceIds || [];
        const preferenceIndex = preferedDeviceIds.indexOf(enumeratedDevice.id);

        enumeratedDevice.preference =
          preferenceIndex > -1
            ? preferedDeviceIds.length - preferenceIndex
            : 0;

        this._availableDevices[device.kind].push(enumeratedDevice);
      }
    });
  }

  _deviceParameters(device) {
    return {
      id: device.deviceId,
      label: device.label,
      deviceKind: device.kind,
      name: this._getDeviceName(device),
      trackKind: this._deviceKindtoTrackKind(device.kind),
      connected: true,
      groupId: device.groupId,
    };
  }

  _getDeviceName(device) {
    const deviceKind = device.kind;
    const i18nKey = "libwebphone:mediaDevices." + deviceKind;
    return (
      device.label ||
      i18nKey + " " + (this._availableDevices[deviceKind].length + 1)
    );
  }

  _deviceKindtoTrackKind(deviceKind) {
    switch (deviceKind) {
      case "ringoutput":
      case "ringoutput2":
      case "audiooutput":
      case "audioinput":
        return "audio";
      case "videoinput":
        return "video";
    }
  }

  _deviceKindtoEventKind(deviceKind) {
    switch (deviceKind) {
      case "ringoutput":
        return "ring.output";
      case "ringoutput2":
        return "ring.output.secondary";
      case "audiooutput":
        return "audio.output";
      case "audioinput":
        return "audio.input";
      case "videoinput":
        return "video.input";
    }
  }

  _deviceKinds() {
    return [
      "ringoutput",
      "ringoutput2",
      "audiooutput",
      "audioinput",
      "videoinput",
    ];
  }

  /** Shims */

  // Both ring output kinds are synthesised from the enumerated audiooutput
  // devices: the browser has no notion of "a device to ring on", so each real
  // output is offered once per ring kind and tracked separately from there.
  async _shimEnumerateDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const ringoutputDevices = [];

    devices.forEach((device) => {
      if (device.kind !== "audiooutput") return;
      ringoutputDevices.push(
        this._outputDeviceToRingDevice(device, "ringoutput")
      );
      ringoutputDevices.push(
        this._outputDeviceToRingDevice(device, "ringoutput2")
      );
    });

    return devices.concat(ringoutputDevices);
  }

  _outputDeviceToRingDevice(device, kind = "ringoutput") {
    return {
      deviceId: device.deviceId,
      groupId: device.groupId,
      kind: kind,
      label: device.label,
    };
  }

  _shimGetUserMedia(constraints) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }
}
