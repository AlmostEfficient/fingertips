# Architecture Log

## 2024-XX-XX — Initial Content-Script Approach
- **Goal:** Reuse the MediaPipe demo pipeline directly inside the iCloud Photos tab.
- **Implementation:** Packaged the Tasks-Vision ESM bundle + gesture model and loaded them from the content script (`GestureEngine` helper).
- **Issue:** iCloud’s CSP blocks dynamic wasm bootstrapping (`ModuleFactory not set` → `unsafe-eval` denied). Gesture recognizer never instantiates.

## 2024-XX-XX — Injected Page Module
- **Goal:** Bypass Chrome isolated world restrictions by injecting a module (`pageBridge.js`) into the page so MediaPipe runs in iCloud’s execution context.
- **Implementation:** Content script added a `<script type="module">` that imported the packaged bundle and streamed gestures back via `postMessage`.
- **Issue:** iCloud CSP still refuses wasm instantiation; MediaPipe emits `WebAssembly.instantiate` unsafe-eval errors even inside the page context.

## 2024-XX-XX — Decision Point
- **Observation:** iCloud only allows wasm from whitelisted hashes/origins; any attempt to load our packaged runtime inside the tab fails.
- **Options Considered:**
  1. Run recognition in an extension-controlled surface (offscreen doc / iframe).
  2. Embed a floating extension iframe hosting the Google demo.
  3. Move gesture detection to a native helper app.
- **Decision:** Implement option 1 to keep everything within the MV3 extension while retaining Google’s MediaPipe pipeline.

## 2024-XX-XX — Offscreen Document Architecture
- **Implementation:**
  - Added `offscreen/gesture.html` + `gesture.js` to own the MediaPipe runtime and webcam outside the page CSP.
  - Background service worker manages offscreen lifecycle, routes start/stop/camera requests, and rebroadcasts gestures to active tabs.
  - Content script simplified to send start/stop/camera messages, execute navigation/delete actions, and render a 200px preview overlay for user feedback.
- **Gotchas & Fixes:**
  - Chrome raised “offscreen documents unavailable” until the new offscreen page was declared in `manifest.json` (`offscreen_documents` section).
  - Preview setup required guarding against duplicate `getUserMedia` calls and ensuring cleanup when the engine stops/errors.
  - Offscreen worker now shuts down cleanly and reports errors back to the page; errors trigger a stop + toast in the tab.


## 2024-XX-XX — Hidden iframe spike (abandoned)
- **Goal:** keep MediaPipe out of the page CSP by loading it in an extension iframe injected into the tab.
- **Outcome:** failed.
  - Content script cannot call `window.fingertipsEngine` on the iframe because Chrome blocks cross-origin property access (`https` page → `chrome-extension://` frame). This yields `SecurityError: Blocked a frame with origin ... protocols must match` once the iframe arrives.
  - Even if the bridge were reachable, `postMessage` cannot carry a live `MediaStream` between those origins; Chrome throws `DataCloneError: MediaStream object could not be cloned` when the content script tries to forward the camera stream into the iframe.
  - Pushing MediaPipe directly into the page also triggers `ModuleFactory not set` (CSP disallows the WASM bootstrapping path).
- **Resolution:** revert to the MV3 offscreen document. The offscreen context shares Chrome’s extension origin, can initialize WASM without tripping CSP, and once we request the optional `camera` permission, it can own the `getUserMedia` session outright.

## Current State
- Gesture recognition runs entirely in the offscreen document, avoiding iCloud’s CSP restrictions.
- Content script receives gesture actions and drives the DOM (navigation/delete) using the existing logic.
- Popup toggle + camera warm-up leverage the background bridge; users see a live preview overlay while gestures are active.

*Future adjustments should be recorded here to keep the architectural history fresh.*
