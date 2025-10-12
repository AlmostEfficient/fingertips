import { showToast } from './overlay.js';
import { performAction } from './actions.js';
import { detectViewMode, observeModeChanges, VIEW_MODES } from './modeManager.js';
import {
  ACTION_ORDER,
  DEFAULT_ACTION_BINDINGS,
  DEFAULT_STATE,
  HAND_OPTIONS,
  STATE_STORAGE_KEY
} from '../shared/constants.js';

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
let currentViewMode = VIEW_MODES.UNKNOWN;
let stopModeObserver = null;

const DEFAULT_REPEAT_DELAY = DEFAULT_STATE.repeatDelayMs || 120;
const DEFAULT_REPEAT_INTERVAL = DEFAULT_STATE.repeatIntervalMs || 120;
const gestureActionState = new Map();
let extensionState = {
  isActive: DEFAULT_STATE.isActive,
  repeatDelayMs: DEFAULT_REPEAT_DELAY,
  repeatIntervalMs: DEFAULT_REPEAT_INTERVAL,
  actionBindings: sanitizeBindings(DEFAULT_STATE.actionBindings)
};
const MIN_GESTURE_SCORE = 0.55;
const MIN_HANDEDNESS_SCORE = 0.45;
const MODE_WARNING_COOLDOWN_MS = 4000;
let lastModeWarningAt = 0;

init();

window.addEventListener('beforeunload', () => {
  if (typeof stopModeObserver === 'function') {
    try {
      stopModeObserver();
    } catch (err) {
      console.warn('Fingertips: failed to clean up mode observer', err);
    }
    stopModeObserver = null;
  }

  chrome.storage.onChanged.removeListener(handleStorageChange);
  stopPreview();
});

async function init() {
  chrome.runtime.sendMessage({ type: 'fingertips:getState' }, (response) => {
    const err = chrome.runtime.lastError;
    if (err) {
      console.warn('Fingertips: failed to fetch initial state', err);
      return;
    }
    if (response?.state) {
      mergeExtensionState(response.state);
    }
    activationEnabled = Boolean(extensionState.isActive);
    if (activationEnabled) {
      startPreview();
    }
  });

  currentViewMode = detectViewMode();
  stopModeObserver = observeModeChanges((mode) => {
    currentViewMode = mode;
  });

  chrome.storage.onChanged.addListener(handleStorageChange);

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
        if (message.payload) {
          lastGesturePayload = message.payload;
          lastGestureReceivedAt = Date.now();
          handleGesturePayload(message.payload);
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

function handleStorageChange(changes, area) {
  if (area !== 'local') {
    return;
  }

  const stateChange = changes[STATE_STORAGE_KEY];
  if (!stateChange?.newValue) {
    return;
  }

  mergeExtensionState(stateChange.newValue);
}

function sanitizeBindings(bindings) {
  const result = {};
  const source = bindings && typeof bindings === 'object' ? bindings : {};
  for (const action of ACTION_ORDER) {
    const fallback = DEFAULT_ACTION_BINDINGS[action];
    const entry = source[action];
    const gesture = typeof entry?.gesture === 'string' ? entry.gesture : fallback.gesture;
    let handValue = typeof entry?.hand === 'string' ? entry.hand.toLowerCase() : fallback.hand;
    if (gesture === 'None') {
      handValue = HAND_OPTIONS.ANY;
    } else if (handValue !== HAND_OPTIONS.LEFT && handValue !== HAND_OPTIONS.RIGHT) {
      handValue = HAND_OPTIONS.ANY;
    }
    result[action] = { gesture, hand: handValue };
  }
  return result;
}

function mergeExtensionState(partialState) {
  if (!partialState) {
    return;
  }

  extensionState = {
    ...extensionState,
    ...partialState,
    actionBindings: sanitizeBindings(partialState.actionBindings || extensionState.actionBindings)
  };

  delete extensionState.gestureMap;

  if (typeof extensionState.repeatDelayMs !== 'number' || Number.isNaN(extensionState.repeatDelayMs)) {
    extensionState.repeatDelayMs = DEFAULT_REPEAT_DELAY;
  }

  if (typeof extensionState.repeatIntervalMs !== 'number' || Number.isNaN(extensionState.repeatIntervalMs)) {
    extensionState.repeatIntervalMs = DEFAULT_REPEAT_INTERVAL;
  }
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
        gestureActionState.clear();
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
      gestureActionState.clear();
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
      const hands = Array.isArray(lastGesturePayload.hands) ? lastGesturePayload.hands : [];
      const gestureSummary = lastGesturePayload.gesture || (hands.length
        ? hands.map((hand) => hand?.gesture).filter(Boolean).join(', ') || null
        : null);
      const handednessSummary = lastGesturePayload.handedness || (hands.length
        ? hands.map((hand) => hand?.handedness).filter(Boolean).join(', ') || null
        : null);
      const scoreSummary = typeof lastGesturePayload.score === 'number'
        ? lastGesturePayload.score
        : (hands.find((hand) => typeof hand?.score === 'number')?.score ?? null);
      console.log('Fingertips gesture monitor:', {
        gesture: gestureSummary,
        handedness: handednessSummary,
        score: scoreSummary,
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

function handleGesturePayload(payload) {
  if (!gestureEngineActive || !payload) {
    return;
  }

  const now = Date.now();
  pruneStaleGestureState(now);

  const entries = normalizeHands(payload);
  if (!entries.length) {
    return;
  }

  if (currentViewMode !== VIEW_MODES.ONE_UP) {
    maybeWarnAboutViewMode(entries);
    return;
  }

  entries.forEach((entry) => {
    const match = matchActionForEntry(entry);
    if (!match) {
      return;
    }

    if (typeof entry.score === 'number' && entry.score < MIN_GESTURE_SCORE) {
      return;
    }

    const { action, binding } = match;

    if (bindingRequiresSpecificHand(binding) && !hasConfidentHand(entry)) {
      return;
    }

    const key = buildGestureKey(entry, action, binding);
    if (shouldDispatchForKey(key, now)) {
      triggerAction(action);
    }
  });
}

function normalizeHands(payload) {
  if (Array.isArray(payload.hands) && payload.hands.length) {
    return payload.hands
      .map((hand) => ({
        gesture: hand?.gesture || null,
        score: typeof hand?.score === 'number' ? hand.score : null,
        handedness: hand?.handedness || null,
        handednessScore: typeof hand?.handednessScore === 'number' ? hand.handednessScore : null
      }))
      .filter((hand) => Boolean(hand.gesture));
  }

  if (payload.gesture) {
    return [{
      gesture: payload.gesture,
      score: typeof payload.score === 'number' ? payload.score : null,
      handedness: payload.handedness || null,
      handednessScore: typeof payload.handednessScore === 'number' ? payload.handednessScore : null
    }];
  }

  return [];
}

function matchActionForEntry(entry) {
  if (!entry?.gesture) {
    return null;
  }

  const entryHand = normalizeHandValue(entry.handedness);

  for (const action of ACTION_ORDER) {
    const binding = extensionState.actionBindings?.[action];
    if (!binding) {
      continue;
    }

    const gesture = binding.gesture;
    if (!gesture || gesture === 'None' || gesture !== entry.gesture) {
      continue;
    }

    const requiredHand = normalizeHandValue(binding.hand);
    if (requiredHand !== HAND_OPTIONS.ANY && requiredHand !== entryHand) {
      continue;
    }

    return { action, binding };
  }

  return null;
}

function normalizeHandValue(value) {
  const lower = typeof value === 'string' ? value.toLowerCase() : '';
  if (lower === HAND_OPTIONS.LEFT || lower === 'left') {
    return HAND_OPTIONS.LEFT;
  }
  if (lower === HAND_OPTIONS.RIGHT || lower === 'right') {
    return HAND_OPTIONS.RIGHT;
  }
  return HAND_OPTIONS.ANY;
}

function bindingRequiresSpecificHand(binding) {
  const hand = normalizeHandValue(binding?.hand);
  return hand === HAND_OPTIONS.LEFT || hand === HAND_OPTIONS.RIGHT;
}

function hasConfidentHand(entry) {
  if (typeof entry.handednessScore !== 'number') {
    return false;
  }
  return entry.handednessScore >= MIN_HANDEDNESS_SCORE;
}

function buildGestureKey(entry, action, binding) {
  const entryHand = normalizeHandValue(entry.handedness);
  const requiredHand = normalizeHandValue(binding?.hand);
  const handKey = requiredHand === HAND_OPTIONS.ANY ? entryHand : requiredHand;
  return `${handKey}:${entry.gesture}:${action}`;
}

function shouldDispatchForKey(key, now) {
  const repeatDelay = extensionState.repeatDelayMs ?? DEFAULT_REPEAT_DELAY;
  const repeatInterval = extensionState.repeatIntervalMs ?? DEFAULT_REPEAT_INTERVAL;
  const idleReset = Math.max(repeatDelay, repeatInterval) * 1.5;

  const state = gestureActionState.get(key) || {
    lastTriggered: 0,
    lastSeen: 0,
    phase: 'initial'
  };

  if (state.lastSeen && now - state.lastSeen > idleReset) {
    state.lastTriggered = 0;
    state.phase = 'initial';
  }

  const threshold = state.phase === 'initial'
    ? 0
    : state.phase === 'delay'
    ? repeatDelay
    : repeatInterval;

  const allow = state.lastTriggered === 0 || now - state.lastTriggered >= threshold;
  state.lastSeen = now;

  if (allow) {
    state.lastTriggered = now;
    state.phase = state.phase === 'initial' ? 'delay' : 'repeat';
  }

  gestureActionState.set(key, state);
  return allow;
}

function pruneStaleGestureState(now) {
  const repeatDelay = extensionState.repeatDelayMs ?? DEFAULT_REPEAT_DELAY;
  const repeatInterval = extensionState.repeatIntervalMs ?? DEFAULT_REPEAT_INTERVAL;
  const idleReset = Math.max(repeatDelay, repeatInterval) * 3;

  for (const [key, state] of gestureActionState.entries()) {
    if (!state?.lastSeen) {
      continue;
    }
    if (now - state.lastSeen > idleReset) {
      gestureActionState.delete(key);
    }
  }
}

function triggerAction(action) {
  try {
    const result = performAction(action);
    if (result && typeof result.then === 'function') {
      result.catch((err) => {
        console.error('Fingertips: action handler rejected', err);
      });
    }
  } catch (err) {
    console.error('Fingertips: failed to dispatch action', err);
  }
}

function maybeWarnAboutViewMode(entries) {
  if (!entries?.length) {
    return;
  }

  const now = Date.now();
  if (now - lastModeWarningAt < MODE_WARNING_COOLDOWN_MS) {
    return;
  }

  const actionable = entries.some((entry) => {
    const match = matchActionForEntry(entry);
    if (!match) {
      return false;
    }
    if (typeof entry.score === 'number' && entry.score < MIN_GESTURE_SCORE) {
      return false;
    }
    if (bindingRequiresSpecificHand(match.binding) && !hasConfidentHand(entry)) {
      return false;
    }
    return true;
  });

  if (!actionable) {
    return;
  }

  lastModeWarningAt = now;
  showToast('Open a single photo to use navigation gestures.', {
    tone: 'neutral',
    duration: 2200
  });
}
