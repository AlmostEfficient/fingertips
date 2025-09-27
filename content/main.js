import { getExtensionState, observeStateChanges } from '../shared/storage.js';
import { showToast } from './overlay.js';

let currentState = null;
let previewActive = false;
let previewVideo = null;
let previewStream = null;
let previewPromise = null;

init();

async function init() {
  currentState = await getExtensionState();

  observeStateChanges((nextState) => {
    currentState = nextState;
    if (currentState.isActive) {
      startPreview();
    } else {
      stopPreview();
      showToast('Camera preview disabled');
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message?.type) {
      case 'fingertips:requestCamera':
        requestCameraAccess().then((result) => sendResponse?.(result));
        return true;
      case 'fingertips:activationChanged':
        if (message.isActive) {
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

  if (currentState.isActive) {
    startPreview();
  }

  window.addEventListener('beforeunload', () => {
    stopPreview();
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
  teardownPreview();
}

async function requestCameraAccess() {
  try {
    await ensurePreview();
    previewActive = true;
    showToast('Camera access granted.', { tone: 'success' });
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
