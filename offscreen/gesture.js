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

  const scheduleNext = () => {
    if (isRunning) {
      setTimeout(() => loop(), 100);
    }
  };

  try {
    const now = performance.now();
    const result = gestureRecognizer.recognizeForVideo(videoElement, now);
    const hands = extractHands(result);
    if (hands.length) {
      dispatchGesture(hands);
    }
  } catch (err) {
    reportError(err);
    scheduleNext();
    return;
  }

  scheduleNext();
}

function extractHands(result) {
  if (!result?.gestures?.length) {
    return [];
  }

  const hands = [];
  for (let index = 0; index < result.gestures.length; index += 1) {
    const gestureList = result.gestures[index];
    if (!gestureList || !gestureList.length) {
      continue;
    }

    const [topGesture] = gestureList;
    if (!topGesture) {
      continue;
    }

    const handednessList = result.handednesses?.[index] || null;
    const [topHandedness] = handednessList || [];

    hands.push({
      gesture: topGesture.categoryName || null,
      score: typeof topGesture.score === 'number' ? topGesture.score : null,
      handedness: topHandedness?.categoryName || null,
      handednessScore: typeof topHandedness?.score === 'number' ? topHandedness.score : null
    });
  }

  return hands;
}

function dispatchGesture(hands) {
  const timestamp = Date.now();
  const [primaryHand] = hands;
  lastGesture = primaryHand?.gesture || 'None';
  lastDispatchTime = timestamp;

  console.debug('Fingertips offscreen: dispatching gesture', {
    gesture: primaryHand?.gesture || null,
    handedness: primaryHand?.handedness || null,
    score: primaryHand?.score ?? null,
    timestamp,
    handCount: hands.length
  });

  chrome.runtime.sendMessage({
    source: 'offscreen',
    type: 'offscreen:gesture',
    payload: {
      gesture: primaryHand?.gesture || null,
      handedness: primaryHand?.handedness || null,
      score: primaryHand?.score ?? null,
      hands,
      timestamp
    }
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('Fingertips offscreen: failed to send gesture', chrome.runtime.lastError?.message || chrome.runtime.lastError);
    }
  });
}
