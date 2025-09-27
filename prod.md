
  1. Reconnect Gesture Actions
     Wire the recogniser output back into performAction() so the “debug only” logs actually scroll or delete again. We’ve got
  the stable pipeline now—time to make it useful.
  2. Reduce Dual Camera Streams
     Right now both the tab and offscreen doc call getUserMedia. Consider letting the offscreen worker own the stream and
  piping frames back to the page for the preview. That would halve camera usage and simplify warmup logic.
  3. Streamline Message Path
     Once actions are live, we can swap the content→popup status messages for a simple event bus or even consolidate start/stop
  so only the popup talks to the service worker. Fewer message types = easier debugging.
  4. Tune Logging / Telemetry
     The continuous console output is great for development, but we should add a quiet mode or wrap logs behind a DEBUG flag
  before shipping. Maybe surface the last gesture in the UI instead.
  5. Gesture Noise Filtering (after re-enabling actions)
     A simple debounce or confidence threshold in dispatchGesture will prevent accidental repeats once “delete” is back on. We
  can expose those thresholds in settings later