const MODEL_URL = chrome.runtime.getURL('models/gesture_recognizer.task');
const LIB_URL = chrome.runtime.getURL('libs/tasks-vision.esm.js');
const WASM_BASE_URL = chrome.runtime.getURL('libs/wasm');

let visionModule = null;
let gestureRecognizer = null;
let videoElement = null;
let mediaStream = null;
let isRunning = false;
let lastGesture = 'None';
let lastDispatchTime = 0;

chrome.runtime.sendMessage({
  source: 'offscreen',
  type: 'offscreen:ready'
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') {
    return;
  }

  switch (message.type) {
    case 'offscreen:start':
      startRecognition().catch((err) => reportError(err));
      break;
    case 'offscreen:stop':
      stopRecognition().catch((err) => reportError(err));
      break;
    case 'offscreen:warmup':
      warmupCamera(message.requestId).catch((err) => reportError(err));
      break;
    default:
      break;
  }
});

async function loadVisionModule() {
  if (visionModule) {
    return visionModule;
  }
  visionModule = await import(LIB_URL);
  return visionModule;
}

async function ensureRecognizer() {
  if (gestureRecognizer) {
    return gestureRecognizer;
  }

  const { GestureRecognizer, FilesetResolver } = await loadVisionModule();
  const wasmBase = WASM_BASE_URL.replace(/\/+$/, '');
  const filesetResolver = await FilesetResolver.forVisionTasks(wasmBase);

  gestureRecognizer = await GestureRecognizer.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath: MODEL_URL
    },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
    minHandPresenceConfidence: 0.5
  });

  return gestureRecognizer;
}

async function ensureVideoElement() {
  if (videoElement && mediaStream && mediaStream.active) {
    return videoElement;
  }

  if (!mediaStream || !mediaStream.active) {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user'
        }
      });
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        throw new Error('Camera permission denied. Please allow camera access to use gesture recognition.');
      } else if (err.name === 'NotFoundError') {
        throw new Error('No camera found. Please connect a camera to use gesture recognition.');
      } else if (err.name === 'NotReadableError') {
        throw new Error('Camera is already in use by another application.');
      } else {
        throw new Error(`Camera access failed: ${err.message}`);
      }
    }
  }

  videoElement = document.createElement('video');
  videoElement.muted = true;
  videoElement.autoplay = true;
  videoElement.playsInline = true;
  videoElement.style.display = 'none';
  videoElement.srcObject = mediaStream;

  document.body.appendChild(videoElement);

  await videoElement.play().catch(() => undefined);
  if (videoElement.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) {
    await new Promise((resolve) => {
      videoElement.addEventListener('loadeddata', resolve, { once: true });
    });
  }

  return videoElement;
}

async function startRecognition() {
  if (isRunning) {
    return;
  }

  try {
    await Promise.all([ensureRecognizer(), ensureVideoElement()]);
    isRunning = true;
    lastGesture = 'None';
    lastDispatchTime = 0;
    loop();
    chrome.runtime.sendMessage({
      source: 'offscreen',
      type: 'offscreen:status',
      payload: { ok: true }
    });
  } catch (err) {
    reportError(err);
    await stopRecognition();
    throw err;
  }
}

async function stopRecognition() {
  isRunning = false;

  if (gestureRecognizer) {
    try {
      gestureRecognizer.close();
    } catch (err) {
      console.warn('Fingertips offscreen recognizer close failed', err);
    }
    gestureRecognizer = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (videoElement) {
    videoElement.srcObject = null;
    videoElement.remove();
    videoElement = null;
  }

  lastGesture = 'None';
  lastDispatchTime = 0;
}

async function warmupCamera(requestId) {
  try {
    if (mediaStream && mediaStream.active) {
      try {
        console.info('Fingertips offscreen: camera warmup hit cache');
        chrome.runtime.sendMessage({
          source: 'offscreen',
          type: 'offscreen:cameraResult',
          requestId,
          payload: { ok: true }
        });
      } catch (msgErr) {
        console.warn('Failed to send camera warmup success message:', msgErr);
      }
      return;
    }

    console.info('Fingertips offscreen: requesting camera access');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user'
      }
    });

    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
    }
    mediaStream = stream;

    try {
      chrome.runtime.sendMessage({
        source: 'offscreen',
        type: 'offscreen:cameraResult',
        requestId,
        payload: { ok: true }
      });
    } catch (msgErr) {
      console.warn('Failed to send camera warmup success message:', msgErr);
    }
  } catch (err) {
    console.error('Fingertips offscreen: camera warmup failed', err, err?.name, err?.message);
    const errorMsg = err.name === 'NotAllowedError'
      ? 'Camera permission denied'
      : err.name === 'NotReadableError'
      ? 'Camera is already in use by another application'
      : err?.message || String(err);
    try {
      chrome.runtime.sendMessage({
        source: 'offscreen',
        type: 'offscreen:cameraResult',
        requestId,
        payload: { ok: false, error: errorMsg }
      });
    } catch (msgErr) {
      console.warn('Failed to send camera warmup error message:', msgErr);
    }
  }
}

function reportError(error) {
  const message = error?.message || String(error);
  console.error('Fingertips offscreen error', message, error?.stack);
  if (isRunning) {
    stopRecognition().catch(() => {});
  }
  try {
    chrome.runtime.sendMessage({
      source: 'offscreen',
      type: 'offscreen:error',
      payload: {
        message,
        stack: error?.stack || null
      }
    });
  } catch (err) {
    console.warn('Failed to send error message to background script:', err);
  }
}

async function loop() {
  if (!isRunning || !gestureRecognizer || !videoElement) {
    return;
  }

  try {
    const now = performance.now();
    const result = gestureRecognizer.recognizeForVideo(videoElement, now);
    const gesture = extractGesture(result);
    if (gesture) {
      dispatchGesture(gesture, result);
    }
  } catch (err) {
    reportError(err);
  }

  if (isRunning) {
    requestAnimationFrame(() => loop());
  }
}

function extractGesture(result) {
  if (!result?.gestures?.length) {
    return null;
  }
  const [gestureList] = result.gestures;
  if (!gestureList || gestureList.length === 0) {
    return null;
  }
  const [topGesture] = gestureList;
  return topGesture?.categoryName || null;
}

function dispatchGesture(gesture, result) {
  const timestamp = Date.now();
  if (gesture === lastGesture && timestamp - lastDispatchTime < 400) {
    return;
  }
  lastGesture = gesture;
  lastDispatchTime = timestamp;

  chrome.runtime.sendMessage({
    source: 'offscreen',
    type: 'offscreen:gesture',
    payload: {
      gesture,
      score: result?.gestures?.[0]?.[0]?.score ?? null,
      timestamp
    }
  });
}
