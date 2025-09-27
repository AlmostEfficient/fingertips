import { showToast } from './overlay.js';

let activationEnabled = false;
let previewActive = false;
let previewVideo = null;
let previewStream = null;
let previewPromise = null;
let warmupErrorShown = false;
let gestureEngineActive = false;
let lastGesturePayload = null;
let lastGestureReceivedAt = 0;
let gestureLogInterval = null;

init();

async function init() {
  chrome.runtime.sendMessage({ type: 'fingertips:getState' }, (response) => {
    const err = chrome.runtime.lastError;
    if (err) {
      console.warn('Fingertips: failed to fetch initial state', err);
      return;
    }
    activationEnabled = Boolean(response?.state?.isActive);
    if (activationEnabled) {
      startPreview();
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message?.type) {
      case 'fingertips:requestCamera':
        requestCameraAccess().then((result) => sendResponse?.(result));
        return true;
      case 'fingertips:startGestureEngine':
        startGestureEngine().then((result) => sendResponse?.(result));
        return true;
      case 'fingertips:stopGestureEngine':
        stopGestureEngine().then((result) => sendResponse?.(result));
        return true;
      case 'fingertips:gesture':
        if (message.payload?.gesture) {
          lastGesturePayload = message.payload;
          lastGestureReceivedAt = Date.now();
          console.log('Fingertips gesture detected (debug only):', message.payload);
        }
        break;
      case 'fingertips:gestureError':
        if (message.payload?.message) {
          console.warn('Fingertips gesture engine error (debug):', message.payload.message);
          showToast(`Gesture engine error: ${message.payload.message}`, {
            tone: 'error',
            duration: 3600
          });
          gestureEngineActive = false;
        }
        break;
      case 'fingertips:activationChanged':
        activationEnabled = Boolean(message.isActive);
        if (activationEnabled) {
          startPreview();
          showToast('Camera preview enabled', { tone: 'success' });
        } else {
          stopPreview();
          showToast('Camera preview disabled');
        }
        break;
      default:
        break;
    }

    return false;
  });

}

async function startPreview() {
  if (previewActive) {
    return;
  }

  try {
    await ensurePreview();
    previewActive = true;
  } catch (err) {
    previewActive = false;
    console.error('Fingertips: failed to start camera preview', err);
    showToast(err?.message || 'Unable to access the camera. Check your browser settings.', {
      tone: 'error',
      duration: 3600
    });
    teardownPreview();
  }
}

function stopPreview() {
  if (!previewActive && !previewVideo && !previewStream) {
    return;
  }
  previewActive = false;
  warmupErrorShown = false;
  teardownPreview();
}

async function requestCameraAccess() {
  try {
    await ensurePreview();
    previewActive = true;
    const warmupResult = await warmupOffscreenCamera();
    if (warmupResult?.ok) {
      showToast('Camera access granted.', { tone: 'success' });
      return { ok: true };
    }
    if (warmupResult) {
      const message = warmupResult.error || 'Gesture engine could not access the camera.';
      handleWarmupError(message);
      return { ok: false, error: message };
    }
    return { ok: true };
  } catch (err) {
    previewActive = false;
    console.error('Fingertips: camera access request failed', err);
    const message = err?.message || 'Camera access blocked. Allow access in browser settings.';
    showToast(message, { tone: 'error', duration: 3600 });
    teardownPreview();
    return { ok: false, error: message };
  }
}

async function ensurePreview() {
  if (previewVideo && previewStream) {
    return previewVideo;
  }

  if (previewPromise) {
    return previewPromise;
  }

  previewPromise = (async () => {
    try {
      previewStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 320 },
          height: { ideal: 240 },
          facingMode: 'user'
        }
      });
    } catch (err) {
      previewStream = null;
      throw normalizeCameraError(err);
    }

    previewVideo = document.createElement('video');
    previewVideo.id = 'fingertips-preview';
    previewVideo.muted = true;
    previewVideo.autoplay = true;
    previewVideo.playsInline = true;
    previewVideo.width = 200;
    previewVideo.height = 150;
    previewVideo.style.cssText = [
      'position: fixed',
      'bottom: 16px',
      'right: 16px',
      'width: 200px',
      'height: 150px',
      'border-radius: 12px',
      'box-shadow: 0 8px 28px rgba(0,0,0,0.45)',
      'z-index: 2147483647',
      'background: black',
      'object-fit: cover',
      'pointer-events: none',
      'opacity: 0.65'
    ].join(';');

    previewVideo.srcObject = previewStream;
    document.body.appendChild(previewVideo);

    await previewVideo.play().catch(() => undefined);
    return previewVideo;
  })();

  try {
    return await previewPromise;
  } finally {
    previewPromise = null;
  }
}

function teardownPreview() {
  if (previewStream) {
    previewStream.getTracks().forEach((track) => track.stop());
    previewStream = null;
  }
  if (previewVideo) {
    previewVideo.remove();
    previewVideo = null;
  }
  previewPromise = null;
}

async function warmupOffscreenCamera() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'fingertips:requestCamera' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('Fingertips: offscreen camera request failed', chrome.runtime.lastError);
        resolve({ ok: false, error: chrome.runtime.lastError?.message || 'Unable to reach gesture engine.' });
        return;
      }
      resolve(response || { ok: false, error: 'No response from offscreen document.' });
    });
  });

  window.addEventListener('beforeunload', () => {
    stopPreview();
  });
}

function handleWarmupError(message) {
  console.warn('Fingertips: offscreen warmup error', message);
  if (!warmupErrorShown) {
    warmupErrorShown = true;
    showToast(`${message} Use “Grant camera permission” in the popup, then try again.`, {
      tone: 'error',
      duration: 3600
    });
  }
}

async function startGestureEngine() {
  if (gestureEngineActive) {
    return { ok: true };
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'fingertips:startRecognition' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Fingertips: failed to start gesture engine', chrome.runtime.lastError);
        resolve({ ok: false, error: chrome.runtime.lastError?.message || 'Gesture engine unavailable.' });
        return;
      }

      if (response?.ok) {
        gestureEngineActive = true;
        startGestureLogging();
        resolve({ ok: true });
      } else {
        gestureEngineActive = false;
        resolve({ ok: false, error: response?.error || 'Gesture engine failed to start.' });
      }
    });
  });
}

async function stopGestureEngine() {
  if (!gestureEngineActive) {
    gestureEngineActive = false;
    return { ok: true };
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'fingertips:stopRecognition' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Fingertips: failed to stop gesture engine', chrome.runtime.lastError);
        resolve({ ok: false, error: chrome.runtime.lastError?.message || 'Gesture engine stop failed.' });
        return;
      }

      gestureEngineActive = false;
      stopGestureLogging();
      lastGesturePayload = null;
      lastGestureReceivedAt = 0;
      resolve(response || { ok: true });
    });
  });
}

function startGestureLogging() {
  if (gestureLogInterval) {
    return;
  }
  gestureLogInterval = setInterval(() => {
    if (!gestureEngineActive) {
      return;
    }

    const now = Date.now();
    if (lastGesturePayload && now - lastGestureReceivedAt <= 1500) {
      console.log('Fingertips gesture monitor:', {
        gesture: lastGesturePayload.gesture,
        score: lastGesturePayload.score ?? null,
        ageMs: now - lastGestureReceivedAt
      });
    } else {
      console.log('Fingertips gesture monitor: no gesture detected in the last second');
    }
  }, 1000);
}

function stopGestureLogging() {
  if (gestureLogInterval) {
    clearInterval(gestureLogInterval);
    gestureLogInterval = null;
  }
}

function normalizeCameraError(err) {
  if (!err) {
    return new Error('Camera access failed. Please try again.');
  }

  if (err.name === 'NotAllowedError') {
    return new Error('Camera permission denied. Allow access in your browser settings.');
  }
  if (err.name === 'NotFoundError') {
    return new Error('No camera found. Connect a camera to continue.');
  }
  if (err.name === 'NotReadableError') {
    return new Error('Camera is already in use by another application.');
  }
  if (err.name === 'OverconstrainedError') {
    return new Error('Camera does not support the requested resolution.');
  }

  const message = err?.message || String(err);
  return new Error(`Camera access failed: ${message}`);
}
